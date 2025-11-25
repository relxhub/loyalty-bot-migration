// app.js (ฉบับรวมร่าง - แก้ปัญหา Port Railway)

import 'dotenv/config'; 
import { Telegraf } from 'telegraf';
import express from 'express';
import { loadConfig, getConfig } from './src/config/config.js';
import { loadAdminCache } from './src/services/admin.service.js';

// Import Handlers ของทั้ง 2 บอท
import { handleAdminCommand } from './src/handlers/admin.handlers.js'; 
import { handleCustomerCommand } from './src/handlers/customer.handlers.js';

// Import Scheduler (ยัง Bypass ไว้ก่อน)
// import { runScheduler } from './src/jobs/scheduler.js'; 

// ⭐️ ใช้ PORT จาก Railway เป็นหลัก (สำคัญมาก)
const PORT = process.env.PORT || 3000;
const app = express();

async function startServer() {
    console.log("🚀 Starting Unified Server...");
    
    // 1. โหลด Config และ Cache
    await loadConfig();
    await loadAdminCache();

    const PUBLIC_URL = process.env.PUBLIC_URL;
    if (!PUBLIC_URL) throw new Error("PUBLIC_URL is missing");

    // 2. ตั้งค่า Express (ประตูหลัก)
    app.use(express.json()); 

    // =========================================
    // 🤖 ส่วนที่ 1: ADMIN BOT SETUP
    // =========================================
    const adminToken = getConfig('adminBotToken');
    const adminBot = new Telegraf(adminToken);
    
    // กำหนด Logic
    adminBot.on('message', handleAdminCommand);
    
    // กำหนด Webhook Route
    app.post(`/webhook/admin`, (req, res) => {
        adminBot.handleUpdate(req.body);
        res.sendStatus(200);
    });
    
    // บอก Telegram ให้ส่งมาที่นี่
    await adminBot.telegram.setWebhook(`${PUBLIC_URL}/webhook/admin`);
    console.log(`✅ Admin Bot Webhook Ready`);


    // =========================================
    // 👤 ส่วนที่ 2: CUSTOMER BOT SETUP
    // =========================================
    const customerToken = getConfig('customerBotToken');
    const customerBot = new Telegraf(customerToken);
    
    // กำหนด Logic
    customerBot.on('message', handleCustomerCommand);
    
    // กำหนด Webhook Route (ใช้ App ตัวเดิม แต่คนละ Path)
    app.post(`/webhook/customer`, (req, res) => {
        customerBot.handleUpdate(req.body);
        res.sendStatus(200);
    });
    
    // บอก Telegram ให้ส่งมาที่นี่
    await customerBot.telegram.setWebhook(`${PUBLIC_URL}/webhook/customer`);
    console.log(`✅ Customer Bot Webhook Ready`);


    // =========================================
    // ⏰ ส่วนที่ 3: SCHEDULER (Bypassed)
    // =========================================
    /*
    const TIMEZONE = getConfig('systemTimezone');
    runScheduler(TIMEZONE);
    */

    // 3. เปิดประตูรับแขก (Listen)
    app.listen(PORT, () => {
        console.log(`⚡️ Server listening on port ${PORT}`);
        console.log(`   - Admin Bot path: /webhook/admin`);
        console.log(`   - Customer Bot path: /webhook/customer`);
    });
}

startServer().catch(err => {
    console.error("Critical error during startup:", err);
    process.exit(1);
});