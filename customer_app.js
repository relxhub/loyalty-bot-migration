// customer_app.js (ฉบับสมบูรณ์)

import 'dotenv/config'; 
import { Telegraf } from 'telegraf';
import express from 'express';
import { loadConfig, getConfig } from './src/config/config.js';
// ⭐️ แก้ไข: Import handler ที่ถูกต้องสำหรับลูกค้าเท่านั้น ⭐️
import { handleCustomerCommand } from './src/handlers/customer.handlers.js'; 

const PORT = process.env.PORT || 3001; // รันบน Port 3001 เพื่อหลีกเลี่ยง Port Conflict กับ Admin Bot
const app = express();

async function startCustomerBot() {
    console.log("Starting Customer Bot initialization...");
    
    // 1. โหลด Configs และ Tokens
    await loadConfig();
    
    const CUSTOMER_BOT_TOKEN = getConfig('customerBotToken');
    if (!CUSTOMER_BOT_TOKEN) throw new Error("CUSTOMER_BOT_TOKEN is missing in config.");

    const bot = new Telegraf(CUSTOMER_BOT_TOKEN);

    // 2. ตั้งค่า Webhook Listener (รับข้อความขาเข้า)
    app.use(express.json()); 
    app.post(`/webhook/customer`, (req, res) => {
        bot.handleUpdate(req.body);
        res.sendStatus(200);
    });

    // 3. กำหนด Listener หลัก: ส่งคำสั่งทั้งหมดไปที่ Customer Handler
    bot.on('message', handleCustomerCommand);

    // 4. ตั้งค่า Webhook บน Telegram API
    const webhookUrl = `${process.env.PUBLIC_URL}/webhook/customer`;
    await bot.telegram.setWebhook(webhookUrl);
    console.log(`✅ Customer Bot Webhook set to: ${webhookUrl}`);

    // 5. รันเซิร์ฟเวอร์ Express
    app.listen(PORT, () => {
        console.log(`⚡️ Customer Bot listening on port ${PORT}`);
    });
}

startCustomerBot().catch(err => {
    console.error("Critical error during Customer Bot startup:", err);
    process.exit(1);
});