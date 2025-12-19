// src/services/notification.service.js

import { getConfig } from '../config/config.js';
// Telegraf is no longer imported here as instances will be injected from app.js

// ประกาศตัวแปรสำหรับเก็บ Telegraf instance ที่ถูก inject มา
let injectedAdminBotInstance = null;
let injectedOrderBotInstance = null;

// ฟังก์ชันสำหรับ inject adminBot instance
export function setAdminBotInstance(bot) {
    injectedAdminBotInstance = bot;
}

// ฟังก์ชันสำหรับ inject orderBot instance
export function setOrderBotInstance(bot) {
    injectedOrderBotInstance = bot;
}

// ---------------------------------------------------------------------

/**
 * 1. ส่งข้อความตอบกลับไปยังแอดมิน
 */
export async function sendAdminReply(chatId, text) {
    if (!injectedAdminBotInstance) {
        console.error("Admin bot instance not set for sendAdminReply.");
        return;
    }
    try {
        await injectedAdminBotInstance.telegram.sendMessage(chatId, text, { parse_mode: 'HTML' });
    } catch (e) {
        console.error("Failed to send simple admin reply:", e.message);
    }
}

/**
 * 2. ส่งข้อความแจ้งเตือนไปหา Super Admin
 */
export async function sendAlertToSuperAdmin(text) {
    if (!injectedAdminBotInstance) {
        console.error("Admin bot instance not set for sendAlertToSuperAdmin.");
        return;
    }
    const superAdminChatId = getConfig('superAdminTelegramId'); // Use camelCase
    if (!superAdminChatId) return;
    try {
        await injectedAdminBotInstance.telegram.sendMessage(superAdminChatId, text, { parse_mode: 'HTML' });
    } catch (e) {
        console.error("Failed to send alert to super admin:", e.message);
    }
}

/**
 * 3. ส่งข้อความแจ้งเตือนไปหาลูกค้า/ผู้แนะนำ
 */
export async function sendNotificationToCustomer(telegramUserId, text) {
    if (!injectedOrderBotInstance) {
        console.error("Order bot instance not set for sendNotificationToCustomer.");
        return;
    }
    if (!telegramUserId) return;
    try {
        await injectedOrderBotInstance.telegram.sendMessage(telegramUserId, text, { parse_mode: 'HTML' });
    } catch (e) {
        console.error(`Failed to notify customer ${telegramUserId}: ${e.message}`);
    }
}