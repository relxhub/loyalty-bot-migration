// tests/unit/stockReservation.db.test.js
//
// เทส DB-dependent functions ของ stock-reservation service:
//   - getCustomerTier (D5)
//   - getEffectiveExpiryMinutes (D5)
//   - checkVelocity (D3)
//   - getActiveReservations (D2)
//   - reserveStockAtomic (D4 + D6)
//   - releaseReservation
//   - convertReservationToHardDecrement
//
// Pattern: mock prisma + ส่ง prismaClient เป็น prisma mock เพื่อจำลอง $transaction

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockReset } from '../mocks/prisma.mock.js';

vi.mock('../../src/db.js', async () => {
    const { mockDeep } = await import('vitest-mock-extended');
    return { prisma: mockDeep() };
});
vi.mock('../../src/config/config.js', () => ({
    getConfig: vi.fn(),
    loadConfig: vi.fn(),
}));

import { prisma } from '../../src/db.js';
import {
    getCustomerTier,
    getEffectiveExpiryMinutes,
    checkVelocity,
    getActiveReservations,
    reserveStockAtomic,
    releaseReservation,
    convertReservationToHardDecrement,
} from '../../src/services/stock-reservation.service.js';

beforeEach(() => mockReset(prisma));

const cfg = {
    maxQtyPerItem: 10,
    maxTotalItems: 50,
    maxDistinctSkus: 15,
    maxActiveReservations: 1,
    velocityMaxPerHour: 5,
    velocityWindowSeconds: 3600,
    reserveMaxPerUserPct: 0.5,
    reserveGlobalAlertPct: 0.8,
    expiryMinutesNew: 10,
    expiryMinutesRegular: 15,
    expiryMinutesVip: 30,
    expiryMinutesAbuser: 5,
    newThresholdOrders: 1,
    vipThresholdOrders: 5,
    abuserThresholdCancellations: 3,
};

// ============================================================
// D5: customer tier + expiry
// ============================================================

describe('getCustomerTier', () => {
    it('returns NEW when paidCount < newThreshold and no recent cancellations', async () => {
        // [paidCount, recentCancelCount] — ใช้ Promise.all → mock เรียงตามลำดับ call
        prisma.order.count.mockResolvedValueOnce(0).mockResolvedValueOnce(0);
        expect(await getCustomerTier('OT1', cfg)).toBe('NEW');
    });

    it('returns REGULAR when paidCount in range [newThreshold, vipThreshold)', async () => {
        prisma.order.count.mockResolvedValueOnce(3).mockResolvedValueOnce(0);
        expect(await getCustomerTier('OT1', cfg)).toBe('REGULAR');
    });

    it('returns VIP when paidCount >= vipThreshold', async () => {
        prisma.order.count.mockResolvedValueOnce(10).mockResolvedValueOnce(0);
        expect(await getCustomerTier('OT1', cfg)).toBe('VIP');
    });

    it('returns ABUSER when recent cancellations >= threshold (overrides VIP)', async () => {
        // VIP ตาม paidCount แต่มี cancel เยอะ → ABUSER override
        prisma.order.count.mockResolvedValueOnce(10).mockResolvedValueOnce(3);
        expect(await getCustomerTier('OT1', cfg)).toBe('ABUSER');
    });

    it('returns NEW for null/undefined customerId', async () => {
        expect(await getCustomerTier(null, cfg)).toBe('NEW');
        expect(prisma.order.count).not.toHaveBeenCalled();
    });
});

describe('getEffectiveExpiryMinutes', () => {
    it('maps NEW → expiryMinutesNew', async () => {
        prisma.order.count.mockResolvedValueOnce(0).mockResolvedValueOnce(0);
        expect(await getEffectiveExpiryMinutes('OT1', cfg)).toBe(cfg.expiryMinutesNew);
    });
    it('maps VIP → expiryMinutesVip', async () => {
        prisma.order.count.mockResolvedValueOnce(10).mockResolvedValueOnce(0);
        expect(await getEffectiveExpiryMinutes('OT1', cfg)).toBe(cfg.expiryMinutesVip);
    });
    it('maps ABUSER → expiryMinutesAbuser (smallest window)', async () => {
        prisma.order.count.mockResolvedValueOnce(10).mockResolvedValueOnce(3);
        expect(await getEffectiveExpiryMinutes('OT1', cfg)).toBe(cfg.expiryMinutesAbuser);
    });
});

// ============================================================
// D3: velocity
// ============================================================

describe('checkVelocity', () => {
    it('returns ok when count below limit', async () => {
        prisma.order.count.mockResolvedValue(2);
        const r = await checkVelocity('OT1', cfg);
        expect(r.ok).toBe(true);
    });

    it('rejects when count reaches limit', async () => {
        prisma.order.count.mockResolvedValue(5);
        const r = await checkVelocity('OT1', cfg);
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/เกิน 5 ครั้ง/);
    });

    it('rejects when count exceeds limit', async () => {
        prisma.order.count.mockResolvedValue(99);
        expect((await checkVelocity('OT1', cfg)).ok).toBe(false);
    });
});

// ============================================================
// D2: active reservations
// ============================================================

describe('getActiveReservations', () => {
    it('splits orders into mismatch and non-mismatch', async () => {
        prisma.order.findMany.mockResolvedValue([
            { id: 'A', mismatchLocked: false, createdAt: new Date() },
            { id: 'B', mismatchLocked: true, createdAt: new Date() },
            { id: 'C', mismatchLocked: false, createdAt: new Date() },
        ]);
        const r = await getActiveReservations('OT1');
        expect(r.nonMismatch.map(o => o.id).sort()).toEqual(['A', 'C']);
        expect(r.mismatch.map(o => o.id)).toEqual(['B']);
    });
});

// ============================================================
// D4 + D6: reserveStockAtomic
// ============================================================

describe('reserveStockAtomic', () => {
    it('throws NOT_FOUND when product missing', async () => {
        prisma.product.findUnique.mockResolvedValue(null);
        await expect(
            reserveStockAtomic(prisma, 'OT1', [{ productId: 99, qty: 1 }], cfg),
        ).rejects.toThrow(/NOT_FOUND:99/);
    });

    it('throws RATIO_EXCEEDED when user already reserved >= 50% of stock', async () => {
        // stock=10 → max per user = floor(10 × 0.5) = 5
        // user already has 3, requesting 3 more → 6 > 5
        prisma.product.findUnique.mockResolvedValue({ id: 1, stockQuantity: 10, reservedQuantity: 3 });
        prisma.orderItem.aggregate.mockResolvedValue({ _sum: { quantity: 3 } });
        await expect(
            reserveStockAtomic(prisma, 'OT1', [{ productId: 1, qty: 3 }], cfg),
        ).rejects.toThrow(/RATIO_EXCEEDED:1:5/);
    });

    it('throws INSUFFICIENT_STOCK when atomic UPDATE returns 0 rows', async () => {
        // ใช้ stock ใหญ่พอให้ผ่าน ratio (50%×20 = 10 ≥ 3) แต่ mock $executeRaw=0 เพื่อจำลอง
        // race condition: ระหว่าง findUnique กับ UPDATE มีคนอื่นจองตัดหน้า
        prisma.product.findUnique.mockResolvedValue({ id: 1, stockQuantity: 20, reservedQuantity: 0 });
        prisma.orderItem.aggregate.mockResolvedValue({ _sum: { quantity: 0 } });
        prisma.$executeRaw.mockResolvedValue(0); // 0 rows updated → another tx beat us
        await expect(
            reserveStockAtomic(prisma, 'OT1', [{ productId: 1, qty: 3 }], cfg),
        ).rejects.toThrow(/INSUFFICIENT_STOCK:1/);
    });

    it('succeeds when within ratio + atomic UPDATE returns 1', async () => {
        prisma.product.findUnique.mockResolvedValue({ id: 1, stockQuantity: 10, reservedQuantity: 0 });
        prisma.orderItem.aggregate.mockResolvedValue({ _sum: { quantity: 0 } });
        prisma.$executeRaw.mockResolvedValue(1);
        await expect(
            reserveStockAtomic(prisma, 'OT1', [{ productId: 1, qty: 3 }], cfg),
        ).resolves.toBeUndefined();
        expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    });

    it('throws INVALID_ITEM for non-numeric productId or qty', async () => {
        await expect(
            reserveStockAtomic(prisma, 'OT1', [{ productId: 'abc', qty: 1 }], cfg),
        ).rejects.toThrow(/INVALID_ITEM/);
        await expect(
            reserveStockAtomic(prisma, 'OT1', [{ productId: 1, qty: 0 }], cfg),
        ).rejects.toThrow(/INVALID_ITEM/);
    });

    it('floor at 1 — stock=1 with 50% pct → user can still reserve 1 (no division-by-zero)', async () => {
        prisma.product.findUnique.mockResolvedValue({ id: 1, stockQuantity: 1, reservedQuantity: 0 });
        prisma.orderItem.aggregate.mockResolvedValue({ _sum: { quantity: 0 } });
        prisma.$executeRaw.mockResolvedValue(1);
        // floor(1 × 0.5) = 0 → max(1, 0) = 1 → ratio check ผ่าน
        await expect(
            reserveStockAtomic(prisma, 'OT1', [{ productId: 1, qty: 1 }], cfg),
        ).resolves.toBeUndefined();
    });
});

// ============================================================
// release / convert
// ============================================================

describe('releaseReservation', () => {
    it('issues 1 raw UPDATE per item', async () => {
        prisma.$executeRaw.mockResolvedValue(1);
        await releaseReservation(prisma, [
            { productId: 1, quantity: 2 },
            { productId: 2, quantity: 5 },
        ]);
        expect(prisma.$executeRaw).toHaveBeenCalledTimes(2);
    });

    it('handles empty items list (no-op)', async () => {
        await releaseReservation(prisma, []);
        expect(prisma.$executeRaw).not.toHaveBeenCalled();
    });
});

describe('convertReservationToHardDecrement', () => {
    it('issues 1 raw UPDATE per item (atomic stock-- + reserved--)', async () => {
        prisma.$executeRaw.mockResolvedValue(1);
        await convertReservationToHardDecrement(prisma, [
            { productId: 1, quantity: 3 },
        ]);
        expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    });
});
