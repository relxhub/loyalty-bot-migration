// src/services/notification.service.js

import { Telegraf } from 'telegraf';
import { getConfig } from '../config/config.js';

// ⭐️ สำคัญ: Initialise Bots ด้วย Token ที่ถูกต้องจาก Config ⭐️

// 1. Bot สำหรับ Admin (ใช้สำหรับตอบกลับ Admin และส่ง Super Admin Alerts)
// Note: ต้องมั่นใจว่า Admin Bot Token ถูกโหลดใน config.js
const adminBot = new Telegraf(getConfig('adminBotToken')); 

// 2. Bot สำหรับ Notification/Order Bot (ใช้สำหรับส่งข้อความออกไปหาลูกค้า/ผู้แนะนำ)
// Note: ใช้ Order Bot Token ตามการแก้ไขครั้งล่าสุด
const orderBot = new Telegraf(getConfig('orderBotToken')); 

// ---------------------------------------------------------------------

/**
 * 1. ส่งข้อความตอบกลับไปยังแอดมิน (ใช้สำหรับคำสั่ง /start, /check, หรือข้อความผิดพลาด)
 * (แทนที่ sendText ในโค้ด Apps Script เดิม)
 */
export async function sendAdminReply(chatId, text) {
    try {
        // ใช้ Admin Bot ในการตอบกลับแอดมินที่กำลังใช้งาน
        await adminBot.telegram.sendMessage(chatId, text, { parse_mode: 'HTML' });
    } catch (e) {
        console.error("Failed to send simple admin reply:", e.message);
    }
}

/**
 * 2. ส่งข้อความแจ้งเตือนไปหา Super Admin (สำหรับ Audit Log และ Alert)
 */
export async function sendAlertToSuperAdmin(text) {
    const superAdminChatId = getConfig('superAdminChatId');
    if (!superAdminChatId) return;
    try {
        // ใช้ Admin Bot ในการส่ง Alert ไปยัง Super Admin Chat ID
        await adminBot.telegram.sendMessage(superAdminChatId, text, { parse_mode: 'HTML' });
    } catch (e) {
        console.error("Failed to send alert to super admin.");
    }
}

/**
 * 3. ส่งข้อความแจ้งเตือนไปหาลูกค้า/ผู้แนะนำ (ผ่าน ORDER/NOTIFICATION BOT)
 * (ใช้สำหรับแจ้ง Referral Bonus หรือแต้มหมดอายุ)
 */
export async function sendNotificationToCustomer(telegramUserId, text) {
    if (!telegramUserId) return;
    try {
        // ⭐️ ใช้ Order Bot ในการส่งข้อความหาลูกค้า/ผู้แนะนำ ⭐️
        await orderBot.telegram.sendMessage(telegramUserId, text, { parse_mode: 'HTML' });
    } catch (e) {
        // Log ข้อผิดพลาดถ้าส่งไม่ได้ (เช่น ลูกค้าบล็อกบอท)
        console.error(`Failed to notify customer ${telegramUserId}: ${e.message}`);
    }
}