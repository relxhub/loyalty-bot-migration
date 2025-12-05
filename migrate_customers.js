// migrate_customers.js
import fs from 'fs';
import csv from 'csv-parser';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function migrateCustomers() {
    console.log('🚀 เริ่มต้นการย้ายข้อมูลลูกค้า (Customer Migration)...');
    
    const customers = [];
    const filePath = './CustomerData.csv'; // ไฟล์ CSV ของคุณ

    if (!fs.existsSync(filePath)) {
        console.error(`❌ ไม่พบไฟล์ ${filePath}`);
        return;
    }

    // 1. อ่านไฟล์ CSV เข้า Memory ก่อน
    await new Promise((resolve, reject) => {
        fs.createReadStream(filePath)
            .pipe(csv())
            .on('data', (data) => customers.push(data))
            .on('end', resolve)
            .on('error', reject);
    });

    console.log(`📄 พบข้อมูลลูกค้า ${customers.length} คน`);
    let successCount = 0;

    // 2. บันทึกลง DB
    for (const row of customers) {
        try {
            if (!row.customerId) continue;

            // แปลงค่าให้ตรงกับ Schema
            const points = parseInt(row.points) || 0;
            const joinDate = row.joinDate ? new Date(row.joinDate) : new Date();
            const expiryDate = row.expiryDate ? new Date(row.expiryDate) : null;
            
            // ใช้ upsert: ถ้ามีแล้วให้แก้, ถ้าไม่มีให้สร้าง
            await prisma.customer.upsert({
                where: { customerId: row.customerId },
                update: {
                    points: points,
                    firstName: row.firstName,
                    lastName: row.lastName,
                    username: row.username,
                    telegramUserId: row.telegramUserId || null,
                    referrerId: row.referrerId || null,
                    expiryDate: expiryDate
                },
                create: {
                    customerId: row.customerId,
                    points: points,
                    firstName: row.firstName || '',
                    lastName: row.lastName || '',
                    username: row.username || '',
                    telegramUserId: row.telegramUserId || null,
                    referrerId: row.referrerId || null,
                    joinDate: joinDate,
                    expiryDate: expiryDate,
                    verificationCode: row.verificationCode || undefined
                }
            });
            
            successCount++;
            if (successCount % 50 === 0) process.stdout.write('.'); // โชว์จุดทุก 50 คน

        } catch (error) {
            console.error(`\n❌ Error [${row.customerId}]: ${error.message}`);
        }
    }

    console.log(`\n✅ นำเข้าลูกค้าเสร็จสิ้น: ${successCount} รายการ`);
    await prisma.$disconnect();
}

migrateCustomers().catch(e => console.error(e));