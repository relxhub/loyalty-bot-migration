// tests/unit/mysteryBox.openTicket.test.js
//
// เทส openTicket — ครอบคลุม:
//   1. NOT_FOUND / NOT_OWNER / NO_PRIZES_CONFIGURED guards
//   2. already-OPENED → คืน cached state (ไม่ reroll)
//   3. query ใช้ filter isActive: true (กัน prize ที่ปิดอยู่ออก)
//   4. weighted random distribution อยู่ใน ±5% relative ที่ 10k รอบ
//
// Findings ที่ต่างจากสเปคผู้ใช้:
//   - ticket OPENED แล้ว ของจริง "ไม่ reject" — return {success:true, alreadyOpened:true}
//     (เพื่อให้ frontend retry ได้แบบ idempotent) → assert ตามจริง
//   - "isActive=false ไม่ออก" บังคับใช้ที่ Prisma query (where: {isActive:true})
//     → เทสด้วยการ verify args ของ findUnique (active filter ต้องอยู่)

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
import { openTicket } from '../../src/services/mystery-box.service.js';

// ----- seeded PRNG (mulberry32) — deterministic ทุกครั้งที่รัน -----
function mulberry32(seed) {
    return function () {
        let t = (seed += 0x6d2b79f5);
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

beforeEach(() => {
    mockReset(prisma);
    // $transaction → run callback against the same mock
    prisma.$transaction.mockImplementation(async (cb) => cb(prisma));
});

// ----- fixtures -----

function makeTicket(overrides = {}) {
    return {
        id: 100,
        customerId: 'OT1',
        mysteryBoxId: 'MB1',
        status: 'UNOPENED',
        awardedPrizeId: null,
        mysteryBox: {
            id: 'MB1',
            prizes: [
                { id: 1, name: 'P1', weight: 10, rewardCouponId: null, isPhysicalReward: false, isNoPrize: false, isActive: true },
                { id: 2, name: 'P2', weight: 20, rewardCouponId: null, isPhysicalReward: false, isNoPrize: false, isActive: true },
                { id: 3, name: 'P3', weight: 30, rewardCouponId: null, isPhysicalReward: false, isNoPrize: false, isActive: true },
                { id: 4, name: 'P4', weight: 40, rewardCouponId: null, isPhysicalReward: false, isNoPrize: true,  isActive: true },
            ],
        },
        ...overrides,
    };
}

// ============================================================
// 1-3. basic guards
// ============================================================

describe('openTicket — guards', () => {
    it('returns NOT_FOUND when ticket missing', async () => {
        prisma.mysteryBoxTicket.findUnique.mockResolvedValue(null);
        const r = await openTicket({ customerId: 'OT1', ticketId: 100 });
        expect(r).toEqual({ success: false, error: 'NOT_FOUND' });
    });

    it('returns NOT_OWNER when ticket belongs to a different customer', async () => {
        prisma.mysteryBoxTicket.findUnique.mockResolvedValue(
            makeTicket({ customerId: 'OT-OTHER' }),
        );
        const r = await openTicket({ customerId: 'OT1', ticketId: 100 });
        expect(r).toEqual({ success: false, error: 'NOT_OWNER' });
    });

    it('returns NO_PRIZES_CONFIGURED when prize pool is empty', async () => {
        prisma.mysteryBoxTicket.findUnique.mockResolvedValue(
            makeTicket({ mysteryBox: { id: 'MB1', prizes: [] } }),
        );
        const r = await openTicket({ customerId: 'OT1', ticketId: 100 });
        expect(r).toEqual({ success: false, error: 'NO_PRIZES_CONFIGURED' });
    });

    it('returns INVALID_INPUT when args missing', async () => {
        expect(await openTicket({})).toEqual({ success: false, error: 'INVALID_INPUT' });
        expect(await openTicket({ customerId: 'OT1' })).toEqual({ success: false, error: 'INVALID_INPUT' });
    });
});

// ============================================================
// 4. already-OPENED → cached, no reroll
// ============================================================

describe('openTicket — already-OPENED idempotency', () => {
    it('returns alreadyOpened:true with prize lookup, never re-rolls', async () => {
        const cachedPrize = { id: 7, name: 'CACHED', weight: 1, isNoPrize: false, isPhysicalReward: false };
        prisma.mysteryBoxTicket.findUnique.mockResolvedValue(
            makeTicket({ status: 'OPENED', awardedPrizeId: 7 }),
        );
        prisma.mysteryBoxPrize.findUnique.mockResolvedValue(cachedPrize);

        const r = await openTicket({ customerId: 'OT1', ticketId: 100 });

        expect(r.success).toBe(true);
        expect(r.alreadyOpened).toBe(true);
        expect(r.prize).toEqual(cachedPrize);

        // ห้าม re-roll → $transaction ต้องไม่ถูกเรียก, update ตั๋วต้องไม่ถูกเรียก
        expect(prisma.$transaction).not.toHaveBeenCalled();
        expect(prisma.mysteryBoxTicket.update).not.toHaveBeenCalled();
    });
});

// ============================================================
// 5. isActive filter ติด query
// ============================================================

describe('openTicket — isActive filter', () => {
    it('queries prizes with where: {isActive: true} so inactive prizes are never reachable', async () => {
        prisma.mysteryBoxTicket.findUnique.mockResolvedValue(makeTicket());

        await openTicket({ customerId: 'OT1', ticketId: 100 });

        const arg = prisma.mysteryBoxTicket.findUnique.mock.calls[0][0];
        expect(arg.include.mysteryBox.include.prizes).toEqual({ where: { isActive: true } });
    });
});

// ============================================================
// 6. weighted random distribution — 10k samples, ±5% relative
// ============================================================

describe('openTicket — weighted distribution', () => {
    it('honors prize weights within ±5% relative tolerance over 10000 samples', async () => {
        // mock prisma — return same ticket every time
        prisma.mysteryBoxTicket.findUnique.mockResolvedValue(makeTicket());
        prisma.mysteryBoxTicket.update.mockResolvedValue({});

        // seeded PRNG → reproducible distribution
        const rand = mulberry32(20260507);
        const spy = vi.spyOn(Math, 'random').mockImplementation(rand);

        const N = 10000;
        const counts = { 1: 0, 2: 0, 3: 0, 4: 0 };

        for (let i = 0; i < N; i++) {
            const r = await openTicket({ customerId: 'OT1', ticketId: 100 });
            expect(r.success).toBe(true);
            counts[r.prize.id]++;
        }
        spy.mockRestore();

        // expected proportions [10, 20, 30, 40] / 100
        const expected = { 1: 1000, 2: 2000, 3: 3000, 4: 4000 };
        for (const id of [1, 2, 3, 4]) {
            const obs = counts[id];
            const exp = expected[id];
            const relError = Math.abs(obs - exp) / exp;
            // ±5% relative — fixed seed → deterministic เซ็ต assert ที่ค่าจริงของ seed นี้
            expect(relError, `prize ${id}: observed=${obs}, expected=${exp}, relErr=${relError}`).toBeLessThan(0.05);
        }
    }, 15000); // เพิ่ม timeout เผื่อ
});
