// migrate_logs.js (Fixed Date Parsing & Auto-Clean)

import fs from 'fs';
import readline from 'readline';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/**
 * 📅 ฟังก์ชันแปลงวันที่แบบระบุ Format ชัดเจน
 * รองรับ: "27/11/2025", "27/11/2025 14:30:00" (Day/Month/Year)
 */
function parseDate(dateStr) {
    if (!dateStr) return new Date();

    const cleanStr = dateStr.replace(/"/g, '').trim();
    
    // ถ้าเป็น ISO Format (2025-11-27) ให้ใช้เลย
    if (cleanStr.includes('-')) {
        const d = new Date(cleanStr);
        return isNaN(d.getTime()) ? new Date() : d;
    }

    // ถ้าเป็น Slash Format (27/11/2025) จาก Google Sheet
    // แยก วันที่ กับ เวลา
    const [datePart, timePart] = cleanStr.split(' ');
    if (!datePart) return new Date();

    const parts = datePart.split('/');
    if (parts.length === 3) {
        // Google Sheet CSV: parts[0]=Day, parts[1]=Month, parts[2]=Year
        const day = parseInt(parts[0]);
        const month = parseInt(parts[1]) - 1; // JS Month เริ่มที่ 0
        const year = parseInt(parts[2]);
        
        let hour = 0, minute = 0, second = 0;
        if (timePart) {
            const timeParts = timePart.split(':');
            hour = parseInt(timeParts[0]) || 0;
            minute = parseInt(timeParts[1]) || 0;
            second = parseInt(timeParts[2]) || 0;
        }

        const d = new Date(year, month, day, hour, minute, second);
        // ปรับ Timezone ถ้าจำเป็น (ในที่นี้เราถือว่า CSV เป็นเวลาไทย)
        // แต่ Database เก็บ UTC: ถ้าต้องการเป๊ะๆ อาจต้องลบ 7 ชม. หรือปล่อยให้ Prisma จัดการ
        // เบื้องต้นส่งเป็น Local Time ของเครื่องรัน (ซึ่งถ้าคุณรันในไทย มันจะตรง)
        return isNaN(d.getTime()) ? new Date() : d;
    }

    return new Date(); // Fallback
}

function splitCsvLine(line) {
    return line.split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/).map(col => col.replace(/^"|"$/g, '').trim());
}

async function importAdminLogs() {
    const filePath = './admin_logs.csv';
    if (!fs.existsSync(filePath)) return;
    
    console.log(`🚀 กำลังนำเข้า Admin Logs...`);
    const fileStream = fs.createReadStream(filePath);
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

    let isHeader = true;
    let count = 0;

    for await (const line of rl) {
        if (isHeader) { isHeader = false; continue; }
        const cols = splitCsvLine(line);
        if (cols.length < 2) continue;

        try {
            await prisma.adminLog.create({
                data: {
                    createdAt: parseDate(cols[0]), // ใช้วันที่ที่แปลงแล้ว
                    admin: cols[1] || 'System',
                    action: cols[2] || 'UNKNOWN',
                    customerId: cols[3] || null,
                    pointsChange: parseInt(cols[4]) || 0,
                    details: cols[5] || ''
                }
            });
            process.stdout.write(`\r✅ Admin Log: ${++count}`);
        } catch (e) { }
    }
    console.log(`\n✨ Admin Logs เสร็จสิ้น: ${count} รายการ`);
}

async function importCustomerLogs() {
    const filePath = './customer_logs.csv';
    if (!fs.existsSync(filePath)) return;

    console.log(`🚀 กำลังนำเข้า Customer Logs...`);
    const fileStream = fs.createReadStream(filePath);
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

    let isHeader = true;
    let count = 0;

    for await (const line of rl) {
        if (isHeader) { isHeader = false; continue; }
        const cols = splitCsvLine(line);
        if (cols.length < 2) continue;

        try {
            await prisma.customerLog.create({
                data: {
                    createdAt: parseDate(cols[0]), // ใช้วันที่ที่แปลงแล้ว
                    telegramUserId: cols[1] || 'Unknown',
                    customerId: cols[2] || null,
                    action: cols[3] || 'UNKNOWN',
                    pointsChange: parseInt(cols[4]) || 0
                }
            });
            process.stdout.write(`\r✅ Customer Log: ${++count}`);
        } catch (e) { }
    }
    console.log(`\n✨ Customer Logs เสร็จสิ้น: ${count} รายการ`);
}

async function main() {
    console.log('⚠️ กำลังล้างข้อมูล Logs เก่าที่ผิดพลาด...');
    await prisma.adminLog.deleteMany({});
    await prisma.customerLog.deleteMany({});
    console.log('✅ ล้างข้อมูลเรียบร้อย เริ่มนำเข้าใหม่...');

    await importAdminLogs();
    await importCustomerLogs();
    console.log('\n🎉 MIGRATION COMPLETED 🎉');
}

main()
    .catch(e => console.error(e))
    .finally(async () => { await prisma.$disconnect(); });