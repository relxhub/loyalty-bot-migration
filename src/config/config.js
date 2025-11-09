// src/config/config.js

import { prisma } from '../db.js';

let appConfig = {};

/**
 * โหลดค่าตั้งค่าทั้งหมดจากฐานข้อมูล (SystemConfig) และ Environment Variables (Secrets)
 * ต้องเรียกใช้เพียงครั้งเดียวเมื่อแอปพลิเคชันเริ่มทำงาน
 */
export async function loadConfig() {
    // 1. โหลดค่าจากตาราง SystemConfig ใน DB
    const configs = await prisma.systemConfig.findMany();
    
    // แปลง Array ให้เป็น Object (Key-Value) และพยายามแปลงเป็นตัวเลข
    configs.forEach(item => {
        const numValue = parseInt(item.value);
        appConfig[item.key] = isNaN(numValue) ? item.value : numValue;
    });

    // 2. โหลด Secrets จาก Environment Variables (ENV) 
    // ใช้ตัวพิมพ์ใหญ่ (Snake_Case) ใน process.env และเก็บเป็นตัวพิมพ์เล็ก (CamelCase) ภายใน
    appConfig.adminBotToken = process.env.ADMIN_BOT_TOKEN;
    appConfig.customerBotToken = process.env.CUSTOMER_BOT_TOKEN;
    // ⭐️ โทเคนตัวที่ 3 ที่ทำให้เกิดปัญหา: ถูกเพิ่มเข้ามาแล้ว ⭐️
    appConfig.orderBotToken = process.env.ORDER_BOT_TOKEN; 
    
    appConfig.superAdminChatId = process.env.SUPER_ADMIN_CHAT_ID;
    appConfig.systemTimezone = process.env.SYSTEM_TIMEZONE; 

    return appConfig;
}

/**
 * ฟังก์ชันสำหรับเข้าถึงค่า Config ที่โหลดไว้
 * @param {string} key ชื่อคีย์ที่ต้องการดึง (camelCase)
 */
export function getConfig(key) {
    if (appConfig[key] === undefined) {
        // หากโค้ดพยายามเรียกใช้คีย์ที่ไม่มีอยู่จริงใน DB หรือ ENV ให้แจ้งเตือน
        console.error(`ERROR: Config key "${key}" not found. Check SystemConfig table or .env file.`);
    }
    return appConfig[key];
}