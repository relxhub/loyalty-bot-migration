// tests/unit/coupon.redeemCouponWithPoints.test.js
//
// เทส redeemCouponWithPoints — atomic แต้ม → คูปองในกระเป๋า
// ครอบคลุม: validity gates, quota gates, points-sufficient gate, happy path

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockReset } from '../mocks/prisma.mock.js';

vi.mock('../../src/db.js', async () => {
    const { mockDeep } = await import('vitest-mock-extended');
    return { prisma: mockDeep() };
});

import { prisma } from '../../src/db.js';
import { redeemCouponWithPoints } from '../../src/services/coupon.service.js';

beforeEach(() => {
    mockReset(prisma);
    prisma.$transaction.mockImplementation(async (cb) => cb(prisma));
});

// ----- fixtures -----

function makeCoupon(overrides = {}) {
    return {
        id: 'C1',
        name: 'Test Coupon',
        isActive: true,
        pointsCost: 100,
        startDate: null,
        endDate: null,
        validUntil: null,
        validityDays: null,
        totalQuota: null,
        claimedCount: 0,
        usageLimitPerUser: 1,
        ...overrides,
    };
}

function setHappyPath({ couponOverrides = {}, customerPoints = 500, existingClaims = 0 } = {}) {
    const coupon = makeCoupon(couponOverrides);
    prisma.coupon.findUnique.mockResolvedValue(coupon);
    prisma.customerCoupon.count.mockResolvedValue(existingClaims);
    prisma.customer.findUnique.mockResolvedValue({ customerId: 'OT1', points: customerPoints });
    prisma.customer.update.mockResolvedValue({});
    prisma.pointTransaction.create.mockResolvedValue({});
    // หลังหักแต้ม ระบบ inc claimedCount → return updated coupon
    prisma.coupon.update.mockResolvedValue({ ...coupon, claimedCount: coupon.claimedCount + 1 });
    prisma.customerCoupon.create.mockResolvedValue({ id: 999, customerId: 'OT1', couponId: coupon.id });
    return coupon;
}

// ============================================================
// validity gates
// ============================================================

describe('redeemCouponWithPoints — coupon availability', () => {
    it('throws when coupon does not exist', async () => {
        prisma.coupon.findUnique.mockResolvedValue(null);
        await expect(redeemCouponWithPoints('OT1', 'GHOST')).rejects.toThrow(/ไม่พร้อมใช้งาน/);
    });

    it('throws when coupon is inactive', async () => {
        prisma.coupon.findUnique.mockResolvedValue(makeCoupon({ isActive: false }));
        await expect(redeemCouponWithPoints('OT1', 'C1')).rejects.toThrow(/ไม่พร้อมใช้งาน/);
    });

    it('throws when coupon has no points cost (not redeemable for points)', async () => {
        prisma.coupon.findUnique.mockResolvedValue(makeCoupon({ pointsCost: 0 }));
        await expect(redeemCouponWithPoints('OT1', 'C1')).rejects.toThrow(/ไม่ได้เปิดให้ใช้แต้มแลก/);
    });
});

// ============================================================
// quota gates
// ============================================================

describe('redeemCouponWithPoints — quota gates', () => {
    it('throws when totalQuota is reached', async () => {
        prisma.coupon.findUnique.mockResolvedValue(
            makeCoupon({ totalQuota: 100, claimedCount: 100 }),
        );
        await expect(redeemCouponWithPoints('OT1', 'C1')).rejects.toThrow(/แลกจนเต็มแล้ว/);
    });

    it('throws when customer hits usageLimitPerUser', async () => {
        setHappyPath({ couponOverrides: { usageLimitPerUser: 2 }, existingClaims: 2 });
        await expect(redeemCouponWithPoints('OT1', 'C1')).rejects.toThrow(/แลกคูปองนี้ครบตามสิทธิ์/);
    });
});

// ============================================================
// points sufficiency
// ============================================================

describe('redeemCouponWithPoints — points sufficiency', () => {
    it('throws when customer has insufficient points', async () => {
        setHappyPath({ couponOverrides: { pointsCost: 100 }, customerPoints: 50 });
        await expect(redeemCouponWithPoints('OT1', 'C1')).rejects.toThrow(/แต้มไม่พอ/);
    });
});

// ============================================================
// happy path
// ============================================================

describe('redeemCouponWithPoints — happy path', () => {
    it('decrements points, logs transaction, increments claimedCount, creates CustomerCoupon', async () => {
        setHappyPath({ couponOverrides: { pointsCost: 80 }, customerPoints: 500 });

        const r = await redeemCouponWithPoints('OT1', 'C1');

        expect(r.remainingPoints).toBe(420); // 500 - 80
        expect(r.customerCoupon).toBeDefined();

        // 1. หักแต้ม
        const custUpdate = prisma.customer.update.mock.calls[0][0];
        expect(custUpdate.where.customerId).toBe('OT1');
        expect(custUpdate.data.points.decrement).toBe(80);

        // 2. log point transaction (amount = -pointsCost, type = REDEEM_REWARD)
        const ptArg = prisma.pointTransaction.create.mock.calls[0][0].data;
        expect(ptArg.customerId).toBe('OT1');
        expect(ptArg.amount).toBe(-80);
        expect(ptArg.type).toBe('REDEEM_REWARD');

        // 3. inc claimedCount
        const cpUpdate = prisma.coupon.update.mock.calls[0][0];
        expect(cpUpdate.where.id).toBe('C1');
        expect(cpUpdate.data.claimedCount.increment).toBe(1);

        // 4. customerCoupon created with status AVAILABLE
        const ccArg = prisma.customerCoupon.create.mock.calls[0][0].data;
        expect(ccArg.customerId).toBe('OT1');
        expect(ccArg.couponId).toBe('C1');
        expect(ccArg.status).toBe('AVAILABLE');
    });
});
