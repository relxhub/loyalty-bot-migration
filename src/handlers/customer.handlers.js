// src/handlers/customer.handlers.js

import fetch from 'node-fetch';
import { getConfig } from '../config/config.js';
// ... (imports อื่นๆ เช่น linkAccount, checkPoints)

/**
 * 🔐 ตรวจสอบสถานะสมาชิกใน Channel
 */
async function isChannelMember(userId) {
    const customerBotToken = getConfig('customerBotToken');
    const channelId = getConfig('channelId'); // ต้องเพิ่ม 'channelId' ใน SystemConfig หรือ ENV
    if (!channelId) return true; // ป้องกันการล่มถ้า config หาย
    
    const url = `https://api.telegram.org/bot${customerBotToken}/getChatMember?chat_id=${channelId}&user_id=${userId}`;
    
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


/**
 * 👤 Route คำสั่งลูกค้าทั้งหมด
 */
export async function handleCustomerCommand(ctx) {
    const userTgId = String(ctx.from.id);
    const text = ctx.message.text || "";
    const commandParts = text.split(" ");
    const command = commandParts[0].toLowerCase();

    // 1. Channel Gating (ตรวจสอบการเข้าร่วม Channel)
    // ⚠️ ต้องเพิ่ม channelId และ channelLink ใน SystemConfig
    if (!(await isChannelMember(userTgId))) {
        // ⚠️ ต้อง implement logic สำหรับส่งข้อความพร้อมปุ่ม Join
        return ctx.reply('🔔 กรุณาเข้าร่วม Channel ของเราก่อน'); 
    }

    switch (command) {
        case "/points":
            // ⚠️ ต้องเรียกใช้ตรรกะ checkPointsByTelegramId
            return ctx.reply("✅ ตรรกะ /points จะถูกเรียกใช้");
        case "/link":
            // ⚠️ ต้องเรียกใช้ตรรกะ handleLinkAccount(customerId, verificationCode, userTgId)
            return ctx.reply("✅ ตรรกะ /link จะถูกเรียกใช้");
        case "/reward":
            // ⚠️ ต้องเรียกใช้ตรรกะ listRewardsForCustomer
            return ctx.reply("✅ ตรรกะ /reward จะถูกเรียกใช้");
        default:
            return ctx.reply(`🤔 ขออภัยค่ะ ไม่รู้จักคำสั่งนี้`);
    }
}