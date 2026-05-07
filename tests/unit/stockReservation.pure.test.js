// tests/unit/stockReservation.pure.test.js
//
// เทส pure functions ของ stock-reservation service:
//   - validateCartLimits (D1) — qty/total/distinct caps
//   - formatReservationError — แปลง error code → ข้อความลูกค้า

import { describe, it, expect } from 'vitest';
import {
    validateCartLimits,
    formatReservationError,
} from '../../src/services/stock-reservation.service.js';

const cfg = {
    maxQtyPerItem: 10,
    maxTotalItems: 50,
    maxDistinctSkus: 15,
};

// ============================================================
// validateCartLimits — D1
// ============================================================

describe('validateCartLimits — empty / invalid', () => {
    it('rejects empty cart', () => {
        expect(validateCartLimits([], cfg).ok).toBe(false);
    });

    it('rejects when item quantity is 0', () => {
        const r = validateCartLimits([{ id: 1, quantity: 0 }], cfg);
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/มากกว่า 0/);
    });

    it('rejects when item quantity is negative', () => {
        expect(validateCartLimits([{ id: 1, quantity: -3 }], cfg).ok).toBe(false);
    });
});

describe('validateCartLimits — qty per item cap', () => {
    it('rejects when single SKU exceeds maxQtyPerItem', () => {
        const r = validateCartLimits([{ id: 1, quantity: 11 }], { ...cfg, maxQtyPerItem: 10 });
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/ไม่เกิน 10/);
    });

    it('accepts exactly at maxQtyPerItem', () => {
        expect(validateCartLimits([{ id: 1, quantity: 10 }], { ...cfg, maxQtyPerItem: 10 }).ok).toBe(true);
    });
});

describe('validateCartLimits — total items cap', () => {
    it('rejects when total across SKUs exceeds maxTotalItems', () => {
        // 6 SKUs × 9 each = 54 > 50
        const cart = Array.from({ length: 6 }, (_, i) => ({ id: i + 1, quantity: 9 }));
        const r = validateCartLimits(cart, cfg);
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/รวมเกิน 50/);
    });
});

describe('validateCartLimits — distinct SKU cap', () => {
    it('rejects when number of distinct SKUs exceeds cap', () => {
        // 16 SKUs × 1 each — total OK but distinct > 15
        const cart = Array.from({ length: 16 }, (_, i) => ({ id: i + 1, quantity: 1 }));
        const r = validateCartLimits(cart, cfg);
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/ไม่เกิน 15 รายการ/);
    });
});

describe('validateCartLimits — happy path', () => {
    it('accepts cart within all limits', () => {
        const cart = [
            { id: 1, quantity: 5 },
            { id: 2, quantity: 3 },
            { id: 3, quantity: 2 },
        ];
        expect(validateCartLimits(cart, cfg)).toEqual({ ok: true });
    });
});

// ============================================================
// formatReservationError
// ============================================================

describe('formatReservationError', () => {
    const names = { 7: 'หัวพ็อด Banana' };

    it('uses product name from map for INSUFFICIENT_STOCK', () => {
        const msg = formatReservationError('INSUFFICIENT_STOCK:7', names);
        expect(msg).toMatch(/หัวพ็อด Banana/);
        expect(msg).toMatch(/มีคนจองตัดหน้า/);
    });

    it('falls back to #id when product name missing', () => {
        const msg = formatReservationError('INSUFFICIENT_STOCK:42', {});
        expect(msg).toMatch(/#42/);
    });

    it('formats RATIO_EXCEEDED with limit number', () => {
        const msg = formatReservationError('RATIO_EXCEEDED:7:5', names);
        expect(msg).toMatch(/หัวพ็อด Banana/);
        expect(msg).toMatch(/ไม่เกิน 5 ชิ้น/);
    });

    it('formats NOT_FOUND', () => {
        expect(formatReservationError('NOT_FOUND:42', names)).toMatch(/ไม่พบสินค้า/);
    });

    it('passes through INVALID_ITEM', () => {
        expect(formatReservationError('INVALID_ITEM', {})).toMatch(/ไม่ถูกต้อง/);
    });

    it('passes through unknown messages unchanged', () => {
        expect(formatReservationError('SOME_RANDOM_ERROR')).toBe('SOME_RANDOM_ERROR');
    });
});
