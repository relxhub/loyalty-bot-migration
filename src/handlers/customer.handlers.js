// src/handlers/customer.handlers.js (ฉบับปรับปรุงข้อความ Gating)

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

    // 1. Channel Gating (ตรวจสอบการเข้าร่วม Channel)
    if (!(await isChannelMember(userTgId))) {
        const channelLink = getConfig('channelLink') || "https://t.me/relxhub";
        
        // ⭐️ ปรับแก้: ข้อความชัดเจนขึ้น พร้อมปุ่มกด
        return ctx.reply(`🔔 <b>ยังไม่ได้เข้าร่วม Channel ค่ะ</b>\n\n` +
            `เพื่อให้บอททำงานได้สมบูรณ์ กรุณาทำตาม 2 ขั้นตอนนี้ค่ะ:\n\n` +
            `1️⃣ กดปุ่มด้านล่างเพื่อไปที่ Channel\n` +
            `2️⃣ <b>กดปุ่ม "JOIN" (เข้าร่วม) ที่ด้านล่างของหน้าจอ Channel</b>\n` +
            `3️⃣ กลับมาที่นี่ แล้วพิมพ์คำสั่งอีกครั้งค่ะ`, 
            { 
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [[
                        { text: "👉 กดปุ่มนี้ แล้วกด JOIN ใน Channel ✅", url: channelLink }
                    ]]
                }
            }
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
            // commandParts[1] will contain the payload, e.g., "ref_OT123"
            const payload = commandParts.length > 1 ? commandParts[1] : null;

            if (payload && payload.startsWith('ref_')) {
                // This is a referral link click
                const referrerId = payload.split('_')[1];
                const webAppUrl = `${getConfig('publicUrl')}?start_param=ref_${referrerId}`;

                await createCustomerLog(userTgId, null, "REFERRAL_LINK_CLICK", 0, `Referrer: ${referrerId}`);
                
                return ctx.replyWithWebApp(
                    `👋 สวัสดีค่ะคุณ ${customerName}!\n\n` +
                    `คุณได้รับเชิญให้เข้าร่วมโปรแกรมสะสมแต้ม! 🎉\n\n` +
                    `กดปุ่มด้านล่างเพื่อเริ่มลงทะเบียนและรับแต้มแรกของคุณได้เลย!`, 
                    {
                        reply_markup: {
                            inline_keyboard: [[
                                { text: "📝 เริ่มลงทะเบียน", web_app: { url: webAppUrl } }
                            ]]
                        }
                    }
                );

            } else {
                // This is a normal /start command without a referral
                await createCustomerLog(userTgId, null, "START_BOT", 0);
                
                const webAppUrl = getConfig('publicUrl');
                
                return ctx.replyWithWebApp(
                    `👋 สวัสดีค่ะคุณ ${customerName}!\n\n` +
                    `นี่คือบอทสำหรับโปรแกรมสะสมแต้มของเราค่ะ\n\n` +
                    `คุณสามารถจัดการทุกอย่างได้ง่ายๆ ผ่านแอปพลิเคชันของเรา`, 
                    {
                        reply_markup: {
                            inline_keyboard: [[
                                { text: "💎 เปิดแอปพลิเคชัน", web_app: { url: webAppUrl } }
                            ]]
                        }
                    }
                );
            }
        default:
            break;
    }
}

// ==================================================
// 🛠️ HELPER FUNCTIONS & LOGGING
// ==================================================

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
    } catch (e) { console.error("Failed to create Customer Log:", e); }
}

async function handleLinkAccount(ctx, customerId, verificationCode, telegramUserId) {
    const searchId = customerId.toUpperCase();

    const existingTgUser = await prisma.customer.findUnique({ where: { telegramUserId: telegramUserId } });
    if (existingTgUser) return ctx.reply(`⚠️ บัญชี Telegram นี้เชื่อมกับรหัส ${existingTgUser.customerId} ไปแล้วค่ะ`);

    const customer = await prisma.customer.findUnique({ where: { customerId: searchId, isDeleted: false } });
    if (!customer) return ctx.reply(`😥 รหัสสมาชิกไม่ถูกต้อง`);
    if (customer.telegramUserId) return ctx.reply(`⚠️ รหัส ${searchId} ถูกเชื่อมไปแล้ว`);

    if (customer.verificationCode && String(customer.verificationCode) !== String(verificationCode)) {
        await createCustomerLog(telegramUserId, searchId, "LINK_FAILED_WRONG_CODE", 0);
        return ctx.reply(`😥 รหัสยืนยันไม่ถูกต้อง`);
    }

    const campaign = await getActiveCampaign();
    const bonusPoints = campaign?.linkBonus || getConfig('standardLinkBonus') || 50;
    const daysToExtend = getConfig('expiryDaysLinkAccount') || 7;

    const currentExpiry = customer.expiryDate;
    const today = new Date(); today.setHours(0,0,0,0);
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

    await createCustomerLog(telegramUserId, searchId, "LINK_ACCOUNT_SUCCESS", 0);
    await createCustomerLog(telegramUserId, searchId, "LINK_BONUS", bonusPoints);

    const newPoints = customer.points + bonusPoints;
    return ctx.reply(`✅ เชื่อมบัญชี <b>${searchId}</b> สำเร็จ!\n🎉 รับโบนัส <b>${bonusPoints}</b> แต้ม\n💰 แต้มรวม: <b>${newPoints}</b>`, { parse_mode: 'HTML' });
}

async function checkPointsByTelegramId(ctx, telegramUserId) {
    const customer = await prisma.customer.findUnique({ where: { telegramUserId: telegramUserId, isDeleted: false } });
    if (!customer) return ctx.reply("🤔 ไม่พบบัญชีที่เชื่อมต่อ กรุณาพิมพ์ /link");

    await createCustomerLog(telegramUserId, customer.customerId, "CHECK_POINTS", 0);

    const formattedDate = customer.expiryDate.toLocaleDateString('th-TH');
    return ctx.reply(`👋 สวัสดีคุณ ${customer.customerId}!\n💰 แต้มของคุณ: <b>${customer.points}</b>\n🗓️ หมดอายุ: ${formattedDate}`, { parse_mode: 'HTML' });
}

async function listRewardsForCustomer(ctx, telegramUserId) {
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
    } catch (e) { return false; }
}