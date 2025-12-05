// app.js (ฉบับแก้ไข: รองรับ Magic Link ทุกรูปแบบ)

import 'dotenv/config'; 
import path from 'path';
import { fileURLToPath } from 'url';

// 🛡️ เพิ่มตัวดัก Error
process.on('uncaughtException', (err) => {
  console.error('💥 CRITICAL ERROR:', err);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('💥 UNHANDLED PROMISE:', reason);
});

console.log("🟢 App is starting...");
import { Telegraf } from 'telegraf';
import express from 'express';
import { loadConfig, getConfig } from './src/config/config.js';
import { loadAdminCache } from './src/services/admin.service.js';

// Import Handlers
import { handleAdminCommand } from './src/handlers/admin.handlers.js'; 
import { handleCustomerCommand } from './src/handlers/customer.handlers.js';

// Import API Routes
import apiRoutes from './src/routes/api.routes.js';

// Import Scheduler
import { runScheduler } from './src/jobs/scheduler.js'; 

// ✅ กำหนด Path ปัจจุบัน
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
    // ✅ Serve ไฟล์ Static (รูป, css, js)
    app.use(express.static(path.join(__dirname, 'public')));
    
    // CORS
    app.use((req, res, next) => {
        res.header("Access-Control-Allow-Origin", "*");
        res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
        next();
    });

    // Logger
    app.use((req, res, next) => {
        if (!req.url.includes('.')) { // ไม่ต้อง Log พวกไฟล์รูปภาพ/js ให้รก
            console.log(`📥 [INCOMING] ${req.method} ${req.url}`);
        }
        next();
    });

    // Health Check (ย้ายไปไว้ที่ /health แทน)
    app.get('/health', (req, res) => {
        res.send('✅ Loyalty Bot is online and running!');
    });

    // ⭐️ เชื่อมต่อ API Routes
    app.use('/api', apiRoutes);

    // =========================================
    // 🤖 ADMIN & CUSTOMER BOT SETUP
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
    // ⏰ SCHEDULER
    // =========================================
    const TIMEZONE = getConfig('systemTimezone');
    runScheduler(TIMEZONE); 
    console.log(`✅ Scheduler started`);

    // =========================================
    // 🌐 [สำคัญ] FRONTEND ROUTING (SPA Fallback)
    // =========================================
    // ดักจับทุก Route ที่ไม่ใช่ API และไม่ใช่ Webhook ให้ส่งหน้า index.html ไปแสดง
    // วิธีนี้จะแก้ปัญหา 404 ไม่ว่าจะเข้าผ่าน /, /app, หรือ /login
    app.get('*', (req, res) => {
        // ถ้าเป็น API หรือ Webhook แต่หลุดมาถึงตรงนี้ ให้ตอบ 404 จริงๆ
        if (req.url.startsWith('/api') || req.url.startsWith('/webhook')) {
             return res.status(404).json({ error: 'Not Found' });
        }
        // นอกนั้นส่งหน้าเว็บไปให้หมด
        res.sendFile(path.join(__dirname, 'public', 'index.html'));
    });

    // 3. เริ่ม Server
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`⚡️ Server listening on port ${PORT}`);
    });
}

startServer().catch(err => {
    console.error("Critical error during startup:", err);
    process.exit(1);
});