// app.js
import 'dotenv/config'; 
import { Telegraf } from 'telegraf';
import express from 'express';
import { loadConfig, getConfig } from './src/config/config.js';
import { loadAdminCache } from './src/services/admin.service.js';
import { handleAdminCommand } from './src/handlers/admin.handlers.js'; 
// import { runScheduler } from './src/jobs/scheduler.js'; 

const PORT = process.env.PORT || 3000;
const app = express();

async function startBot() {
    console.log("Starting Admin Bot initialization...");
    
    await loadConfig();
    await loadAdminCache();

    const ADMIN_BOT_TOKEN = getConfig('adminBotToken');
    const TIMEZONE = getConfig('systemTimezone');
    if (!ADMIN_BOT_TOKEN) throw new Error("ADMIN_BOT_TOKEN is missing.");

    const bot = new Telegraf(ADMIN_BOT_TOKEN);

    // 1. ตั้งค่า Webhook
    app.use(express.json()); 
    app.post(`/webhook/admin`, (req, res) => {
        bot.handleUpdate(req.body);
        res.sendStatus(200);
    });

    // 2. กำหนด Listener หลัก
    bot.on('message', handleAdminCommand);

    // 3. ตั้งค่า Webhook บน Telegram API
    const webhookUrl = `${process.env.PUBLIC_URL}/webhook/admin`;
    await bot.telegram.setWebhook(webhookUrl);
    console.log(`✅ Admin Bot Webhook set to: ${webhookUrl}`);

    // 4. รัน Cron Scheduler 
    // runScheduler(TIMEZONE); 
    
    // 5. รันเซิร์ฟเวอร์ Express
    app.listen(PORT, () => {
        console.log(`⚡️ Admin Bot listening on port ${PORT}`);
    });
}

startBot().catch(err => {
    console.error("Critical error during Admin Bot startup:", err);
    process.exit(1);
});