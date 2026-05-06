// src/services/notification-center.service.js
//
// In-app notification (กระดิ่งบน mini app)
// - createNotification(): สร้าง row + emit socket
// - notifyCustomer(): create + ส่ง Telegram chat msg (ถ้ามี telegramUserId)
// - list / unreadCount / markRead / markAllRead

import { prisma } from '../db.js';
import { sendNotificationToCustomer } from './notification.service.js';

let injectedIo = null;
export function setSocketIo(io) {
    injectedIo = io;
}

const VALID_KINDS = new Set([
    'REWARD_COUPON_GRANTED',
    'ORDER_STATUS_CHANGED',
    'POINTS_EARNED',
    'COUPON_EXPIRING_SOON',
    'ADMIN_BROADCAST',
]);

/**
 * สร้าง in-app notification + emit socket
 * - ใช้ unique (customerId, kind, entityKey) กันซ้ำ → P2002 = ของเดิมมีอยู่แล้ว ก็คืน null
 * - best-effort: error log แล้วคืน null ไม่ throw
 *
 * @param {object} p
 * @param {string} p.customerId
 * @param {string} p.kind         (NotificationKind)
 * @param {string} p.title
 * @param {string} p.body
 * @param {string} [p.link]
 * @param {object} [p.payload]    serialize เป็น JSON string ก่อนเก็บ
 * @param {string} [p.entityKey]  ใช้กันแจ้งซ้ำ
 * @returns {Promise<object|null>}
 */
export async function createNotification({ customerId, kind, title, body, link, payload, entityKey } = {}) {
    if (!customerId || !kind || !title || !body) {
        console.error('[Notif] missing required fields', { customerId, kind, hasTitle: !!title, hasBody: !!body });
        return null;
    }
    if (!VALID_KINDS.has(kind)) {
        console.error('[Notif] invalid kind:', kind);
        return null;
    }

    let row;
    try {
        row = await prisma.notification.create({
            data: {
                customerId,
                kind,
                title: String(title).slice(0, 200),
                body: String(body),
                link: link || null,
                payload: payload != null ? JSON.stringify(payload) : null,
                entityKey: entityKey || null,
            },
        });
    } catch (e) {
        // P2002 = unique violation → ของซ้ำ (กันแจ้งซ้ำสำเร็จ) → return null เงียบๆ
        if (e?.code === 'P2002') return null;
        console.error('[Notif] create failed:', e.message);
        return null;
    }

    // Emit socket — broadcast (client filter ตาม customerId)
    if (injectedIo) {
        try {
            injectedIo.emit('notification:new', {
                customerId,
                notification: shapeForClient(row),
            });
        } catch (e) {
            console.error('[Notif] socket emit failed:', e.message);
        }
    }
    return row;
}

/**
 * สะดวก: create in-app notif + ส่ง Telegram chat msg (ถ้า provided + ลูกค้ามี telegramUserId)
 * - telegramText: HTML string
 * - ถ้าไม่ส่ง telegramText → skip Telegram
 */
export async function notifyCustomer({
    customerId,
    kind,
    title,
    body,
    link,
    payload,
    entityKey,
    telegramText,
    customer,
} = {}) {
    const created = await createNotification({ customerId, kind, title, body, link, payload, entityKey });
    if (!created) return null;

    if (telegramText) {
        try {
            const cust = customer || await prisma.customer.findUnique({
                where: { customerId },
                select: { telegramUserId: true },
            });
            if (cust?.telegramUserId) {
                await sendNotificationToCustomer(cust.telegramUserId, telegramText);
            }
        } catch (e) {
            console.error('[Notif] telegram push failed:', e.message);
        }
    }
    return created;
}

export async function listNotifications(customerId, { limit = 30 } = {}) {
    const safeLimit = Math.min(Math.max(parseInt(limit) || 30, 1), 100);
    const rows = await prisma.notification.findMany({
        where: { customerId },
        orderBy: { createdAt: 'desc' },
        take: safeLimit,
    });
    return rows.map(shapeForClient);
}

export async function getUnreadCount(customerId) {
    return prisma.notification.count({
        where: { customerId, readAt: null },
    });
}

export async function markRead(customerId, notificationId) {
    const id = parseInt(notificationId);
    if (!Number.isFinite(id)) return null;
    const row = await prisma.notification.findUnique({ where: { id } });
    if (!row || row.customerId !== customerId) return null;
    if (row.readAt) return row;
    return prisma.notification.update({
        where: { id },
        data: { readAt: new Date() },
    });
}

export async function markAllRead(customerId) {
    const r = await prisma.notification.updateMany({
        where: { customerId, readAt: null },
        data: { readAt: new Date() },
    });
    return r.count;
}

/**
 * Broadcast notification ให้ลูกค้าทุกคน (สำหรับ ADMIN_BROADCAST)
 * - ใช้ entityKey เพื่อ trace แต่ละ broadcast (caller ส่ง broadcastId ที่ unique มา)
 * - sendTelegram: true → ส่ง Telegram chat ด้วย (ระวัง — กระทบ rate limit)
 * - excludeCustomerIds: array ของ customerId ที่ไม่ต้องแจ้ง
 *
 * คืน { created, telegramSent }
 */
export async function broadcastNotification({
    kind = 'ADMIN_BROADCAST',
    title,
    body,
    link,
    payload,
    broadcastId, // string เช่น "bcast-2026-05-06-1234"
    sendTelegram = false,
    excludeCustomerIds = [],
} = {}) {
    if (!title || !body || !broadcastId) {
        console.error('[Notif] broadcast missing required fields');
        return { created: 0, telegramSent: 0 };
    }

    // ดึง customer ทั้งหมดที่ active (มี telegramUserId หรือไม่ก็ตาม — มี notif ใน mini app ก็ได้)
    const customers = await prisma.customer.findMany({
        where: {
            isDeleted: false,
            customerId: excludeCustomerIds.length > 0 ? { notIn: excludeCustomerIds } : undefined,
        },
        select: { customerId: true, telegramUserId: true },
    });

    let created = 0;
    let telegramSent = 0;

    // Throttle Telegram: 25 msgs/sec → 40ms between sends
    const TG_DELAY_MS = 50;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    for (const c of customers) {
        try {
            const row = await createNotification({
                customerId: c.customerId,
                kind,
                title,
                body,
                link,
                payload,
                entityKey: broadcastId,
            });
            if (row) created += 1;

            if (sendTelegram && c.telegramUserId) {
                const html = `📣 <b>${escapeHtml(title)}</b>\n\n${escapeHtml(body)}`;
                try {
                    await sendNotificationToCustomer(c.telegramUserId, html);
                    telegramSent += 1;
                    await sleep(TG_DELAY_MS);
                } catch (e) {
                    // continue
                }
            }
        } catch (e) {
            console.error('[Notif] broadcast row failed:', e.message);
        }
    }

    return { created, telegramSent };
}

/**
 * Helper: แจ้งเตือน order เปลี่ยนสถานะ (in-app เท่านั้น — ห้ามส่ง Telegram จากที่นี่
 * เพราะหลายจุดมี Telegram push ของตัวเองอยู่แล้ว ไม่งั้นจะส่งซ้ำ)
 *
 * @param {object} p
 * @param {string} p.orderId
 * @param {string} p.customerId
 * @param {string} p.status     'PAID' | 'PROCESSING' | 'SHIPPED' | 'CANCELLED'
 * @param {string} [p.note]     ข้อความเสริม (เช่น เลขพัสดุ, เหตุผลยกเลิก)
 */
export async function notifyOrderStatusChanged({ orderId, customerId, status, note } = {}) {
    if (!orderId || !customerId || !status) return null;
    const titles = {
        PAID: '✅ ยืนยันชำระเงินแล้ว',
        PROCESSING: '📦 เริ่มเตรียมจัดส่ง',
        SHIPPED: '🚚 จัดส่งแล้ว',
        CANCELLED: '❌ ออเดอร์ถูกยกเลิก',
    };
    const title = titles[status] || '📋 อัพเดทออเดอร์';
    const body = `ออเดอร์ #${orderId}${note ? `\n${note}` : ''}`;
    return createNotification({
        customerId,
        kind: 'ORDER_STATUS_CHANGED',
        title,
        body,
        link: 'dashboard.html',
        payload: { orderId, status },
        entityKey: `order:${orderId}:${status}`,
    });
}

// ---- helpers ----

function shapeForClient(row) {
    let parsedPayload = null;
    if (row.payload) {
        try { parsedPayload = JSON.parse(row.payload); } catch (e) { parsedPayload = null; }
    }
    return {
        id: row.id,
        kind: row.kind,
        title: row.title,
        body: row.body,
        link: row.link,
        payload: parsedPayload,
        readAt: row.readAt,
        createdAt: row.createdAt,
    };
}

function escapeHtml(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}
