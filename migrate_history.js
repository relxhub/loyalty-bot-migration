import fs from 'fs';
import readline from 'readline';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// ฟังก์ชันแปลงวันที่ให้รองรับ format ใน CSV ของคุณ
function parseDate(dateStr) {
    if (!dateStr) return new Date();
    const cleanStr = dateStr.replace(/"/g, '').trim();
    
    // แบบที่มี Slash: "5/9/2025, 14:32:15"
    if (cleanStr.includes('/')) {
        const [dPart, tPart] = cleanStr.split(', ');
        if (!dPart) return new Date();
        
        const [day, month, year] = dPart.split('/').map(Number);
        const [hour, min, sec] = tPart ? tPart.split(':').map(Number) : [0, 0, 0];
        
        // สร้าง Date object (Note: Month ใน JS เริ่มที่ 0)
        return new Date(year, month - 1, day, hour, min, sec);
    }
    
    // เผื่อกรณี format อื่น
    return new Date(cleanStr);
}

async function main() {
    console.log("🚀 เริ่มต้นการย้ายประวัติ (History Migration)...");

    // ---------------------------------------------------------
    // 1. ประวัติการแนะนำเพื่อน (จาก ProcessedReferrals.csv)
    // ---------------------------------------------------------
    if (fs.existsSync('ProcessedReferrals.csv')) {
        console.log("👥 กำลังนำเข้าประวัติการแนะนำเพื่อน...");
        const rs = fs.createReadStream('ProcessedReferrals.csv');
        const rl = readline.createInterface({ input: rs, crlfDelay: Infinity });
        let isHeader = true;
        let count = 0;

        for await (const line of rl) {
            if (isHeader) { isHeader = false; continue; }
            // Format: Date,Invitee_ID,Admin_Closer,Inviter_ID,Admin_Recommender
            const cols = line.split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/);
            const timestamp = parseDate(cols[0]);
            const inviteeId = cols[1]?.trim();
            const inviterId = cols[3]?.trim();

            if (inviterId && inviterId !== 'N/A') {
                try {
                    await prisma.pointTransaction.create({
                        data: {
                            customerId: inviterId,
                            amount: 100, // สมมติ 100 แต้มตามแคมเปญ
                            type: 'REFERRAL_BONUS',
                            relatedId: inviteeId,
                            detail: `แนะนำเพื่อนสำเร็จ: ${inviteeId}`,
                            createdAt: timestamp
                        }
                    });
                    count++;
                } catch (e) { 
                    // อาจ error ถ้าไม่มีลูกค้าคนนี้ในระบบใหม่ (ข้ามไป)
                }
            }
        }
        console.log(`   -> เพิ่มประวัติแนะนำเพื่อน ${count} รายการ`);
    }

    // ---------------------------------------------------------
    // 2. ประวัติการผูกบัญชี (จาก CustomerLogs.csv)
    // ---------------------------------------------------------
    if (fs.existsSync('CustomerLogs.csv')) {
        console.log("🎁 กำลังนำเข้าประวัติ Customer Logs...");
        const rs = fs.createReadStream('CustomerLogs.csv');
        const rl = readline.createInterface({ input: rs, crlfDelay: Infinity });
        let isHeader = true;
        let count = 0;

        for await (const line of rl) {
            if (isHeader) { isHeader = false; continue; }
            // Format: Timestamp,TelegramUserID,CustomerID,Action,PointsChange...
            const cols = line.split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/);
            const timestamp = parseDate(cols[0]);
            const customerId = cols[2]?.trim();
            const action = cols[3]?.trim();
            
            // หาแต้มถ้ามี
            let points = 0;
            if (cols[4]) points = parseInt(cols[4].replace(/"/g, '')) || 0;

            if (customerId && customerId !== '-' && action === 'LINK_BONUS') {
                try {
                    await prisma.pointTransaction.create({
                        data: {
                            customerId,
                            amount: points || 50, // Default 50 ถ้าไม่มีระบุ
                            type: 'LINK_BONUS',
                            detail: 'รับโบนัสผูกบัญชี',
                            createdAt: timestamp
                        }
                    });
                    count++;
                } catch (e) {}
            }
        }
        console.log(`   -> เพิ่มประวัติ Link Bonus ${count} รายการ`);
    }

    // ---------------------------------------------------------
    // 3. ประวัติ Admin & การแลกของ (จาก Logs.csv)
    // ---------------------------------------------------------
    if (fs.existsSync('Logs.csv')) {
        console.log("👮 กำลังนำเข้า Admin Logs & Redemptions...");
        const rs = fs.createReadStream('Logs.csv');
        const rl = readline.createInterface({ input: rs, crlfDelay: Infinity });
        let isHeader = true;
        let countAudit = 0;
        let countTrans = 0;

        for await (const line of rl) {
            if (isHeader) { isHeader = false; continue; }
            // Format: Timestamp,Admin,Action,CustomerID,PointsChange,Details
            const cols = line.split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/);
            const timestamp = parseDate(cols[0]);
            const adminName = cols[1]?.trim();
            const action = cols[2]?.trim();
            const targetId = cols[3]?.trim();
            const pointsChange = parseInt(cols[4]?.trim()) || 0;
            const details = cols[5]?.replace(/"/g, '').trim();

            try {
                // 3.1 บันทึกลง AdminAuditLog (เก็บไว้ตรวจสอบแอดมิน)
                await prisma.adminAuditLog.create({
                    data: {
                        adminName: adminName,
                        action: action,
                        targetId: (targetId && targetId !== 'N/A') ? targetId : null,
                        details: `Points: ${pointsChange}, Info: ${details}`,
                        createdAt: timestamp
                    }
                });
                countAudit++;

                // 3.2 ถ้ามีการเปลี่ยนแต้ม -> สร้าง PointTransaction ให้ลูกค้าด้วย
                // รองรับทั้ง ADD_POINTS (เพิ่มแต้ม) และ REDEEM_POINTS (แลกของ/ตัดแต้ม)
                if (pointsChange !== 0 && targetId && targetId !== 'N/A') {
                    let type = 'ADMIN_ADJUST';
                    let detailMsg = `แก้ไขโดย Admin (${adminName})`;

                    if (action === 'REDEEM_POINTS') {
                        type = 'REDEEM_REWARD';
                        detailMsg = details || 'แลกของรางวัล';
                    }

                    await prisma.pointTransaction.create({
                        data: {
                            customerId: targetId,
                            amount: pointsChange,
                            type: type,
                            detail: detailMsg,
                            createdAt: timestamp
                        }
                    });
                    countTrans++;
                }
            } catch (e) { /* ข้าม Error เช่น หา user ไม่เจอ */ }
        }
        console.log(`   -> เพิ่ม Admin Audit ${countAudit} รายการ`);
        console.log(`   -> เพิ่ม Transaction จาก Admin ${countTrans} รายการ`);
    }

    console.log("✅ ย้ายประวัติทั้งหมดเสร็จสิ้น!");
}

main()
    .catch(e => console.error(e))
    .finally(async () => { await prisma.$disconnect(); });