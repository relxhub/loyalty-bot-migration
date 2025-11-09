// src/config/config.js (ฉบับสมบูรณ์)

import { prisma } from '../db.js';

let appConfig = {};

/**
 * ⭐️ ฟังก์ชันหลัก: โหลดค่าตั้งค่าทั้งหมดจากฐานข้อมูล (SystemConfig) และ Secrets (ENV)
 * ต้องเรียกใช้เพียงครั้งเดียวเมื่อแอปพลิเคชันเริ่มทำงาน
 */
export async function loadConfig() {
    // 1. โหลดค่าจากตาราง SystemConfig ใน DB
    const configs = await prisma.systemConfig.findMany();
    
    // แปลง Array ให้เป็น Object (Key-Value)
    configs.forEach(item => {
        const numValue = parseInt(item.value);
        appConfig[item.key] = isNaN(numValue) ? item.value : numValue;
    });

    // 2. โหลด Secrets จาก Environment Variables (ENV) 
    // โค้ดจะดึงค่าจากตัวพิมพ์ใหญ่ (ADMIN_BOT_TOKEN) และเก็บเป็นตัวพิมพ์เล็ก (adminBotToken)
    appConfig.adminBotToken = process.env.ADMIN_BOT_TOKEN;       // 1. โทเคนสำหรับ Admin Bot
    appConfig.customerBotToken = process.env.CUSTOMER_BOT_TOKEN;   // 2. โทเคนสำหรับ Customer App (Inbound)
    appConfig.orderBotToken = process.env.ORDER_BOT_TOKEN;         // 3. โทเคนสำหรับ Order/Notification Bot (Outbound)
    
    appConfig.superAdminChatId = process.env.SUPER_ADMIN_CHAT_ID;
    appConfig.systemTimezone = process.env.SYSTEM_TIMEZONE; 

    return appConfig;
}

// ----------------------------------------------------------------------

/**
 * ฟังก์ชันสำหรับเข้าถึงค่า Config ที่โหลดไว้
 * @param {string} key ชื่อคีย์ที่ต้องการดึง (camelCase เช่น 'adminBotToken')
 */
export function getConfig(key) {
    // โค้ดนี้จะตรวจสอบว่าค่า Token หรือ Config มีค่าเป็น undefined หรือไม่
    if (appConfig[key] === undefined) {
        // หากโค้ดพยายามเรียกใช้คีย์ที่ไม่มีอยู่จริงใน DB หรือ ENV ให้แจ้งเตือน
        console.error(`ERROR: Config key "${key}" not found. Check SystemConfig table or .env file.`);
    }
    return appConfig[key];
}