// src/handlers/admin.handlers.js

import { prisma } from '../db.js';
import { getAdminRole } from '../services/admin.service.js';
import { sendAdminReply, sendAlertToSuperAdmin, sendNotificationToCustomer } from '../services/notification.service.js'; 
import { listRewards, formatRewardsForAdmin } from '../services/reward.service.js';
import { isValidIdFormat } from '../utils/validation.utils.js'; 
import { generateUniqueCode } from '../utils/crypto.utils.js';
import { addDays } from '../utils/date.utils.js';
import { getActiveCampaign } from '../services/campaign.service.js';
import { getConfig } from '../config/config.js';
import { giveReferralBonus } from '../services/customer.service.js';

export async function handleAdminCommand(ctx) {
    const userTgId = String(ctx.from.id);
    const text = ctx.message.text || "";
    const role = await getAdminRole(userTgId);
    const commandParts = text.trim().split(/\s+/);
    const command = commandParts[0].toLowerCase();
    const adminUser = ctx.from.username || ctx.from.first_name || "Admin";
    const chatId = ctx.chat.id;

    if (!role) return sendAdminReply(chatId, "⛔️ คุณไม่มีสิทธิ์ใช้งานคำสั่งนี้");

    switch (command) {
        case "/new":
            await handleNewCustomer(ctx, commandParts, adminUser, chatId);
            break;

        case "/check":
            if (commandParts.length !== 2) {
                sendAdminReply(chatId, "❗️รูปแบบคำสั่งผิด\nต้องเป็น: /check [รหัสลูกค้า]");
            } else {
                const result = await checkCustomerInfo(commandParts[1], adminUser);
                sendAdminReply(chatId, result);
            }
            break;

        case "/add":
            // สิทธิ์เฉพาะ SuperAdmin
            if (role !== "SuperAdmin") {
                sendAdminReply(chatId, "⛔️ คุณไม่มีสิทธิ์ใช้งานคำสั่ง /add");
                break;
            }
            await handleAddPoints(ctx, commandParts, adminUser, chatId);
            break;

        case "/redeem":
            await handleRedeemReward(ctx, commandParts, adminUser, chatId);
            break;

        case "/reward":
            const rewards = await listRewards();
            const result = formatRewardsForAdmin(rewards);
            // Log การดู reward (Optional)
            await createAdminLog(adminUser, "LIST_REWARDS", null, 0, "Requested reward list");
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

        default:
            sendAdminReply(chatId, "⚠️ คำสั่งไม่ถูกต้อง หรือรูปแบบไม่สมบูรณ์");
            break;
    }
}

// ==================================================
// 🛠️ HELPER FUNCTIONS (LOGIC)
// ==================================================

/**
 * ฟังก์ชันช่วยบันทึก Log แอดมิน
 */
async function createAdminLog(admin, action, customerId, pointsChange, details) {
    try {
        await prisma.adminLog.create({
            data: {
                admin: admin,
                action: action,
                customerId: customerId || null,
                pointsChange: pointsChange || 0,
                details: details || ""
            }
        });
    } catch (e) {
        console.error("Failed to create Admin Log:", e);
    }
}

async function handleNewCustomer(ctx, commandParts, adminUser, chatId) {
    const newCustomerId = commandParts[1]?.toUpperCase();
    const referrerId = commandParts[2]?.toUpperCase() || null;
    const isReferrerSpecified = referrerId && referrerId !== 'N/A';

    if (!newCustomerId) return sendAdminReply(chatId, "❗️รูปแบบคำสั่งผิด\nต้องเป็น: /new [รหัสลูกค้าใหม่] [รหัสผู้แนะนำ]");
    if (!isValidIdFormat(newCustomerId)) return sendAdminReply(chatId, `❌ รูปแบบรหัสลูกค้าไม่ถูกต้อง`);
    
    const existing = await prisma.customer.findUnique({ where: { customerId: newCustomerId, isDeleted: false } });
    if (existing) return sendAdminReply(chatId, `❌ รหัสลูกค้า '${newCustomerId}' มีอยู่ในระบบแล้ว`);

    if (isReferrerSpecified) {
        const refUser = await prisma.customer.findUnique({ where: { customerId: referrerId, isDeleted: false } });
        if (!refUser) return sendAdminReply(chatId, `❌ ไม่พบข้อมูลรหัสผู้แนะนำ '${referrerId}'`);
        if (newCustomerId === referrerId) return sendAdminReply(chatId, "❌ รหัสลูกค้าและผู้แนะนำต้องไม่เหมือนกัน");
    }

    const verificationCode = generateUniqueCode(4);
    const newExpiryDate = addDays(new Date(), getConfig('expiryDaysNewCustomer') || 30);

    await prisma.customer.create({
        data: {
            customerId: newCustomerId,
            referrerId: isReferrerSpecified ? referrerId : null,
            expiryDate: newExpiryDate,
            verificationCode: verificationCode,
            adminCreatedBy: adminUser,
        }
    });

    // 📝 LOG
    await createAdminLog(adminUser, "CREATE_CUSTOMER", newCustomerId, 0, `Referred by: ${referrerId || 'N/A'}`);

    if (isReferrerSpecified) {
        await giveReferralBonus(referrerId, newCustomerId, adminUser);
    }

    const campaign = await getActiveCampaign();
    const linkBonus = campaign?.linkBonus || 50;
    const referralBonus = campaign?.base || 50;
    const botLink = getConfig('customerBotLink') || "https://t.me/ONEHUBCustomer_Bot";

    const adminMsg = `✅ สร้างลูกค้าใหม่ '${newCustomerId}' เรียบร้อยแล้ว`;
    
    let promoText = "";
    if (campaign?.name && campaign?.name !== 'Standard') {
         promoText = `\n💌 <i>(แคมเปญพิเศษ ${campaign.name} | ปกติ 50 แต้ม)</i> 💌`;
    }

    const customerMsg = `🎉 ยินดีต้อนรับสมาชิกใหม่!\n` +
        `👤 รหัสสมาชิก: <b>${newCustomerId}</b>\n` +
        `🔑 รหัสยืนยัน: <b>${verificationCode}</b>\n\n` +
        `1️⃣ กดที่ลิงก์นี้: ${botLink}\n` +
        `2️⃣ พิมพ์คำสั่ง: <code>/link ${newCustomerId} ${verificationCode}</code>\n` +
        `----------------------------------\n` +
        `✨ รับทันที <b>${linkBonus} แต้ม</b> เมื่อเชื่อมบัญชี!\n` +
        `💌 เพื่อนแนะนำเพื่อน รับเพิ่ม <b>${referralBonus} แต้ม</b>${promoText}`;

    await sendAdminReply(chatId, adminMsg);
    await sendAdminReply(chatId, customerMsg);
}

async function checkCustomerInfo(customerId, adminUser) {
    const customer = await prisma.customer.findUnique({
        where: { customerId: customerId.toUpperCase(), isDeleted: false }
    });
    
    // 📝 LOG
    await createAdminLog(adminUser, "CHECK_CUSTOMER", customerId.toUpperCase(), 0, "Checked info");

    if (!customer) return `🔍 ไม่พบข้อมูลลูกค้า ${customerId}`;
    const formattedDate = customer.expiryDate.toLocaleDateString('th-TH');
    return `👤 <b>ข้อมูลลูกค้า: ${customer.customerId}</b>\n` +
           `🤝 ผู้แนะนำ: ${customer.referrerId || 'N/A'}\n` +
           `💰 แต้มคงเหลือ: ${customer.points}\n` +
           `🗓️ วันหมดอายุ: ${formattedDate}`;
}

/**
 * Logic สำหรับเพิ่มแต้ม (/add)
 */
async function handleAddPoints(ctx, commandParts, adminUser, chatId) {
    const customerId = commandParts[1]?.toUpperCase();
    const points = parseInt(commandParts[2]);

    if (!customerId || isNaN(points)) {
        return sendAdminReply(chatId, "❗️รูปแบบคำสั่งผิด\nต้องเป็น: /add [รหัสลูกค้า] [แต้ม]");
    }

    const customer = await prisma.customer.findUnique({ where: { customerId: customerId, isDeleted: false } });
    if (!customer) return sendAdminReply(chatId, `🔍 ไม่พบข้อมูลลูกค้า ${customerId}`);

    // คำนวณวันหมดอายุ (สูตร: MAX(วันเดิม, วันนี้+30วัน) แต่ไม่เกิน 60 วัน)
    const today = new Date(); today.setHours(0,0,0,0);
    const currentExpiry = customer.expiryDate;
    
    const limitDays = getConfig('expiryDaysLimitMax') || 60;
    const extendDays = getConfig('expiryDaysAddPoints') || 30;

    const limitDate = addDays(today, limitDays);
    const proposedExpiry = addDays(today, extendDays);
    
    let bestDate = currentExpiry > proposedExpiry ? currentExpiry : proposedExpiry;
    let finalExpiryDate = bestDate > limitDate ? limitDate : bestDate;

    // อัปเดต DB
    await prisma.customer.update({
        where: { customerId: customerId },
        data: {
            points: { increment: points },
            expiryDate: finalExpiryDate
        }
    });

    const newPoints = customer.points + points;

    // 📝 LOG
    await createAdminLog(adminUser, "ADD_POINTS", customerId, points, "Manual Add");

    // แจ้งเตือนลูกค้า
    if (customer.telegramUserId) {
        await sendNotificationToCustomer(customer.telegramUserId, `🎉 คุณได้รับ ${points} แต้ม!\n💰 แต้มสะสมปัจจุบัน: ${newPoints} แต้ม`);
    }

    // แจ้งเตือน Super Admin
    await sendAlertToSuperAdmin(`🔔 <b>Admin Alert: /add</b>\nUser: ${adminUser}\nCustomer: ${customerId}\nPoints: +${points}`);

    sendAdminReply(chatId, `✅ เพิ่ม ${points} แต้มให้ ${customerId} เรียบร้อย\n💰 ยอดรวม: ${newPoints}`);
}

/**
 * Logic สำหรับแลกรางวัล (/redeem)
 */
async function handleRedeemReward(ctx, commandParts, adminUser, chatId) {
    const customerId = commandParts[1]?.toUpperCase();
    const rewardId = commandParts[2]?.toUpperCase();

    if (!customerId || !rewardId) {
        return sendAdminReply(chatId, "❗️รูปแบบคำสั่งผิด\nต้องเป็น: /redeem [รหัสลูกค้า] [รหัสรางวัล]");
    }

    const customer = await prisma.customer.findUnique({ where: { customerId: customerId, isDeleted: false } });
    if (!customer) return sendAdminReply(chatId, `🔍 ไม่พบข้อมูลลูกค้า ${customerId}`);

    const reward = await prisma.reward.findUnique({ where: { rewardId: rewardId } });
    if (!reward) return sendAdminReply(chatId, `🎁 ไม่พบของรางวัลรหัส '${rewardId}'`);

    if (customer.points < reward.points) {
        return sendAdminReply(chatId, `⚠️ แต้มไม่เพียงพอ (มี ${customer.points}, ใช้ ${reward.points})`);
    }

    // หักแต้ม
    await prisma.customer.update({
        where: { customerId: customerId },
        data: { points: { decrement: reward.points } }
    });

    const newPoints = customer.points - reward.points;

    // 📝 LOG
    await createAdminLog(adminUser, "REDEEM_POINTS", customerId, -reward.points, `Redeemed: ${reward.name}`);

    // แจ้งเตือนลูกค้า
    if (customer.telegramUserId) {
        await sendNotificationToCustomer(customer.telegramUserId, `🎁 คุณใช้ ${reward.points} แต้ม แลก '${reward.name}' สำเร็จ\n💰 แต้มคงเหลือ: ${newPoints}`);
    }

    sendAdminReply(chatId, `✅ แลก '${reward.name}' ให้ ${customerId} สำเร็จ\n💰 แต้มคงเหลือ: ${newPoints}`);
}