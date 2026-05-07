// tests/unit/coupon.getBestCoupon.test.js
//
// เทส getBestCoupon — เลือกคูปองที่ saving สูงสุดจากกระเป๋าลูกค้า
// ครอบคลุม: DISCOUNT_PERCENT/FLAT calc, GIFT pricing, excludedProductIds,
//            allowCoupons=false, target product/category, minPurchase, minQty,
//            validFrom, GIFT availability, max-saving picker, null fallback

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockReset } from '../mocks/prisma.mock.js';

vi.mock('../../src/db.js', async () => {
    const { mockDeep } = await import('vitest-mock-extended');
    return { prisma: mockDeep() };
});

import { prisma } from '../../src/db.js';
import { getBestCoupon } from '../../src/services/coupon.service.js';

beforeEach(() => mockReset(prisma));

// ----- fixtures -----

function makeCoupon(overrides = {}) {
    return {
        id: 'C1',
        type: 'DISCOUNT_FLAT',
        value: 50,
        minPurchase: null,
        minQty: null,
        targetProductId: null,
        targetCategoryId: null,
        giftCategoryId: null,
        giftProductId: null,
        giftQty: null,
        excludedProductIds: [],
        validFrom: null,
        validUntil: null,
        isActive: true,
        ...overrides,
    };
}

function makeCustomerCoupon(coupon, overrides = {}) {
    return {
        id: 1,
        customerId: 'OT1',
        couponId: coupon.id,
        status: 'AVAILABLE',
        expiryDate: null,
        coupon,
        ...overrides,
    };
}

const cart = (...items) =>
    items.map((i, idx) => ({
        productId: i.productId ?? idx + 1,
        categoryId: i.categoryId ?? null,
        qty: i.qty ?? 1,
        price: i.price ?? 100,
    }));

/** stub prisma.customerCoupon.findMany (จาก getCustomerCoupons) */
function setWalletCoupons(...customerCoupons) {
    prisma.customerCoupon.findMany.mockResolvedValue(customerCoupons);
}

/** stub prisma.product.findMany (สำหรับเช็ค allowCoupons) */
function setCartProducts(...products) {
    prisma.product.findMany.mockResolvedValue(
        products.map((p) => ({ id: p.id, allowCoupons: p.allowCoupons ?? true })),
    );
}

// ============================================================
// 1-4. discount calculation
// ============================================================

describe('getBestCoupon — DISCOUNT_PERCENT calc', () => {
    it('calculates saving = eligibleAmount * value/100', async () => {
        const coupon = makeCoupon({ type: 'DISCOUNT_PERCENT', value: 10 });
        setWalletCoupons(makeCustomerCoupon(coupon));
        setCartProducts({ id: 1 }, { id: 2 });

        const items = cart({ productId: 1, qty: 2, price: 100 }, { productId: 2, qty: 1, price: 300 });
        const r = await getBestCoupon('OT1', items, 500);

        // eligibleAmount = 100*2 + 300*1 = 500
        // saving = 500 * 0.10 = 50
        expect(r.calculatedSaving).toBe(50);
    });
});

describe('getBestCoupon — DISCOUNT_FLAT calc', () => {
    it('returns Number(coupon.value) directly', async () => {
        const coupon = makeCoupon({ type: 'DISCOUNT_FLAT', value: 75 });
        setWalletCoupons(makeCustomerCoupon(coupon));
        setCartProducts({ id: 1 });

        const r = await getBestCoupon('OT1', cart({ productId: 1, price: 200 }), 200);
        expect(r.calculatedSaving).toBe(75);
    });
});

describe('getBestCoupon — GIFT calc', () => {
    it('uses category.price * giftQty when giftCategoryId is set', async () => {
        const coupon = makeCoupon({
            type: 'GIFT',
            giftCategoryId: 5,
            giftQty: 2,
        });
        setWalletCoupons(makeCustomerCoupon(coupon));
        setCartProducts({ id: 10 });
        prisma.category.findUnique.mockResolvedValue({ id: 5, price: 80 });

        // ตะกร้ามีของในหมวด 5 อย่างน้อย 2 ชิ้น (ผ่านเช็ค availableForGift)
        const items = cart(
            { productId: 10, categoryId: 5, qty: 2, price: 80 },
        );
        const r = await getBestCoupon('OT1', items, 160);

        expect(r.calculatedSaving).toBe(80 * 2);
    });

    it('uses product.category.price * giftQty when giftProductId is set', async () => {
        const coupon = makeCoupon({
            type: 'GIFT',
            giftProductId: 99,
            giftQty: 1,
        });
        setWalletCoupons(makeCustomerCoupon(coupon));
        setCartProducts({ id: 99 });
        prisma.product.findUnique.mockResolvedValue({
            id: 99,
            category: { price: 150 },
        });

        const items = cart({ productId: 99, qty: 1, price: 150 });
        const r = await getBestCoupon('OT1', items, 150);

        expect(r.calculatedSaving).toBe(150);
    });
});

// ============================================================
// 5-6. exclusion logic
// ============================================================

describe('getBestCoupon — excludedProductIds', () => {
    it('excludes listed products from eligibleAmount', async () => {
        const coupon = makeCoupon({
            type: 'DISCOUNT_PERCENT',
            value: 10,
            excludedProductIds: [1],
        });
        setWalletCoupons(makeCustomerCoupon(coupon));
        setCartProducts({ id: 1 }, { id: 2 });

        // product 1 excluded → eligibleAmount = 200 (product 2 เท่านั้น)
        const items = cart(
            { productId: 1, qty: 1, price: 100 },
            { productId: 2, qty: 1, price: 200 },
        );
        const r = await getBestCoupon('OT1', items, 300);

        expect(r.calculatedSaving).toBe(20); // 200 * 10%
    });
});

describe('getBestCoupon — products.allowCoupons=false', () => {
    it('excludes products with allowCoupons=false from eligibleAmount', async () => {
        const coupon = makeCoupon({ type: 'DISCOUNT_PERCENT', value: 10 });
        setWalletCoupons(makeCustomerCoupon(coupon));
        setCartProducts(
            { id: 1, allowCoupons: false },
            { id: 2, allowCoupons: true },
        );

        const items = cart(
            { productId: 1, qty: 1, price: 100 },
            { productId: 2, qty: 1, price: 200 },
        );
        const r = await getBestCoupon('OT1', items, 300);

        // eligibleAmount = 200, saving = 20
        expect(r.calculatedSaving).toBe(20);
    });
});

// ============================================================
// 7-12. eligibility filters → coupon skipped (returns null)
// ============================================================

describe('getBestCoupon — eligibility filters', () => {
    it('skips coupon when minPurchase not met', async () => {
        const coupon = makeCoupon({ minPurchase: 500 });
        setWalletCoupons(makeCustomerCoupon(coupon));
        setCartProducts({ id: 1 });

        const r = await getBestCoupon('OT1', cart({ price: 100 }), 100);
        expect(r).toBeNull();
    });

    it('skips coupon when minQty not met (whole-cart count)', async () => {
        const coupon = makeCoupon({ minQty: 10 });
        setWalletCoupons(makeCustomerCoupon(coupon));
        setCartProducts({ id: 1 });

        const r = await getBestCoupon('OT1', cart({ qty: 3 }), 300);
        expect(r).toBeNull();
    });

    it('skips coupon when targetCategoryId not present in cart', async () => {
        const coupon = makeCoupon({ targetCategoryId: 99 });
        setWalletCoupons(makeCustomerCoupon(coupon));
        setCartProducts({ id: 1 });

        const r = await getBestCoupon('OT1', cart({ categoryId: 5 }), 100);
        expect(r).toBeNull();
    });

    it('skips coupon when targetProductId not present in cart', async () => {
        const coupon = makeCoupon({ targetProductId: 99 });
        setWalletCoupons(makeCustomerCoupon(coupon));
        setCartProducts({ id: 1 });

        const r = await getBestCoupon('OT1', cart({ productId: 1 }), 100);
        expect(r).toBeNull();
    });

    it('skips coupon when validFrom is still in the future', async () => {
        const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
        const coupon = makeCoupon({ validFrom: future });
        setWalletCoupons(makeCustomerCoupon(coupon));
        setCartProducts({ id: 1 });

        const r = await getBestCoupon('OT1', cart(), 100);
        expect(r).toBeNull();
    });

    it('skips GIFT coupon when gift items are not enough in cart', async () => {
        const coupon = makeCoupon({
            type: 'GIFT',
            giftCategoryId: 5,
            giftQty: 3,
        });
        setWalletCoupons(makeCustomerCoupon(coupon));
        setCartProducts({ id: 10 });

        // ตะกร้ามีของในหมวด 5 แค่ 1 ชิ้น (ต้องการ 3)
        const r = await getBestCoupon(
            'OT1',
            cart({ productId: 10, categoryId: 5, qty: 1 }),
            100,
        );
        expect(r).toBeNull();
    });
});

// ============================================================
// 13. picks highest saving
// ============================================================

describe('getBestCoupon — picks highest saving', () => {
    it('returns the coupon with highest currentSaving when multiple qualify', async () => {
        const small = makeCoupon({ id: 'SMALL', type: 'DISCOUNT_FLAT', value: 30 });
        const big = makeCoupon({ id: 'BIG', type: 'DISCOUNT_FLAT', value: 100 });
        setWalletCoupons(makeCustomerCoupon(small), makeCustomerCoupon(big));
        setCartProducts({ id: 1 });

        const r = await getBestCoupon('OT1', cart({ price: 200 }), 200);

        expect(r.coupon.id).toBe('BIG');
        expect(r.calculatedSaving).toBe(100);
    });
});

// ============================================================
// 14. null when nothing qualifies
// ============================================================

describe('getBestCoupon — null fallback', () => {
    it('returns null when no coupons in wallet', async () => {
        setWalletCoupons(); // empty
        setCartProducts({ id: 1 });

        const r = await getBestCoupon('OT1', cart(), 100);
        expect(r).toBeNull();
    });
});

// ============================================================
// 15. all products excluded → eligibleAmount=0 → not picked
// ============================================================

describe('getBestCoupon — all products excluded', () => {
    it('does not pick coupon when every cart product is excluded', async () => {
        const coupon = makeCoupon({
            type: 'DISCOUNT_PERCENT',
            value: 50,
            excludedProductIds: [1, 2],
        });
        setWalletCoupons(makeCustomerCoupon(coupon));
        setCartProducts({ id: 1 }, { id: 2 });

        const items = cart(
            { productId: 1, qty: 1, price: 100 },
            { productId: 2, qty: 1, price: 200 },
        );
        const r = await getBestCoupon('OT1', items, 300);

        // eligibleAmount = 0 → continue → null
        expect(r).toBeNull();
    });
});
