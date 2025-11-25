// app.js (ฉบับเพิ่ม Health Check & Logger)

import 'dotenv/config'; 
import { Telegraf } from 'telegraf';
import express from 'express';
import { loadConfig, getConfig } from './src/config/config.js';
import { loadAdminCache } from './src/services/admin.service.js';
import { handleAdminCommand } from './src/handlers/admin.handlers.js'; 
import { handleCustomerCommand } from './src/handlers/customer.handlers.js';

const PORT = process.env.PORT || 3000;
const app = express();

async function startServer() {
    console.log("🚀 Starting Unified Server...");
    
    // 1. โหลด Config
    await loadConfig();
    await loadAdminCache();

    const PUBLIC_URL = process.env.PUBLIC_URL;
    if (!PUBLIC_URL) throw new Error("PUBLIC_URL is missing");

    // 2. ตั้งค่า Express
    app.use(express.json()); 

    // ⭐️ เพิ่ม: Logger (ดูว่ามีใครส่งอะไรมาไหม)
    app.use((req, res, next) => {
        console.log(`📥 [INCOMING] ${req.method} ${req.url}`);
        next();
    });

    // ⭐️ เพิ่ม: Health Check (หน้าแรกสำหรับเปิดใน Browser)
    app.get('/', (req, res) => {
        res.send('✅ Loyalty Bot is online and running!');
    });

    // 🤖 ADMIN BOT SETUP
    const adminToken = getConfig('adminBotToken');
    const adminBot = new Telegraf(adminToken);
    adminBot.on('message', handleAdminCommand);
    
    app.post(`/webhook/admin`, (req, res) => {
        adminBot.handleUpdate(req.body);
        res.sendStatus(200);
    });
    
    await adminBot.telegram.setWebhook(`${PUBLIC_URL}/webhook/admin`);
    console.log(`✅ Admin Bot Webhook set`);

    // 👤 CUSTOMER BOT SETUP
    const customerToken = getConfig('customerBotToken');
    const customerBot = new Telegraf(customerToken);
    customerBot.on('message', handleCustomerCommand);
    
    app.post(`/webhook/customer`, (req, res) => {
        customerBot.handleUpdate(req.body);
        res.sendStatus(200);
    });
    
    await customerBot.telegram.setWebhook(`${PUBLIC_URL}/webhook/customer`);
    console.log(`✅ Customer Bot Webhook set`);

    // 3. เปิด Server
    app.listen(PORT, () => {
        console.log(`⚡️ Server listening on port ${PORT}`);
    });
}

startServer().catch(err => {
    console.error("Critical error during startup:", err);
    process.exit(1);
});