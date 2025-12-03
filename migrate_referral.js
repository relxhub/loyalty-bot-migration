// migrate_referral.js
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// ⚠️ ตั้งค่าแต้มที่แจกต่อการเชิญ 1 คน
const POINTS_PER_REFERRAL = 50; 
// ⚠️ ตั้งค่าจำนวนวันหมดอายุเริ่มต้น (เพื่อใช้คำนวณย้อนกลับกรณีหา log ไม่เจอ)
const DEFAULT_EXPIRY_DAYS = 30;

async function migrateReferralHistory() {
    console.log("🚀 เริ่มต้นกู้ประวัติแนะนำเพื่อน (แบบดึงเวลาจริง)...");

    try {
        // 1. ดึงลูกค้าทุกคนที่มีคนชวน
        const invitedUsers = await prisma.customer.findMany({
            where: {
                referrerId: { not: null } 
            }
        });

        console.log(`📦 พบการเชิญเพื่อนทั้งหมด: ${invitedUsers.length} รายการ`);
        let count = 0;

        for (const child of invitedUsers) {
            // child = คนที่ถูกชวน
            // parent = คนชวน 
            
            if (!child.referrerId || child.referrerId === 'N/A') continue;

            const parent = await prisma.customer.findUnique({
                where: { customerId: child.referrerId }
            });

            // ถ้าเจอคนชวน และคนชวนผูก Telegram ไว้
            if (parent && parent.telegramUserId) {
                
                // 🕵️‍♂️ ค้นหาวันที่สมัครจริงของเพื่อน (child) จาก AdminLog
                let actualDate = new Date();
                
                // 1. ลองหาจาก AdminLog ตอนสร้างลูกค้า
                const creationLog = await prisma.adminLog.findFirst({
                    where: { 
                        customerId: child.customerId,
                        action: 'CREATE_CUSTOMER'
                    }
                });

                if (creationLog) {
                    actualDate = creationLog.createdAt;
                } else {
                    // 2. ถ้าไม่เจอ Log (เช่น สร้างไว้นานแล้ว) ให้เดาจากวันหมดอายุ
                    // สูตร: วันสมัคร = วันหมดอายุ - 30 วัน (ค่า Default)
                    if (child.expiryDate) {
                        const estimatedDate = new Date(child.expiryDate);
                        estimatedDate.setDate(estimatedDate.getDate() - DEFAULT_EXPIRY_DAYS);
                        actualDate = estimatedDate;
                        // console.log(`⚠️ ไม่พบ Log ของ ${child.customerId} ใช้วันโดยประมาณ: ${actualDate.toISOString()}`);
                    }
                }

                // เช็คว่ามีประวัตินี้แล้วหรือยัง (เช็คจาก Action และ CustomerId ของคนชวน)
                // *ไม่ต้องเช็คเวลาเป๊ะๆ แล้ว เพราะเราอาจจะคำนวณใหม่*
                const exists = await prisma.customerLog.findFirst({
                    where: {
                        customerId: parent.customerId,
                        action: 'REFERRAL_BONUS',
                        // ใช้ details เป็นตัวแยก unique แทน (เก็บว่าชวนใคร)
                        // แต่เนื่องจาก db คุณไม่มี details เราจะเช็คคร่าวๆ ว่าเคยได้แต้มในช่วงเวลานั้นไหม
                        createdAt: {
                            gte: new Date(actualDate.getTime() - 1000 * 60), // บวกลบ 1 นาที
                            lte: new Date(actualDate.getTime() + 1000 * 60)
                        }
                    }
                });

                if (!exists) {
                    await prisma.customerLog.create({
                        data: {
                            telegramUserId: parent.telegramUserId,
                            customerId: parent.customerId,
                            action: 'REFERRAL_BONUS',
                            pointsChange: POINTS_PER_REFERRAL,
                            createdAt: actualDate // ✅ ใช้วันที่หามาได้ (ย้อนหลัง)
                        }
                    });
                    process.stdout.write(".");
                    count++;
                }
            }
        }

        console.log(`\n\n✅ กู้ประวัติเชิญเพื่อนสำเร็จ ${count} รายการ`);
        console.log(`(ใช้วันที่จริงจาก AdminLog หรือคำนวณย้อนหลัง)`);

    } catch (error) {
        console.error("\n❌ Error:", error);
    } finally {
        await prisma.$disconnect();
    }
}

migrateReferralHistory();