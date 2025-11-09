// src/handlers/admin.handlers.js

import { prisma } from '../db.js';
import { getActiveCampaign } from '../services/campaign.service.js';
import { sendAdminReply, sendAlertToSuperAdmin } from '../services/notification.service.js';
import { giveReferralBonus } from '../services/customer.service.js'; // ต้องสร้าง function นี้
import { addDays } from '../utils/date.utils.js';
import { generateUniqueCode } from '../utils/crypto.utils.js'; // สมมติว่ามี function นี้
import { isValidIdFormat } from '../utils/validation.utils.js'; // สมมติว่ามี function นี้

// ⭐️ ฟังก์ชันหลักที่รันตรรกะการสร้างลูกค้าใหม่ (แทนที่ Placeholder)
export async function handleNewCustomer(ctx, commandParts) {
    
    const newCustomerId = commandParts[1]?.toUpperCase();
    const referrerId = commandParts[2]?.toUpperCase() || null;
    const adminUser = ctx.from.username || ctx.from.first_name;
    const chatId = ctx.chat.id;

    // --- 1. ตรวจสอบความถูกต้อง (Validations) ---
    if (!newCustomerId || commandParts.length > 3) {
        return ctx.reply("❗️รูปแบบคำสั่งผิด\nต้องเป็น: /new [รหัสลูกค้าใหม่] [รหัสผู้แนะนำ (ถ้ามี)]");
    }
    
    if (!isValidIdFormat(newCustomerId)) {
        return ctx.reply(`❌ รูปแบบรหัสลูกค้าไม่ถูกต้อง (ต้องเป็น A-Z และ 0-9)`);
    }

    const customerExists = await prisma.customer.findUnique({ 
        where: { customerId: newCustomerId, isDeleted: false } 
    });
    if (customerExists) {
        return ctx.reply(`❌ รหัสลูกค้า '${newCustomerId}' มีอยู่ในระบบแล้ว`);
    }

    if (referrerId && referrerId !== 'N/A') {
        const referrerExists = await prisma.customer.findUnique({ 
            where: { customerId: referrerId, isDeleted: false } 
        });
        if (!referrerExists) {
            return ctx.reply(`❌ ไม่พบข้อมูลรหัสผู้แนะนำ '${referrerId}' ในระบบ`);
        }
        if (newCustomerId === referrerId) {
            return ctx.reply("❌ รหัสลูกค้าและรหัสผู้แนะนำไม่สามารถเป็นรหัสเดียวกันได้");
        }
    }
    // ----------------------------------------

    // --- 2. สร้างข้อมูลพื้นฐานและบันทึก Customer ใน DB ---
    const verificationCode = generateUniqueCode(4); // 4 หลัก
    const initialPoints = 0; 
    const newExpiryDate = addDays(new Date(), 30); // 30 วัน

    await prisma.customer.create({
        data: {
            customerId: newCustomerId,
            referrerId: referrerId,
            points: initialPoints,
            expiryDate: newExpiryDate,
            verificationCode: verificationCode,
            adminCreatedBy: adminUser,
        }
    });

    // --- 3. เรียก giveReferralBonus (ถ้ามี) ---
    if (referrerId && referrerId !== 'N/A') {
        await giveReferralBonus(referrerId, newCustomerId, adminUser); 
    }
    
    // 4. สร้างข้อความ Dynamic และ 5. ส่งข้อความต้อนรับ
    const campaign = await getActiveCampaign();
    const linkBonusPoints = campaign?.linkBonus || 50; 
    const referralBonusPoints = campaign?.base || 50;
    const customerBotLink = "https://t.me/ONEHUBCustomer_Bot"; // ⚠️ ควรดึงจาก SystemConfig ⚠️

    // ... (ละเว้นตรรกะสร้างข้อความ HTML ที่ซับซ้อน แต่หลักการคือการประกอบ String)
    const customerMessage = `🎉 ยินดีต้อนรับสู่การเป็นสมาชิกค่ะ!\n\n` +
      `👤 <b>รหัสสมาชิก:</b> ${newCustomerId}\n` +
      `🔑 <b>รหัสยืนยัน:</b> ${verificationCode}\n\n` +
      `กดลิงก์: ${customerBotLink}\n` +
      `พิมพ์คำสั่ง: <code>/link ${newCustomerId} ${verificationCode}</code>`;

    // ส่งข้อความให้แอดมินยืนยัน
    ctx.reply(`✅ สร้างลูกค้าใหม่ '${newCustomerId}' เรียบร้อยแล้ว`);
    
    // ส่งข้อความต้อนรับ
    // ⚠️ Note: ในระบบจริง คุณจะใช้ notification.service.js ส่งข้อความนี้
    ctx.telegram.sendMessage(chatId, customerMessage, { parse_mode: 'HTML' });
}