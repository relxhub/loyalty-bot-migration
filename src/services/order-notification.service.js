// src/services/order-notification.service.js
// Rich admin payment notification — shared between:
//   1. /api/orders/:orderId/verify-slip success path
//   2. Admin "Mark PAID" button on slip mismatch
//
// Returns { groupMsgId } so caller can persist if needed.

import { prisma } from '../db.js';
import { recordAdminMessage } from './admin-message.service.js';

const fmtMoney = (n) => {
    const num = parseFloat(n) || 0;
    const hasDecimals = num % 1 !== 0;
    return num.toLocaleString('th-TH', hasDecimals ? { minimumFractionDigits: 2, maximumFractionDigits: 2 } : {});
};
const escapeHtml = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Send the rich "Order PAID" admin notification.
 *
 * @param {string} orderId
 * @param {object} options
 * @param {number} options.slipAmount      Actual amount paid (from slip or accepted)
 * @param {string} [options.slipPhotoUrl]  URL of slip image (omit → text-only)
 * @param {string} [options.referralMsg]   Appended message about referral bonus (already-formatted HTML)
 * @param {boolean} [options.bypassMode]   true → prepend "test mode" banner
 * @param {string} [options.mismatchNote]  Optional banner for mismatch-accepted orders (e.g. "⚠️ ยอมรับยอดต่างจากออเดอร์ -฿2.00")
 * @param {boolean} [options.overPaidRefund]  When true, append "💸 ยืนยันคืนเงินส่วนเกินแล้ว" inline button
 * @returns {Promise<{ groupMsgId: number|null, activeAdminId: string|null }>}
 */
export async function sendOrderPaidAdminNotification(orderId, options = {}) {
    const adminToken = process.env.ADMIN_BOT_TOKEN;
    if (!adminToken) {
        console.error('[ORDER-NOTIF] ADMIN_BOT_TOKEN is missing');
        return { groupMsgId: null, activeAdminId: null };
    }

    const order = await prisma.order.findUnique({
        where: { id: orderId },
        include: {
            items: { include: { product: { include: { category: true } } } },
            customer: true,
        },
    });
    if (!order) {
        console.error('[ORDER-NOTIF] Order not found:', orderId);
        return { groupMsgId: null, activeAdminId: null };
    }

    const {
        slipAmount,
        slipPhotoUrl = '',
        referralMsg = '',
        bypassMode = false,
        mismatchNote = '',
        overPaidRefund = false,
    } = options;

    // ---- Build message text (mirrors original verify-slip success-path format) ----
    const bkkOpts = { timeZone: 'Asia/Bangkok', year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' };
    const orderTimeStr = new Date(order.createdAt).toLocaleDateString('th-TH', bkkOpts);
    const paidTimeStr = new Date().toLocaleDateString('th-TH', bkkOpts);
    const sameTime = orderTimeStr === paidTimeStr;

    const cust = order.customer || await prisma.customer.findUnique({ where: { customerId: order.customerId } });
    const custName = [cust?.firstName, cust?.lastName].filter(Boolean).join(' ').trim() || '-';
    const custUsername = cust?.username ? `@${cust.username}` : '';
    const custPoints = (cust?.points ?? 0).toLocaleString('th-TH');

    let shippingInfo = 'ไม่ระบุที่อยู่จัดส่ง';
    if (order.shippingAddressId) {
        const addr = await prisma.shippingAddress.findUnique({ where: { id: order.shippingAddressId } });
        if (addr) {
            shippingInfo = `ชื่อ: ${escapeHtml(addr.receiverName)}\nโทร: ${escapeHtml(addr.phone)}\nที่อยู่: ${escapeHtml(addr.address)} ${escapeHtml(addr.subdistrict)} ${escapeHtml(addr.district)} ${escapeHtml(addr.province)} ${escapeHtml(addr.zipcode)}`;
        }
    }

    const itemsByCategory = {};
    let totalUnits = 0;
    for (const item of order.items) {
        totalUnits += item.quantity;
        const categoryName = item.product?.category?.name || 'ไม่ระบุหมวดหมู่';
        const categoryPrice = item.product?.category?.price ? ` (฿${fmtMoney(item.product.category.price)})` : '';
        const catKey = `${categoryName}${categoryPrice}`;
        if (!itemsByCategory[catKey]) itemsByCategory[catKey] = [];
        itemsByCategory[catKey].push(item);
    }
    const totalLines = order.items.length;

    let itemsDetails = '';
    const catEntries = Object.entries(itemsByCategory);
    catEntries.forEach(([catName, catItems], idx) => {
        itemsDetails += `<b>${escapeHtml(catName)}</b>\n`;
        for (const item of catItems) {
            const nicStr = item.product?.nicotine != null ? ` (${item.product.nicotine}%)` : '';
            itemsDetails += `• ${escapeHtml(item.product?.nameEn || '-')}${nicStr} x${item.quantity}\n`;
        }
        if (idx < catEntries.length - 1) itemsDetails += '\n';
    });

    const shipConfigRaw = await prisma.systemConfig.findUnique({ where: { key: 'shipping_fee' } });
    const freeMinRaw = await prisma.systemConfig.findUnique({ where: { key: 'free_shipping_min' } });
    const shipFeeBase = shipConfigRaw ? parseFloat(shipConfigRaw.value) : 60;
    const freeMin = freeMinRaw ? parseFloat(freeMinRaw.value) : 500;
    const itemsSubtotal = order.items.reduce((sum, item) => sum + (item.quantity * parseFloat(item.priceAtPurchase)), 0);
    const actualShipFee = itemsSubtotal >= freeMin ? 0 : shipFeeBase;

    let message = '';
    if (mismatchNote) message += mismatchNote;
    if (bypassMode) message += `⚠️ <b>โหมดทดสอบ — ไม่ได้ตรวจสลิปผ่าน SlipOK</b>\n\n`;
    message += `✅ <b>ได้รับการชำระเงินใหม่</b>\n\n`;

    message += `<b>ออเดอร์:</b> #${order.id}\n`;
    if (sameTime) {
        message += `<b>วันที่:</b> ${orderTimeStr}\n\n`;
    } else {
        message += `<b>สั่งซื้อ:</b> ${orderTimeStr}\n`;
        message += `<b>ชำระเงิน:</b> ${paidTimeStr}\n\n`;
    }

    message += `👤 <b>[ข้อมูลลูกค้า]</b>\n`;
    message += `${escapeHtml(custName)}${custUsername ? ' · ' + escapeHtml(custUsername) : ''}\n`;
    message += `รหัส: <code>${order.customerId}</code> · แต้มสะสม: ${custPoints}\n\n`;

    message += `📦 <b>[ข้อมูลจัดส่ง]</b>\n${shippingInfo}\n\n`;

    message += `🛍️ <b>[รายการสินค้า]</b> · รวม ${totalUnits} ชิ้น (${totalLines} รายการ)\n${itemsDetails}\n`;

    message += `<b>รวมค่าสินค้า:</b> ฿${fmtMoney(itemsSubtotal)}\n`;
    if (actualShipFee === 0) {
        message += `<b>ค่าจัดส่ง:</b> ฟรี <i>(ซื้อครบ ฿${fmtMoney(freeMin)})</i>\n`;
    } else {
        message += `<b>ค่าจัดส่ง:</b> ฿${fmtMoney(actualShipFee)}\n`;
    }

    if (parseFloat(order.discountAmount) > 0) {
        let couponLine = `<b>ส่วนลดคูปอง:</b> -฿${fmtMoney(order.discountAmount)}`;
        if (order.appliedCouponId) {
            const appliedCoupon = await prisma.coupon.findUnique({ where: { id: order.appliedCouponId } });
            if (appliedCoupon && appliedCoupon.name) {
                couponLine += ` · ${escapeHtml(appliedCoupon.name)}`;
            }
        }
        message += couponLine + '\n';
    }

    message += `\n💰 <b>ยอดสุทธิ:</b> ฿${fmtMoney(slipAmount)}`;
    if (!bypassMode && !mismatchNote) {
        message += `\n<i>✓ ตรวจสอบสลิปผ่าน SlipOK สำเร็จ</i>`;
    }

    if (referralMsg) message += referralMsg;

    // ---- Round-robin active admin ----
    const dayOfWeek = new Date().toLocaleString('en-US', { timeZone: 'Asia/Bangkok', weekday: 'short' });
    const daysMap = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
    const currentDayInt = daysMap[dayOfWeek];
    const currentBkkTime = new Date().toLocaleTimeString('en-US', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit', hour12: false });

    const todaysShifts = await prisma.adminShift.findMany({
        where: { dayOfWeek: { in: [0, currentDayInt] } },
        include: { admin: true },
    });

    const activeAdminsMap = new Map();
    for (const shift of todaysShifts) {
        const checkTime = (start, end) => {
            if (!start || !end) return false;
            if (start <= end) return currentBkkTime >= start && currentBkkTime <= end;
            return currentBkkTime >= start || currentBkkTime <= end;
        };
        if (
            checkTime(shift.shift1Start, shift.shift1End) ||
            checkTime(shift.shift2Start, shift.shift2End) ||
            checkTime(shift.shift3Start, shift.shift3End)
        ) {
            activeAdminsMap.set(shift.adminTelegramId, shift.adminTelegramId);
        }
    }

    let activeAdminId = null;
    let activeAdminName = 'ไม่ระบุ';
    const activeAdminIds = Array.from(activeAdminsMap.values()).sort();
    if (activeAdminIds.length > 0) {
        const storeSetting = await prisma.storeSetting.findUnique({ where: { id: 1 } });
        const lastId = storeSetting?.lastAssignedAdminId;
        let nextIndex = 0;
        if (lastId && activeAdminIds.includes(lastId)) {
            const lastIndex = activeAdminIds.indexOf(lastId);
            nextIndex = (lastIndex + 1) % activeAdminIds.length;
        }
        activeAdminId = activeAdminIds[nextIndex];
        const assignedAdmin = await prisma.admin.findUnique({
            where: { telegramId: activeAdminId },
            select: { name: true },
        });
        if (assignedAdmin?.name) activeAdminName = assignedAdmin.name;

        await prisma.storeSetting.update({
            where: { id: 1 },
            data: { lastAssignedAdminId: activeAdminId },
        });
        // บันทึก assignedAdminId + assignedAt ลงในออเดอร์
        // (ใช้ filter scope ของ Admin role + คำนวณ time-to-bill)
        try {
            await prisma.order.update({
                where: { id: order.id },
                data: { assignedAdminId: activeAdminId, assignedAt: new Date() },
            });
        } catch (e) { console.error('[ORDER-NOTIF] save assignedAdminId failed:', e.message); }
    }
    message += `\n👨‍💼 <b>แอดมินผู้รับผิดชอบ:</b> ${activeAdminName}`;

    // ---- Sender ----
    const sendOne = async (chatId, isPersonalAdmin) => {
        if (!chatId) return null;
        try {
            const inlineKb = isPersonalAdmin
                ? [[{ text: '📝 แนบเลขบิล', callback_data: `addbill_${order.id}` }]]
                : [[{ text: `⚙️ จัดการ #${order.id}`, callback_data: `manage_order_${order.id}` }]];
            if (overPaidRefund) {
                inlineKb.push([{ text: '💸 ยืนยันคืนเงินส่วนเกินแล้ว', callback_data: `op_refund_${order.id}` }]);
            }
            const replyMarkup = { inline_keyboard: inlineKb };

            const url = slipPhotoUrl
                ? `https://api.telegram.org/bot${adminToken}/sendPhoto`
                : `https://api.telegram.org/bot${adminToken}/sendMessage`;

            const body = slipPhotoUrl
                ? { chat_id: chatId, photo: slipPhotoUrl, caption: message, parse_mode: 'HTML', reply_markup: replyMarkup }
                : { chat_id: chatId, text: message, parse_mode: 'HTML', reply_markup: replyMarkup };

            const r = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            if (!r.ok) {
                console.error(`[ORDER-NOTIF] Telegram error for ${chatId}:`, await r.json().catch(() => ({})));
                return null;
            }
            return await r.json();
        } catch (e) {
            console.error(`[ORDER-NOTIF] Fetch error to ${chatId}:`, e.message);
            return null;
        }
    };

    let groupMsgId = null;
    const hasPhoto = !!slipPhotoUrl;

    if (activeAdminId) {
        const personalRes = await sendOne(activeAdminId, true);
        if (personalRes?.result?.message_id) {
            await recordAdminMessage({
                orderId: order.id,
                kind: 'NEW_ORDER',
                chatId: activeAdminId,
                messageId: personalRes.result.message_id,
                hasPhoto,
            });
        }
    }
    const groupId = process.env.ADMIN_GROUP_ID || process.env.SUPER_ADMIN_TELEGRAM_ID;
    if (groupId && groupId !== activeAdminId) {
        const groupRes = await sendOne(groupId, false);
        if (groupRes?.result?.message_id) {
            groupMsgId = groupRes.result.message_id;
            try {
                await prisma.order.update({
                    where: { id: order.id },
                    data: { groupMsgId },
                });
            } catch (dbErr) {
                console.error('[ORDER-NOTIF] Failed to save groupMsgId:', dbErr.message);
            }
            await recordAdminMessage({
                orderId: order.id,
                kind: 'NEW_ORDER',
                chatId: groupId,
                messageId: groupMsgId,
                hasPhoto,
            });
        }
    }

    return { groupMsgId, activeAdminId };
}
