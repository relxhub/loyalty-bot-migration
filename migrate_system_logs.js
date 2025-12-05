// migrate_system_logs.js (ฉบับแก้ไข: รองรับวันที่แบบมีคอมม่า)
import fs from 'fs';
import readline from 'readline';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

function parseDate(dateStr) {
    if (!dateStr) return new Date(); // ถ้าไม่มีค่า ใช้วันนี้

    // 1. ล้าง String: ลบ " และ , ออกให้หมด เพื่อแก้ปัญหา "2025," กลายเป็น NaN
    const cleanStr = dateStr.replace(/["|,]/g, '').trim(); 
    // ตัวอย่าง: "5/9/2025, 14:32:16" -> "5/9/2025 14:32:16"

    // 2. กรณี ISO Format (2025-12-05)
    if (cleanStr.includes('-')) {
        const d = new Date(cleanStr);
        return isNaN(d.getTime()) ? new Date() : d;
    }

    // 3. กรณี Slash Format (05/12/2025)
    if (cleanStr.includes('/')) {
        // แยกวันที่กับเวลาด้วยช่องว่าง
        const parts = cleanStr.split(/\s+/); 
        const datePart = parts[0];
        const timePart = parts[1];

        if (datePart) {
            // ใช้ map(Number) อาจพังถ้ามีคอมม่าติด แต่เราลบไปแล้วในขั้นตอนที่ 1
            const [day, month, year] = datePart.split('/').map(Number);
            
            let hour = 0, min = 0, sec = 0;
            if (timePart) {
                const t = timePart.split(':').map(Number);
                hour = t[0] || 0;
                min = t[1] || 0;
                sec = t[2] || 0;
            }

            // สร้างวันที่ (ระวัง: Month ใน JS เริ่มที่ 0)
            const d = new Date(year, month - 1, day, hour, min, sec);
            
            // เช็คว่าวันที่ถูกต้องไหม ถ้าไม่ถูก (Invalid Date) ให้ใช้วันนี้แทน
            if (!isNaN(d.getTime())) return d;
        }
    }

    // 4. กรณีแปลงไม่ได้จริงๆ ให้ใช้วันปัจจุบัน (เพื่อไม่ให้ Script Error)
    return new Date();
}

async function migrateSystemLogs() {
    console.log("🤖 เริ่มต้นการย้าย System Logs (แบบละเอียด & แก้ไขวันที่)...");

    const filePath = 'Logs.csv';
    if (!fs.existsSync(filePath)) {
        console.error("❌ ไม่พบไฟล์ Logs.csv");
        return;
    }

    // ล้างข้อมูลเก่าก่อนเริ่ม (เพื่อให้ข้อมูลไม่ซ้ำซ้อน)
    console.log("🧹 ล้างข้อมูล SystemLog เก่าทิ้งก่อน...");
    try {
        await prisma.systemLog.deleteMany({
            where: { source: 'LEGACY_AUTO' } 
        });
    } catch (e) {
        console.warn("⚠️ ลบข้อมูลเก่าไม่สำเร็จ (อาจยังไม่มีตาราง):", e.message);
    }

    const fileStream = fs.createReadStream(filePath);
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

    let isHeader = true;
    let count = 0;
    let errorCount = 0;

    for await (const line of rl) {
        if (isHeader) { isHeader = false; continue; }

        // CSV Format: Timestamp,Admin,Action,CustomerID,PointsChange,Details
        // ใช้ Regex แยก comma ที่ไม่ได้อยู่ใน quote
        const cols = line.split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/);
        
        // ดึงค่าและลบ quote ทิ้ง
        const timestamp = parseDate(cols[0]);
        const adminName = cols[1]?.replace(/"/g, '').trim();
        const action = cols[2]?.replace(/"/g, '').trim();
        const customerId = cols[3]?.replace(/"/g, '').trim();
        const pointsStr = cols[4]?.replace(/"/g, '').trim();
        const details = cols[5]?.replace(/"/g, '').trim();

        // ✅ กรองเฉพาะ System (Auto) เท่านั้น
        if (adminName === 'System (Auto)') {
            try {
                // แปลงค่าแต้ม
                const pointsVal = pointsStr && pointsStr !== '' ? parseInt(pointsStr) : 0;
                // แปลง Customer ID (ถ้าเป็น N/A ให้เป็น null)
                const userIdVal = (customerId && customerId !== 'N/A') ? customerId : null;

                await prisma.systemLog.create({
                    data: {
                        level: 'INFO',
                        source: 'LEGACY_AUTO', // ระบุแหล่งที่มา
                        
                        // ใส่ข้อมูลลงช่องใหม่
                        action: action,
                        customerId: userIdVal,
                        points: pointsVal,
                        
                        // ใส่รายละเอียดรวมไว้ใน message
                        message: details || `System Action: ${action}`,
                        
                        createdAt: timestamp
                    }
                });
                
                process.stdout.write(".");
                count++;
            } catch (e) {
                // ถ้า Error ให้ข้ามแถวนี้ไปเลย ไม่ต้องหยุดโปรแกรม
                // console.error(`\n❌ Error Row: ${e.message}`);
                errorCount++;
            }
        }
    }

    console.log(`\n\n✅ ย้ายข้อมูล System (Auto) เสร็จสิ้น: ${count} รายการ`);
    if (errorCount > 0) console.log(`⚠️ มีรายการที่ข้ามไปจำนวน: ${errorCount} รายการ (เนื่องจากข้อมูลไม่สมบูรณ์)`);
}

migrateSystemLogs()
    .catch(e => console.error(e))
    .finally(async () => {
        await prisma.$disconnect();
    });