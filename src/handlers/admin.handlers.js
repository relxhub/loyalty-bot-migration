// src/handlers/admin.handlers.js (ฉบับสมบูรณ์ - Logic จริง)

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

// ⭐️ ฟังก์ชันหลัก: Router คำสั่ง Admin
export async function handleAdminCommand(ctx) {
    const userTgId = String(ctx.from.id);
    const text = ctx.message.text || "";
    const role = await getAdminRole(userTgId);
    
    // แยกคำสั่งและ Argument (รองรับการเว้นวรรคหลายแบบ)
    const commandParts = text.trim().split(/\s+/);
    const command = commandParts[0].toLowerCase();
    
    const adminUser = ctx.from.username || ctx.from.first_name;
    const chatId = ctx.chat.id;

    // 1. ตรวจสอบ Gating
    if (!role) {
        return sendAdminReply(chatId, "⛔️ คุณไม่มีสิทธิ์ใช้งานคำสั่งนี้");
    }

    if (command === "/add" && role !== "SuperAdmin") {
        return sendAdminReply(chatId, "⛔️ คุณไม่มีสิทธิ์ใช้งานคำสั่ง /add");
    }

    // ==================================================
    // ⚡️ LOGIC HANDLERS (ตรรกะจริง)
    // ==================================================

    switch (command) {
        // --------------------------------------------------
        // 🆕 COMMAND: /new [ลูกค้า] [ผู้แนะนำ]
        // --------------------------------------------------
        case "/new":
            await handleNewCustomer(ctx, commandParts, adminUser, chatId);
            break;

        // --------------------------------------------------
        // 🔍 COMMAND: /check [ลูกค้า]
        // --------------------------------------------------
        case "/check":
            if (commandParts.length !== 2) {
                sendAdminReply(chatId, "❗️รูปแบบคำสั่งผิด\nต้องเป็น: /check [รหัสลูกค้า]");
            } else {
                const result = await checkCustomerInfo(commandParts[1]);
                sendAdminReply(chatId, result);
            }
            break;

        // --------------------------------------------------
        // 🎁 COMMAND: /reward
        // --------------------------------------------------
        case "/reward":
            const rewards = await listRewards();
            const result = formatRewardsForAdmin(rewards);
            sendAdminReply(chatId, result);
            break;
            
        // --------------------------------------------------
        // 👋 COMMAND: /start
        // --------------------------------------------------
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

        default:
            sendAdminReply(chatId, "⚠️ คำสั่งไม่ถูกต้อง หรือรูปแบบไม่สมบูรณ์");
            break;
    }
}

// ==================================================
// 🛠️ HELPER FUNCTIONS (ฟังก์ชันช่วยทำงาน)
// ==================================================

/**
 * Logic สำหรับสร้างลูกค้าใหม่ (/new)
 */
async function handleNewCustomer(ctx, commandParts, adminUser, chatId) {
    const newCustomerId = commandParts[1]?.toUpperCase();
    const referrerId = commandParts[2]?.toUpperCase() || null;
    const isReferrerSpecified = referrerId && referrerId !== 'N/A';

    // 1. Validation
    if (!newCustomerId) {
        return sendAdminReply(chatId, "❗️รูปแบบคำสั่งผิด\nต้องเป็น: /new [รหัสลูกค้าใหม่] [รหัสผู้แนะนำ (ถ้ามี)]");
    }
    if (!isValidIdFormat(newCustomerId)) {
        return sendAdminReply(chatId, `❌ รูปแบบรหัสลูกค้า '${newCustomerId}' ไม่ถูกต้อง (A-Z, 0-9)`);
    }
    
    // เช็คซ้ำใน DB
    const existing = await prisma.customer.findUnique({ where: { customerId: newCustomerId, isDeleted: false } });
    if (existing) {
        return sendAdminReply(chatId, `❌ รหัสลูกค้า '${newCustomerId}' นี้มีอยู่ในระบบแล้ว`);
    }

    // เช็คผู้แนะนำ
    if (isReferrerSpecified) {
        const refUser = await prisma.customer.findUnique({ where: { customerId: referrerId, isDeleted: false } });
        if (!refUser) {
            return sendAdminReply(chatId, `❌ ไม่พบข้อมูลรหัสผู้แนะนำ '${referrerId}'`);
        }
        if (newCustomerId === referrerId) {
            return sendAdminReply(chatId, "❌ รหัสลูกค้าและผู้แนะนำต้องไม่เหมือนกัน");
        }
    }

    // 2. Prepare Data
    const verificationCode = generateUniqueCode(4);
    const initialPoints = 0;
    const newExpiryDate = addDays(new Date(), getConfig('expiryDaysNewCustomer') || 30);

    // 3. Create Customer
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

    // 4. Give Referral Bonus (ถ้ามีผู้แนะนำ)
    if (isReferrerSpecified) {
        await giveReferralBonus(referrerId, newCustomerId, adminUser);
    }

    // 5. Prepare Response Message
    const campaign = await getActiveCampaign();
    const linkBonus = campaign?.linkBonus || 50;
    const botLink = getConfig('customerBotLink') || "https://t.me/ONEHUBCustomer_Bot";

    const msg = `✅ สร้างลูกค้าใหม่ <b>${newCustomerId}</b> เรียบร้อย\n\n` +
                `👇 <b>ส่งข้อความนี้ให้ลูกค้า:</b> 👇\n` +
                `----------------------------------\n` +
                `🎉 ยินดีต้อนรับสมาชิกใหม่!\n\n` +
                `👤 รหัสสมาชิก: <b>${newCustomerId}</b>\n` +
                `🔑 รหัสยืนยัน: <b>${verificationCode}</b>\n\n` +
                `1️⃣ กดที่ลิงก์นี้: ${botLink}\n` +
                `2️⃣ พิมพ์คำสั่ง: <code>/link ${newCustomerId} ${verificationCode}</code>\n` +
                `----------------------------------\n` +
                `✨ รับทันที <b>${linkBonus} แต้ม</b> เมื่อเชื่อมบัญชี!`;

    sendAdminReply(chatId, msg);
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