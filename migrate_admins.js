// migrate_admins.js
import fs from 'fs';
import readline from 'readline';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function migrateAdmins() {
    console.log("👮 เริ่มต้นการย้ายข้อมูล Admin...");

    const filePath = 'admins.csv';
    if (!fs.existsSync(filePath)) {
        console.error("❌ ไม่พบไฟล์ admins.csv กรุณาสร้างไฟล์และใส่ข้อมูลก่อนครับ");
        console.log("📝 ตัวอย่าง Format: TelegramID,Name,Role");
        return;
    }

    const fileStream = fs.createReadStream(filePath);
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

    let isHeader = true;
    let count = 0;

    for await (const line of rl) {
        if (isHeader) { isHeader = false; continue; } // ข้ามบรรทัดหัวข้อ

        // CSV Format: TelegramID, Name, Role
        // ใช้ Regex เพื่อแยกคอมม่า โดยไม่สนคอมม่าที่อยู่ในเครื่องหมายคำพูด
        const cols = line.split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/);
        
        const telegramId = cols[0]?.replace(/"/g, '').trim();
        const name = cols[1]?.replace(/"/g, '').trim() || 'Unknown Admin';
        let roleStr = cols[2]?.replace(/"/g, '').trim();

        if (!telegramId) continue;

        // แปลง Role ให้ตรงกับ Enum ใน Prisma (SuperAdmin / Admin)
        // ถ้าไม่ระบุ หรือระบุผิด จะให้เป็น Admin ธรรมดา
        let role = 'Admin';
        if (roleStr && roleStr.toLowerCase().includes('super')) {
            role = 'SuperAdmin';
        }

        try {
            await prisma.admin.upsert({
                where: { telegramId: telegramId },
                update: {
                    name: name,
                    role: role
                },
                create: {
                    telegramId: telegramId,
                    name: name,
                    role: role
                }
            });
            process.stdout.write(`\r✅ Imported: ${telegramId} (${role})`);
            count++;
        } catch (e) {
            console.error(`\n❌ Error [${telegramId}]: ${e.message}`);
        }
    }

    console.log(`\n\n🎉 นำเข้า Admin เสร็จสิ้น: ${count} รายการ`);
}

migrateAdmins()
    .catch(e => console.error(e))
    .finally(async () => {
        await prisma.$disconnect();
    });