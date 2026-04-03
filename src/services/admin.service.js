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
    // ดึงจาก DB โดยตรงเสมอเพื่อให้รองรับการแก้ไขผ่าน Prisma Studio ได้ทันที
    const admin = await prisma.admin.findUnique({
        where: { telegramId: telegramId },
        select: { role: true }
    });

    if (admin) {
        // อัปเดต Cache ไปด้วยในตัว
        adminCache[telegramId] = admin.role;
        return admin.role;
    }
    
    // ถ้าไม่เจอใน DB ให้ล้าง Cache ของ ID นี้ (ถ้ามี)
    delete adminCache[telegramId];
    return null;
}