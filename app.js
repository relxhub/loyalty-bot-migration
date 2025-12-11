// app.js (Corrected Structure)

import 'dotenv/config';
import path from 'path';
import { fileURLToPath } from 'url';

// 🛡️ Error Handlers
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

// ✅ Path setup
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;
const app = express();

// =========================================
// 🤖 BOT INSTANTIATION (Top Level)
// =========================================
// We instantiate bots here so they can be exported.
// Tokens are loaded from process.env, which is available due to 'dotenv/config' import.
// The main configuration (webhooks, etc.) happens inside startServer after config is fully loaded.

const adminToken = process.env.ADMIN_BOT_TOKEN;
if (!adminToken) throw new Error("ADMIN_BOT_TOKEN is missing from .env");
const adminBot = new Telegraf(adminToken);

const orderBotToken = process.env.ORDER_BOT_TOKEN;
if (!orderBotToken) throw new Error("ORDER_BOT_TOKEN is missing from .env");
export const customerBot = new Telegraf(orderBotToken); // Exported for use in other services

// =========================================
// 🚀 SERVER STARTUP
// =========================================
async function startServer() {
    console.log("🚀 Starting Unified Server...");

    // 1. Load Config from DB and Cache Admins
    await loadConfig();
    await loadAdminCache();

    const PUBLIC_URL = getConfig('publicUrl');
    if (!PUBLIC_URL) throw new Error("PUBLIC_URL is missing from config");

    // 2. Express Setup
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

    // API Route Logging
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
    // 🤖 BOT CONFIGURATION (Inside startServer)
    // =========================================
    // --- Admin Bot Webhook ---
    adminBot.on('message', handleAdminCommand);
    app.post(`/webhook/admin`, (req, res) => {
        adminBot.handleUpdate(req.body);
        res.sendStatus(200);
    });
    await adminBot.telegram.setWebhook(`${PUBLIC_URL}/webhook/admin`);
    console.log(`✅ Admin Bot Webhook Ready`);

    // --- Order Bot Mini App Menu ---
    const webAppUrl = `${PUBLIC_URL}/home.html`;
    await customerBot.telegram.setChatMenuButton({
        menuButton: {
            type: 'web_app',
            text: 'Loyalty App',
            web_app: { url: webAppUrl }
        }
    });
    console.log(`✅ Order Bot Menu Button configured for Mini App.`);
    // Note: No webhook is set for customerBot here, as intended.

    // =========================================
    // ⏰ SCHEDULER
    // =========================================
    const TIMEZONE = getConfig('systemTimezone');
    runScheduler(TIMEZONE);
    console.log(`✅ Scheduler started`);

    // =========================================
    // 🌐 FRONTEND ROUTING (SPA Fallback)
    // =========================================
    app.get('*', (req, res, next) => {
        if (req.url.startsWith('/api') || req.url.startsWith('/webhook')) {
            return next();
        }
        res.sendFile(path.join(__dirname, 'public', 'index.html'));
    });

    // 404 Handler
    app.use((req, res, next) => {
        res.status(404).json({
            error: 'Not Found',
            message: `The requested URL ${req.originalUrl} was not found on this server.`
        });
    });

    // 3. Start Server
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`⚡️ Server listening on port ${PORT}`);
    });
}

startServer().catch(err => {
    console.error("Critical error during startup:", err);
    process.exit(1);
});