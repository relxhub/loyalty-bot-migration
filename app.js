// app.js (ฉบับสมบูรณ์ - เปิดใช้งานทุกระบบ)

import 'dotenv/config'; 
import { Telegraf } from 'telegraf';
import express from 'express';
import { loadConfig, getConfig } from './src/config/config.js';
import { loadAdminCache } from './src/services/admin.service.js';

// Import Handlers
import { handleAdminCommand } from './src/handlers/admin.handlers.js'; 
import { handleCustomerCommand } from './src/handlers/customer.handlers.js';

// ⭐️ Import Scheduler (สำหรับงานตัดแต้มอัตโนมัติ)
import { runScheduler } from './src/jobs/scheduler.js'; 

const PORT = process.env.PORT || 3000;
const app = express();

async function startServer() {
    console.log("🚀 Starting Unified Server...");
    
    // 1. โหลด Config และ Cache
    await loadConfig();
    await loadAdminCache();

    const PUBLIC_URL = process.env.PUBLIC_URL;
    if (!PUBLIC_URL) throw new Error("PUBLIC_URL is missing");

    // 2. ตั้งค่า Express
    app.use(express.json()); 

    // Logger
    app.use((req, res, next) => {
        console.log(`📥 [INCOMING] ${req.method} ${req.url}`);
        next();
    });

    // Health Check
    app.get('/', (req, res) => {
        res.send('✅ Loyalty Bot is online and running!');
    });

    // =========================================
    // 🤖 ส่วนที่ 1: ADMIN BOT SETUP
    // =========================================
    const adminToken = getConfig('adminBotToken');
    const adminBot = new Telegraf(adminToken);
    
    adminBot.on('message', handleAdminCommand);
    
    app.post(`/webhook/admin`, (req, res) => {
        adminBot.handleUpdate(req.body);
        res.sendStatus(200);
    });
    
    await adminBot.telegram.setWebhook(`${PUBLIC_URL}/webhook/admin`);
    console.log(`✅ Admin Bot Webhook Ready`);


    // =========================================
    // 👤 ส่วนที่ 2: CUSTOMER BOT SETUP
    // =========================================
    const customerToken = getConfig('customerBotToken');
    const customerBot = new Telegraf(customerToken);
    
    customerBot.on('message', handleCustomerCommand);
    
    app.post(`/webhook/customer`, (req, res) => {
        customerBot.handleUpdate(req.body);
        res.sendStatus(200);
    });
    
    await customerBot.telegram.setWebhook(`${PUBLIC_URL}/webhook/customer`);
    console.log(`✅ Customer Bot Webhook Ready`);


    // =========================================
    // ⏰ ส่วนที่ 3: SCHEDULER (เปิดใช้งานแล้ว) ⭐️
    // =========================================
    const TIMEZONE = getConfig('systemTimezone');
    
    // เรียกใช้ Scheduler เพื่อเริ่มนับถอยหลังตัดแต้ม/แจ้งเตือน
    runScheduler(TIMEZONE); 
    console.log(`✅ Scheduler started for Timezone: ${TIMEZONE}`);


    // 3. เปิดประตูรับแขก (Listen)
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`⚡️ Server listening on port ${PORT}`);
    });
}

startServer().catch(err => {
    console.error("Critical error during startup:", err);
    process.exit(1);
});