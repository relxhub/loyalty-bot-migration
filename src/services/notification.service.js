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
    if (!telegramUserId) return;
    try {
        const orderBotToken = process.env.ORDER_BOT_TOKEN;
        if (!orderBotToken) {
            console.error("ORDER_BOT_TOKEN is missing");
            return;
        }
        
        // Use fetch directly to bypass any dependency injection issues
        const fetchModule = await import('node-fetch');
        const fetchFn = fetchModule.default;
        
        const url = `https://api.telegram.org/bot${orderBotToken}/sendMessage`;
        const res = await fetchFn(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: telegramUserId,
                text: text,
                parse_mode: 'HTML'
            })
        });
        
        const data = await res.json();
        if (!data.ok) {
            console.error(`Telegram API Error notifying customer ${telegramUserId}:`, data);
        }
    } catch (e) {
        console.error(`Failed to notify customer ${telegramUserId}: ${e.message}`);
    }
}