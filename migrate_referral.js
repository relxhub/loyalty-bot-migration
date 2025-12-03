// migrate_referral.js
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// ⚠️ ตั้งค่าแต้มที่แจกต่อการเชิญ 1 คน
const POINTS_PER_REFERRAL = 50; 

async function migrateReferralHistory() {
    console.log("🚀 เริ่มต้นกู้ประวัติแนะนำเพื่อน...");

    try {
        // 1. ดึงข้อมูลลูกค้าทุกคนที่มีคนชวน
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
            
            // ข้ามถ้าไม่มี ID คนชวน
            if (!child.referrerId || child.referrerId === 'N/A') continue;

            const parent = await prisma.customer.findUnique({
                where: {
                    customerId: child.referrerId 
                }
            });

            // ถ้าเจอคนชวน และคนชวนผูก Telegram ไว้
            if (parent && parent.telegramUserId) {
                
                // ✅ แก้ไข: เช็คจากวันที่เพื่อนสมัครแทน (เพราะ CustomerLog ไม่มี details)
                const exists = await prisma.customerLog.findFirst({
                    where: {
                        customerId: parent.customerId,
                        action: 'REFERRAL_BONUS',
                        createdAt: child.createdAt // ใช้วันที่เดียวกันเป๊ะๆ เป็นตัวเช็ค
                    }
                });

                if (!exists) {
                    await prisma.customerLog.create({
                        data: {
                            telegramUserId: parent.telegramUserId,
                            customerId: parent.customerId,
                            action: 'REFERRAL_BONUS',
                            pointsChange: POINTS_PER_REFERRAL,
                            // ❌ ลบ details ออก เพราะตารางไม่มีช่องนี้
                            createdAt: child.createdAt // ใช้วันที่เพื่อนสมัคร เป็นวันที่ได้แต้ม
                        }
                    });
                    process.stdout.write(".");
                    count++;
                }
            }
        }

        console.log(`\n\n✅ กู้ประวัติเชิญเพื่อนสำเร็จ ${count} รายการ`);

    } catch (error) {
        console.error("\n❌ Error:", error);
    } finally {
        await prisma.$disconnect();
    }
}

migrateReferralHistory();