// src/services/stock-reservation.service.js
//
// Stock Reservation + Anti-Abuse helpers (Phase 4)
//
// ทำหน้าที่:
//   - validateCartLimits()         → D1: qty/total/distinct caps (pure)
//   - getCustomerTier()            → D5: 'NEW'|'REGULAR'|'VIP'|'ABUSER'
//   - getEffectiveExpiryMinutes()  → D5: คืนนาทีที่จะ snapshot ลง Order
//   - checkVelocity()              → D3: rate-limit per customer per hour
//   - checkActiveReservations()    → D2: active PENDING_PAYMENT counts
//   - reserveStockAtomic()         → D4+D6: conditional UPDATE (no oversold)
//   - releaseReservation()         → cancel/expire path: reservedQuantity--
//   - convertReservationToHardDecrement() → paid/mismatch path: stock-- + reserved--
//
// All DB-mutating functions รับ `prismaClient` (default = global prisma) เพื่อใช้ใน $transaction

import { prisma } from '../db.js';
import { getConfig } from '../config/config.js';
import { emitSocket } from './notification-center.service.js';

// ----- config loader -----

/**
 * โหลด config ทั้งหมดที่ใช้ใน checkout flow มาเป็น object เดียว
 * (อ่านจาก in-memory cache ของ getConfig — เร็ว, ไม่แตะ DB)
 */
export function loadCheckoutConfigs() {
    const num = (k, d) => {
        const v = getConfig(k);
        const n = Number(v);
        return Number.isFinite(n) ? n : d;
    };
    return {
        // D1
        maxQtyPerItem: num('checkout_max_qty_per_item', 10),
        maxTotalItems: num('checkout_max_total_items', 50),
        maxDistinctSkus: num('checkout_max_distinct_skus', 15),
        // D2
        maxActiveReservations: num('checkout_max_active_reservations', 1),
        // D3
        velocityMaxPerHour: num('checkout_velocity_max_per_hour', 5),
        velocityWindowSeconds: num('checkout_velocity_window_seconds', 3600),
        // D4
        reserveMaxPerUserPct: num('checkout_reserve_max_per_user_pct', 0.5),
        reserveGlobalAlertPct: num('checkout_reserve_global_alert_pct', 0.8),
        // D5
        expiryMinutesNew: num('expiry_minutes_new', 10),
        expiryMinutesRegular: num('expiry_minutes_regular', 15),
        expiryMinutesVip: num('expiry_minutes_vip', 30),
        expiryMinutesAbuser: num('expiry_minutes_abuser', 5),
        newThresholdOrders: num('checkout_new_threshold_orders', 1),
        vipThresholdOrders: num('checkout_vip_threshold_orders', 5),
        abuserThresholdCancellations: num('checkout_abuser_threshold_cancellations', 3),
    };
}

// ----- D1: cart limits (pure) -----

/**
 * ตรวจสอบ cart ว่าไม่เกิน limits
 * @param {Array<{id:any, quantity:number}>} cart — items จาก /orders/checkout
 * @param {object} cfg — output ของ loadCheckoutConfigs()
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
export function validateCartLimits(cart, cfg) {
    if (!Array.isArray(cart) || cart.length === 0) {
        return { ok: false, error: 'ตะกร้าสินค้าว่างเปล่า' };
    }
    if (cart.length > cfg.maxDistinctSkus) {
        return { ok: false, error: `เลือกสินค้าได้ไม่เกิน ${cfg.maxDistinctSkus} รายการต่อออเดอร์ (กรุณาลดจำนวนชนิด หรือทักแอดมินสำหรับซื้อขายส่ง)` };
    }
    let totalItems = 0;
    for (const it of cart) {
        const q = parseInt(it.quantity, 10) || 0;
        if (q <= 0) {
            return { ok: false, error: 'จำนวนสินค้าต้องมากกว่า 0' };
        }
        if (q > cfg.maxQtyPerItem) {
            return { ok: false, error: `สินค้าตัวเดียวกันสั่งได้ไม่เกิน ${cfg.maxQtyPerItem} ชิ้นต่อออเดอร์` };
        }
        totalItems += q;
    }
    if (totalItems > cfg.maxTotalItems) {
        return { ok: false, error: `จำนวนสินค้ารวมเกิน ${cfg.maxTotalItems} ชิ้นต่อออเดอร์` };
    }
    return { ok: true };
}

// ----- D5: customer tier + expiry -----

/**
 * หา tier ของลูกค้าจากประวัติ:
 *   - PAID/PROCESSING/SHIPPED count → New / Regular / VIP
 *   - CANCELLED ใน 24 ชม. ล่าสุด → ถ้าเกิน abuserThreshold → Abuser (override)
 */
export async function getCustomerTier(customerId, cfg, prismaClient = prisma) {
    if (!customerId) return 'NEW';

    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [paidCount, recentCancelCount] = await Promise.all([
        prismaClient.order.count({
            where: {
                customerId,
                status: { in: ['PAID', 'PROCESSING', 'SHIPPED'] },
                kind: 'PRODUCT',
            },
        }),
        prismaClient.order.count({
            where: {
                customerId,
                status: 'CANCELLED',
                kind: 'PRODUCT',
                createdAt: { gte: since24h },
            },
        }),
    ]);

    if (recentCancelCount >= cfg.abuserThresholdCancellations) return 'ABUSER';
    if (paidCount >= cfg.vipThresholdOrders) return 'VIP';
    if (paidCount < cfg.newThresholdOrders) return 'NEW';
    return 'REGULAR';
}

export async function getEffectiveExpiryMinutes(customerId, cfg, prismaClient = prisma) {
    const tier = await getCustomerTier(customerId, cfg, prismaClient);
    switch (tier) {
        case 'ABUSER':  return cfg.expiryMinutesAbuser;
        case 'NEW':     return cfg.expiryMinutesNew;
        case 'VIP':     return cfg.expiryMinutesVip;
        default:        return cfg.expiryMinutesRegular;
    }
}

// ----- D3: velocity -----

export async function checkVelocity(customerId, cfg, prismaClient = prisma) {
    const since = new Date(Date.now() - cfg.velocityWindowSeconds * 1000);
    const count = await prismaClient.order.count({
        where: {
            customerId,
            kind: 'PRODUCT',
            createdAt: { gte: since },
        },
    });
    if (count >= cfg.velocityMaxPerHour) {
        return {
            ok: false,
            count,
            limit: cfg.velocityMaxPerHour,
            error: `สร้างออเดอร์เกิน ${cfg.velocityMaxPerHour} ครั้งในช่วง ${Math.round(cfg.velocityWindowSeconds / 60)} นาที กรุณารอสักครู่`,
        };
    }
    return { ok: true, count };
}

// ----- D2: active reservations -----

/**
 * คืน array ของ orders ที่ active (PENDING_PAYMENT, kind=PRODUCT)
 * แยก mismatchLocked ออก เพราะ caller ตัดสินใจต่างกัน:
 *   - non-mismatch → auto-cancel ได้
 *   - mismatch → ต้อง block (admin ต้องดำเนินการก่อน)
 */
export async function getActiveReservations(customerId, prismaClient = prisma) {
    const orders = await prismaClient.order.findMany({
        where: {
            customerId,
            kind: 'PRODUCT',
            status: 'PENDING_PAYMENT',
        },
        select: { id: true, mismatchLocked: true, createdAt: true },
    });
    return {
        nonMismatch: orders.filter(o => !o.mismatchLocked),
        mismatch: orders.filter(o => o.mismatchLocked),
    };
}

// ----- D4 + D6: atomic reservation -----

/**
 * จองสต็อก (เพิ่ม reservedQuantity) แบบ atomic กัน race
 * ใช้ conditional UPDATE: WHERE stockQuantity - reservedQuantity >= qty
 * ถ้า 0 rows updated → throw (ไม่พอ)
 *
 * D4 per-user ratio: เช็คว่าลูกค้าคนนี้กำลังจองรวมเกิน maxRatioPerUser ของ stock หรือไม่
 *
 * @param {object} tx — Prisma transaction client
 * @param {string} customerId
 * @param {Array<{productId:number, qty:number}>} items
 * @param {object} cfg — loadCheckoutConfigs() output
 * @throws Error('INSUFFICIENT_STOCK:<productId>') | Error('RATIO_EXCEEDED:<productId>') | Error('NOT_FOUND:<productId>')
 */
export async function reserveStockAtomic(tx, customerId, items, cfg) {
    for (const it of items) {
        const productId = parseInt(it.productId, 10);
        const qty = parseInt(it.qty, 10);
        if (!Number.isFinite(productId) || !Number.isFinite(qty) || qty <= 0) {
            throw new Error('INVALID_ITEM');
        }

        // โหลดข้อมูล product + คำนวณ user existing reservation (D4 per-user)
        const product = await tx.product.findUnique({
            where: { id: productId },
            select: { id: true, stockQuantity: true, reservedQuantity: true },
        });
        if (!product) throw new Error(`NOT_FOUND:${productId}`);

        // ลูกค้าคนนี้จองสินค้าตัวนี้อยู่กี่ชิ้นแล้ว (D4 per-user ratio)
        const existing = await tx.orderItem.aggregate({
            where: {
                productId,
                order: {
                    customerId,
                    kind: 'PRODUCT',
                    status: 'PENDING_PAYMENT',
                    mismatchLocked: false,
                },
            },
            _sum: { quantity: true },
        });
        const userExisting = existing._sum.quantity || 0;
        const userTotalAfter = userExisting + qty;

        // floor at 1 — กรณี stock น้อย floor(0.5×N) อาจเป็น 0
        const userMax = Math.max(1, Math.floor(product.stockQuantity * cfg.reserveMaxPerUserPct));
        if (userTotalAfter > userMax) {
            throw new Error(`RATIO_EXCEEDED:${productId}:${userMax}`);
        }

        // Conditional UPDATE — atomic check & set
        const updated = await tx.$executeRaw`
            UPDATE "Product"
            SET "reservedQuantity" = "reservedQuantity" + ${qty}
            WHERE id = ${productId}
              AND "stockQuantity" - "reservedQuantity" >= ${qty}
        `;
        if (updated === 0) {
            throw new Error(`INSUFFICIENT_STOCK:${productId}`);
        }
    }
}

// ----- release / convert -----

/**
 * ปล่อย reservation (cancel / expire) — reservedQuantity -= qty (clamp ที่ 0)
 */
export async function releaseReservation(tx, orderItems) {
    for (const it of orderItems) {
        await tx.$executeRaw`
            UPDATE "Product"
            SET "reservedQuantity" = GREATEST(0, "reservedQuantity" - ${it.quantity})
            WHERE id = ${it.productId}
        `;
    }
}

/**
 * แปลง reservation → hard decrement (paid path)
 *   - stockQuantity -= qty  (ตัดของจริง)
 *   - reservedQuantity -= qty (ปล่อยจอง — ตอนนี้ของออกไปแล้ว)
 * Atomic ใน update เดียว
 */
export async function convertReservationToHardDecrement(tx, orderItems) {
    for (const it of orderItems) {
        await tx.$executeRaw`
            UPDATE "Product"
            SET "stockQuantity" = "stockQuantity" - ${it.quantity},
                "reservedQuantity" = GREATEST(0, "reservedQuantity" - ${it.quantity})
            WHERE id = ${it.productId}
        `;
    }
}

// ----- broadcast helper: notify clients ของ available stock เปลี่ยน -----

/**
 * อ่านสต็อกสด (post-tx) และ broadcast 'product_update' ให้ทุก client
 * เพื่อให้ products.html อัปเดต available realtime หลัง reserve/release/convert
 * ใช้นอก tx (หลัง commit) เท่านั้น เพราะอ่านจาก global prisma
 *
 * @param {Array<number>|Array<{productId:number}>|Array<{id:number}>} idsOrItems
 */
export async function broadcastStockUpdate(idsOrItems) {
    try {
        if (!Array.isArray(idsOrItems) || idsOrItems.length === 0) return;
        const ids = [...new Set(idsOrItems.map(x => {
            if (typeof x === 'number') return x;
            return parseInt(x.productId ?? x.id, 10);
        }).filter(Number.isFinite))];
        if (ids.length === 0) return;
        const products = await prisma.product.findMany({
            where: { id: { in: ids } },
            select: { id: true, status: true, stockQuantity: true, reservedQuantity: true },
        });
        for (const p of products) {
            const available = Math.max(0, p.stockQuantity - (p.reservedQuantity || 0));
            emitSocket('product_update', {
                productId: p.id,
                status: p.status,
                stock: available,
            });
        }
    } catch (e) { /* best-effort — never fail caller */ }
}

// ----- helper: build user-friendly error map for endpoint -----

const ERROR_MESSAGES = {
    INVALID_ITEM: 'ข้อมูลรายการไม่ถูกต้อง',
};

/**
 * แปลง error.message ของ reserveStockAtomic เป็นข้อความสำหรับลูกค้า
 * (caller ส่ง productNameMap optional เพื่อแสดงชื่อ)
 */
export function formatReservationError(message, productNameMap = {}) {
    if (typeof message !== 'string') return 'จองสต็อกไม่สำเร็จ';
    if (ERROR_MESSAGES[message]) return ERROR_MESSAGES[message];

    const [code, pid, extra] = message.split(':');
    const name = productNameMap[pid] || `#${pid}`;
    if (code === 'INSUFFICIENT_STOCK') return `สินค้า "${name}" ไม่พอ — มีคนจองตัดหน้าแล้ว`;
    if (code === 'NOT_FOUND') return `ไม่พบสินค้า "${name}"`;
    if (code === 'RATIO_EXCEEDED') return `สินค้า "${name}" คุณจองได้ไม่เกิน ${extra} ชิ้นจากสต็อกที่มี (กันสินค้าหมดเกินสำหรับลูกค้าท่านอื่น)`;
    return message;
}
