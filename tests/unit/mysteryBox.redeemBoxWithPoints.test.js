// tests/unit/mysteryBox.redeemBoxWithPoints.test.js
//
// เทส redeemBoxWithPoints — atomic แต้ม → ticket
// Pattern returns {success:false, error:'CODE'} ไม่ throw (ต่างจาก coupon redeem)

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
vi.mock('../../src/services/notification-center.service.js', () => ({
    notifyCustomer: vi.fn(),
}));

import { prisma } from '../../src/db.js';
import { getConfig } from '../../src/config/config.js';
import { redeemBoxWithPoints } from '../../src/services/mystery-box.service.js';

const DEFAULT_CONFIG = {
    tier_silver_min: '3',
    tier_gold_min: '6',
};

beforeEach(() => {
    mockReset(prisma);
    vi.mocked(getConfig).mockImplementation((key) => DEFAULT_CONFIG[key]);
    prisma.$transaction.mockImplementation(async (cb) => cb(prisma));
});

// ----- fixtures -----

function makeBox(overrides = {}) {
    return {
        id: 'MB1',
        name: 'Test Box',
        isActive: true,
        pointCost: 100,
        startDate: null,
        endDate: null,
        requiredTier: 'NONE',
        maxPerUser: null,
        ...overrides,
    };
}

function setHappyPath({ box = {}, customerPoints = 500, existingTickets = 0, monthCount = 0 } = {}) {
    const finalBox = makeBox(box);
    prisma.mysteryBox.findUnique.mockResolvedValue(finalBox);
    prisma.referral.count.mockResolvedValue(monthCount);
    prisma.mysteryBoxTicket.count.mockResolvedValue(existingTickets);
    prisma.customer.findUnique.mockResolvedValue({ customerId: 'OT1', points: customerPoints });
    prisma.customer.update.mockResolvedValue({});
    prisma.pointTransaction.create.mockResolvedValue({});
    prisma.mysteryBoxTicket.create.mockResolvedValue({ id: 999 });
    return finalBox;
}

// ============================================================
// guards
// ============================================================

describe('redeemBoxWithPoints — guards', () => {
    it('returns INVALID_INPUT when args missing', async () => {
        const r = await redeemBoxWithPoints({ customerId: 'OT1' });
        expect(r).toEqual({ success: false, error: 'INVALID_INPUT' });
    });

    it('returns BOX_NOT_FOUND when box does not exist', async () => {
        prisma.mysteryBox.findUnique.mockResolvedValue(null);
        const r = await redeemBoxWithPoints({ customerId: 'OT1', mysteryBoxId: 'GHOST' });
        expect(r).toEqual({ success: false, error: 'BOX_NOT_FOUND' });
    });

    it('returns NOT_REDEEMABLE when pointCost is null or 0', async () => {
        prisma.mysteryBox.findUnique.mockResolvedValue(makeBox({ pointCost: 0 }));
        const r = await redeemBoxWithPoints({ customerId: 'OT1', mysteryBoxId: 'MB1' });
        expect(r).toEqual({ success: false, error: 'NOT_REDEEMABLE' });
    });
});

// ============================================================
// tier guard
// ============================================================

describe('redeemBoxWithPoints — tier requirement', () => {
    it('returns TIER_TOO_LOW when monthly count below required tier', async () => {
        // requiredTier=SILVER → ต้องชวนเดือนนี้ ≥ 3 คน
        setHappyPath({ box: { requiredTier: 'SILVER' }, monthCount: 2 });
        const r = await redeemBoxWithPoints({ customerId: 'OT1', mysteryBoxId: 'MB1' });
        expect(r).toEqual({ success: false, error: 'TIER_TOO_LOW' });
    });
});

// ============================================================
// quota / points / happy path (inside tx)
// ============================================================

describe('redeemBoxWithPoints — tx-level guards', () => {
    it('returns MAX_PER_USER_REACHED when limit hit', async () => {
        setHappyPath({ box: { maxPerUser: 3 }, existingTickets: 3 });
        const r = await redeemBoxWithPoints({ customerId: 'OT1', mysteryBoxId: 'MB1' });
        expect(r).toEqual({ success: false, error: 'MAX_PER_USER_REACHED' });

        // ห้ามหักแต้ม / สร้าง ticket
        expect(prisma.customer.update).not.toHaveBeenCalled();
        expect(prisma.mysteryBoxTicket.create).not.toHaveBeenCalled();
    });

    it('returns INSUFFICIENT_POINTS when customer points below cost', async () => {
        setHappyPath({ box: { pointCost: 100 }, customerPoints: 50 });
        const r = await redeemBoxWithPoints({ customerId: 'OT1', mysteryBoxId: 'MB1' });
        expect(r).toEqual({ success: false, error: 'INSUFFICIENT_POINTS' });

        expect(prisma.customer.update).not.toHaveBeenCalled();
        expect(prisma.mysteryBoxTicket.create).not.toHaveBeenCalled();
    });
});

describe('redeemBoxWithPoints — happy path', () => {
    it('decrements points, logs transaction, creates ticket, returns remainingPoints + ticketId', async () => {
        setHappyPath({ box: { pointCost: 80 }, customerPoints: 500 });

        const r = await redeemBoxWithPoints({ customerId: 'OT1', mysteryBoxId: 'MB1' });

        expect(r.success).toBe(true);
        expect(r.ticketId).toBe(999);
        expect(r.remainingPoints).toBe(420); // 500 - 80

        // 1. points decrement
        const custUpdate = prisma.customer.update.mock.calls[0][0];
        expect(custUpdate.where.customerId).toBe('OT1');
        expect(custUpdate.data.points.decrement).toBe(80);

        // 2. PointTransaction logged (-80, REDEEM_REWARD)
        const ptArg = prisma.pointTransaction.create.mock.calls[0][0].data;
        expect(ptArg.amount).toBe(-80);
        expect(ptArg.type).toBe('REDEEM_REWARD');
        expect(ptArg.detail).toMatch(/Test Box/);

        // 3. ticket created with sourceEvent=POINT_REDEEM, status=UNOPENED
        const tArg = prisma.mysteryBoxTicket.create.mock.calls[0][0].data;
        expect(tArg.customerId).toBe('OT1');
        expect(tArg.mysteryBoxId).toBe('MB1');
        expect(tArg.sourceEvent).toBe('POINT_REDEEM');
        expect(tArg.status).toBe('UNOPENED');
    });
});
