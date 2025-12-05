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
        // Log เฉพาะ API Request
        if (req.url.startsWith('/api')) {
            console.log(`📥 [API REQUEST] ${req.method} ${req.url}`);
        }
        next();
    });

    // Health Check
    app.get('/health', (req, res) => {
        res.send('✅ Loyalty Bot is online and running!');
    });

    // ⭐️ เชื่อมต่อ API Routes
    app.use('/api', apiRoutes);

    // ✅ [DEBUG] เพิ่มโค้ดสำหรับ Log-Route
    if (apiRoutes.stack) {
        console.log("==================== Registered API Routes ====================");
        apiRoutes.stack.forEach(middleware => {
            if (middleware.route) { // BINGO! This is a route.
                const path = middleware.route.path;
                const methods = Object.keys(middleware.route.methods).join(', ').toUpperCase();
                console.log(`✅ ${methods} - /api${path}`);
            }
        });
        console.log("=============================================================");
    }

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
    // ดักจับ GET requests ทั้งหมดที่ยังไม่ถูก match (ที่ไม่ใช่ API/webhook)
    // และส่ง index.html กลับไป เพื่อให้ client-side router ทำงาน
    app.get('*', (req, res, next) => {
        // เช็คว่าเป็น request ที่ควรจะถูกจัดการโดย SPA หรือไม่
        if (req.url.startsWith('/api') || req.url.startsWith('/webhook')) {
            // ถ้าเป็น API หรือ webhook ที่หลุดมาถึงตรงนี้ ให้ส่งต่อไปยัง 404 handler
            return next();
        }
        
        // สำหรับ route อื่นๆ ทั้งหมด, ส่งหน้าหลักของ SPA กลับไป
        res.sendFile(path.join(__dirname, 'public', 'index.html'));
    });

    // Middleware สำหรับจัดการ 404 (เมื่อไม่มี route ไหน match)
    app.use((req, res, next) => {
        res.status(404).json({
            error: 'Not Found',
            message: `The requested URL ${req.originalUrl} was not found on this server.`
        });
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