// src/handlers/admin.handlers.js (Final Version)

import { prisma } from '../db.js';
import { getAdminRole } from '../services/admin.service.js';
import { sendAdminReply } from '../services/notification.service.js'; 
import { listRewards, formatRewardsForAdmin } from '../services/reward.service.js';
import { isValidIdFormat } from '../utils/validation.utils.js'; 
import { generateUniqueCode } from '../utils/crypto.utils.js';
import { addDays } from '../utils/date.utils.js';
import { getActiveCampaign } from '../services/campaign.service.js';
import { getConfig } from '../config/config.js';
import { giveReferralBonus } from '../services/customer.service.js';

// ==================================================
// ⭐️ MAIN ROUTER: จัดการคำสั่งทั้งหมดของ Admin
// ==================================================
export async function handleAdminCommand(ctx) {
    const userTgId = String(ctx.from.id);
    const text = ctx.message.text || "";
    const role = await getAdminRole(userTgId);
    
    // แยกคำสั่งและ Argument (รองรับการเว้นวรรคหลายแบบ)
    const commandParts = text.trim().split(/\s+/);
    const command = commandParts[0].toLowerCase();
    
    const adminUser = ctx.from.username || ctx.from.first_name;
    const chatId = ctx.chat.id;

    // 1. ตรวจสอบสิทธิ์ (Gating)
    if (!role) {
        return sendAdminReply(chatId, "⛔️ คุณไม่มีสิทธิ์ใช้งานคำสั่งนี้");
    }

    // 2. ตรวจสอบสิทธิ์เฉพาะคำสั่ง /add (Super Admin Only)
    if (command === "/add" && role !== "SuperAdmin") {
        return sendAdminReply(chatId, "⛔️ คุณไม่มีสิทธิ์ใช้งานคำสั่ง /add");
    }

    // 3. Route คำสั่งไปยังฟังก์ชันที่เกี่ยวข้อง
    switch (command) {
        case "/new":
            await handleNewCustomer(ctx, commandParts, adminUser, chatId);
            break;

        case "/check":
            if (commandParts.length !== 2) {
                sendAdminReply(chatId, "❗️รูปแบบคำสั่งผิด\nต้องเป็น: /check [รหัสลูกค้า]");
            } else {
                const result = await checkCustomerInfo(commandParts[1]);
                sendAdminReply(chatId, result);
            }
            break;

        case "/reward":
            const rewards = await listRewards();
            const result = formatRewardsForAdmin(rewards);
            sendAdminReply(chatId, result);
            break;
            
        case "/start":
            const welcomeMsg = `👋 สวัสดี ${adminUser}!\nบอทสำหรับแอดมินพร้อมใช้งาน\n\n` +
            "<b>คำสั่งทั้งหมด:</b>\n" +
            `ℹ️ /check [รหัสลูกค้า]\n` +
            (role === "SuperAdmin" ? "🪙 /add [รหัสลูกค้า] [แต้ม]\n" : "") +
            "👤 /new [ลูกค้าใหม่] [ผู้แนะนำ]\n" +
            "🎁 /reward\n" +
            "✨ /redeem [รหัสลูกค้า] [รหัสรางวัล]";
            sendAdminReply(chatId, welcomeMsg);
            break;

        // TODO: เพิ่ม case "/redeem" และ "/add" ตามตรรกะที่คุณต้องการในอนาคต

        default:
            sendAdminReply(chatId, "⚠️ คำสั่งไม่ถูกต้อง หรือรูปแบบไม่สมบูรณ์");
            break;
    }
}

// ==================================================
// 🛠️ HELPER FUNCTIONS (ฟังก์ชันทำงานจริง)
// ==================================================

/**
 * Logic สำหรับสร้างลูกค้าใหม่ (/new)
 * - สร้างลูกค้าใน DB
 * - ให้แต้มผู้แนะนำ
 * - ส่งข้อความตอบกลับ 2 ส่วน (Admin Info + Customer Template)
 */
async function handleNewCustomer(ctx, commandParts, adminUser, chatId) {
    const newCustomerId = commandParts[1]?.toUpperCase();
    const referrerId = commandParts[2]?.toUpperCase() || null;
    const isReferrerSpecified = referrerId && referrerId !== 'N/A';

    // --- 1. Validation (ตรวจสอบความถูกต้อง) ---
    if (!newCustomerId) {
        return sendAdminReply(chatId, "❗️รูปแบบคำสั่งผิด\nต้องเป็น: /new [รหัสลูกค้าใหม่] [รหัสผู้แนะนำ (ถ้ามี)]");
    }
    if (!isValidIdFormat(newCustomerId)) {
        return sendAdminReply(chatId, `❌ รูปแบบรหัสลูกค้า '${newCustomerId}' ไม่ถูกต้อง (ต้องเป็น A-Z, 0-9)`);
    }
    
    // เช็คว่ามีลูกค้านี้อยู่แล้วหรือไม่
    const existing = await prisma.customer.findUnique({ where: { customerId: newCustomerId, isDeleted: false } });
    if (existing) {
        return sendAdminReply(chatId, `❌ รหัสลูกค้า '${newCustomerId}' นี้มีอยู่ในระบบแล้ว`);
    }

    // เช็คผู้แนะนำ (ถ้ามี)
    if (isReferrerSpecified) {
        const refUser = await prisma.customer.findUnique({ where: { customerId: referrerId, isDeleted: false } });
        if (!refUser) {
            return sendAdminReply(chatId, `❌ ไม่พบข้อมูลรหัสผู้แนะนำ '${referrerId}'`);
        }
        if (newCustomerId === referrerId) {
            return sendAdminReply(chatId, "❌ รหัสลูกค้าและผู้แนะนำต้องไม่เหมือนกัน");
        }
    }

    // --- 2. Prepare Data (เตรียมข้อมูล) ---
    const verificationCode = generateUniqueCode(4);
    const initialPoints = 0;
    // วันหมดอายุลูกค้าใหม่ = วันนี้ + 30 วัน (หรือตาม Config)
    const newExpiryDate = addDays(new Date(), getConfig('expiryDaysNewCustomer') || 30);

    // --- 3. Create Customer (บันทึกลง DB) ---
    await prisma.customer.create({
        data: {
            customerId: newCustomerId,
            referrerId: isReferrerSpecified ? referrerId : null,
            points: initialPoints,
            expiryDate: newExpiryDate,
            verificationCode: verificationCode,
            adminCreatedBy: adminUser,
        }
    });

    // --- 4. Give Referral Bonus (ให้แต้มผู้แนะนำ) ---
    if (isReferrerSpecified) {
        await giveReferralBonus(referrerId, newCustomerId, adminUser);
    }

    // --- 5. Prepare Messages (เตรียมข้อความตอบกลับ) ---
    const campaign = await getActiveCampaign();
    const linkBonus = campaign?.linkBonus || 50;
    const referralBonus = campaign?.base || 50;
    const botLink = getConfig('customerBotLink') || "https://t.me/ONEHUBCustomer_Bot";

    // ข้อความส่วนที่ 1: แจ้งแอดมินว่าสำเร็จ
    const adminMsg = `✅ สร้างลูกค้าใหม่ '${newCustomerId}' เรียบร้อยแล้ว\n\n` +
                     `👇 <b>กรุณาคัดลอกข้อความด้านล่างนี้ทั้งหมด แล้วส่งให้ลูกค้าได้เลยครับ</b> 👇`;

    // ข้อความส่วนที่ 2: Template สำหรับส่งให้ลูกค้า
    let promoText = "";
    if (campaign?.name && campaign?.name !== 'Standard') {
         promoText = `\n💌 <i>(แคมเปญพิเศษ ${campaign.name} | ปกติ 50 แต้ม)</i> 💌`;
    }

    const customerMsg = `🎉 ยินดีต้อนรับสู่การเป็นสมาชิกค่ะ!\n\n` +
        `นี่คือข้อมูลสำหรับใช้สะสมแต้มของคุณ:\n` +
        `----------------------------------\n` +
        `👤 <b>รหัสสมาชิก:</b> ${newCustomerId}\n` +
        `🔑 <b>รหัสยืนยัน (ใช้ครั้งเดียว):</b> ${verificationCode}\n` +
        `----------------------------------\n\n` +
        `<b>✨ รับสิทธิพิเศษทันที! ✨</b>\n` +
        `เพียงนำรหัสข้างต้นไปเชื่อมต่อกับบัญชี Telegram รับฟรี <b>${linkBonus} แต้ม</b>ไปเลย!\n\n` +
        `<b><u>ขั้นตอนการเชื่อมบัญชี:</u></b>\n` +
        `1️⃣ กดที่ลิงก์นี้เพื่อไปที่บอท: ${botLink}\n` +
        `2️⃣ พิมพ์คำสั่งตามนี้แล้วกดส่ง:\n` +
        `<code>/link ${newCustomerId} ${verificationCode}</code>\n\n` +
        `<b>💌 บอกต่อเพื่อนรับแต้มเพิ่ม!</b>\n` +
        `คุณสามารถใช้รหัสสมาชิก (<b>${newCustomerId}</b>) ของคุณเป็น "รหัสผู้แนะนำ" ให้เพื่อนได้ทันที เมื่อเพื่อนของคุณมียอดสั่งซื้อครั้งแรกเกิน 500 บาท ` +
        `คุณจะได้รับแต้มสะสมเพิ่มอีก <b>${referralBonus} แต้ม</b>ค่ะ!${promoText}`;

    // --- 6. Send Messages (ส่งแยก 2 ข้อความ) ---
    await sendAdminReply(chatId, adminMsg);
    await sendAdminReply(chatId, customerMsg);
}

/**
 * Logic สำหรับเช็คข้อมูลลูกค้า (/check)
 */
async function checkCustomerInfo(customerId) {
    const customer = await prisma.customer.findUnique({
        where: { customerId: customerId.toUpperCase(), isDeleted: false }
    });

    if (!customer) {
        return `🔍 ไม่พบข้อมูลลูกค้า ${customerId}`;
    }

    const formattedDate = customer.expiryDate.toLocaleDateString('th-TH');
    
    return `👤 <b>ข้อมูลลูกค้า: ${customer.customerId}</b>\n` +
           `🤝 ผู้แนะนำ: ${customer.referrerId || 'N/A'}\n` +
           `💰 แต้มคงเหลือ: ${customer.points}\n` +
           `🗓️ วันหมดอายุ: ${formattedDate}`;
}