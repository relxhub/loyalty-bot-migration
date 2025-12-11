// src/config/config.js
import { prisma } from '../db.js';

let configCache = null;

/**
 * Loads configuration from both the database (SystemConfig table) and environment variables.
 * Database values take precedence for dynamic settings.
 */
export async function loadConfig() {
    console.log("🔄 Loading configuration...");
    configCache = {};

    // 1. Load dynamic configs from the database
    try {
        const dbConfigs = await prisma.systemConfig.findMany();
        dbConfigs.forEach(config => {
            configCache[config.key] = config.value;
        });
        console.log(`✅ Loaded ${dbConfigs.length} settings from database.`);
    } catch (error) {
        console.error("⚠️ Could not load config from DB. Falling back to env vars.", error.message);
    }

    // 2. Load essential configs from environment variables
    // These are critical for startup and should always be in .env
    const essentialKeys = [
        'DATABASE_URL',
        'ADMIN_BOT_TOKEN',
        'ORDER_BOT_TOKEN',
        'PUBLIC_URL',
        'SUPER_ADMIN_TELEGRAM_ID'
    ];
    
    essentialKeys.forEach(key => {
        const camelCaseKey = key.replace(/_([A-Z])/g, (g) => g[1].toUpperCase());
        configCache[camelCaseKey] = process.env[key];
    });

    // --- Debugging: Log essential environment variables to help diagnose missing values ---
    console.log("--- Environment Variables ---");
    console.log(`ADMIN_BOT_TOKEN: ${process.env.ADMIN_BOT_TOKEN ? '✅ FOUND' : '❌ MISSING'}`);
    console.log(`ORDER_BOT_TOKEN: ${process.env.ORDER_BOT_TOKEN ? '✅ FOUND' : '❌ MISSING'}`); // <<< This is what we need to verify
    console.log(`PUBLIC_URL: ${process.env.PUBLIC_URL ? '✅ FOUND' : '❌ MISSING'}`);
    console.log(`SUPER_ADMIN_TELEGRAM_ID: ${process.env.SUPER_ADMIN_TELEGRAM_ID ? '✅ FOUND' : '❌ MISSING'}`);
    console.log("---------------------------");
    // --- End Debugging ---

    // Railway specific fallback for PUBLIC_URL
    // If PUBLIC_URL is not set, try to build it from Railway's provided env vars.
    if (!configCache.publicUrl && process.env.RAILWAY_PUBLIC_DOMAIN) {
        configCache.publicUrl = `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
        console.log(`✅ PUBLIC_URL not set, automatically using Railway domain: ${configCache.publicUrl}`);
    }
    // --- End Railway specific fallback ---

    console.log("👍 Configuration loaded.");
}

/**
 * Gets a configuration value from the cache.
 * @param {string} key The key of the config value to retrieve.
 * @param {any} defaultValue A default value to return if the key is not found.
 * @returns {string | any} The configuration value.
 */
export function getConfig(key, defaultValue = null) {
    if (!configCache) {
        throw new Error("FATAL: Config not loaded! Call loadConfig() at startup.");    
    }
    
    const value = configCache[key];

    if (value === undefined || value === null) {
        // For certain keys, we want to warn the user if they're missing, as it might be an issue.
        const criticalKeys = ['orderBotUsername', 'standardReferralPoints', 'standardLinkBonus'];
        if (criticalKeys.includes(key)) {
            console.warn(`⚠️ Config key "${key}" is missing or null. Using default value: ${defaultValue}`);
        }
        return defaultValue;
    }
    
    return value;
}
