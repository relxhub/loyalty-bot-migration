import { prisma } from '../db.js';

let appConfig = {};

/**
 * โหลดค่าตั้งค่าทั้งหมดจากฐานข้อมูล (SystemConfig) และ Environment Variables (Secrets)
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

    // ---------------------------------------------------
    // 🔍 DEBUG SECTION: ตรวจสอบว่า Railway ส่งค่ามาให้หรือไม่?
    // (ส่วนนี้จะช่วยบอกเราว่าตัวแปรไหน Missing)
    // ---------------------------------------------------
    console.log("\n===================================================");
    console.log("🔍 DEBUG: Checking Environment Variables...");
    console.log("ADMIN_BOT_TOKEN:", process.env.ADMIN_BOT_TOKEN ? "✅ FOUND" : "❌ MISSING");
    console.log("ORDER_BOT_TOKEN:", process.env.ORDER_BOT_TOKEN ? "✅ FOUND" : "❌ MISSING");
    console.log("CUSTOMER_BOT_TOKEN:", process.env.CUSTOMER_BOT_TOKEN ? "✅ FOUND" : "❌ MISSING");
    console.log("SUPER_ADMIN_CHAT_ID:", process.env.SUPER_ADMIN_CHAT_ID ? "✅ FOUND" : "❌ MISSING");
    console.log("===================================================\n");
    // ---------------------------------------------------

    // 2. โหลด Secrets จาก Environment Variables (ENV) 
    // โค้ดจะดึงค่าจากตัวพิมพ์ใหญ่ (Snake_Case) และเก็บเป็นตัวพิมพ์เล็ก (camelCase)
    appConfig.adminBotToken = process.env.ADMIN_BOT_TOKEN;       // 1. Admin Bot
    appConfig.customerBotToken = process.env.CUSTOMER_BOT_TOKEN;   // 2. Customer Bot
    appConfig.orderBotToken = process.env.ORDER_BOT_TOKEN;         // 3. Order Bot
    
    appConfig.superAdminChatId = process.env.SUPER_ADMIN_CHAT_ID;
    appConfig.systemTimezone = process.env.SYSTEM_TIMEZONE; 

    return appConfig;
}

/**
 * ฟังก์ชันสำหรับเข้าถึงค่า Config ที่โหลดไว้
 * @param {string} key ชื่อคีย์ที่ต้องการดึง (camelCase)
 */
export function getConfig(key) {
    // โค้ดนี้จะตรวจสอบว่าค่า Token หรือ Config มีค่าเป็น undefined หรือไม่
    if (appConfig[key] === undefined) {
        console.error(`ERROR: Config key "${key}" not found. Check SystemConfig table or .env file.`);
    }
    return appConfig[key];
}