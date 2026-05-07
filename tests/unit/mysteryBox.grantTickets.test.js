// tests/unit/mysteryBox.grantTickets.test.js
//
// เทส grantTickets — แจกตั๋วกล่องสุ่มอัตโนมัติเมื่อ event เกิด
// ครอบคลุม: amount range, tier guard, duplicate referral, maxPerUser, happy path

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
import { grantTickets } from '../../src/services/mystery-box.service.js';

const DEFAULT_CONFIG = {
    tier_silver_min: '3',
    tier_gold_min: '6',
};

beforeEach(() => {
    mockReset(prisma);
    vi.mocked(getConfig).mockImplementation((key) => DEFAULT_CONFIG[key]);
});

// ----- fixtures -----

function makeBox(overrides = {}) {
    return {
        id: 'MB1',
        name: 'Test Box',
        isActive: true,
        trigger: 'REFEREE_FIRST_PURCHASE',
        minPurchaseAmount: null,
        maxPurchaseAmount: null,
        ticketsPerEvent: 1,
        maxPerUser: null,
        requiredTier: 'NONE',
        startDate: null,
        endDate: null,
        ...overrides,
    };
}

function setBoxes(...boxes) {
    prisma.mysteryBox.findMany.mockResolvedValue(boxes);
}

const baseArgs = {
    customerId: 'OT-REF',
    event: 'REFEREE_FIRST_PURCHASE',
    eligibleAmount: 1000,
    referralRowId: 42,
};

// ============================================================
// amount range
// ============================================================

describe('grantTickets — amount range', () => {
    it('skips BELOW_MIN when eligibleAmount < box.minPurchaseAmount', async () => {
        setBoxes(makeBox({ minPurchaseAmount: 500 }));

        const r = await grantTickets({ ...baseArgs, eligibleAmount: 300 });

        expect(r.granted).toEqual([]);
        expect(r.skipped[0].reason).toBe('BELOW_MIN');
        expect(prisma.mysteryBoxTicket.create).not.toHaveBeenCalled();
    });
});

// ============================================================
// tier guard
// ============================================================

describe('grantTickets — tier requirement', () => {
    it('skips TIER_TOO_LOW when monthCount below requiredTier', async () => {
        setBoxes(makeBox({ requiredTier: 'GOLD' }));
        // GOLD ต้องการ ≥ 6 — ส่ง 4 ไป
        prisma.referral.count.mockResolvedValue(4);

        const r = await grantTickets(baseArgs);

        expect(r.granted).toEqual([]);
        expect(r.skipped[0].reason).toBe('TIER_TOO_LOW');
    });
});

// ============================================================
// duplicate prevention
// ============================================================

describe('grantTickets — duplicate prevention', () => {
    it('skips DUPLICATE_REFERRAL when ticket for same referralRowId exists', async () => {
        setBoxes(makeBox());
        // มี ticket ผูก referralRowId=42 อยู่แล้ว
        prisma.mysteryBoxTicket.findFirst.mockResolvedValue({ id: 999 });

        const r = await grantTickets(baseArgs);

        expect(r.granted).toEqual([]);
        expect(r.skipped[0].reason).toBe('DUPLICATE_REFERRAL');
        expect(prisma.mysteryBoxTicket.create).not.toHaveBeenCalled();
    });
});

// ============================================================
// maxPerUser
// ============================================================

describe('grantTickets — maxPerUser', () => {
    it('skips MAX_PER_USER_REACHED when limit hit', async () => {
        setBoxes(makeBox({ maxPerUser: 3 }));
        prisma.mysteryBoxTicket.findFirst.mockResolvedValue(null); // no dup
        prisma.mysteryBoxTicket.count.mockResolvedValue(3);        // already at cap

        const r = await grantTickets(baseArgs);

        expect(r.granted).toEqual([]);
        expect(r.skipped[0].reason).toBe('MAX_PER_USER_REACHED');
    });
});

// ============================================================
// happy path
// ============================================================

describe('grantTickets — happy path', () => {
    it('creates ticket with sourceEvent + sourceReferralId + UNOPENED status', async () => {
        setBoxes(makeBox());
        prisma.mysteryBoxTicket.findFirst.mockResolvedValue(null);
        prisma.mysteryBoxTicket.count.mockResolvedValue(0);
        prisma.mysteryBoxTicket.create.mockResolvedValue({ id: 100 });

        const r = await grantTickets(baseArgs);

        expect(r.granted).toHaveLength(1);
        expect(r.granted[0].boxId).toBe('MB1');
        expect(r.granted[0].qty).toBe(1);
        expect(r.granted[0].ticketIds).toEqual([100]);

        const tArg = prisma.mysteryBoxTicket.create.mock.calls[0][0].data;
        expect(tArg.customerId).toBe('OT-REF');
        expect(tArg.mysteryBoxId).toBe('MB1');
        expect(tArg.sourceEvent).toBe('REFEREE_FIRST_PURCHASE');
        expect(tArg.sourceReferralId).toBe(42);
        expect(tArg.status).toBe('UNOPENED');
    });

    it('creates multiple tickets when ticketsPerEvent > 1', async () => {
        setBoxes(makeBox({ ticketsPerEvent: 3 }));
        prisma.mysteryBoxTicket.findFirst.mockResolvedValue(null);
        prisma.mysteryBoxTicket.count.mockResolvedValue(0);
        prisma.mysteryBoxTicket.create
            .mockResolvedValueOnce({ id: 1 })
            .mockResolvedValueOnce({ id: 2 })
            .mockResolvedValueOnce({ id: 3 });

        const r = await grantTickets(baseArgs);

        expect(r.granted[0].qty).toBe(3);
        expect(r.granted[0].ticketIds).toEqual([1, 2, 3]);
        expect(prisma.mysteryBoxTicket.create).toHaveBeenCalledTimes(3);
    });
});
