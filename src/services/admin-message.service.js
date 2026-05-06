// src/services/admin-message.service.js
//
// ติดตาม + แก้ไขข้อความที่บอท admin ส่งให้ recipient หลายๆ คน (personal admin, group, super)
// ใช้ราว Telegram Bot API ตรงๆ (fetch) เพื่อให้ส่ง chat_id ใดๆ ก็ได้ ไม่ผูก ctx
//
// ทุก fetch ห่อ try/catch เดี่ยวๆ แล้วใช้ Promise.allSettled ใน broadcast
// ตัวเดียวพังจะไม่ลาก handler ตาย

import { prisma } from '../db.js';

const TELEGRAM_API = (token, method) => `https://api.telegram.org/bot${token}/${method}`;

/**
 * Record a message we just sent so we can edit it later.
 * Best-effort — DB error is logged แต่ไม่โยน
 */
export async function recordAdminMessage({ orderId, kind, chatId, messageId, hasPhoto = false }) {
    if (!orderId || !kind || !chatId || !messageId) return;
    try {
        await prisma.adminMessage.create({
            data: {
                orderId: String(orderId),
                kind: String(kind),
                chatId: String(chatId),
                messageId: Number(messageId),
                hasPhoto: !!hasPhoto,
            },
        });
    } catch (e) {
        console.error('[AdminMessage] record failed:', e.message);
    }
}

/**
 * Edit ทุกข้อความที่ตรง orderId+kind (ถ้า kind = null จะแก้ทุก kind ของออเดอร์นั้น)
 * - newText: ข้อความใหม่ (HTML)
 * - replyMarkup:
 *     undefined  → ไม่แก้ปุ่ม (ของเดิมยังอยู่)
 *     null       → ตั้งเป็น inline_keyboard ว่าง (ลบปุ่มทั้งหมด)
 *     object     → ใช้ค่านี้สำหรับทุก recipient
 *     function   → (row) => markup; เรียกต่อ recipient (สำหรับ keyboard variant ตาม chat)
 * - kindFilter: string | string[] | null
 *
 * คืน { ok, failed } เพื่อ debug
 */
export async function broadcastEditAdminMessages(orderId, kindFilter, { newText, replyMarkup }) {
    const adminToken = process.env.ADMIN_BOT_TOKEN;
    if (!adminToken) {
        console.error('[AdminMessage] ADMIN_BOT_TOKEN missing — skip broadcast');
        return { ok: 0, failed: 0 };
    }

    const where = { orderId: String(orderId) };
    if (Array.isArray(kindFilter)) where.kind = { in: kindFilter };
    else if (typeof kindFilter === 'string') where.kind = kindFilter;

    let rows = [];
    try {
        rows = await prisma.adminMessage.findMany({ where });
    } catch (e) {
        console.error('[AdminMessage] lookup failed:', e.message);
        return { ok: 0, failed: 0 };
    }
    if (rows.length === 0) return { ok: 0, failed: 0 };

    // กัน duplicate (chatId+messageId) — บางทีเก็บเข้าซ้ำได้
    const seen = new Set();
    const targets = [];
    for (const r of rows) {
        const k = `${r.chatId}:${r.messageId}`;
        if (seen.has(k)) continue;
        seen.add(k);
        targets.push(r);
    }

    const tasks = targets.map((row) => {
        const rowMarkup = (typeof replyMarkup === 'function') ? replyMarkup(row) : replyMarkup;
        return editOne({
            adminToken,
            chatId: row.chatId,
            messageId: row.messageId,
            hasPhoto: row.hasPhoto,
            newText,
            replyMarkup: rowMarkup,
        });
    });

    const results = await Promise.allSettled(tasks);
    let ok = 0, failed = 0;
    for (const r of results) {
        if (r.status === 'fulfilled' && r.value === true) ok += 1;
        else failed += 1;
    }
    return { ok, failed };
}

async function editOne({ adminToken, chatId, messageId, hasPhoto, newText, replyMarkup }) {
    try {
        const method = hasPhoto ? 'editMessageCaption' : 'editMessageText';
        const body = {
            chat_id: chatId,
            message_id: Number(messageId),
            parse_mode: 'HTML',
        };
        if (hasPhoto) body.caption = newText;
        else body.text = newText;
        if (replyMarkup !== undefined) body.reply_markup = replyMarkup ?? { inline_keyboard: [] };

        const r = await fetch(TELEGRAM_API(adminToken, method), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (r.ok) return true;

        // Telegram จะคืน 400 หลายเคสที่เพิกเฉยได้
        // - "message is not modified" — ของเดิมเหมือนกันอยู่แล้ว
        // - "message to edit not found" — admin ลบเอง
        // - "MESSAGE_ID_INVALID"
        // - "Bad Request: chat not found"
        // - "Forbidden: bot was blocked by the user"
        const errBody = await r.json().catch(() => ({}));
        const desc = String(errBody?.description || '').toLowerCase();
        const benign = (
            desc.includes('not modified') ||
            desc.includes('message to edit not found') ||
            desc.includes('message_id_invalid') ||
            desc.includes('chat not found') ||
            desc.includes('blocked by the user')
        );
        if (!benign) {
            console.error(`[AdminMessage] edit failed (${chatId}/${messageId}):`, errBody);
        }
        return false;
    } catch (e) {
        console.error(`[AdminMessage] edit fetch error (${chatId}/${messageId}):`, e.message);
        return false;
    }
}
