import fs from 'fs';
import readline from 'readline';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// ฟังก์ชันแปลงวันที่จาก DD/MM/YYYY เป็น Date Object มาตรฐาน
function parseDate(dateStr) {
    if (!dateStr) return new Date(); // ถ้าไม่มี ใช้วันนี้
    
    // ลบเวลาออกถ้ามี (เช่น 30/11/2025 12:00:00 -> 30/11/2025)
    const cleanDateStr = dateStr.split(' ')[0]; 

    // กรณีรูปแบบ 2025-11-30 (ISO)
    if (cleanDateStr.includes('-')) return new Date(cleanDateStr);

    // กรณีรูปแบบ 30/11/2025 (Thai Format)
    const parts = cleanDateStr.split('/');
    if (parts.length === 3) {
        // parts[0]=Day, parts[1]=Month, parts[2]=Year
        return new Date(`${parts[2]}-${parts[1]}-${parts[0]}`);
    }

    return new Date(); // กันเหนียว
}

async function main() {
    console.log("🚀 เริ่มต้นการย้ายข้อมูลลูกค้า...");

    const fileStream = fs.createReadStream('CustomerData.csv');
    const rl = readline.createInterface({
        input: fileStream,
        crlfDelay: Infinity
    });

    let isHeader = true;
    let count = 0;
    let errorCount = 0;

    for await (const line of rl) {
        if (isHeader) { isHeader = false; continue; } // ข้ามหัวตาราง

        // แยกคอมม่า (ระวังกรณีข้อมูลมีคอมม่าในเนื้อหา)
        const cols = line.split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/);
        
        // Map ตามลำดับคอลัมน์ใน Google Sheet ของคุณ
        // A=0, B=1, C=2, D=3, E=4, F=5, G=6, H=7, I=8
        const customerId = cols[0]?.replace(/"/g, '').trim();
        
        if (!customerId) continue;

        // Clean Referrer (เปลี่ยน N/A เป็น null)
        let referrerId = cols[1]?.replace(/"/g, '').trim();
        if (referrerId === 'N/A' || referrerId === '') referrerId = null;

        // Clean Points
        const points = parseInt(cols[2]?.replace(/"/g, '').trim()) || 0;

        // Clean Date
        const expiryDate = parseDate(cols[3]?.replace(/"/g, '').trim());

        // Clean Telegram ID
        let telegramUserId = cols[4]?.replace(/"/g, '').trim();
        if (telegramUserId === '' || telegramUserId === '-') telegramUserId = null;

        // Clean Verification Code
        let verificationCode = cols[5]?.replace(/"/g, '').trim();
        if (verificationCode === '') verificationCode = null;

        const adminCreatedBy = cols[6]?.replace(/"/g, '').trim() || 'Migration';
        const referralCount = parseInt(cols[7]?.replace(/"/g, '').trim()) || 0;
        const activeCampaignTag = cols[8]?.replace(/"/g, '').trim() || null;

        try {
            await prisma.customer.upsert({
                where: { customerId: customerId },
                update: {
                    points,
                    expiryDate,
                    telegramUserId,
                    referralCount,
                    activeCampaignTag
                },
                create: {
                    customerId,
                    referrerId,
                    points,
                    expiryDate,
                    telegramUserId,
                    verificationCode,
                    adminCreatedBy,
                    referralCount,
                    activeCampaignTag,
                    isDeleted: false
                }
            });
            process.stdout.write(`\r✅ Imported: ${++count} (${customerId})`);
        } catch (e) {
            console.error(`\n❌ Error Customer ${customerId}: ${e.message}`);
            errorCount++;
        }
    }

    console.log(`\n\n🎉 เสร็จสิ้น! นำเข้าสำเร็จ ${count} รายการ (ผิดพลาด ${errorCount})`);
}

main()
    .catch(e => console.error(e))
    .finally(async () => {
        await prisma.$disconnect();
    });