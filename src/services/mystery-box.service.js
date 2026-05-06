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
