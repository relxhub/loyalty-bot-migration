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
    app.use(express.static(path.join(__dirname, 'public')));
    
    app.use((req, res, next) => {
        res.header("Access-Control-Allow-Origin", "*");
        res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
        next();
    });

    app.use((req, res, next) => {
        if (req.url.startsWith('/api')) {
            console.log(`📥 [API REQUEST] ${req.method} ${req.url}`);
        }
        next();
    });

    app.get('/health', (req, res) => {
        res.send('✅ Loyalty Bot is online and running!');
    });

    app.use('/api', apiRoutes);

    if (apiRoutes.stack) {
        console.log("==================== Registered API Routes ====================");
        apiRoutes.stack.forEach(middleware => {
            if (middleware.route) {
                const path = middleware.route.path;
                const methods = Object.keys(middleware.route.methods).join(', ').toUpperCase();
                console.log(`✅ ${methods} - /api${path}`);
            }
        });
        console.log("=============================================================");
    }

    // =========================================
    // 🤖 ADMIN & ORDER BOT SETUP
    // =========================================
    // --- Admin Bot Setup ---
    const adminToken = getConfig('adminBotToken');
    if (!adminToken) throw new Error("ADMIN_BOT_TOKEN is missing from config");
    const adminBot = new Telegraf(adminToken);
    adminBot.on('message', handleAdminCommand);
    app.post(`/webhook/admin`, (req, res) => {
        adminBot.handleUpdate(req.body);
        res.sendStatus(200);
    });
    await adminBot.telegram.setWebhook(`${PUBLIC_URL}/webhook/admin`);
    console.log(`✅ Admin Bot Webhook Ready`);
    
    // --- Order Bot Setup ---
    // The Order Bot is used for two purposes:
    // 1. Sending outbound notifications (requires token).
    // 2. Providing a menu button to launch the Mini App (requires token).
    // It does NOT use a webhook here, as inbound messages are handled by another service (e.g., Respond.io).
    const orderBotToken = getConfig('orderBotToken');
    if (!orderBotToken) throw new Error("ORDER_BOT_TOKEN is missing from config");
    export const customerBot = new Telegraf(orderBotToken); // Export for notification service    
    // Set the Mini App menu button for the Order Bot
    const webAppUrl = `${PUBLIC_URL}/home.html`; 
    await customerBot.telegram.setChatMenuButton({
        menuButton: {
            type: 'web_app',
            text: 'Loyalty App', // Text on the menu button
            web_app: { url: webAppUrl }
        }
    });
    console.log(`✅ Order Bot Menu Button configured for Mini App.`);
    
    // We explicitly DO NOT set up a webhook for the customer/order bot here.
        
    // =========================================
    // ⏰ SCHEDULER
    // =========================================
    const TIMEZONE = getConfig('systemTimezone');
    runScheduler(TIMEZONE); 
    console.log(`✅ Scheduler started`);

    // =========================================
    // 🌐 [สำคัญ] FRONTEND ROUTING (SPA Fallback)
    // =========================================
    app.get('*', (req, res, next) => {
        if (req.url.startsWith('/api') || req.url.startsWith('/webhook')) {
            return next();
        }
        res.sendFile(path.join(__dirname, 'public', 'index.html'));
    });

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
