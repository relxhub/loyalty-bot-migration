import fs from 'fs';
import readline from 'readline';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
    console.log("🌱 เริ่มต้น Seed ข้อมูล Master Data...");

    // 1. นำเข้า Rewards
    if (fs.existsSync('Rewards.csv')) {
        const fileStream = fs.createReadStream('Rewards.csv');
        const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });
        let isHeader = true;

        for await (const line of rl) {
            if (isHeader) { isHeader = false; continue; }
            // CSV Format: RewardID,RewardName,PointsCost
            // ใช้ regex เพื่อแยก comma ที่ไม่ได้อยู่ในเครื่องหมายคำพูด
            const cols = line.split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/);
            if (cols.length < 3) continue;

            const id = cols[0].trim();
            const name = cols[1].replace(/"/g, '').trim();
            const cost = parseInt(cols[2].trim()) || 0;

            await prisma.reward.upsert({
                where: { rewardId: id },
                update: { name, pointsCost: cost },
                create: { rewardId: id, name, pointsCost: cost }
            });
        }
        console.log("✅ นำเข้าของรางวัล (Rewards) เรียบร้อย");
    } else {
        console.warn("⚠️ ไม่พบไฟล์ Rewards.csv ข้ามการนำเข้าของรางวัล");
    }

    // 2. สร้าง Campaign (Hardcode แคมเปญปัจจุบันไว้ให้เลย เพื่อความชัวร์)
    // ข้อมูลจาก Campaigns.csv ค่อนข้างซับซ้อน เราสร้างตัวล่าสุดให้ระบบรันต่อได้เลยดีกว่า
    await prisma.campaign.upsert({
        where: { name: 'Nov 2025 Campaign' },
        update: {},
        create: {
            name: 'Nov 2025 Campaign',
            startDate: new Date('2025-11-01'),
            endDate: new Date('2025-11-30'),
            baseReferral: 100, // แต้มพื้นฐาน
            milestoneTarget: 5, // เป้าหมายโบนัส
            milestoneBonus: 50, // แต้มโบนัส
            linkBonus: 50,      // แต้มผูกบัญชี
            isActive: true
        }
    });
    console.log("✅ สร้างแคมเปญ (Campaign) เรียบร้อย");
}

main()
    .catch(e => console.error(e))
    .finally(async () => { await prisma.$disconnect(); });