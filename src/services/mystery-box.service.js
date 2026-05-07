// src/services/mystery-box.service.js
//
// Mystery Box ระบบหลัก — แยกจาก Coupon
// ทำหน้าที่:
//  - listActiveBoxes()        → รายการกล่อง active สำหรับ catalog
//  - listMyTickets(custId)    → ตั๋วของลูกค้า (UNOPENED + OPENED history)
//  - getUnopenedCount(custId) → สำหรับ badge บน dashboard
//  - grantTickets({...})      → ฮุกจาก trigger ต่างๆ — มอบสิทธิ์
//  - openTicket({...})        → เปิดกล่อง → weighted random → สร้าง coupon (ถ้าผูก)
//
// Notification:
//  - grantTickets ส่ง REWARD_COUPON_GRANTED notif (reuse kind เดิม) เพื่อความเรียบง่าย
//  - openTicket ไม่ส่ง notif (ลูกค้ารู้แล้วว่าเปิดอะไร)

import { prisma } from '../db.js';
import { notifyCustomer } from './notification-center.service.js';
import { getConfig } from '../config/config.js';

// แปลง MysteryBoxRequiredTier enum → จำนวนเพื่อนขั้นต่ำที่ต้องชวนเดือนนี้
function tierEnumToMinCount(requiredTier) {
    if (requiredTier === 'GOLD') return parseInt(getConfig('tier_gold_min')) || 6;
    if (requiredTier === 'SILVER') return parseInt(getConfig('tier_silver_min')) || 3;
    return 0; // NONE หรือไม่ตั้ง = ไม่จำกัด
}

/**
 * รายการกล่อง active สำหรับ catalog page
 * - ถ้าส่ง customerId มา จะใส่ claimedCount + remaining ของลูกค้าให้ด้วย
 */
export async function listActiveBoxes(customerId = null) {
    const now = new Date();
    const boxes = await prisma.mysteryBox.findMany({
        where: {
            isActive: true,
            AND: [
                { OR: [{ startDate: null }, { startDate: { lte: now } }] },
                { OR: [{ endDate: null }, { endDate: { gte: now } }] },
            ],
        },
        include: {
            prizes: {
                where: { isActive: true },
                orderBy: { weight: 'desc' },
            },
        },
        orderBy: { createdAt: 'desc' },
    });

    // ถ้ามี customerId — query ticket count ต่อ box แบบ batch
    let claimedMap = {};
    if (customerId && boxes.length > 0) {
        try {
            const counts = await prisma.mysteryBoxTicket.groupBy({
                by: ['mysteryBoxId'],
                where: { customerId, mysteryBoxId: { in: boxes.map(b => b.id) } },
                _count: { _all: true },
            });
            for (const c of counts) claimedMap[c.mysteryBoxId] = c._count._all;
        } catch (e) {
            console.error('[MysteryBox] claimed count failed:', e.message);
        }
    }

    return boxes.map((b) => {
        const shaped = shapeBoxForClient(b);
        const claimed = claimedMap[b.id] || 0;
        shaped.userClaimedCount = claimed;
        shaped.userRemaining = b.maxPerUser != null ? Math.max(0, b.maxPerUser - claimed) : null;
        return shaped;
    });
}

/**
 * ตั๋วของลูกค้า + รายละเอียด prize ที่ได้ (ถ้าเปิดแล้ว)
 */
export async function listMyTickets(customerId) {
    const tickets = await prisma.mysteryBoxTicket.findMany({
        where: { customerId },
        include: {
            mysteryBox: { select: { id: true, name: true, nameEn: true, imageUrl: true } },
            awardedPrize: true,
        },
        orderBy: [{ status: 'asc' }, { createdAt: 'desc' }], // UNOPENED first
        take: 100,
    });
    return tickets.map(shapeTicketForClient);
}

export async function getUnopenedCount(customerId) {
    return prisma.mysteryBoxTicket.count({
        where: { customerId, status: 'UNOPENED' },
    });
}

/**
 * มอบสิทธิ์กล่องสุ่มให้ลูกค้า — ใช้สำหรับฮุกจาก trigger ต่างๆ
 *
 * @param {object} p
 * @param {string} p.customerId
 * @param {'REFEREE_FIRST_PURCHASE'|'JOIN_CHANNEL'|'ADMIN_GRANT'|'PURCHASE_MILESTONE'|'REVIEW_PRODUCT'} p.event
 * @param {number} [p.eligibleAmount]   - สำหรับ REFEREE_FIRST_PURCHASE (เช็ค min/max)
 * @param {number} [p.referralRowId]    - กันแจกซ้ำต่อ Referral
 * @param {object} [p.metadata]         - JSON metadata เก็บลง ticket
 * @returns {Promise<{ granted: Array, skipped: Array }>}
 */
export async function grantTickets({ customerId, event, eligibleAmount = null, referralRowId = null, metadata = null } = {}) {
    const granted = [];
    const skipped = [];
    if (!customerId || !event) return { granted, skipped };

    const now = new Date();
    let boxes = [];
    try {
        boxes = await prisma.mysteryBox.findMany({
            where: {
                isActive: true,
                trigger: event,
                AND: [
                    { OR: [{ startDate: null }, { startDate: { lte: now } }] },
                    { OR: [{ endDate: null }, { endDate: { gte: now } }] },
                ],
            },
        });
    } catch (e) {
        console.error('[MysteryBox] lookup failed:', e.message);
        return { granted, skipped };
    }
    if (boxes.length === 0) return { granted, skipped };

    for (const box of boxes) {
        // เงื่อนไขยอดเงิน — ใช้กับ REFEREE_FIRST_PURCHASE (ยอดออเดอร์)
        // และ PURCHASE_MILESTONE (ยอดสะสม lifetime)
        if (event === 'REFEREE_FIRST_PURCHASE' || event === 'PURCHASE_MILESTONE') {
            const amt = Number(eligibleAmount) || 0;
            if (box.minPurchaseAmount != null && amt < Number(box.minPurchaseAmount)) {
                skipped.push({ boxId: box.id, reason: 'BELOW_MIN' });
                continue;
            }
            if (box.maxPurchaseAmount != null && amt > Number(box.maxPurchaseAmount)) {
                skipped.push({ boxId: box.id, reason: 'ABOVE_MAX' });
                continue;
            }
        }

        // เงื่อนไข tier — แปลง enum เป็นจำนวนเพื่อนขั้นต่ำ แล้วเทียบกับเดือนนี้
        const minCountRequired = tierEnumToMinCount(box.requiredTier);
        if (minCountRequired > 0) {
            const m = new Date();
            const startOfMonth = new Date(m.getFullYear(), m.getMonth(), 1);
            const endOfMonth = new Date(m.getFullYear(), m.getMonth() + 1, 0, 23, 59, 59, 999);
            const monthCount = await prisma.referral.count({
                where: {
                    referrerId: customerId,
                    status: 'COMPLETED',
                    completedAt: { gte: startOfMonth, lte: endOfMonth },
                },
            });
            if (monthCount < minCountRequired) {
                skipped.push({ boxId: box.id, reason: 'TIER_TOO_LOW', userMonthCount: monthCount, requiredTier: box.requiredTier, minCountRequired });
                continue;
            }
        }

        try {
            // กันแจกซ้ำต่อ Referral
            if (referralRowId) {
                const dup = await prisma.mysteryBoxTicket.findFirst({
                    where: { customerId, mysteryBoxId: box.id, sourceReferralId: referralRowId },
                });
                if (dup) {
                    skipped.push({ boxId: box.id, reason: 'DUPLICATE_REFERRAL' });
                    continue;
                }
            }

            // เพดานต่อ user
            if (box.maxPerUser != null) {
                const existingCount = await prisma.mysteryBoxTicket.count({
                    where: { customerId, mysteryBoxId: box.id },
                });
                if (existingCount >= box.maxPerUser) {
                    skipped.push({ boxId: box.id, reason: 'MAX_PER_USER_REACHED' });
                    continue;
                }
            }

            // มอบ ticketsPerEvent ใบ (default 1)
            const qty = Math.max(1, box.ticketsPerEvent || 1);
            const created = [];
            for (let i = 0; i < qty; i++) {
                const t = await prisma.mysteryBoxTicket.create({
                    data: {
                        customerId,
                        mysteryBoxId: box.id,
                        sourceEvent: event,
                        sourceReferralId: referralRowId,
                        sourceMetadata: metadata ? JSON.stringify(metadata) : null,
                        status: 'UNOPENED',
                    },
                });
                created.push(t);
            }
            granted.push({ boxId: box.id, boxName: box.name, ticketIds: created.map(t => t.id), qty });

            // แจ้งเตือน — reuse REWARD_COUPON_GRANTED kind
            try {
                await notifyCustomer({
                    customerId,
                    kind: 'REWARD_COUPON_GRANTED',
                    title: '🎁 ได้รับกล่องสุ่มพิเศษ!',
                    body: `${box.name}${qty > 1 ? ` (×${qty})` : ''}\nเปิดที่หน้า "กล่องสุ่ม" เพื่อลุ้นรางวัล ✨`,
                    link: 'mystery-box.html',
                    payload: { mysteryBoxId: box.id, qty, sourceEvent: event },
                    entityKey: `mbox:${box.id}:src:${referralRowId || 'na'}:${event}:${Date.now()}`,
                    telegramText:
                        `🎁 <b>ได้รับกล่องสุ่มพิเศษ!</b>\n\n` +
                        `<b>${escapeHtml(box.name)}</b>${qty > 1 ? ` (×${qty})` : ''}\n\n` +
                        `📦 เปิดที่ Mini App → "กล่องสุ่ม" เพื่อลุ้นรางวัล ✨`,
                });
            } catch (e) {
                console.error('[MysteryBox] notify failed:', e.message);
            }
        } catch (e) {
            console.error(`[MysteryBox] grant failed for box ${box.id}:`, e.message);
            skipped.push({ boxId: box.id, reason: 'ERROR' });
        }
    }

    if (granted.length > 0) {
        console.log(`[MysteryBox] event=${event} granted=${granted.length} skipped=${skipped.length}`);
    }
    return { granted, skipped };
}

// ============================================================
// 🚚 PRIZE DELIVERY — สำหรับ physical reward (ของจริงต้องส่งไปรษณีย์)
// ============================================================

/**
 * รายการของรางวัลของลูกค้า แยกตาม deliveryStatus
 * คืนเฉพาะ tickets ที่ OPENED + prize.isPhysicalReward=true
 */
export async function listMyPrizes(customerId) {
    if (!customerId) return [];
    const tickets = await prisma.mysteryBoxTicket.findMany({
        where: {
            customerId,
            status: 'OPENED',
            awardedPrize: { isPhysicalReward: true },
        },
        include: {
            mysteryBox: { select: { id: true, name: true, nameEn: true } },
            awardedPrize: true,
            shipment: { select: { id: true, status: true, trackingNumber: true, shippedAt: true, deliveredAt: true } },
        },
        orderBy: [{ deliveryStatus: 'asc' }, { openedAt: 'desc' }],
    });
    return tickets.map((t) => ({
        id: t.id,
        boxName: t.mysteryBox?.name,
        prize: t.awardedPrize ? {
            id: t.awardedPrize.id,
            name: t.awardedPrize.name,
            description: t.awardedPrize.description,
            imageUrl: t.awardedPrize.imageUrl,
        } : null,
        deliveryStatus: t.deliveryStatus || 'OWNED',
        deliveryRequestedAt: t.deliveryRequestedAt,
        shippedAt: t.shippedAt,
        deliveredAt: t.deliveredAt,
        trackingNumber: t.trackingNumber,
        shipmentId: t.deliveryShipmentId,
        shipment: t.shipment,
        openedAt: t.openedAt,
    }));
}

/**
 * ลูกค้าขอจัดส่งของรางวัล (batch หลายชิ้น)
 * สร้าง Order (kind=PRIZE_DELIVERY, prefix PRZ-) คู่กับ PrizeShipment
 * - ค่าส่ง 0 → Order auto-PAID + แจ้ง admin ทันที
 * - ค่าส่ง > 0 → Order PENDING_PAYMENT → frontend redirect ไป payment.html
 *
 * @param {object} p
 * @param {string} p.customerId
 * @param {Array<number>} p.ticketIds
 * @param {number} p.shippingAddressId
 * @returns {Promise<{success, orderId?, shippingFee?, needsPayment?, error?}>}
 */
export async function requestPrizeDelivery({ customerId, ticketIds, shippingAddressId }) {
    if (!customerId || !Array.isArray(ticketIds) || ticketIds.length === 0 || !shippingAddressId) {
        return { success: false, error: 'INVALID_INPUT' };
    }
    const ids = ticketIds.map(Number).filter(Number.isFinite);
    if (ids.length === 0) return { success: false, error: 'NO_VALID_TICKETS' };

    // verify ที่อยู่
    const addr = await prisma.shippingAddress.findUnique({ where: { id: parseInt(shippingAddressId) } });
    if (!addr || addr.customerId !== customerId) {
        return { success: false, error: 'INVALID_ADDRESS' };
    }

    // verify tickets
    const tickets = await prisma.mysteryBoxTicket.findMany({
        where: { id: { in: ids } },
        include: { awardedPrize: { select: { isPhysicalReward: true, name: true } } },
    });
    for (const t of tickets) {
        if (t.customerId !== customerId) return { success: false, error: 'NOT_OWNER' };
        if (t.status !== 'OPENED') return { success: false, error: 'NOT_OPENED' };
        if (!t.awardedPrize?.isPhysicalReward) return { success: false, error: 'NOT_PHYSICAL' };
        if (t.deliveryStatus && t.deliveryStatus !== 'OWNED') {
            return { success: false, error: 'ALREADY_REQUESTED' };
        }
    }
    if (tickets.length !== ids.length) return { success: false, error: 'TICKETS_NOT_FOUND' };

    // ค่าส่ง — ใช้ Number() เพื่อรองรับค่า 0
    const cfgRow = await prisma.systemConfig.findUnique({ where: { key: 'shipping_fee' } });
    const shippingFee = (cfgRow && cfgRow.value !== '' && Number.isFinite(Number(cfgRow.value)))
        ? Number(cfgRow.value)
        : 60;

    const isFree = shippingFee <= 0;
    const orderId = `PRZ-${Date.now().toString().slice(-6)}-${Math.floor(1000 + Math.random() * 9000)}`;

    // สร้าง PrizeShipment + Order linked + อัพเดท tickets ใน tx
    const result = await prisma.$transaction(async (tx) => {
        // 1. สร้าง Order ก่อน (kind=PRIZE_DELIVERY, status ตามว่าฟรีหรือไม่)
        const orderStatus = isFree ? 'PAID' : 'PENDING_PAYMENT';
        const order = await tx.order.create({
            data: {
                id: orderId,
                customerId,
                totalAmount: shippingFee,
                kind: 'PRIZE_DELIVERY',
                status: orderStatus,
                shippingAddressId: parseInt(shippingAddressId),
                subtotal: 0,
                shippingFee: shippingFee,
                discountAmount: 0,
            },
        });
        // 2. สร้าง PrizeShipment linked
        const sh = await tx.prizeShipment.create({
            data: {
                customerId,
                shippingAddressId: parseInt(shippingAddressId),
                shippingFeeSnapshot: shippingFee,
                status: 'PENDING',
                orderId: order.id,
            },
        });
        // 3. อัพเดท tickets
        await tx.mysteryBoxTicket.updateMany({
            where: { id: { in: ids } },
            data: {
                deliveryStatus: 'REQUESTED',
                deliveryRequestedAt: new Date(),
                deliveryShipmentId: sh.id,
                shippingAddressId: parseInt(shippingAddressId),
                shippingFeeSnapshot: shippingFee,
            },
        });
        return { order, shipment: sh };
    });

    // ถ้าฟรี — auto-PAID → แจ้ง admin ทันที
    if (isFree) {
        try {
            await sendPrizeOrderAdminNotification(result.order.id, { isFree: true });
        } catch (e) { console.error('[PrizeShipment] notify admin failed:', e.message); }

        // notif ลูกค้า
        try {
            const items = tickets.map(t => `• ${t.awardedPrize.name}`).join('\n');
            await notifyCustomer({
                customerId,
                kind: 'REWARD_COUPON_GRANTED',
                title: '📦 ส่งคำขอจัดส่งของรางวัลแล้ว',
                body: `ขอส่ง ${tickets.length} ชิ้น (ค่าส่งฟรี)\nรอแอดมินจัดส่ง`,
                link: 'mystery-box.html',
                payload: { orderId: result.order.id, shipmentId: result.shipment.id },
                entityKey: `prize-order-paid:${result.order.id}`,
                telegramText:
                    `📦 <b>ส่งคำขอจัดส่งของรางวัลแล้ว!</b>\n\n` +
                    `ออเดอร์: <code>${result.order.id}</code>\n` +
                    `ชิ้นที่ขอ:\n${items}\n\n` +
                    `🎁 ค่าส่งฟรี — แอดมินจะจัดส่งให้เร็วๆ นี้`,
            });
        } catch (e) { /* silent */ }
    }

    return {
        success: true,
        orderId: result.order.id,
        shippingFee,
        needsPayment: !isFree,
    };
}

/**
 * Admin: mark shipment as SHIPPED with tracking
 * รองรับเรียกผ่านทั้ง shipmentId หรือ orderId (Order kind=PRIZE_DELIVERY)
 */
export async function markShipmentShipped({ shipmentId, orderId, trackingNumber, adminName }) {
    let sh;
    if (orderId) {
        sh = await prisma.prizeShipment.findFirst({
            where: { orderId: orderId },
            include: { tickets: { include: { awardedPrize: true } } },
        });
    } else if (shipmentId) {
        sh = await prisma.prizeShipment.findUnique({
            where: { id: parseInt(shipmentId) },
            include: { tickets: { include: { awardedPrize: true } } },
        });
    }
    if (!sh) return { success: false, error: 'NOT_FOUND' };
    if (sh.status !== 'PENDING') return { success: false, error: 'INVALID_STATUS' };

    const now = new Date();
    await prisma.$transaction(async (tx) => {
        await tx.prizeShipment.update({
            where: { id: sh.id },
            data: {
                status: 'SHIPPED',
                trackingNumber: trackingNumber || null,
                shippedAt: now,
                adminNote: adminName ? `Shipped by ${adminName}` : null,
            },
        });
        await tx.mysteryBoxTicket.updateMany({
            where: { deliveryShipmentId: sh.id },
            data: {
                deliveryStatus: 'SHIPPED',
                shippedAt: now,
                trackingNumber: trackingNumber || null,
            },
        });
        // ถ้ามี order linked → update เป็น SHIPPED + เก็บ tracking ใน billNumber
        if (sh.orderId) {
            await tx.order.update({
                where: { id: sh.orderId },
                data: {
                    status: 'SHIPPED',
                    billNumber: trackingNumber || null,
                    trackingNumber: trackingNumber || null,
                },
            });
        }
    });

    // Notif ลูกค้า
    try {
        const items = sh.tickets.map(t => `• ${t.awardedPrize?.name || '—'}`).join('\n');
        await notifyCustomer({
            customerId: sh.customerId,
            kind: 'ORDER_STATUS_CHANGED',
            title: '🚚 ของรางวัลจัดส่งแล้ว!',
            body: `${sh.tickets.length} ชิ้น\n${trackingNumber ? `เลขพัสดุ: ${trackingNumber}` : ''}`,
            link: 'mystery-box.html',
            payload: { shipmentId: sh.id, orderId: sh.orderId, trackingNumber },
            entityKey: `prize-shipment-shipped:${sh.id}`,
            telegramText:
                `🚚 <b>ของรางวัลจัดส่งแล้ว!</b>\n\n` +
                items + `\n\n` +
                (trackingNumber ? `📦 เลขพัสดุ: <code>${trackingNumber}</code>\n` : '') +
                `ขอบคุณที่อุดหนุนค่ะ 🎉`,
        });
    } catch (e) { /* silent */ }

    return { success: true, shipment: sh };
}

/**
 * ส่ง notif ไปกลุ่ม admin หลัง prize order ถูก PAID (รวม addbill button)
 * ใช้ pattern เดียวกับ sendOrderPaidAdminNotification ของออเดอร์ปกติ
 */
export async function sendPrizeOrderAdminNotification(orderId, { isFree = false } = {}) {
    const adminToken = process.env.ADMIN_BOT_TOKEN;
    if (!adminToken) {
        console.error('[PrizeNotif] ADMIN_BOT_TOKEN missing');
        return;
    }
    const order = await prisma.order.findUnique({
        where: { id: orderId },
        include: {
            customer: true,
            prizeShipment: {
                include: { tickets: { include: { awardedPrize: true } } },
            },
        },
    });
    if (!order || order.kind !== 'PRIZE_DELIVERY') return;

    const sh = order.prizeShipment;
    if (!sh) return;
    const addr = await prisma.shippingAddress.findUnique({ where: { id: sh.shippingAddressId } });

    const cust = order.customer;
    const custName = [cust?.firstName, cust?.lastName].filter(Boolean).join(' ').trim() || '-';
    const custUsername = cust?.username ? `@${cust.username}` : '';
    const itemsList = sh.tickets.map((t, i) => `${i + 1}. ${t.awardedPrize?.name || '—'}`).join('\n');
    const addrText = addr
        ? `${addr.receiverName}\n${addr.phone}\n${addr.address} ${addr.subdistrict} ${addr.district} ${addr.province} ${addr.zipcode}`
        : '(ไม่พบที่อยู่)';
    const fee = Number(sh.shippingFeeSnapshot);

    let message = '';
    message += `🎁 <b>คำขอจัดส่งของรางวัล Mystery Box</b>${isFree ? ' (ค่าส่งฟรี)' : ' — ชำระค่าส่งแล้ว'}\n\n`;
    message += `<b>ออเดอร์:</b> <code>${order.id}</code>\n\n`;
    message += `👤 <b>[ลูกค้า]</b>\n${custName}${custUsername ? ' · ' + custUsername : ''}\nรหัส: <code>${order.customerId}</code>\n\n`;
    message += `🎁 <b>[ของรางวัล ${sh.tickets.length} ชิ้น]</b>\n${itemsList}\n\n`;
    message += `📍 <b>[ที่อยู่จัดส่ง]</b>\n${addrText}\n\n`;
    message += `💰 ค่าส่ง: ฿${fee.toLocaleString('th-TH', { minimumFractionDigits: 2 })}${isFree ? ' (ฟรี)' : ' (ชำระแล้ว)'}\n\n`;
    message += `กดปุ่มด้านล่างเพื่อแนบเลขพัสดุหลังจัดส่ง`;

    const replyMarkup = {
        inline_keyboard: [
            [{ text: '📝 แนบเลขพัสดุ', callback_data: `addbill_${order.id}` }],
            [{ text: `⚙️ จัดการ #${order.id}`, callback_data: `manage_order_${order.id}` }],
        ],
    };

    const sendOne = async (chatId) => {
        try {
            const r = await fetch(`https://api.telegram.org/bot${adminToken}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'HTML', reply_markup: replyMarkup }),
            });
            if (!r.ok) {
                console.error(`[PrizeNotif] Telegram error for ${chatId}:`, await r.json().catch(() => ({})));
                return null;
            }
            return await r.json();
        } catch (e) {
            console.error(`[PrizeNotif] fetch error to ${chatId}:`, e.message);
            return null;
        }
    };

    const groupId = process.env.ADMIN_GROUP_ID || process.env.SUPER_ADMIN_TELEGRAM_ID;
    if (groupId) {
        const res = await sendOne(groupId);
        if (res?.result?.message_id) {
            try {
                await prisma.order.update({
                    where: { id: order.id },
                    data: { groupMsgId: res.result.message_id },
                });
            } catch (e) {}
            // เก็บ AdminMessage เพื่อรองรับ broadcast edit
            try {
                const { recordAdminMessage } = await import('./admin-message.service.js');
                await recordAdminMessage({
                    orderId: order.id,
                    kind: 'NEW_ORDER',
                    chatId: groupId,
                    messageId: res.result.message_id,
                    hasPhoto: false,
                });
            } catch (e) {}
        }
    }
}

/**
 * Admin: list pending shipments
 */
export async function listPendingShipments() {
    return prisma.prizeShipment.findMany({
        where: { status: 'PENDING' },
        include: {
            tickets: { include: { awardedPrize: true } },
        },
        orderBy: { createdAt: 'asc' },
    });
}

/**
 * ส่ง notif ไปกลุ่ม admin เมื่อมีคำขอใหม่ — ใช้ adminBot ผ่าน fetch
 */
async function sendShipmentRequestToAdmin(shipmentId) {
    const adminToken = process.env.ADMIN_BOT_TOKEN;
    const groupId = process.env.ADMIN_GROUP_ID || process.env.SUPER_ADMIN_TELEGRAM_ID;
    if (!adminToken || !groupId) return;

    const sh = await prisma.prizeShipment.findUnique({
        where: { id: shipmentId },
        include: {
            tickets: { include: { awardedPrize: true } },
            // ไม่มี relation address ตรงๆ — ดึงเอง
        },
    });
    if (!sh) return;

    const addr = await prisma.shippingAddress.findUnique({ where: { id: sh.shippingAddressId } });
    const cust = await prisma.customer.findUnique({ where: { customerId: sh.customerId } });

    const itemsList = sh.tickets.map((t, i) => `${i + 1}. ${t.awardedPrize?.name || '—'}`).join('\n');
    const addrText = addr ? `${addr.receiverName}\n${addr.phone}\n${addr.address} ${addr.subdistrict} ${addr.district} ${addr.province} ${addr.zipcode}` : '(ไม่พบที่อยู่)';

    const message =
        `📦 <b>คำขอจัดส่งของรางวัล Mystery Box</b>\n\n` +
        `🆔 Shipment #${sh.id}\n` +
        `👤 ลูกค้า: <code>${sh.customerId}</code>${cust?.firstName ? ` · ${cust.firstName} ${cust.lastName || ''}` : ''}\n\n` +
        `🎁 <b>ของรางวัล (${sh.tickets.length} ชิ้น):</b>\n${itemsList}\n\n` +
        `📍 <b>ที่อยู่จัดส่ง:</b>\n${addrText}\n\n` +
        `💰 ค่าส่ง: ฿${Number(sh.shippingFeeSnapshot).toLocaleString('th-TH', { minimumFractionDigits: 2 })}\n` +
        (sh.customerNote ? `\n📝 หมายเหตุลูกค้า: ${sh.customerNote}\n` : '') +
        `\nใช้: <code>/shipprize ${sh.id} [เลขพัสดุ]</code> เพื่อ mark ส่งแล้ว`;

    try {
        const r = await fetch(`https://api.telegram.org/bot${adminToken}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: groupId, text: message, parse_mode: 'HTML' }),
        });
        const data = await r.json();
        if (data.ok && data.result?.message_id) {
            await prisma.prizeShipment.update({
                where: { id: sh.id },
                data: { adminGroupMsgId: data.result.message_id },
            });
        }
    } catch (e) { console.error('[Shipment] admin send failed:', e.message); }
}

/**
 * Admin grant: มอบกล่องเจาะจง 1 กล่อง 1 ใบ ให้ลูกค้า
 * (ไม่เช็ค trigger / minPurchase / quotas — admin มีอำนาจเต็ม)
 */
export async function grantSpecificBox({ customerId, mysteryBoxId, adminName = 'admin' } = {}) {
    if (!customerId || !mysteryBoxId) return { success: false, error: 'INVALID_INPUT' };
    const box = await prisma.mysteryBox.findUnique({ where: { id: mysteryBoxId } });
    if (!box) return { success: false, error: 'BOX_NOT_FOUND' };

    const ticket = await prisma.mysteryBoxTicket.create({
        data: {
            customerId,
            mysteryBoxId,
            sourceEvent: 'ADMIN_GRANT',
            sourceMetadata: JSON.stringify({ admin: adminName, manual: true }),
            status: 'UNOPENED',
        },
    });

    // notif
    try {
        await notifyCustomer({
            customerId,
            kind: 'REWARD_COUPON_GRANTED',
            title: '🎁 ได้รับกล่องสุ่มพิเศษ!',
            body: `${box.name}\nเปิดที่หน้า "กล่องสุ่ม" เพื่อลุ้นรางวัล ✨`,
            link: 'mystery-box.html',
            payload: { mysteryBoxId: box.id, ticketId: ticket.id, sourceEvent: 'ADMIN_GRANT' },
            entityKey: `mbox:${box.id}:admin:${ticket.id}`,
            telegramText:
                `🎁 <b>ได้รับกล่องสุ่มพิเศษ!</b>\n\n` +
                `<b>${escapeHtml(box.name)}</b>\n\n` +
                `📦 เปิดที่ Mini App → "กล่องสุ่ม" เพื่อลุ้นรางวัล ✨`,
        });
    } catch (e) { /* silent */ }

    return { success: true, ticket, box };
}

/**
 * ลูกค้าใช้แต้มซื้อกล่อง — สร้าง ticket ใบเดียว แล้วลูกค้ากดเปิดเอง
 *
 * Atomic: หักแต้ม + log PointTransaction + create ticket ใน tx เดียว
 * เคารพเงื่อนไข maxPerUser, requiredTier, active window เหมือน grant ปกติ
 *
 * @param {object} p
 * @param {string} p.customerId
 * @param {string} p.mysteryBoxId
 * @returns {Promise<{ success, ticketId?, remainingPoints?, error? }>}
 */
export async function redeemBoxWithPoints({ customerId, mysteryBoxId } = {}) {
    if (!customerId || !mysteryBoxId) return { success: false, error: 'INVALID_INPUT' };

    const box = await prisma.mysteryBox.findUnique({ where: { id: mysteryBoxId } });
    if (!box) return { success: false, error: 'BOX_NOT_FOUND' };
    if (!box.isActive) return { success: false, error: 'BOX_INACTIVE' };

    const cost = Number(box.pointCost);
    if (!Number.isFinite(cost) || cost <= 0) {
        return { success: false, error: 'NOT_REDEEMABLE' };
    }

    const now = new Date();
    if (box.startDate && now < box.startDate) return { success: false, error: 'NOT_STARTED' };
    if (box.endDate && now > box.endDate) return { success: false, error: 'EXPIRED' };

    // เงื่อนไข tier — เหมือน grant ปกติ
    const minCountRequired = tierEnumToMinCount(box.requiredTier);
    if (minCountRequired > 0) {
        const m = new Date();
        const startOfMonth = new Date(m.getFullYear(), m.getMonth(), 1);
        const endOfMonth = new Date(m.getFullYear(), m.getMonth() + 1, 0, 23, 59, 59, 999);
        const monthCount = await prisma.referral.count({
            where: {
                referrerId: customerId,
                status: 'COMPLETED',
                completedAt: { gte: startOfMonth, lte: endOfMonth },
            },
        });
        if (monthCount < minCountRequired) {
            return { success: false, error: 'TIER_TOO_LOW' };
        }
    }

    try {
        const result = await prisma.$transaction(async (tx) => {
            // เพดานต่อ user
            if (box.maxPerUser != null) {
                const existingCount = await tx.mysteryBoxTicket.count({
                    where: { customerId, mysteryBoxId: box.id },
                });
                if (existingCount >= box.maxPerUser) {
                    throw new Error('MAX_PER_USER_REACHED');
                }
            }

            // เช็คแต้ม
            const cust = await tx.customer.findUnique({ where: { customerId } });
            if (!cust) throw new Error('CUSTOMER_NOT_FOUND');
            if (cust.points < cost) throw new Error('INSUFFICIENT_POINTS');

            // หักแต้ม
            await tx.customer.update({
                where: { customerId },
                data: { points: { decrement: cost } },
            });

            // log
            await tx.pointTransaction.create({
                data: {
                    customerId,
                    amount: -cost,
                    type: 'REDEEM_REWARD',
                    detail: `แลกกล่องสุ่ม ${box.name} (ID: ${box.id})`,
                },
            });

            // create ticket
            const ticket = await tx.mysteryBoxTicket.create({
                data: {
                    customerId,
                    mysteryBoxId: box.id,
                    sourceEvent: 'POINT_REDEEM',
                    sourceMetadata: JSON.stringify({ pointCost: cost }),
                    status: 'UNOPENED',
                },
            });

            return { ticketId: ticket.id, remainingPoints: cust.points - cost };
        });
        return { success: true, ...result };
    } catch (e) {
        const known = ['MAX_PER_USER_REACHED', 'CUSTOMER_NOT_FOUND', 'INSUFFICIENT_POINTS'];
        if (known.includes(e.message)) return { success: false, error: e.message };
        console.error('[MysteryBox] redeemBoxWithPoints failed:', e.message);
        return { success: false, error: 'REDEEM_FAILED' };
    }
}

/**
 * เปิดกล่อง — เลือก prize แบบ weighted random
 *
 * Returns: { success, prize, customerCoupon? }
 */
export async function openTicket({ customerId, ticketId } = {}) {
    if (!customerId || !ticketId) {
        return { success: false, error: 'INVALID_INPUT' };
    }

    // load ticket + box + prizes
    const ticket = await prisma.mysteryBoxTicket.findUnique({
        where: { id: parseInt(ticketId) },
        include: {
            mysteryBox: {
                include: {
                    prizes: { where: { isActive: true } },
                },
            },
        },
    });
    if (!ticket) return { success: false, error: 'NOT_FOUND' };
    if (ticket.customerId !== customerId) return { success: false, error: 'NOT_OWNER' };
    if (ticket.status === 'OPENED') {
        // ส่งคืนสภาพปัจจุบัน — เผื่อ frontend retry
        const prize = ticket.awardedPrizeId
            ? await prisma.mysteryBoxPrize.findUnique({ where: { id: ticket.awardedPrizeId } })
            : null;
        return { success: true, alreadyOpened: true, prize };
    }

    const prizes = ticket.mysteryBox.prizes;
    if (prizes.length === 0) return { success: false, error: 'NO_PRIZES_CONFIGURED' };

    // weighted random
    const totalWeight = prizes.reduce((sum, p) => sum + Math.max(0, p.weight || 0), 0);
    if (totalWeight <= 0) return { success: false, error: 'INVALID_WEIGHTS' };
    let roll = Math.random() * totalWeight;
    let chosen = prizes[0];
    for (const p of prizes) {
        roll -= Math.max(0, p.weight || 0);
        if (roll <= 0) {
            chosen = p;
            break;
        }
    }

    // ทำ tx: mark ticket OPENED + สร้าง CustomerCoupon ถ้ามี rewardCouponId
    let createdCC = null;
    try {
        await prisma.$transaction(async (tx) => {
            let couponId = null;
            if (chosen.rewardCouponId) {
                // ตรวจว่า coupon ยังมี active
                const coupon = await tx.coupon.findUnique({ where: { id: chosen.rewardCouponId } });
                if (coupon && coupon.isActive) {
                    let expiryDate = coupon.validUntil;
                    if (coupon.validityDays) {
                        expiryDate = new Date(Date.now() + coupon.validityDays * 24 * 60 * 60 * 1000);
                    }
                    createdCC = await tx.customerCoupon.create({
                        data: {
                            customerId,
                            couponId: coupon.id,
                            status: 'AVAILABLE',
                            expiryDate,
                            sourceEvent: `MYSTERY_BOX:${ticket.mysteryBoxId}:prize:${chosen.id}`,
                        },
                    });
                    await tx.coupon.update({
                        where: { id: coupon.id },
                        data: { claimedCount: { increment: 1 } },
                    });
                    couponId = createdCC.id;
                }
            }

            await tx.mysteryBoxTicket.update({
                where: { id: ticket.id },
                data: {
                    status: 'OPENED',
                    openedAt: new Date(),
                    awardedPrizeId: chosen.id,
                    awardedCustomerCouponId: couponId,
                },
            });
        });
    } catch (e) {
        console.error('[MysteryBox] openTicket failed:', e.message);
        return { success: false, error: 'OPEN_FAILED' };
    }

    return {
        success: true,
        prize: shapePrizeForClient(chosen),
        customerCoupon: createdCC ? { id: createdCC.id, couponId: createdCC.couponId } : null,
    };
}

// ----- shapers -----

function shapeBoxForClient(box) {
    const totalWeight = (box.prizes || []).reduce((s, p) => s + Math.max(0, p.weight || 0), 0) || 1;
    return {
        id: box.id,
        name: box.name,
        nameEn: box.nameEn,
        description: box.description,
        descriptionEn: box.descriptionEn,
        imageUrl: box.imageUrl,
        trigger: box.trigger,
        minPurchaseAmount: box.minPurchaseAmount != null ? Number(box.minPurchaseAmount) : null,
        maxPurchaseAmount: box.maxPurchaseAmount != null ? Number(box.maxPurchaseAmount) : null,
        ticketsPerEvent: box.ticketsPerEvent,
        maxPerUser: box.maxPerUser,
        pointCost: box.pointCost ?? null,
        requiredTier: box.requiredTier, // 'NONE' | 'SILVER' | 'GOLD'
        endDate: box.endDate,
        prizes: (box.prizes || []).map((p) => ({
            ...shapePrizeForClient(p),
            chancePercent: Math.round(((p.weight || 0) / totalWeight) * 1000) / 10, // 1 decimal
        })),
    };
}

function shapePrizeForClient(p) {
    return {
        id: p.id,
        name: p.name,
        nameEn: p.nameEn,
        description: p.description,
        descriptionEn: p.descriptionEn,
        imageUrl: p.imageUrl,
        weight: p.weight,
        rewardCouponId: p.rewardCouponId,
        isPhysicalReward: p.isPhysicalReward,
        isNoPrize: !!p.isNoPrize,
    };
}

function shapeTicketForClient(t) {
    return {
        id: t.id,
        boxId: t.mysteryBoxId,
        boxName: t.mysteryBox?.name,
        boxNameEn: t.mysteryBox?.nameEn,
        boxImageUrl: t.mysteryBox?.imageUrl,
        status: t.status,
        sourceEvent: t.sourceEvent,
        createdAt: t.createdAt,
        openedAt: t.openedAt,
        awardedPrize: t.awardedPrize ? shapePrizeForClient(t.awardedPrize) : null,
    };
}

function escapeHtml(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}
