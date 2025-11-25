import { prisma } from '../db.js';

let appConfig = {};

export async function loadConfig() {
    // 1. โหลดค่าจาก DB
    const configs = await prisma.systemConfig.findMany();
    configs.forEach(item => {
        const numValue = parseInt(item.value);
        appConfig[item.key] = isNaN(numValue) ? item.value : numValue;
    });

    // ⭐️ ส่วนที่เพิ่ม: Debugging Log (เช็คว่า ENV เข้ามาจริงไหม) ⭐️
    console.log("---------------------------------------------------");
    console.log("🔍 DEBUG: Checking Environment Variables...");
    console.log("ADMIN_BOT_TOKEN:", process.env.ADMIN_BOT_TOKEN ? "✅ FOUND" : "❌ MISSING");
    console.log("ORDER_BOT_TOKEN:", process.env.ORDER_BOT_TOKEN ? "✅ FOUND" : "❌ MISSING");
    console.log("CUSTOMER_BOT_TOKEN:", process.env.CUSTOMER_BOT_TOKEN ? "✅ FOUND" : "❌ MISSING");
    console.log("SUPER_ADMIN_CHAT_ID:", process.env.SUPER_ADMIN_CHAT_ID ? "✅ FOUND" : "❌ MISSING");
    console.log("---------------------------------------------------");

    // 2. โหลด Secrets
    appConfig.adminBotToken = process.env.ADMIN_BOT_TOKEN;
    appConfig.customerBotToken = process.env.CUSTOMER_BOT_TOKEN;
    appConfig.orderBotToken = process.env.ORDER_BOT_TOKEN;
    appConfig.superAdminChatId = process.env.SUPER_ADMIN_CHAT_ID;
    appConfig.systemTimezone = process.env.SYSTEM_TIMEZONE; 

    return appConfig;
}

export function getConfig(key) {
    if (appConfig[key] === undefined) {
        // console.error เอาไว้เหมือนเดิม
        console.error(`ERROR: Config key "${key}" not found.`);
    }
    return appConfig[key];
}