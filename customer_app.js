// customer_app.js
import 'dotenv/config'; 
import { Telegraf } from 'telegraf';
import express from 'express';
import { loadConfig, getConfig } from './src/config/config.js';
import { handleCustomerCommand } from './src/handlers/customer.handlers.js'; 

const PORT = process.env.PORT || 3001; 
const app = express();

async function startCustomerBot() {
    console.log("Starting Customer Bot initialization...");
    
    // 1. โหลด Config
    await loadConfig();
    
    // 2. ดึง Token ลูกค้าโดยเฉพาะ
    const CUSTOMER_BOT_TOKEN = getConfig('customerBotToken');
    if (!CUSTOMER_BOT_TOKEN) throw new Error("CUSTOMER_BOT_TOKEN is missing in config.");

    const bot = new Telegraf(CUSTOMER_BOT_TOKEN);

    // 3. ตั้งค่า Webhook (ใช้ endpoint /webhook/customer)
    app.use(express.json()); 
    app.post(`/webhook/customer`, (req, res) => {
        bot.handleUpdate(req.body);
        res.sendStatus(200);
    });

    // 4. กำหนด Listener หลัก
    bot.on('message', handleCustomerCommand);

    // 5. ตั้งค่า Webhook บน Telegram API
    const webhookUrl = `${process.env.PUBLIC_URL}/webhook/customer`;
    await bot.telegram.setWebhook(webhookUrl);
    console.log(`✅ Customer Bot Webhook set to: ${webhookUrl}`);

    // 6. รันเซิร์ฟเวอร์ Express
    app.listen(PORT, () => {
        console.log(`⚡️ Customer Bot listening on port ${PORT}`);
    });
}

startCustomerBot().catch(err => {
    console.error("Critical error during Customer Bot startup:", err);
    process.exit(1);
});