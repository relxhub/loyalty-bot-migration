// migrate_history.js
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function migrateAdminLogs() {
    console.log("🚀 เริ่มต้นย้ายข้อมูลประวัติเก่า...");

    try {
        // 1. ดึงข้อมูล AdminLog ที่เกี่ยวกับแต้มทั้งหมด
        const adminLogs = await prisma.adminLog.findMany({
            where: {
                action: {
                    in: ['ADD_POINTS', 'REDEEM_POINTS'] // เอาเฉพาะเติมแต้มกับแลกของ
                }
            }
        });

        console.log(`📦 พบรายการจาก Admin ทั้งหมด: ${adminLogs.length} รายการ`);
        let count = 0;

        // 2. วนลูปตรวจสอบทีละรายการ
        for (const log of adminLogs) {
            if (!log.customerId) continue;

            // หาข้อมูลลูกค้าเพื่อเอา telegramUserId
            const customer = await prisma.customer.findUnique({
                where: { customerId: log.customerId }
            });

            // ถ้าลูกค้าคนนี้ผูก Telegram แล้ว -> สร้างประวัติให้เขาเห็น
            if (customer && customer.telegramUserId) {
                
                // แปลงชื่อ Action ให้ตรงกับแบบใหม่
                let newAction = log.action === 'ADD_POINTS' ? 'ADMIN_ADD_POINTS' : 'ADMIN_REDEEM';

                // ตรวจสอบว่ามีประวัตินี้อยู่แล้วหรือยัง (กันซ้ำ)
                const exists = await prisma.customerLog.findFirst({
                    where: {
                        telegramUserId: customer.telegramUserId,
                        customerId: log.customerId,
                        createdAt: log.createdAt, // เช็คจากเวลาเดียวกันเป๊ะๆ
                        action: newAction
                    }
                });

                if (!exists) {
                    await prisma.customerLog.create({
                        data: {
                            telegramUserId: customer.telegramUserId,
                            customerId: log.customerId,
                            action: newAction,
                            pointsChange: log.pointsChange,
                            createdAt: log.createdAt // ✅ สำคัญ! ใช้วันที่เดิมจากอดีต
                        }
                    });
                    process.stdout.write("."); // แสดงจุดเมื่อทำสำเร็จ
                    count++;
                }
            }
        }

        console.log(`\n\n✅ เสร็จสิ้น! ย้ายข้อมูลสำเร็จ ${count} รายการ`);
        console.log(`(รายการที่เหลือคือลูกค้าที่ยังไม่ได้ผูก Telegram หรือย้ายไปแล้ว)`);

    } catch (error) {
        console.error("\n❌ เกิดข้อผิดพลาด:", error);
    } finally {
        await prisma.$disconnect();
    }
}

migrateAdminLogs();