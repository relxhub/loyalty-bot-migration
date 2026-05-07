// tests/unit/coupon.computeDiscountForCart.test.js
//
// เทส computeDiscountForCart — server-side discount calc ใช้ใน /orders/checkout
// กัน client ส่ง discountAmount เกินจริง

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockReset } from '../mocks/prisma.mock.js';

vi.mock('../../src/db.js', async () => {
    const { mockDeep } = await import('vitest-mock-extended');
    return { prisma: mockDeep() };
});

import { prisma } from '../../src/db.js';
import { computeDiscountForCart } from '../../src/services/coupon.service.js';

beforeEach(() => mockReset(prisma));

// ----- fixtures -----

function makeCoupon(overrides = {}) {
    return {
        type: 'DISCOUNT_FLAT',
        value: 50,
        excludedProductIds: [],
        giftCategoryId: null,
        giftProductId: null,
        giftQty: null,
        ...overrides,
    };
}

const cart = (...items) => items.map((i) => ({ productId: i.productId, price: i.price, qty: i.qty }));

function setProductsAllow(...products) {
    prisma.product.findMany.mockResolvedValue(
        products.map((p) => ({ id: p.id, allowCoupons: p.allowCoupons ?? true })),
    );
}

// ============================================================
// 1-2. flat / percent
// ============================================================

describe('computeDiscountForCart — DISCOUNT_FLAT', () => {
    it('returns Number(coupon.value)', async () => {
        setProductsAllow({ id: 1 });
        const r = await computeDiscountForCart(makeCoupon({ value: 75 }), cart({ productId: 1, price: 200, qty: 1 }));
        expect(r).toBe(75);
    });
});

describe('computeDiscountForCart — DISCOUNT_PERCENT', () => {
    it('returns eligibleAmount × value/100', async () => {
        setProductsAllow({ id: 1 }, { id: 2 });
        const items = cart({ productId: 1, price: 100, qty: 2 }, { productId: 2, price: 300, qty: 1 });
        const r = await computeDiscountForCart(
            makeCoupon({ type: 'DISCOUNT_PERCENT', value: 10 }),
            items,
        );
        // eligibleAmount = 200 + 300 = 500; 500 × 10% = 50
        expect(r).toBe(50);
    });
});

// ============================================================
// 3-4. GIFT pricing
// ============================================================

describe('computeDiscountForCart — GIFT', () => {
    it('returns category.price × giftQty when giftCategoryId set', async () => {
        setProductsAllow({ id: 10 });
        prisma.category.findUnique.mockResolvedValue({ id: 5, price: 80 });
        const r = await computeDiscountForCart(
            makeCoupon({ type: 'GIFT', giftCategoryId: 5, giftQty: 2 }),
            cart({ productId: 10, price: 100, qty: 1 }),
        );
        expect(r).toBe(160);
    });

    it('returns product.category.price × giftQty when giftProductId set', async () => {
        setProductsAllow({ id: 99 });
        prisma.product.findUnique.mockResolvedValue({ id: 99, category: { price: 150 } });
        const r = await computeDiscountForCart(
            makeCoupon({ type: 'GIFT', giftProductId: 99, giftQty: 1 }),
            cart({ productId: 99, price: 150, qty: 1 }),
        );
        expect(r).toBe(150);
    });

    it('returns 0 when GIFT has neither giftCategoryId nor giftProductId', async () => {
        setProductsAllow({ id: 1 });
        const r = await computeDiscountForCart(
            makeCoupon({ type: 'GIFT', giftQty: 2 }),
            cart({ productId: 1, price: 100, qty: 1 }),
        );
        expect(r).toBe(0);
    });
});

// ============================================================
// 5-7. exclusions
// ============================================================

describe('computeDiscountForCart — exclusions', () => {
    it('excludes products in coupon.excludedProductIds from eligibleAmount', async () => {
        setProductsAllow({ id: 1 }, { id: 2 });
        const items = cart({ productId: 1, price: 100, qty: 1 }, { productId: 2, price: 200, qty: 1 });
        const r = await computeDiscountForCart(
            makeCoupon({ type: 'DISCOUNT_PERCENT', value: 10, excludedProductIds: [1] }),
            items,
        );
        // eligibleAmount = 200 (only product 2); discount = 20
        expect(r).toBe(20);
    });

    it('excludes products with allowCoupons=false from eligibleAmount', async () => {
        setProductsAllow({ id: 1, allowCoupons: false }, { id: 2, allowCoupons: true });
        const items = cart({ productId: 1, price: 100, qty: 1 }, { productId: 2, price: 200, qty: 1 });
        const r = await computeDiscountForCart(
            makeCoupon({ type: 'DISCOUNT_PERCENT', value: 10 }),
            items,
        );
        expect(r).toBe(20);
    });

    it('returns 0 when ALL items are excluded (DISCOUNT_FLAT also)', async () => {
        setProductsAllow({ id: 1 }, { id: 2 });
        const items = cart({ productId: 1, price: 100, qty: 1 }, { productId: 2, price: 200, qty: 1 });
        const r = await computeDiscountForCart(
            makeCoupon({ type: 'DISCOUNT_FLAT', value: 50, excludedProductIds: [1, 2] }),
            items,
        );
        // eligibleAmount = 0 → return 0 even though FLAT doesn't depend on amount
        expect(r).toBe(0);
    });
});

// ============================================================
// 8-10. edge cases
// ============================================================

describe('computeDiscountForCart — edge cases', () => {
    it('returns 0 when coupon is null', async () => {
        const r = await computeDiscountForCart(null, cart({ productId: 1, price: 100, qty: 1 }));
        expect(r).toBe(0);
    });

    it('returns 0 when cart is empty', async () => {
        const r = await computeDiscountForCart(makeCoupon(), []);
        expect(r).toBe(0);
    });

    it('returns 0 for unknown coupon.type', async () => {
        setProductsAllow({ id: 1 });
        const r = await computeDiscountForCart(
            makeCoupon({ type: 'UNKNOWN_TYPE' }),
            cart({ productId: 1, price: 100, qty: 1 }),
        );
        expect(r).toBe(0);
    });
});
