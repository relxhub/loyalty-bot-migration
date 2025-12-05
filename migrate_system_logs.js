// migrate_system_logs.js (ฉบับเก็บแยก Column)
import fs from 'fs';
import readline from 'readline';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

function parseDate(dateStr) {
    if (!dateStr) return new Date();
    const cleanStr = dateStr.replace(/"/g, '').trim();
    if (cleanStr.includes('/')) {
        const [dPart, tPart] = cleanStr.split(', ');
        if (!dPart) return new Date();
        const [day, month, year] = dPart.split('/').map(Number);
        const [hour, min, sec] = tPart ? tPart.split(':').map(Number) : [0, 0, 0];
        return new Date(year, month - 1, day, hour, min, sec);
    }
    return new Date(cleanStr);
}

async function migrateSystemLogs() {
    console.log("🤖 เริ่มต้นการย้าย System Logs (แบบแยก Column)...");

    const filePath = 'Logs.csv';
    if (!fs.existsSync(filePath)) {
        console.error("❌ ไม่พบไฟล์ Logs.csv");
        return;
    }

    const fileStream = fs.createReadStream(filePath);
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

    let isHeader = true;
    let count = 0;

    for await (const line of rl) {
        if (isHeader) { isHeader = false; continue; }

        const cols = line.split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/);
        
        const timestamp = parseDate(cols[0]);
        const adminName = cols[1]?.replace(/"/g, '').trim();
        const action = cols[2]?.replace(/"/g, '').trim();
        const customerId = cols[3]?.replace(/"/g, '').trim();
        const pointsStr = cols[4]?.replace(/"/g, '').trim();
        const details = cols[5]?.replace(/"/g, '').trim();

        if (adminName === 'System (Auto)') {
            try {
                // แปลงแต้มเป็นตัวเลข (ถ้าไม่มีให้เป็น 0 หรือ null)
                const pointsVal = pointsStr && pointsStr !== '' ? parseInt(pointsStr) : 0;
                
                // User ID ถ้าเป็น N/A ให้เป็น null
                const userIdVal = (customerId && customerId !== 'N/A') ? customerId : null;

                await prisma.systemLog.create({
                    data: {
                        level: 'INFO',
                        source: 'LEGACY_AUTO',
                        
                        // ✅ ใส่ข้อมูลลงช่องใครช่องมัน
                        action: action,
                        customerId: userIdVal,
                        points: pointsVal,
                        
                        // message เก็บรายละเอียดส่วนที่เหลือ
                        message: details || `System Action: ${action}`,
                        
                        createdAt: timestamp
                    }
                });
                
                process.stdout.write(".");
                count++;
            } catch (e) {
                console.error(`\n❌ Error: ${e.message}`);
            }
        }
    }

    console.log(`\n\n✅ ย้ายข้อมูล System Logs สำเร็จ: ${count} รายการ`);
}

migrateSystemLogs()
    .catch(e => console.error(e))
    .finally(async () => await prisma.$disconnect());