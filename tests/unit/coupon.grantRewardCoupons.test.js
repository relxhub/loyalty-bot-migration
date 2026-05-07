// tests/unit/coupon.grantRewardCoupons.test.js
//
// เทส grantRewardCoupons — แจกคูปอง reward อัตโนมัติเมื่อ event เกิด
// (เช่น REFEREE_FIRST_PURCHASE)

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockReset } from '../mocks/prisma.mock.js';

vi.mock('../../src/db.js', async () => {
    const { mockDeep } = await import('vitest-mock-extended');
    return { prisma: mockDeep() };
});
vi.mock('../../src/services/notification-center.service.js', () => ({
    notifyCustomer: vi.fn(),
}));

import { prisma } from '../../src/db.js';
import { grantRewardCoupons } from '../../src/services/coupon.service.js';

beforeEach(() => {
    mockReset(prisma);
    prisma.$transaction.mockImplementation(async (cb) => cb(prisma));
});

// ----- fixtures -----

function makeRewardCoupon(overrides = {}) {
    return {
        id: 'REWARD_C1',
        name: 'Reward Coupon',
        type: 'DISCOUNT_PERCENT',
        value: 10,
        isActive: true,
        rewardTrigger: 'REFEREE_FIRST_PURCHASE',
        rewardRecipient: 'REFERRER',
        rewardMinAmount: null,
        rewardMaxAmount: null,
        rewardOncePerReferral: true,
        validUntil: null,
        validityDays: null,
        startDate: null,
        endDate: null,
        totalQuota: null,
        claimedCount: 0,
        giftQty: null,
        ...overrides,
    };
}

function setHappyPath(coupons) {
    prisma.coupon.findMany.mockResolvedValue(coupons);
    prisma.customerCoupon.findFirst.mockResolvedValue(null); // no duplicates
    prisma.customerCoupon.create.mockResolvedValue({ id: 1 });
    prisma.coupon.update.mockImplementation(async ({ where }) => {
        const c = coupons.find((x) => x.id === where.id);
        return { ...c, claimedCount: (c?.claimedCount || 0) + 1 };
    });
}

const baseArgs = {
    event: 'REFEREE_FIRST_PURCHASE',
    referrerId: 'OT-REF',
    refereeId: 'OT-NEW',
    eligibleAmount: 1000,
    referralRowId: 42,
};

// ============================================================
// amount range filters
// ============================================================

describe('grantRewardCoupons — amount range', () => {
    it('skips BELOW_MIN when eligibleAmount < rewardMinAmount', async () => {
        setHappyPath([makeRewardCoupon({ rewardMinAmount: 500 })]);

        const r = await grantRewardCoupons({ ...baseArgs, eligibleAmount: 300 });

        expect(r.granted).toEqual([]);
        expect(r.skipped[0].reason).toBe('BELOW_MIN');
        expect(prisma.customerCoupon.create).not.toHaveBeenCalled();
    });

    it('skips ABOVE_MAX when eligibleAmount > rewardMaxAmount', async () => {
        setHappyPath([makeRewardCoupon({ rewardMaxAmount: 500 })]);

        const r = await grantRewardCoupons({ ...baseArgs, eligibleAmount: 800 });

        expect(r.granted).toEqual([]);
        expect(r.skipped[0].reason).toBe('ABOVE_MAX');
    });
});

// ============================================================
// duplicate prevention
// ============================================================

describe('grantRewardCoupons — duplicate prevention', () => {
    it('skips ALREADY_GRANTED when rewardOncePerReferral and dup exists', async () => {
        prisma.coupon.findMany.mockResolvedValue([makeRewardCoupon({ rewardOncePerReferral: true })]);
        // มี customerCoupon ที่ผูก referralRowId เดียวกันอยู่แล้ว
        prisma.customerCoupon.findFirst.mockResolvedValue({ id: 999 });

        const r = await grantRewardCoupons(baseArgs);

        expect(r.granted).toEqual([]);
        expect(r.skipped[0].reason).toBe('ALREADY_GRANTED');
        expect(prisma.customerCoupon.create).not.toHaveBeenCalled();
    });
});

// ============================================================
// recipient role
// ============================================================

describe('grantRewardCoupons — recipient role', () => {
    it('grants to referee only when rewardRecipient=REFEREE', async () => {
        setHappyPath([makeRewardCoupon({ rewardRecipient: 'REFEREE' })]);

        const r = await grantRewardCoupons(baseArgs);

        expect(r.granted).toHaveLength(1);
        expect(r.granted[0].recipientId).toBe('OT-NEW');
        expect(r.granted[0].recipientRole).toBe('REFEREE');
    });

    it('grants to BOTH referrer and referee when rewardRecipient=BOTH', async () => {
        setHappyPath([makeRewardCoupon({ rewardRecipient: 'BOTH' })]);

        const r = await grantRewardCoupons(baseArgs);

        expect(r.granted).toHaveLength(2);
        const recipientIds = r.granted.map((g) => g.recipientId).sort();
        expect(recipientIds).toEqual(['OT-NEW', 'OT-REF']);
    });
});

// ============================================================
// happy path
// ============================================================

describe('grantRewardCoupons — happy path', () => {
    it('creates CustomerCoupon with sourceReferralId + sourceEvent + AVAILABLE', async () => {
        setHappyPath([makeRewardCoupon({ rewardRecipient: 'REFERRER' })]);

        const r = await grantRewardCoupons(baseArgs);

        expect(r.granted).toHaveLength(1);
        expect(r.granted[0].couponId).toBe('REWARD_C1');
        expect(r.granted[0].recipientRole).toBe('REFERRER');

        const ccArg = prisma.customerCoupon.create.mock.calls[0][0].data;
        expect(ccArg.customerId).toBe('OT-REF');
        expect(ccArg.couponId).toBe('REWARD_C1');
        expect(ccArg.status).toBe('AVAILABLE');
        expect(ccArg.sourceReferralId).toBe(42);
        expect(ccArg.sourceEvent).toBe('REFEREE_FIRST_PURCHASE');

        // claimedCount incremented
        expect(prisma.coupon.update).toHaveBeenCalledTimes(1);
        const upArg = prisma.coupon.update.mock.calls[0][0];
        expect(upArg.data.claimedCount.increment).toBe(1);
    });
});
