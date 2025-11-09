// src/handlers/customer.handlers.js

import fetch from 'node-fetch';
import { prisma } from '../db.js';
import { getConfig } from '../config/config.js';
import { sendNotificationToCustomer } from '../services/notification.service.js';
// ... (imports handlers: handleLinkAccountLogic, checkPointsLogic)

/**
 * 🔐 ตรวจสอบสถานะสมาชิกใน Channel (ใช้ Token ของ Customer Bot/Order Bot)
 */
async function isChannelMember(userId) {
    // Note: Customer Bot Token ถูกใช้ใน customer_app.js อยู่แล้ว
    // แต่สำหรับการตรวจสอบ API ภายนอก เราจะใช้ Order Bot Token (ซึ่งอาจเป็นตัวเดียวกับ Customer Token)
    const orderBotToken = getConfig('orderBotToken'); 
    const channelId = getConfig('channelId'); // ⚠️ ต้องมี Channel ID ใน SystemConfig/ENV
    const channelLink = getConfig('channelLink'); // ⚠️ ต้องมี Channel Link ใน SystemConfig/ENV
    
    if (!channelId) {
        console.warn("Channel ID is missing. Skipping channel membership check.");
        return true; // อนุญาตให้ผ่านถ้า config หาย
    }

    const url = `https://api.telegram.org/bot${orderBotToken}/getChatMember?chat_id=${channelId}&user_id=${userId}`;
    
    try {
        const response = await fetch(url);
        const data = await response.json();
        const status = data.result?.status;
        return status === "member" || status === "administrator" || status === "creator";
    } catch (e) {
        console.error("Channel check failed:", e.message);
        return false;
    }
}


// ⭐️ ฟังก์ชันหลัก: Router คำสั่งลูกค้า
export async function handleCustomerCommand(ctx) {
    const userTgId = String(ctx.from.id);
    const text = ctx.message.text || "";
    const customerName = ctx.from.first_name;
    const commandParts = text.split(" ");
    const command = commandParts[0].toLowerCase();
    const chatId = ctx.chat.id;

    // 1. Channel Gating (ตรวจสอบการเข้าร่วม Channel)
    if (!(await isChannelMember(userTgId))) {
        // ⚠️ TODO: Implement sending message with Join button (เหมือนโค้ดเดิม)
        return ctx.reply(`🔔 กรุณาเข้าร่วม Channel ของเราก่อน เพื่อใช้งานฟังก์ชันนี้นะคะ`); 
    }

    switch (command) {
        case "/points":
            // ⚠️ TODO: Call checkPointsByTelegramId Logic
            return ctx.reply("✅ Logic /points จะถูกเรียกใช้");
        case "/link":
            if (commandParts.length < 3) {
                return ctx.reply("❗️ รูปแบบคำสั่งผิด: /link [รหัสลูกค้า] [รหัสยืนยัน]");
            }
            // ⚠️ TODO: Call handleLinkAccount Logic
            return ctx.reply("✅ Logic /link จะถูกเรียกใช้");
        case "/reward":
            // ⚠️ TODO: Call listRewardsForCustomer Logic
            return ctx.reply("✅ Logic /reward จะถูกเรียกใช้");
        case "/start":
             return ctx.reply(`👋 สวัสดีค่ะคุณ ${customerName}!\n\nนี่คือบอทสำหรับตรวจสอบโปรแกรมสะสมแต้ม`);
        default:
            return ctx.reply(`🤔 ขออภัยค่ะคุณ ${customerName} ไม่รู้จักคำสั่งนี้`);
    }
}