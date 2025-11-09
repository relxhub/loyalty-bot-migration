// src/services/notification.service.js
import { Telegraf } from 'telegraf';
import { getConfig } from '../config/config.js';

// ⭐️ สร้าง Instance 2 ตัวตามหน้าที่ ⭐️
// 1. Bot สำหรับส่งข้อความภายใน (Admin Alerts)
const adminBot = new Telegraf(getConfig('adminBotToken')); 
// 2. Bot สำหรับส่งข้อความภายนอก (Order/Notification Bot)
const orderBot = new Telegraf(getConfig('orderBotToken')); 


/**
 * 🔔 ส่งข้อความแจ้งเตือนไปหาลูกค้า/ผู้แนะนำ (ผ่าน ORDER_BOT_TOKEN)
 */
export async function sendNotificationToCustomer(telegramUserId, text) {
    if (!telegramUserId) return;
    try {
        // ใช้ orderBot ในการส่งข้อความหาลูกค้า
        await orderBot.telegram.sendMessage(telegramUserId, text, { parse_mode: 'HTML' });
    } catch (e) {
        // Log ข้อผิดพลาดถ้าส่งไม่ได้ (เช่น ลูกค้าบล็อกบอท)
        console.error(`Failed to notify customer ${telegramUserId}: ${e.message}`);
    }
}

/**
 * 🚨 ส่งข้อความแจ้งเตือนไปหา Super Admin (ผ่าน ADMIN_BOT_TOKEN)
 */
export async function sendAlertToSuperAdmin(text) {
    const superAdminChatId = getConfig('superAdminChatId');
    if (!superAdminChatId) return;
    try {
        // ใช้ adminBot ในการส่งข้อความหา Super Admin
        await adminBot.telegram.sendMessage(superAdminChatId, text, { parse_mode: 'HTML' });
    } catch (e) {
        console.error("Failed to send alert to super admin.");
    }
}