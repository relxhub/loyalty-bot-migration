// tests/unit/prisma-mock.test.js
//
// Step 2 sanity check — ยืนยันว่า prisma mock ทำงานครบทุก pattern ที่ services ใช้:
//   1. method calls ทั่วไป (findUnique / update)
//   2. การจับ argument ที่ถูกส่งเข้าไป
//   3. $transaction callback-style (ใช้บ่อยมากใน services)
//   4. mockReset เคลียร์ state ระหว่างเทส
//
// ยังไม่ import service จริง — ทดสอบ mock infrastructure เพียวๆ
// ลบไฟล์นี้ได้หลัง Step 3+ มี service tests จริงครอบคลุมแล้ว

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockReset } from '../mocks/prisma.mock.js';

vi.mock('../../src/db.js', async () => {
    const { mockDeep } = await import('vitest-mock-extended');
    return { prisma: mockDeep() };
});

import { prisma } from '../../src/db.js';

beforeEach(() => mockReset(prisma));

describe('prisma mock — basic stubbing', () => {
    it('stubs findUnique with mockResolvedValue', async () => {
        prisma.coupon.findUnique.mockResolvedValue({ id: 'C1', isActive: true });

        const r = await prisma.coupon.findUnique({ where: { id: 'C1' } });

        expect(r).toEqual({ id: 'C1', isActive: true });
        expect(prisma.coupon.findUnique).toHaveBeenCalledWith({ where: { id: 'C1' } });
        expect(prisma.coupon.findUnique).toHaveBeenCalledTimes(1);
    });

    it('records arguments passed to update', async () => {
        prisma.customer.update.mockResolvedValue({ customerId: 'OT1', points: 50 });

        await prisma.customer.update({
            where: { customerId: 'OT1' },
            data: { points: { decrement: 10 } },
        });

        const arg = prisma.customer.update.mock.calls[0][0];
        expect(arg.where.customerId).toBe('OT1');
        expect(arg.data.points.decrement).toBe(10);
    });

    it('throws when stubbed with mockRejectedValue', async () => {
        prisma.customer.findUnique.mockRejectedValue(new Error('DB down'));

        await expect(
            prisma.customer.findUnique({ where: { customerId: 'OT1' } }),
        ).rejects.toThrow('DB down');
    });
});

describe('prisma mock — $transaction', () => {
    it('runs callback against the same prisma mock when stubbed', async () => {
        // pattern ที่ services ส่วนใหญ่ใช้ — `prisma.$transaction(async (tx) => { ... })`
        prisma.$transaction.mockImplementation(async (cb) => cb(prisma));
        prisma.customer.findUnique.mockResolvedValue({ customerId: 'OT1', points: 100 });
        prisma.customer.update.mockResolvedValue({ customerId: 'OT1', points: 50 });

        const result = await prisma.$transaction(async (tx) => {
            const cust = await tx.customer.findUnique({ where: { customerId: 'OT1' } });
            return tx.customer.update({
                where: { customerId: cust.customerId },
                data: { points: cust.points - 50 },
            });
        });

        expect(result).toEqual({ customerId: 'OT1', points: 50 });
        expect(prisma.$transaction).toHaveBeenCalledTimes(1);
        expect(prisma.customer.findUnique).toHaveBeenCalledTimes(1);
        expect(prisma.customer.update).toHaveBeenCalledTimes(1);
    });

    it('lets the callback throw to test rollback paths', async () => {
        prisma.$transaction.mockImplementation(async (cb) => cb(prisma));

        await expect(
            prisma.$transaction(async () => {
                throw new Error('forced rollback');
            }),
        ).rejects.toThrow('forced rollback');
    });
});

describe('prisma mock — reset between tests', () => {
    it('records calls in this test (will be reset before next)', async () => {
        prisma.coupon.findUnique.mockResolvedValue({ id: 'X' });
        await prisma.coupon.findUnique({ where: { id: 'X' } });
        expect(prisma.coupon.findUnique).toHaveBeenCalledTimes(1);
    });

    it('starts with zero call count after mockReset', async () => {
        // beforeEach ของไฟล์นี้รัน mockReset(prisma) ก่อนเทสนี้
        expect(prisma.coupon.findUnique).toHaveBeenCalledTimes(0);

        // และ stub เก่าจากเทสก่อนถูกล้าง — return undefined
        const r = await prisma.coupon.findUnique({ where: { id: 'X' } });
        expect(r).toBeUndefined();
    });
});
