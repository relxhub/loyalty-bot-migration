// app.js (Admin Bot Entry - ฉบับแก้ไข)

import 'dotenv/config'; 
import { Telegraf } from 'telegraf';
import express from 'express';
import { loadConfig, getConfig } from './src/config/config.js';
import { loadAdminCache } from './src/services/admin.service.js';
import { handleAdminCommand } from './src/handlers/admin.handlers.js'; 
import { runScheduler } from './src/jobs/scheduler.js'; // ยังคง import ไว้
import { sendAdminReply } from './src/services/notification.service.js';

const PORT = process.env.PORT || 3000;
const app = express();

async function startBot() {
    console.log("Starting Admin Bot initialization...");
    
    // 1. โหลดค่าตั้งค่า Dynamic จาก DB และ Secrets (ENV)
    await loadConfig();
    
    // 2. โหลดรายชื่อ Admin เข้า In-Memory Cache 
    await loadAdminCache();

    // 3. ดึง Token และ Timezone
    const ADMIN_BOT_TOKEN = getConfig('adminBotToken');
    const TIMEZONE = getConfig('systemTimezone');
    
    if (!ADMIN_BOT_TOKEN) {
        // แจ้งเตือนเมื่อ Token หาย (ซึ่งเคยเกิดมาก่อน)
        console.error("FATAL ERROR: ADMIN_BOT_TOKEN is missing in ENV/Config.");
        process.exit(1);
    }

    const bot = new Telegraf(ADMIN_BOT_TOKEN);

    // 4. ตั้งค่า Webhook
    app.use(express.json()); 
    app.post(`/webhook/admin`, (req, res) => {
        bot.handleUpdate(req.body);
        res.sendStatus(200); 
    });

    // 5. กำหนด Listener สำหรับคำสั่งทั้งหมด
    bot.on('message', handleAdminCommand);

    // 6. ตั้งค่า Webhook บน Telegram API
    const webhookUrl = `${process.env.PUBLIC_URL}/webhook/admin`;
    await bot.telegram.setWebhook(webhookUrl);
    console.log(`✅ Admin Bot Webhook set to: ${webhookUrl}`);

    // 7. ❌ BYPASS CRASH: คอมเมนต์ส่วน Scheduler ออกชั่วคราว ❌
    /*
    runScheduler(TIMEZONE); 
    console.log(`✅ Scheduler started for Timezone: ${TIMEZONE}`);
    */
    
    // 8. รันเซิร์ฟเวอร์ Express
    app.listen(PORT, () => {
        console.log(`⚡️ Admin Bot listening on port ${PORT}`);
    });
}

startBot().catch(err => {
    // ใช้ sendAdminReply เพื่อแจ้งเตือน Super Admin หากเป็นไปได้
    if (err.message.includes("FATAL ERROR")) {
        // ใช้ logic แจ้งเตือน (หรือแค่ log)
    }
    console.error("Critical error during bot startup:", err);
    process.exit(1);
});