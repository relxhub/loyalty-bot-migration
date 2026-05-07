// tests/unit/coupon.validateCouponForCart.test.js
//
// เทส validateCouponForCart — eligibility validator (throw on fail, ไม่คำนวณ)
//
// pattern: mock prisma → setup customerCoupon.findFirst → ตรวจ throw หรือ return success

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockReset } from '../mocks/prisma.mock.js';

vi.mock('../../src/db.js', async () => {
    const { mockDeep } = await import('vitest-mock-extended');
    return { prisma: mockDeep() };
});

import { prisma } from '../../src/db.js';
import { validateCouponForCart } from '../../src/services/coupon.service.js';

beforeEach(() => mockReset(prisma));

// ----- fixture helpers -----

/** ส่งคืน customerCoupon record ที่ findFirst จะใช้ */
function makeCustomerCoupon(couponOverrides = {}, customerCouponOverrides = {}) {
    return {
        id: 1,
        customerId: 'OT1',
        couponId: 'C1',
        status: 'AVAILABLE',
        expiryDate: null,
        coupon: {
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
            validFrom: null,
            validUntil: null,
            isActive: true,
            ...couponOverrides,
        },
        ...customerCouponOverrides,
    };
}

const cart = (...items) =>
    items.map((i, idx) => ({
        productId: i.productId ?? idx + 1,
        categoryId: i.categoryId ?? null,
        qty: i.qty ?? 1,
        price: i.price ?? 100,
    }));

// ============================================================
// 1. coupon ไม่อยู่ในกระเป๋า
// ============================================================

describe('validateCouponForCart — wallet lookup', () => {
    it('rejects when coupon is not in customer wallet', async () => {
        prisma.customerCoupon.findFirst.mockResolvedValue(null);

        await expect(validateCouponForCart('OT1', 'C1', cart(), 100)).rejects.toThrow(
            'ไม่พบคูปองนี้ในกระเป๋าของคุณ',
        );
    });
});

// ============================================================
// 2-4. validity window
// ============================================================

describe('validateCouponForCart — validity window', () => {
    it('rejects when coupon.validUntil already passed', async () => {
        const past = new Date('2020-01-01');
        prisma.customerCoupon.findFirst.mockResolvedValue(
            makeCustomerCoupon({ validUntil: past }),
        );

        await expect(validateCouponForCart('OT1', 'C1', cart(), 100)).rejects.toThrow(
            /หมดอายุการใช้งานแล้ว.*แคมเปญสิ้นสุด/,
        );
    });

    it('rejects when customerCoupon.expiryDate already passed', async () => {
        const past = new Date('2020-01-01');
        prisma.customerCoupon.findFirst.mockResolvedValue(
            makeCustomerCoupon({}, { expiryDate: past }),
        );

        await expect(validateCouponForCart('OT1', 'C1', cart(), 100)).rejects.toThrow(
            /คูปองนี้หมดอายุการใช้งานแล้ว/,
        );
    });

    it('rejects when coupon.validFrom is still in the future', async () => {
        const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
        prisma.customerCoupon.findFirst.mockResolvedValue(
            makeCustomerCoupon({ validFrom: future }),
        );

        await expect(validateCouponForCart('OT1', 'C1', cart(), 100)).rejects.toThrow(
            /จะเริ่มใช้งานได้วันที่/,
        );
    });
});

// ============================================================
// 5. minPurchase
// ============================================================

describe('validateCouponForCart — minPurchase', () => {
    it('rejects when totalAmount < minPurchase', async () => {
        prisma.customerCoupon.findFirst.mockResolvedValue(
            makeCustomerCoupon({ minPurchase: 500 }),
        );

        // ส่ง totalAmount=300 < 500
        await expect(validateCouponForCart('OT1', 'C1', cart(), 300)).rejects.toThrow(
            /ยอดซื้อยังไม่ถึงเงื่อนไข.*ขาดอีก/,
        );
    });
});

// ============================================================
// 6-8. minQty + target product/category
// ============================================================

describe('validateCouponForCart — minQty', () => {
    it('rejects when minQty not met (no target — counts whole cart)', async () => {
        prisma.customerCoupon.findFirst.mockResolvedValue(
            makeCustomerCoupon({ minQty: 5 }),
        );

        // ตะกร้ามีแค่ 2 ชิ้น
        await expect(
            validateCouponForCart('OT1', 'C1', cart({ qty: 1 }, { qty: 1 }), 1000),
        ).rejects.toThrow(/เงื่อนไขไม่ครบ.*อย่างน้อย 5 ชิ้น/);
    });

    it('rejects when minQty not met for targetProductId', async () => {
        prisma.customerCoupon.findFirst.mockResolvedValue(
            makeCustomerCoupon({ minQty: 3, targetProductId: 42 }),
        );
        prisma.product.findUnique.mockResolvedValue({
            id: 42,
            nameTh: 'พ็อด A',
            nameEn: 'Pod A',
        });

        // ตะกร้ามี productId=42 จำนวน 1 ชิ้น (ขาด 2)
        await expect(
            validateCouponForCart(
                'OT1',
                'C1',
                cart({ productId: 42, qty: 1 }, { productId: 99, qty: 5 }),
                1000,
            ),
        ).rejects.toThrow(/Pod A.*อย่างน้อย 3 ชิ้น/);
    });

    it('rejects when minQty not met for targetCategoryId', async () => {
        prisma.customerCoupon.findFirst.mockResolvedValue(
            makeCustomerCoupon({ minQty: 4, targetCategoryId: 7 }),
        );
        prisma.category.findUnique.mockResolvedValue({ id: 7, name: 'เครื่อง' });

        // ตะกร้ามีของในหมวด 7 แค่ 2 ชิ้น
        await expect(
            validateCouponForCart(
                'OT1',
                'C1',
                cart(
                    { productId: 1, categoryId: 7, qty: 2 },
                    { productId: 2, categoryId: 99, qty: 10 },
                ),
                1000,
            ),
        ).rejects.toThrow(/หมวด เครื่อง.*อย่างน้อย 4 ชิ้น/);
    });
});

// ============================================================
// 9-10. GIFT availability
// ============================================================

describe('validateCouponForCart — GIFT availability', () => {
    it('rejects GIFT coupon when giftCategoryId items not enough in cart', async () => {
        prisma.customerCoupon.findFirst.mockResolvedValue(
            makeCustomerCoupon({
                type: 'GIFT',
                giftCategoryId: 5,
                giftQty: 2,
            }),
        );
        prisma.category.findUnique.mockResolvedValue({ id: 5, name: 'น้ำยา' });

        // ตะกร้ามีของในหมวด 5 แค่ 1 ชิ้น (ต้องการ 2)
        await expect(
            validateCouponForCart(
                'OT1',
                'C1',
                cart({ productId: 1, categoryId: 5, qty: 1 }),
                1000,
            ),
        ).rejects.toThrow(/หมวด น้ำยา.*ขาดอีก/);
    });

    it('rejects GIFT coupon when giftProductId items not in cart', async () => {
        prisma.customerCoupon.findFirst.mockResolvedValue(
            makeCustomerCoupon({
                type: 'GIFT',
                giftProductId: 99,
                giftQty: 1,
            }),
        );
        prisma.product.findUnique.mockResolvedValue({
            id: 99,
            nameTh: 'หัวพ็อดพรีเมียม',
            nameEn: 'Pod Premium',
        });

        // ตะกร้าไม่มี productId=99
        await expect(
            validateCouponForCart(
                'OT1',
                'C1',
                cart({ productId: 1, qty: 5 }),
                1000,
            ),
        ).rejects.toThrow(/Pod Premium.*ขาดอีก/);
    });
});

// ============================================================
// 11. happy path
// ============================================================

describe('validateCouponForCart — success path', () => {
    it('returns {success:true, coupon} when all conditions are met', async () => {
        const cc = makeCustomerCoupon({
            minPurchase: 200,
            minQty: 2,
        });
        prisma.customerCoupon.findFirst.mockResolvedValue(cc);

        const r = await validateCouponForCart(
            'OT1',
            'C1',
            cart({ qty: 2 }, { qty: 1 }),
            500,
        );

        expect(r.success).toBe(true);
        expect(r.coupon).toBe(cc);
    });
});
