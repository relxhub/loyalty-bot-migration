// src/config/config.js
import { prisma } from '../db.js';

let appConfig = {};

export async function loadConfig() {
    // 1. โหลดค่าจากตาราง SystemConfig
    const configs = await prisma.systemConfig.findMany();
    
    configs.forEach(item => {
        const numValue = parseInt(item.value);
        appConfig[item.key] = isNaN(numValue) ? item.value : numValue;
    });

    // 2. โหลด Secrets จาก Environment Variables (.env)
    appConfig.adminBotToken = process.env.ADMIN_BOT_TOKEN;
    appConfig.customerBotToken = process.env.CUSTOMER_BOT_TOKEN;
    appConfig.superAdminChatId = process.env.SUPER_ADMIN_CHAT_ID;
    appConfig.systemTimezone = process.env.SYSTEM_TIMEZONE; 

    return appConfig;
}

export function getConfig(key) {
    if (appConfig[key] === undefined) {
        console.error(`ERROR: Config key "${key}" not found. Check SystemConfig table or .env file.`);
    }
    return appConfig[key];
}