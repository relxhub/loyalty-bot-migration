// migrate_referral.js (ฉบับรองรับ DB ใหม่)
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// ⚠️ ตั้งค่าแต้มที่แจกต่อการเชิญ 1 คน
const POINTS_PER_REFERRAL = 50; 
// ⚠️ ตั้งค่าจำนวนวันหมดอายุเริ่มต้น (เพื่อใช้คำนวณย้อนกลับกรณีหา log ไม่เจอ)
const DEFAULT_EXPIRY_DAYS = 30;

async function migrateReferralHistory() {
    console.log("🚀 เริ่มต้นกู้ประวัติแนะนำเพื่อน (ลง PointTransaction)...");

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

            // ถ้าเจอคนชวน
            if (parent) {
                
                // 🕵️‍♂️ ค้นหาวันที่สมัครจริงของเพื่อน (child)
                let actualDate = new Date();
                
                // A. ลองหาจาก AdminAuditLog (ตารางใหม่)
                const creationLog = await prisma.adminAuditLog.findFirst({
                    where: { 
                        targetId: child.customerId, // ใช้ targetId แทน customerId
                        action: 'CREATE_CUSTOMER'
                    }
                });

                if (creationLog) {
                    actualDate = creationLog.createdAt;
                } else if (child.joinDate) {
                    // B. ถ้าไม่เจอ Log ให้ใช้วัน joinDate จากตาราง Customer (ถ้ามี)
                    actualDate = child.joinDate;
                } else if (child.expiryDate) {
                    // C. ถ้าไม่มีอะไรเลย ให้เดาจากวันหมดอายุ
                    const estimatedDate = new Date(child.expiryDate);
                    estimatedDate.setDate(estimatedDate.getDate() - DEFAULT_EXPIRY_DAYS);
                    actualDate = estimatedDate;
                }

                // D. เช็คว่ามีประวัติการได้แต้มใน PointTransaction หรือยัง (ตารางใหม่)
                const exists = await prisma.pointTransaction.findFirst({
                    where: {
                        customerId: parent.customerId,
                        type: 'REFERRAL_BONUS', // ใช้ type แทน action
                        relatedId: child.customerId // เช็คว่าเคยได้แต้มจาก ID นี้หรือยัง
                    }
                });

                if (!exists) {
                    await prisma.pointTransaction.create({
                        data: {
                            customerId: parent.customerId,
                            amount: POINTS_PER_REFERRAL, // ใช้ amount แทน pointsChange
                            type: 'REFERRAL_BONUS',
                            detail: `System Repair: แนะนำ ${child.customerId}`,
                            relatedId: child.customerId, // ผูก ID เพื่อนไว้ด้วย
                            createdAt: actualDate
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