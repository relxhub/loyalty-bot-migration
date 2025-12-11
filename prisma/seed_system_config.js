// prisma/seed_system_config.js
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/**
 * This is the single source of truth for the system's dynamic configuration.
 * When you run `npx prisma db seed`, these values will be inserted into the
 * SystemConfig table in your database.
 * 
 * After seeding, you should manage these values directly in your database
 * using Prisma Studio (`npx prisma studio`).
 */
const configs = [
    // --- Bot Settings ---
    { 
        key: 'orderBotUsername', 
        value: 'YOUR_ORDER_BOT_USERNAME_HERE' // 👈 !!! IMPORTANT: Replace with your Order Bot's username without the '@'
    },

    // --- Points & Bonus Settings ---
    { 
        key: 'standardReferralPoints', 
        value: '50' // Points awarded for a successful referral
    },
    { 
        key: 'standardLinkBonus', 
        value: '50' // Points awarded for linking a new account
    },

    // --- Expiry Logic Settings (in days) ---
    { 
        key: 'expiryDaysLinkAccount', 
        value: '7' // How many days to extend expiry when a user links their account
    },
    { 
        key: 'expiryDaysAddPoints', 
        value: '30' // How many days to extend expiry when an admin adds points
    },
    { 
        key: 'expiryDaysLimitMax', 
        value: '60' // The maximum number of days into the future an expiry date can be set to
    },
];

async function seedSystemConfig() {
    console.log(`🌱 Seeding SystemConfig...`);
    let count = 0;
    for (const config of configs) {
        const result = await prisma.systemConfig.upsert({
            where: { key: config.key },
            update: {
                // We update the value here to ensure that re-running seed can update defaults if needed.
                // In production, you'd manage this via Prisma Studio.
                value: config.value 
            },
            create: {
                key: config.key,
                value: config.value,
            },
        });
        if (result) count++;
    }
    console.log(`✅ Finished seeding ${count}/${configs.length} settings into SystemConfig.`);
}

export default seedSystemConfig;