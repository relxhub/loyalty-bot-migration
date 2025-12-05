// migrate_rewards.js
import fs from 'fs';
import csv from 'csv-parser';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function migrateRewards() {
    console.log('🎁 เริ่มต้นการย้ายของรางวัล...');
    
    const filePath = './Rewards.csv';
    if (!fs.existsSync(filePath)) {
        console.error(`❌ ไม่พบไฟล์ ${filePath}`);
        return;
    }

    const rewards = [];
    
    // อ่านไฟล์ CSV
    fs.createReadStream(filePath)
        .pipe(csv({
            // ฟังก์ชันช่วยลบอักขระพิเศษ (BOM) ที่อาจติดมาหน้าชื่อคอลัมน์แรก
            mapHeaders: ({ header }) => header.trim().replace(/^\ufeff/, '')
        }))
        .on('data', (data) => rewards.push(data))
        .on('end', async () => {
            console.log(`📄 พบข้อมูลดิบ ${rewards.length} รายการ`);

            // Debug: ปริ้นท์ตัวอย่างแถวแรกดูว่าอ่าน Key ได้ถูกต้องไหม
            if (rewards.length > 0) {
                console.log('👀 ตัวอย่างข้อมูลที่อ่านได้:', rewards[0]);
            }
            
            let success = 0;

            for (const row of rewards) {
                try {
                    // ✅ แก้ไข: ดึงข้อมูลตามชื่อคอลัมน์ใน CSV (RewardID, RewardName, PointsCost)
                    const rId = row['RewardID']; 
                    const rName = row['RewardName'];
                    const rCost = parseInt(row['PointsCost']) || 0;

                    // ถ้าไม่มี ID ให้ข้าม
                    if (!rId) {
                        console.warn('⚠️ ข้ามแถวที่ไม่มี RewardID:', row);
                        continue;
                    }

                    await prisma.reward.upsert({
                        where: { rewardId: rId },
                        update: {
                            name: rName,
                            pointsCost: rCost,
                            description: `ส่วนลดมูลค่า ${rCost} บาท`, // สร้างคำอธิบายอัตโนมัติ
                            isActive: true
                        },
                        create: {
                            rewardId: rId,
                            name: rName,
                            pointsCost: rCost,
                            description: `ส่วนลดมูลค่า ${rCost} บาท`,
                            isActive: true
                        }
                    });
                    
                    success++;
                    process.stdout.write('.'); // แสดงจุดความคืบหน้า

                } catch (e) {
                    console.error(`\n❌ Error [${row['RewardID']}]:`, e.message);
                }
            }
            console.log(`\n✅ นำเข้าของรางวัลเสร็จสิ้น! (${success} รายการ)`);
            await prisma.$disconnect();
        });
}

migrateRewards().catch(e => console.error(e));