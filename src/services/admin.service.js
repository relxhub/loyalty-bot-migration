// src/services/admin.service.js
import { prisma } from '../db.js';

let adminCache = {};

export async function loadAdminCache() {
    const admins = await prisma.admin.findMany({
        select: { telegramId: true, role: true }
    });
    const newCache = {};
    admins.forEach(admin => {
        newCache[admin.telegramId] = admin.role;
    });
    adminCache = newCache;
    console.log(`✅ Loaded ${admins.length} admin roles into cache.`);
}

export async function getAdminRole(telegramId) {
    if (adminCache[telegramId]) return adminCache[telegramId];

    const admin = await prisma.admin.findUnique({
        where: { telegramId: telegramId },
        select: { role: true }
    });

    if (admin) {
        adminCache[telegramId] = admin.role;
        return admin.role;
    }
    return null;
}