// run_migration_history.js
import fs from 'fs';
import csv from 'csv-parser';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// ฟังก์ชันแปลง Action เก่า -> Type ใหม่
function mapActionToType(oldAction) {
    const actionUpper = oldAction ? oldAction.toUpperCase() : 'OTHER';
    const mapping = {
        'REFERRAL_BONUS': 'REFERRAL_BONUS',
        'LINK_BONUS': 'LINK_BONUS',
        'LINK_ACCOUNT': 'LINK_BONUS',
        'REDEEM': 'REDEEM_REWARD',
        'REDEEM_REWARD': 'REDEEM_REWARD',
        'ADMIN_ADD': 'ADMIN_ADJUST',
        'ADMIN_DEDUCT': 'ADMIN_ADJUST',
        'ADMIN_ADJUST': 'ADMIN_ADJUST'
    };
    return mapping[actionUpper] || 'OTHER';
}

async function migrateHistory() {
    console.log('🚀 เริ่มต้นการย้ายข้อมูลประวัติ (History Migration)...');
    
    const results = [];
    const filePath = './CustomerLogs.csv'; // ตรวจสอบว่าไฟล์ CSV อยู่ที่นี่

    if (!fs.existsSync(filePath)) {
        console.error(`❌ ไม่พบไฟล์ ${filePath} กรุณานำไฟล์ CSV มาวางไว้ในโฟลเดอร์โปรเจกต์`);
        return;
    }

    // 1. อ่านไฟล์ CSV
    fs.createReadStream(filePath)
        .pipe(csv())
        .on('data', (data) => results.push(data))
        .on('end', async () => {
            console.log(`📄 พบข้อมูลทั้งหมด ${results.length} รายการ`);
            
            let successCount = 0;
            let errorCount = 0;

            // 2. วนลูปบันทึกข้อมูล
            for (const row of results) {
                try {
                    // ข้ามแถวที่ไม่มี customerId
                    if (!row.customerId) continue;

                    // ตรวจสอบว่ามี User นี้จริงไหม (กัน Error Foreign Key)
                    const userExists = await prisma.customer.findUnique({
                        where: { customerId: row.customerId }
                    });

                    if (userExists) {
                        const amount = parseInt(row.pointsChange) || 0;
                        const actionType = mapActionToType(row.action);

                        await prisma.pointTransaction.create({
                            data: {
                                customerId: row.customerId,
                                amount: amount,
                                type: actionType,
                                detail: `Migrated: ${row.action} (${row.details || '-'})`,
                                createdAt: row.createdAt ? new Date(row.createdAt) : new Date(),
                                relatedId: row.relatedId || null 
                            }
                        });
                        successCount++;
                    } else {
                        // console.warn(`⚠️ ข้าม: ไม่พบ User ID ${row.customerId}`);
                    }
                    
                    // แสดงความคืบหน้าทุกๆ 100 รายการ
                    if (successCount % 100 === 0) process.stdout.write('.');

                } catch (error) {
                    // console.error(`❌ Error row:`, error.message);
                    errorCount++;
                }
            }

            console.log(`\n✅ เสร็จสิ้น!`);
            console.log(`   - สำเร็จ: ${successCount} รายการ`);
            console.log(`   - ล้มเหลว/ข้าม: ${errorCount} รายการ`);
            
            await prisma.$disconnect();
        });
}

migrateHistory().catch(e => console.error(e));