// app.js (ฉบับรองรับ Mini App API)

import 'dotenv/config'; 
import { Telegraf } from 'telegraf';
import express from 'express';
import cors from 'cors'; // (Optional: อาจต้องใช้ถ้าทำ Frontend แยก)
import { loadConfig, getConfig } from './src/config/config.js';
import { loadAdminCache } from './src/services/admin.service.js';

// Import Handlers
import { handleAdminCommand } from './src/handlers/admin.handlers.js'; 
import { handleCustomerCommand } from './src/handlers/customer.handlers.js';

// ⭐️ Import API Routes (สำหรับ Mini App)
import apiRoutes from './src/routes/api.routes.js';

// Import Scheduler
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
    
    // (Optional) เปิด CORS ให้หน้าเว็บเรียก API ได้
    app.use((req, res, next) => {
        res.header("Access-Control-Allow-Origin", "*");
        res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
        next();
    });

    // Logger
    app.use((req, res, next) => {
        console.log(`📥 [INCOMING] ${req.method} ${req.url}`);
        next();
    });

    // Health Check
    app.get('/', (req, res) => {
        res.send('✅ Loyalty Bot is online and running!');
    });

    // ⭐️ เชื่อมต่อ API Routes (เข้าทาง /api/...)
    app.use('/api', apiRoutes);

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
    // ⏰ ส่วนที่ 3: SCHEDULER
    // =========================================
    const TIMEZONE = getConfig('systemTimezone');
    runScheduler(TIMEZONE); 
    console.log(`✅ Scheduler started for Timezone: ${TIMEZONE}`);


    // 3. เปิดประตูรับแขก (Listen)
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`⚡️ Server listening on port ${PORT}`);
        console.log(`   - API Endpoint: /api`);
    });
}

startServer().catch(err => {
    console.error("Critical error during startup:", err);
    process.exit(1);
});