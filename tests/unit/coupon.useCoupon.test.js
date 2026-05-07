// tests/unit/coupon.useCoupon.test.js
//
// เทส useCoupon — admin กดใช้คูปองตัดสิทธิ์ลูกค้า
// ครอบคลุม: empty wallet, all-expired, picks nearest expiry, happy path

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockReset } from '../mocks/prisma.mock.js';

vi.mock('../../src/db.js', async () => {
    const { mockDeep } = await import('vitest-mock-extended');
    return { prisma: mockDeep() };
});

import { prisma } from '../../src/db.js';
import { useCoupon } from '../../src/services/coupon.service.js';

beforeEach(() => mockReset(prisma));

// ----- fixtures -----

function makeCC({ id, expiryDate = null, validUntil = null, validFrom = null }) {
    return {
        id,
        customerId: 'OT1',
        couponId: 'C1',
        status: 'AVAILABLE',
        expiryDate,
        coupon: { id: 'C1', validUntil, validFrom },
    };
}

const future = (days) => new Date(Date.now() + days * 86400_000);
const past = (days) => new Date(Date.now() - days * 86400_000);

// ============================================================
// guards
// ============================================================

describe('useCoupon — wallet guards', () => {
    it('throws when customer has no AVAILABLE coupon', async () => {
        prisma.customerCoupon.findMany.mockResolvedValue([]);
        await expect(useCoupon('OT1', 'C1', 'admin')).rejects.toThrow(/ไม่พบคูปองนี้ในกระเป๋า/);
    });

    it('throws when all available coupons are expired or not yet valid', async () => {
        prisma.customerCoupon.findMany.mockResolvedValue([
            makeCC({ id: 1, expiryDate: past(1) }),         // expired (individual)
            makeCC({ id: 2, validUntil: past(2) }),         // expired (global)
            makeCC({ id: 3, validFrom: future(7) }),        // not yet started
        ]);
        await expect(useCoupon('OT1', 'C1', 'admin')).rejects.toThrow(/หมดอายุแล้ว/);
    });
});

// ============================================================
// sorting — nearest expiry first
// ============================================================

describe('useCoupon — picks nearest expiry first', () => {
    it('picks the customerCoupon with nearest expiryDate when multiple are valid', async () => {
        // unsorted order — function ต้อง sort เอง
        prisma.customerCoupon.findMany.mockResolvedValue([
            makeCC({ id: 100, expiryDate: future(30) }),    // far
            makeCC({ id: 200, expiryDate: future(2) }),     // nearest ✓
            makeCC({ id: 300, expiryDate: future(10) }),    // mid
        ]);
        prisma.customerCoupon.update.mockResolvedValue({ id: 200, status: 'USED' });

        const r = await useCoupon('OT1', 'C1', 'admin-A');

        expect(prisma.customerCoupon.update.mock.calls[0][0].where.id).toBe(200);
        expect(r.id).toBe(200);
    });

    it('falls back to coupon.validUntil when individual expiryDate is null', async () => {
        prisma.customerCoupon.findMany.mockResolvedValue([
            makeCC({ id: 1, validUntil: future(20) }),      // far
            makeCC({ id: 2, validUntil: future(3) }),       // nearest ✓
        ]);
        prisma.customerCoupon.update.mockResolvedValue({ id: 2, status: 'USED' });

        await useCoupon('OT1', 'C1', 'admin');

        expect(prisma.customerCoupon.update.mock.calls[0][0].where.id).toBe(2);
    });
});

// ============================================================
// happy path — marks USED + records adminName
// ============================================================

describe('useCoupon — happy path', () => {
    it('marks coupon as USED with usedByAdmin and timestamp', async () => {
        prisma.customerCoupon.findMany.mockResolvedValue([
            makeCC({ id: 1, expiryDate: future(7) }),
        ]);
        prisma.customerCoupon.update.mockResolvedValue({ id: 1, status: 'USED' });

        await useCoupon('OT1', 'C1', 'staff-bob');

        const arg = prisma.customerCoupon.update.mock.calls[0][0];
        expect(arg.where.id).toBe(1);
        expect(arg.data.status).toBe('USED');
        expect(arg.data.usedByAdmin).toBe('staff-bob');
        expect(arg.data.usedAt).toBeInstanceOf(Date);
    });
});
