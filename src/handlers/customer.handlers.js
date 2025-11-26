// src/handlers/customer.handlers.js

import fetch from 'node-fetch';
import { prisma } from '../db.js';
import { getConfig } from '../config/config.js';
import { getActiveCampaign } from '../services/campaign.service.js';
import { addDays } from '../utils/date.utils.js';
import { listRewards } from '../services/reward.service.js';

// ==================================================
// ⭐️ MAIN ROUTER
// ==================================================
export async function handleCustomerCommand(ctx) {
    const userTgId = String(ctx.from.id);
    const text = ctx.message.text || "";
    const customerName = ctx.from.first_name;
    const commandParts = text.trim().split(/\s+/);
    const command = commandParts[0].toLowerCase();

    // 1. Channel Gating
    if (!(await isChannelMember(userTgId))) {
        const channelLink = getConfig('channelLink') || "https://t.me/relxhub";
        return ctx.reply(`🔔 <b>กรุณาเข้าร่วม Channel ของเราก่อน</b>\n\n` +
            `เพื่อรับสิทธิพิเศษและใช้งานบอทได้เต็มรูปแบบค่ะ\n` +
            `👉 <a href="${channelLink}">กดที่นี่เพื่อเข้า Channel</a>`, 
            { parse_mode: 'HTML' }
        ); 
    }

    switch (command) {
        case "/link":
            if (commandParts.length < 3) return ctx.reply("❗️ รูปแบบคำสั่งผิด: /link [รหัสลูกค้า] [รหัสยืนยัน]");
            await handleLinkAccount(ctx, commandParts[1], commandParts[2], userTgId);
            break;

        case "/points":
            await checkPointsByTelegramId(ctx, userTgId);
            break;

        case "/reward":
            await listRewardsForCustomer(ctx, userTgId);
            break;

        case "/start":
             // 📝 เพิ่ม Log: กด Start
             await createCustomerLog(userTgId, null, "START_BOT", 0);
             
             return ctx.reply(`👋 สวัสดีค่ะคุณ ${customerName}!\n\n` + 
                `นี่คือบอทสำหรับตรวจสอบโปรแกรมสะสมแต้ม\n\n` +
                `🔹 พิมพ์ /points เพื่อตรวจสอบแต้ม\n` +
                `🎁 พิมพ์ /reward เพื่อดูรายการของรางวัล\n` +
                `🔗 พิมพ์ /link [รหัสลูกค้า] [รหัสยืนยัน] เพื่อเชื่อมบัญชี`);
        default:
            break;
    }
}

// ==================================================
// 🛠️ HELPER FUNCTIONS & LOGGING
// ==================================================

/**
 * 📝 ฟังก์ชันช่วยบันทึก Customer Log (ส่วนที่เพิ่มมา)
 */
async function createCustomerLog(telegramUserId, customerId, action, pointsChange) {
    try {
        await prisma.customerLog.create({
            data: {
                telegramUserId: telegramUserId,
                customerId: customerId || null,
                action: action,
                pointsChange: pointsChange || 0
            }
        });
    } catch (e) {
        console.error("Failed to create Customer Log:", e);
    }
}

async function handleLinkAccount(ctx, customerId, verificationCode, telegramUserId) {
    const searchId = customerId.toUpperCase();

    const existingTgUser = await prisma.customer.findUnique({ where: { telegramUserId: telegramUserId } });
    if (existingTgUser) return ctx.reply(`⚠️ บัญชี Telegram นี้เชื่อมกับรหัส ${existingTgUser.customerId} ไปแล้วค่ะ`);

    const customer = await prisma.customer.findUnique({ where: { customerId: searchId, isDeleted: false } });
    if (!customer) return ctx.reply(`😥 รหัสสมาชิกไม่ถูกต้อง`);
    if (customer.telegramUserId) return ctx.reply(`⚠️ รหัส ${searchId} ถูกเชื่อมไปแล้ว`);

    if (customer.verificationCode && String(customer.verificationCode) !== String(verificationCode)) {
        // 📝 เพิ่ม Log: ใส่รหัสผิด
        await createCustomerLog(telegramUserId, searchId, "LINK_FAILED_WRONG_CODE", 0);
        return ctx.reply(`😥 รหัสยืนยันไม่ถูกต้อง`);
    }

    const campaign = await getActiveCampaign();
    const bonusPoints = campaign?.linkBonus || getConfig('standardLinkBonus') || 50;
    const daysToExtend = getConfig('expiryDaysLinkAccount') || 7;

    const currentExpiry = customer.expiryDate;
    const today = new Date();
    const baseDate = currentExpiry > today ? currentExpiry : today;
    const newExpiryDate = addDays(baseDate, daysToExtend);

    await prisma.customer.update({
        where: { customerId: searchId },
        data: {
            telegramUserId: telegramUserId,
            points: { increment: bonusPoints },
            expiryDate: newExpiryDate,
            verificationCode: null
        }
    });

    // 📝 เพิ่ม Log: เชื่อมสำเร็จ + ได้โบนัส
    await createCustomerLog(telegramUserId, searchId, "LINK_ACCOUNT_SUCCESS", 0);
    await createCustomerLog(telegramUserId, searchId, "LINK_BONUS", bonusPoints);

    const newPoints = customer.points + bonusPoints;
    return ctx.reply(`✅ เชื่อมบัญชี <b>${searchId}</b> สำเร็จ!\n🎉 รับโบนัส <b>${bonusPoints}</b> แต้ม\n💰 แต้มรวม: <b>${newPoints}</b>`, { parse_mode: 'HTML' });
}

async function checkPointsByTelegramId(ctx, telegramUserId) {
    const customer = await prisma.customer.findUnique({ where: { telegramUserId: telegramUserId, isDeleted: false } });
    if (!customer) return ctx.reply("🤔 ไม่พบบัญชีที่เชื่อมต่อ กรุณาพิมพ์ /link");

    // 📝 เพิ่ม Log: เช็คแต้ม
    await createCustomerLog(telegramUserId, customer.customerId, "CHECK_POINTS", 0);

    const formattedDate = customer.expiryDate.toLocaleDateString('th-TH');
    return ctx.reply(`👋 สวัสดีคุณ ${customer.customerId}!\n💰 แต้มของคุณ: <b>${customer.points}</b>\n🗓️ หมดอายุ: ${formattedDate}`, { parse_mode: 'HTML' });
}

async function listRewardsForCustomer(ctx, telegramUserId) {
    // 📝 เพิ่ม Log: ดูของรางวัล
    await createCustomerLog(telegramUserId, null, "LIST_REWARDS", 0);

    const rewards = await listRewards();
    if (!rewards || rewards.length === 0) return ctx.reply("🎁 ยังไม่มีของรางวัลขณะนี้");

    let msg = "<b>🎁 รายการของรางวัล:</b>\n\n";
    rewards.forEach(r => { msg += `✨ ${r.name} - <b>${r.points}</b> แต้ม\n`; });
    return ctx.reply(msg, { parse_mode: 'HTML' });
}

async function isChannelMember(userId) {
    const orderBotToken = getConfig('orderBotToken'); 
    const channelId = getConfig('channelId'); 
    if (!channelId) return true;

    try {
        const url = `https://api.telegram.org/bot${orderBotToken}/getChatMember?chat_id=${channelId}&user_id=${userId}`;
        const response = await fetch(url);
        const data = await response.json();
        
        if (!data.ok) return false; 
        return ["creator", "administrator", "member", "restricted"].includes(data.result?.status);
    } catch (e) {
        return false; 
    }
}