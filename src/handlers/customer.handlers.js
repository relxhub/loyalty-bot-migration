// src/handlers/customer.handlers.js (ฉบับสมบูรณ์ - Logic จริง)

import fetch from 'node-fetch';
import { prisma } from '../db.js';
import { getConfig } from '../config/config.js';
import { getActiveCampaign } from '../services/campaign.service.js';
import { addDays } from '../utils/date.utils.js';
import { listRewards } from '../services/reward.service.js';

// ==================================================
// ⭐️ MAIN ROUTER: จัดการคำสั่งทั้งหมดของ Customer
// ==================================================
export async function handleCustomerCommand(ctx) {
    const userTgId = String(ctx.from.id);
    const text = ctx.message.text || "";
    const customerName = ctx.from.first_name;
    const commandParts = text.trim().split(/\s+/);
    const command = commandParts[0].toLowerCase();

    // 1. Channel Gating (ตรวจสอบการเข้าร่วม Channel)
    if (!(await isChannelMember(userTgId))) {
        const channelLink = getConfig('channelLink') || "https://t.me/relxhub";
        return ctx.reply(`🔔 <b>กรุณาเข้าร่วม Channel ของเราก่อน</b>\n\n` +
            `เพื่อรับสิทธิพิเศษและใช้งานบอทได้เต็มรูปแบบค่ะ\n` +
            `👉 <a href="${channelLink}">กดที่นี่เพื่อเข้า Channel</a>`, 
            { parse_mode: 'HTML' }
        ); 
    }

    switch (command) {
        // --------------------------------------------------
        // 🔗 COMMAND: /link [รหัสลูกค้า] [รหัสยืนยัน]
        // --------------------------------------------------
        case "/link":
            if (commandParts.length < 3) {
                return ctx.reply("❗️ รูปแบบคำสั่งผิด: /link [รหัสลูกค้า] [รหัสยืนยัน]");
            }
            await handleLinkAccount(ctx, commandParts[1], commandParts[2], userTgId);
            break;

        // --------------------------------------------------
        // 💰 COMMAND: /points
        // --------------------------------------------------
        case "/points":
            await checkPointsByTelegramId(ctx, userTgId);
            break;

        // --------------------------------------------------
        // 🎁 COMMAND: /reward
        // --------------------------------------------------
        case "/reward":
            await listRewardsForCustomer(ctx);
            break;

        // --------------------------------------------------
        // 👋 COMMAND: /start
        // --------------------------------------------------
        case "/start":
             return ctx.reply(`👋 สวัสดีค่ะคุณ ${customerName}!\n\n` + 
                `นี่คือบอทสำหรับตรวจสอบโปรแกรมสะสมแต้ม\n\n` +
                `🔹 พิมพ์ /points เพื่อตรวจสอบแต้ม\n` +
                `🎁 พิมพ์ /reward เพื่อดูรายการของรางวัล\n` +
                `🔗 พิมพ์ /link [รหัสลูกค้า] [รหัสยืนยัน] เพื่อเชื่อมบัญชี`);
        default:
            // ไม่ต้องตอบกลับถ้าพิมพ์ผิด เพื่อไม่ให้รบกวน
            break;
    }
}

// ==================================================
// 🛠️ HELPER FUNCTIONS (ฟังก์ชันทำงานจริง)
// ==================================================

/**
 * Logic เชื่อมบัญชี (/link)
 */
async function handleLinkAccount(ctx, customerId, verificationCode, telegramUserId) {
    const searchId = customerId.toUpperCase();

    // 1. เช็คว่า Telegram นี้เคยเชื่อมไปแล้วหรือยัง?
    const existingTgUser = await prisma.customer.findUnique({ where: { telegramUserId: telegramUserId } });
    if (existingTgUser) {
        return ctx.reply(`⚠️ ขออภัยค่ะ บัญชี Telegram ของคุณได้เชื่อมกับรหัสลูกค้า ${existingTgUser.customerId} ไปแล้วค่ะ`);
    }

    // 2. เช็คว่ารหัสลูกค้ามีจริงไหม?
    const customer = await prisma.customer.findUnique({ where: { customerId: searchId, isDeleted: false } });
    if (!customer) {
        return ctx.reply(`😥 รหัสสมาชิกไม่ถูกต้อง กรุณาตรวจสอบอีกครั้งค่ะ`);
    }

    // 3. เช็คว่ารหัสลูกค้าถูกคนอื่นแย่งเชื่อมไปแล้วหรือยัง?
    if (customer.telegramUserId) {
        return ctx.reply(`⚠️ ขออภัยค่ะ รหัสลูกค้า ${searchId} นี้ ถูกเชื่อมกับบัญชี Telegram อื่นไปแล้วค่ะ`);
    }

    // 4. ตรวจสอบรหัสยืนยัน (Verification Code)
    // (รองรับลูกค้าเก่าที่ไม่มี Code ด้วย: ถ้าใน DB เป็น null คือผ่านเลย)
    if (customer.verificationCode && String(customer.verificationCode) !== String(verificationCode)) {
        return ctx.reply(`😥 รหัสยืนยันไม่ถูกต้อง กรุณาตรวจสอบอีกครั้งค่ะ`);
    }

    // --- 5. คำนวณแต้มและวันหมดอายุ ---
    const campaign = await getActiveCampaign();
    const bonusPoints = campaign?.linkBonus || getConfig('standardLinkBonus') || 50;
    const daysToExtend = getConfig('expiryDaysLinkAccount') || 7;

    const currentExpiry = customer.expiryDate;
    const today = new Date();
    
    // สูตรต่ออายุ: MAX(วันหมดอายุเดิม, วันนี้) + 7 วัน
    const baseDate = currentExpiry > today ? currentExpiry : today;
    const newExpiryDate = addDays(baseDate, daysToExtend);

    // --- 6. อัปเดตฐานข้อมูล ---
    await prisma.customer.update({
        where: { customerId: searchId },
        data: {
            telegramUserId: telegramUserId, // เชื่อมไอดี
            points: { increment: bonusPoints }, // ให้แต้ม
            expiryDate: newExpiryDate, // ต่ออายุ
            verificationCode: null // ล้างรหัสยืนยัน (ใช้ได้ครั้งเดียว)
        }
    });

    const newPoints = customer.points + bonusPoints;
    
    return ctx.reply(`✅ เชื่อมบัญชี <b>${searchId}</b> สำเร็จแล้วค่ะ!\n\n` +
        `🎉 <b>รับแต้มโบนัสฟรี ${bonusPoints} แต้ม!</b>\n` +
        `💰 ยอดแต้มปัจจุบันของคุณคือ: <b>${newPoints}</b> แต้ม\n\n` +
        `👉 ต่อไปคุณสามารถพิมพ์ /points เพื่อตรวจสอบแต้มได้ตลอดเวลาค่ะ`, { parse_mode: 'HTML' });
}

/**
 * Logic เช็คแต้ม (/points)
 */
async function checkPointsByTelegramId(ctx, telegramUserId) {
    const customer = await prisma.customer.findUnique({
        where: { telegramUserId: telegramUserId, isDeleted: false }
    });

    if (!customer) {
        return ctx.reply("🤔 ไม่พบบัญชีที่เชื่อมต่อกับ Telegram นี้ค่ะ\nกรุณาใช้คำสั่ง /link เพื่อเชื่อมบัญชีก่อนนะคะ");
    }

    const formattedDate = customer.expiryDate.toLocaleDateString('th-TH');
    
    return ctx.reply(`👋 สวัสดีค่ะคุณ ${customer.customerId}!\n\n` +
        `💰 แต้มสะสมของคุณคือ: <b>${customer.points}</b> แต้ม\n` +
        `🗓️ หมดอายุวันที่: ${formattedDate}`, { parse_mode: 'HTML' });
}

/**
 * Logic แสดงของรางวัล (/reward)
 */
async function listRewardsForCustomer(ctx) {
    const rewards = await listRewards();
    if (!rewards || rewards.length === 0) {
        return ctx.reply("🎁 ขออภัยค่ะ ยังไม่มีของรางวัลให้แลกในขณะนี้");
    }

    let msg = "<b>🎁 รายการของรางวัลทั้งหมด:</b>\n\n";
    rewards.forEach(r => {
        msg += `✨ ${r.name} - <b>${r.points}</b> แต้ม\n`;
    });
    
    return ctx.reply(msg, { parse_mode: 'HTML' });
}

/**
 * ตรวจสอบสมาชิก Channel (Gating)
 */
async function isChannelMember(userId) {
    const orderBotToken = getConfig('orderBotToken'); 
    const channelId = getConfig('channelId'); 
    
    if (!channelId) return true; // ถ้าลืมตั้งค่า ให้ผ่านไปก่อน

    try {
        const url = `https://api.telegram.org/bot${orderBotToken}/getChatMember?chat_id=${channelId}&user_id=${userId}`;
        const response = await fetch(url);
        const data = await response.json();
        
        if (!data.ok) {
            console.error("Channel check API error:", data);
            return false; 
        }

        const status = data.result?.status;
        // status ที่ยอมรับได้
        return ["creator", "administrator", "member", "restricted"].includes(status);
    } catch (e) {
        console.error("Channel check failed:", e.message);
        return false; // ถ้า Error ให้กันไว้ก่อน (หรือจะให้ return true เพื่อปล่อยผ่านก็ได้)
    }
}