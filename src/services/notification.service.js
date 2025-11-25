// src/services/notification.service.js

import { Telegraf } from 'telegraf';
import { getConfig } from '../config/config.js';

// ประกาศตัวแปรเปล่าๆ ไว้ก่อน
let adminBotInstance = null;
let orderBotInstance = null;

// ฟังก์ชันช่วย: ดึง Admin Bot (สร้างเมื่อจำเป็นต้องใช้เท่านั้น)
function getAdminBot() {
    if (!adminBotInstance) {
        const token = getConfig('adminBotToken');
        if (!token) throw new Error("Admin Bot Token not found during initialization");
        adminBotInstance = new Telegraf(token);
    }
    return adminBotInstance;
}

// ฟังก์ชันช่วย: ดึง Order Bot (สร้างเมื่อจำเป็นต้องใช้เท่านั้น)
function getOrderBot() {
    if (!orderBotInstance) {
        const token = getConfig('orderBotToken');
        if (!token) throw new Error("Order Bot Token not found during initialization");
        orderBotInstance = new Telegraf(token);
    }
    return orderBotInstance;
}

// ---------------------------------------------------------------------

/**
 * 1. ส่งข้อความตอบกลับไปยังแอดมิน
 */
export async function sendAdminReply(chatId, text) {
    try {
        // เรียกใช้ getAdminBot() แทนตัวแปรตรงๆ
        await getAdminBot().telegram.sendMessage(chatId, text, { parse_mode: 'HTML' });
    } catch (e) {
        console.error("Failed to send simple admin reply:", e.message);
    }
}

/**
 * 2. ส่งข้อความแจ้งเตือนไปหา Super Admin
 */
export async function sendAlertToSuperAdmin(text) {
    const superAdminChatId = getConfig('superAdminChatId');
    if (!superAdminChatId) return;
    try {
        await getAdminBot().telegram.sendMessage(superAdminChatId, text, { parse_mode: 'HTML' });
    } catch (e) {
        console.error("Failed to send alert to super admin.");
    }
}

/**
 * 3. ส่งข้อความแจ้งเตือนไปหาลูกค้า/ผู้แนะนำ
 */
export async function sendNotificationToCustomer(telegramUserId, text) {
    if (!telegramUserId) return;
    try {
        await getOrderBot().telegram.sendMessage(telegramUserId, text, { parse_mode: 'HTML' });
    } catch (e) {
        console.error(`Failed to notify customer ${telegramUserId}: ${e.message}`);
    }
}