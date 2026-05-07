// tests/unit/stockReservation.concurrent.test.js
//
// เทสจำลอง 100 concurrent checkouts บนสต็อก 10 ชิ้น → ห้าม oversold
//
// LIMITATION: เป็น JS-level simulation ไม่ใช่ true concurrency test (ต้องมี real DB
// + parallel client connections). แต่ทดสอบว่า reserveStockAtomic orchestration
// ถูกต้องโดยให้ atomic primitive (mock $executeRaw) จำลอง Postgres conditional UPDATE
//
// ผลลัพธ์ที่คาดหวัง:
//   - 10 calls succeed (= stock)
//   - 90 calls fail with INSUFFICIENT_STOCK
//   - simulated dbReserved = 10 ตรงเป๊ะ — ไม่ oversold

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
import { reserveStockAtomic } from '../../src/services/stock-reservation.service.js';

beforeEach(() => mockReset(prisma));

const cfg = {
    reserveMaxPerUserPct: 0.5, // 5 ต่อคน (จาก stock 10) — แต่ละ test ขอ 1 ชิ้นเท่านั้น
    maxQtyPerItem: 100,
    maxTotalItems: 100,
    maxDistinctSkus: 100,
    velocityMaxPerHour: 1000,
    velocityWindowSeconds: 3600,
    expiryMinutesNew: 10,
    expiryMinutesRegular: 15,
    expiryMinutesVip: 30,
    expiryMinutesAbuser: 5,
    newThresholdOrders: 1,
    vipThresholdOrders: 5,
    abuserThresholdCancellations: 3,
    maxActiveReservations: 1,
    reserveGlobalAlertPct: 0.8,
};

describe('reserveStockAtomic — concurrent simulation', () => {
    it('100 simultaneous reserve(1) on stock=10 → exactly 10 succeed, no oversold', async () => {
        // Simulated DB state — shared across all promises
        const DB_STOCK = 10;
        let dbReserved = 0;

        // Each user has 0 existing reservations (distinct customerIds)
        prisma.orderItem.aggregate.mockResolvedValue({ _sum: { quantity: 0 } });

        // findUnique returns current stock state (potentially stale — like real DB before tx UPDATE)
        prisma.product.findUnique.mockImplementation(async () => ({
            id: 1,
            stockQuantity: DB_STOCK,
            reservedQuantity: dbReserved,
        }));

        // $executeRaw: simulate Postgres conditional UPDATE atomicity
        // SQL template: SET reservedQuantity = reservedQuantity + ${qty} WHERE ... AND ${stock-reserved >= qty}
        // values = [qty, productId, qty]
        prisma.$executeRaw.mockImplementation(async (_strings, ...values) => {
            const qty = values[0];
            // Atomic check + set (synchronous within this mock fn — same as Postgres row lock)
            if (DB_STOCK - dbReserved >= qty) {
                dbReserved += qty;
                return 1; // 1 row updated
            }
            return 0; // 0 rows updated → INSUFFICIENT_STOCK
        });

        // 100 concurrent customers each try to reserve 1 unit
        const promises = Array.from({ length: 100 }, (_, i) =>
            reserveStockAtomic(prisma, `OT${i}`, [{ productId: 1, qty: 1 }], cfg)
                .then(() => ({ ok: true }))
                .catch((e) => ({ ok: false, error: e.message })),
        );
        const results = await Promise.all(promises);

        const succeeded = results.filter(r => r.ok).length;
        const failed = results.filter(r => !r.ok).length;
        const failedReasons = results
            .filter(r => !r.ok)
            .map(r => r.error.split(':')[0]);

        expect(succeeded).toBe(10);
        expect(failed).toBe(90);
        expect(dbReserved).toBe(10); // ห้าม oversold
        // ทุก failure ต้องเป็น INSUFFICIENT_STOCK (ไม่ใช่ RATIO_EXCEEDED หรืออื่นๆ)
        expect(new Set(failedReasons)).toEqual(new Set(['INSUFFICIENT_STOCK']));
    });

    it('reservations stop exactly at stock cap even when bulk-requested', async () => {
        const DB_STOCK = 10;
        let dbReserved = 0;

        prisma.orderItem.aggregate.mockResolvedValue({ _sum: { quantity: 0 } });
        prisma.product.findUnique.mockImplementation(async () => ({
            id: 1,
            stockQuantity: DB_STOCK,
            reservedQuantity: dbReserved,
        }));
        prisma.$executeRaw.mockImplementation(async (_s, ...v) => {
            const qty = v[0];
            if (DB_STOCK - dbReserved >= qty) {
                dbReserved += qty;
                return 1;
            }
            return 0;
        });

        // 5 customers ขอ 3 ชิ้น/คน — รวม 15 ชิ้น แต่ stock มี 10
        // ใช้ pct 1.0 ใน cfg เฉพาะ test นี้ — กัน RATIO_EXCEEDED (3 > floor(10×0.5)=5 ไม่ตรงข้าม แต่ 3 < 5 ก็ OK)
        const localCfg = { ...cfg, reserveMaxPerUserPct: 1.0 };
        const promises = Array.from({ length: 5 }, (_, i) =>
            reserveStockAtomic(prisma, `OT${i}`, [{ productId: 1, qty: 3 }], localCfg)
                .then(() => ({ ok: true }))
                .catch((e) => ({ ok: false })),
        );
        const results = await Promise.all(promises);

        // ครั้งที่ 1+2+3 รับได้ (3+3+3 = 9), ครั้งที่ 4 = 12 → reject (เพราะ 10-9=1 < 3)
        // → ครั้งที่ 5 ก็ reject เหมือนกัน
        const succeeded = results.filter(r => r.ok).length;
        expect(succeeded).toBe(3);
        expect(dbReserved).toBe(9); // ไม่ใช่ 10 ตรงๆ เพราะ qty step = 3
        expect(dbReserved).toBeLessThanOrEqual(DB_STOCK);
    });
});
