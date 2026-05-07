// tests/unit/referral.completeReferral.test.js
//
// เทส completeReferral — ครอบคลุม:
//   1. ยอดซื้อ < minPurchaseForReferral → status=FAILED_MIN_PURCHASE, ไม่ได้แต้ม
//   2. Bronze tier (monthCount < 3) → bonus = base × 1.0
//   3. Silver tier (3 ≤ monthCount < 6) → bonus = base × tier_silver_multiplier
//   4. Gold tier (monthCount ≥ 6) → bonus = base × tier_gold_multiplier
//   5. ครบ milestone → ได้ milestoneBonus เพิ่ม + type='CAMPAIGN_BONUS'
//   6. Referral status=COMPLETED → reject (ไม่ทำซ้ำ)
//   7. Referral status=FAILED_MIN_PURCHASE → retry สำเร็จได้ถ้ารอบนี้ผ่านเกณฑ์
//
// Findings ที่ต่างจากสเปคผู้ใช้:
//   - tier multipliers ของจริงเป็น config-driven (default ทั้งคู่ = 1.0)
//     ผู้ใช้ระบุ 1.10/1.25 → ผมใส่ค่าผ่าน getConfig mock เพื่อ verify logic
//   - bonus = Math.round(base × multiplier) → 50×1.25=62.5 ปัดเป็น 63 (assert ตามจริง)
//   - milestone trigger ใช้ referralCount (lifetime) ไม่ใช่ monthly count

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
vi.mock('../../src/services/customer.service.js', () => ({
    createCustomer: vi.fn(),
}));
vi.mock('../../src/services/campaign.service.js', () => ({
    getActiveCampaign: vi.fn(),
}));
vi.mock('../../src/services/coupon.service.js', () => ({
    grantRewardCoupons: vi.fn(),
}));
vi.mock('../../src/services/mystery-box.service.js', () => ({
    grantTickets: vi.fn(),
}));
vi.mock('../../src/services/notification-center.service.js', () => ({
    notifyCustomer: vi.fn(),
}));
vi.mock('../../src/utils/date.utils.js', () => ({
    addDays: vi.fn(),
}));

import { prisma } from '../../src/db.js';
import { getConfig } from '../../src/config/config.js';
import * as campaignService from '../../src/services/campaign.service.js';
import * as couponService from '../../src/services/coupon.service.js';
import * as mysteryBoxService from '../../src/services/mystery-box.service.js';
import { completeReferral } from '../../src/services/referral.service.js';

// ----- defaults + helpers -----

const DEFAULT_CONFIG = {
    minPurchaseForReferral: '500',
    standardReferralPoints: '50',
    standardLinkBonus: '50',
    tier_silver_min: '3',
    tier_gold_min: '6',
    tier_silver_multiplier: '1.0',
    tier_gold_multiplier: '1.0',
};

beforeEach(() => {
    mockReset(prisma);
    vi.mocked(getConfig).mockImplementation((key) => DEFAULT_CONFIG[key]);
    // best-effort post-tx services — return ว่างกัน null deref
    vi.mocked(couponService.grantRewardCoupons).mockResolvedValue({ granted: [], skipped: [] });
    vi.mocked(mysteryBoxService.grantTickets).mockResolvedValue({ granted: [], skipped: [] });
    vi.mocked(campaignService.getActiveCampaign).mockResolvedValue(null);
    // $transaction → รัน callback กับ prisma mock เดียวกัน
    prisma.$transaction.mockImplementation(async (cb) => cb(prisma));
    // computeEligibleAmount queries (best-effort)
    prisma.order.findUnique.mockResolvedValue(null);
    prisma.order.findFirst.mockResolvedValue(null);
});

/**
 * Setup happy path เริ่มต้นสำหรับ completeReferral
 *   - referral PENDING_PURCHASE อยู่แล้ว
 *   - referrer มี referralCount ตามค่าที่ส่งมา
 *   - monthly count ตามที่กำหนด
 *   - active campaign (ถ้ามี milestone) ตามที่ส่งมา
 */
function setupHappyPath({
    status = 'PENDING_PURCHASE',
    monthCount = 0,
    referralCount = 0,
    campaign = null, // {baseReferral, milestoneTarget, milestoneBonus, name}
} = {}) {
    prisma.referral.findUnique.mockResolvedValue({
        id: 1,
        referrerId: 'OT-REF',
        refereeId: 'OT-NEW',
        status,
    });
    prisma.referral.count.mockResolvedValue(monthCount);
    prisma.customer.findUnique.mockResolvedValue({
        customerId: 'OT-REF',
        referralCount,
    });
    prisma.customer.update.mockResolvedValue({});
    prisma.referral.update.mockResolvedValue({});
    prisma.pointTransaction.create.mockResolvedValue({});
    if (campaign) {
        vi.mocked(campaignService.getActiveCampaign).mockResolvedValue(campaign);
    }
}

/** snapshot ของ args ที่ส่งเข้า prisma.pointTransaction.create */
function lastPointTxArg() {
    const call = prisma.pointTransaction.create.mock.calls.at(-1);
    return call?.[0]?.data;
}

/** snapshot ของ args ที่ส่งเข้า referral.update (อันสุดท้าย) */
function lastReferralUpdateArg() {
    const call = prisma.referral.update.mock.calls.at(-1);
    return call?.[0]?.data;
}

// ============================================================
// 1. ยอดซื้อ < minPurchaseForReferral
// ============================================================

describe('completeReferral — minPurchase guard', () => {
    it('marks status=FAILED_MIN_PURCHASE and awards no points when amount below threshold', async () => {
        setupHappyPath();

        const r = await completeReferral('OT-NEW', 300); // < 500 default

        expect(r.success).toBe(false);
        expect(r.message).toMatch(/ยอดไม่ถึงเกณฑ์ขั้นต่ำ 500/);

        // referral.update — ใช้ครั้งเดียวด้วย FAILED_MIN_PURCHASE
        expect(prisma.referral.update).toHaveBeenCalledTimes(1);
        const updateArg = lastReferralUpdateArg();
        expect(updateArg.status).toBe('FAILED_MIN_PURCHASE');
        expect(updateArg.bonusAwarded).toBe(0);

        // ไม่บันทึก pointTransaction (ไม่ได้แต้ม)
        expect(prisma.pointTransaction.create).not.toHaveBeenCalled();
    });
});

// ============================================================
// 2-4. Tier multipliers
// ============================================================

describe('completeReferral — tier multipliers', () => {
    it('Bronze tier (monthCount < 3) → bonus = base × 1.0', async () => {
        setupHappyPath({ monthCount: 2 });

        const r = await completeReferral('OT-NEW', 600);

        expect(r.success).toBe(true);
        expect(r.bonus).toBe(50); // 50 × 1.0
        const tx = lastPointTxArg();
        expect(tx.amount).toBe(50);
        expect(tx.type).toBe('REFERRAL_BONUS');
    });

    it('Silver tier (3 ≤ monthCount < 6) → bonus = round(base × silverMul)', async () => {
        // override silver multiplier ให้เป็น 1.10
        vi.mocked(getConfig).mockImplementation((key) =>
            ({ ...DEFAULT_CONFIG, tier_silver_multiplier: '1.10' })[key],
        );
        setupHappyPath({ monthCount: 4 });

        const r = await completeReferral('OT-NEW', 600);

        expect(r.success).toBe(true);
        expect(r.bonus).toBe(55); // round(50 × 1.10) = 55
        expect(r.message).toMatch(/Silver x1\.1/);
    });

    it('Gold tier (monthCount ≥ 6) → bonus = round(base × goldMul)', async () => {
        // override gold multiplier ให้เป็น 1.25
        vi.mocked(getConfig).mockImplementation((key) =>
            ({ ...DEFAULT_CONFIG, tier_gold_multiplier: '1.25' })[key],
        );
        setupHappyPath({ monthCount: 10 });

        const r = await completeReferral('OT-NEW', 600);

        expect(r.success).toBe(true);
        expect(r.bonus).toBe(63); // round(50 × 1.25) = round(62.5) = 63
        expect(r.message).toMatch(/Gold x1\.25/);
    });
});

// ============================================================
// 5. Milestone bonus
// ============================================================

describe('completeReferral — milestone', () => {
    it('adds milestoneBonus when referralCount+1 hits milestoneTarget', async () => {
        // referralCount=4 → newCount=5, 5 % 5 === 0 → trigger
        setupHappyPath({
            monthCount: 0,
            referralCount: 4,
            campaign: {
                baseReferral: 50,
                milestoneTarget: 5,
                milestoneBonus: 200,
                name: 'TEST_CAMPAIGN',
            },
        });

        const r = await completeReferral('OT-NEW', 600);

        expect(r.success).toBe(true);
        expect(r.bonus).toBe(250); // 50 + 200
        expect(r.message).toMatch(/โบนัสแคมเปญ \+200/);

        // type ของ pointTransaction เปลี่ยนเป็น CAMPAIGN_BONUS
        const tx = lastPointTxArg();
        expect(tx.type).toBe('CAMPAIGN_BONUS');
        expect(tx.amount).toBe(250);
    });
});

// ============================================================
// 6. COMPLETED → reject
// ============================================================

describe('completeReferral — status guards', () => {
    it('rejects when referral is already COMPLETED', async () => {
        setupHappyPath({ status: 'COMPLETED' });

        const r = await completeReferral('OT-NEW', 600);

        expect(r.success).toBe(false);
        expect(r.message).toMatch(/เสร็จสมบูรณ์ไปแล้ว/);

        // ไม่มี side effect — ไม่อัพเดท referral, ไม่ออกแต้ม
        expect(prisma.referral.update).not.toHaveBeenCalled();
        expect(prisma.pointTransaction.create).not.toHaveBeenCalled();
    });

    // ============================================================
    // 7. FAILED_MIN_PURCHASE → retry
    // ============================================================

    it('allows retry when prior status is FAILED_MIN_PURCHASE and new amount qualifies', async () => {
        setupHappyPath({
            status: 'FAILED_MIN_PURCHASE',
            monthCount: 0,
        });

        const r = await completeReferral('OT-NEW', 600);

        expect(r.success).toBe(true);
        expect(r.bonus).toBe(50);

        // referral ถูกอัพเดทเป็น COMPLETED
        const updateArg = lastReferralUpdateArg();
        expect(updateArg.status).toBe('COMPLETED');
        expect(updateArg.bonusAwarded).toBe(50);
    });
});
