import { prisma } from '../db.js';
import * as customerService from './customer.service.js';
import * as campaignService from './campaign.service.js';
import * as couponService from './coupon.service.js';
import * as mysteryBoxService from './mystery-box.service.js';
import { notifyCustomer } from './notification-center.service.js';
import { getConfig } from '../config/config.js';
import { addDays } from '../utils/date.utils.js';

/**
 * Creates a pending referral record when a new user joins via a referral link.
 * This is intended to be called after the new user (referee) has been created.
 *
 * @param {string} referrerId - The customer ID of the person who referred.
 * @param {Object} refereeData - Data for the new user (referee) including telegramId, firstName, etc.
 * @returns {Promise<import('@prisma/client').Referral>} The created referral record.
 */
const createPendingReferral = async (referrerId, refereeData) => {
  return prisma.$transaction(async (tx) => {
    // 1. Create the new customer (referee)
    // TODO: Refactor customerService.createCustomer to accept a transaction client (tx)
    const newCustomer = await customerService.createCustomer(refereeData, "REFERRAL"); 

    // 2. Create the referral record with 'PENDING_PURCHASE' status
    const referral = await tx.referral.create({
      data: {
        referrerId: referrerId,
        refereeId: newCustomer.customerId,
        status: 'PENDING_PURCHASE'
      }
    });

    // 3. Give the new user (referee) their initial welcome bonus (LINK_BONUS)
    const activeCampaign = await campaignService.getActiveCampaign();
    const linkBonus = activeCampaign?.linkBonus ?? parseInt(getConfig('standardLinkBonus')) ?? 50;

    if (linkBonus > 0) {
      await tx.customer.update({
        where: { customerId: newCustomer.customerId },
        data: {
          points: { increment: linkBonus }
        }
      });
      await tx.pointTransaction.create({
        data: {
          customerId: newCustomer.customerId,
          amount: linkBonus,
          type: 'LINK_BONUS',
          detail: `Welcome bonus from referral by ${referrerId}`
        }
      });
      await tx.systemLog.create({
        data: {
          level: 'INFO',
          source: 'SYSTEM',
          action: 'WELCOME_BONUS',
          customerId: newCustomer.customerId,
          points: linkBonus,
          message: `New customer ${newCustomer.customerId} received ${linkBonus} welcome points.`
        }
      });
    }

    return referral;
  });
};

/**
 * คำนวณยอดที่ใช้เทียบเงื่อนไข reward coupon
 *   eligibleAmount = subtotal - discountAmount  (ไม่รวมค่าส่ง)
 * - ถ้ามี orderId → ใช้ order นั้นโดยตรง
 * - ไม่งั้นเลือก order ล่าสุดของ refereeId ที่จ่ายเงินแล้ว
 * - ออเดอร์เก่าที่ subtotal เป็น null → fallback คำนวณจาก items
 * - ถ้าหา order ไม่เจอ → fallback ใช้ purchaseAmount ที่ส่งเข้ามา
 */
async function computeEligibleAmount({ orderId, refereeId, fallback }) {
  let order = null;
  try {
    if (orderId) {
      order = await prisma.order.findUnique({
        where: { id: orderId },
        select: { subtotal: true, discountAmount: true, items: { select: { quantity: true, priceAtPurchase: true } } },
      });
    }
    if (!order) {
      order = await prisma.order.findFirst({
        where: { customerId: refereeId, status: { in: ['PAID', 'PROCESSING', 'SHIPPED'] } },
        orderBy: { createdAt: 'desc' },
        select: { subtotal: true, discountAmount: true, items: { select: { quantity: true, priceAtPurchase: true } } },
      });
    }
  } catch (e) {
    console.error('[Referral] computeEligibleAmount lookup failed:', e.message);
  }

  if (!order) return Number(fallback) || 0;

  let subtotal = order.subtotal != null ? Number(order.subtotal) : null;
  if (subtotal == null) {
    subtotal = (order.items || []).reduce(
      (s, it) => s + Number(it.priceAtPurchase || 0) * Number(it.quantity || 0),
      0
    );
  }
  const discount = Number(order.discountAmount) || 0;
  return Math.max(0, Math.round((subtotal - discount) * 100) / 100);
}

/**
 * Completes a referral process after a new user makes their first qualifying purchase.
 * This is triggered by the /refer admin command and auto-trigger from verify-slip.
 *
 * @param {string} refereeId - The customer ID of the new user making the purchase.
 * @param {number} purchaseAmount - The amount of the purchase.
 * @param {string} [orderId] - Optional. Order ID ที่เพิ่งจ่าย — ใช้คำนวณ eligibleAmount แม่นยำ
 * @returns {Promise<{success: boolean, message: string, bonus?: number}>} Result of the operation.
 */
const completeReferral = async (refereeId, purchaseAmount, orderId = null) => {
  const txResult = await prisma.$transaction(async (tx) => {
    let referral = await tx.referral.findUnique({
      where: { refereeId }
    });

    // 1. Validate referral status and existence
    if (!referral) {
      // 1.1 Fallback: Check if the customer has a referrerId but the Referral record was never created (due to old migrations or bugs)
      const refereeCustomer = await tx.customer.findUnique({ where: { customerId: refereeId } });
      if (refereeCustomer && refereeCustomer.referrerId) {
        // Create the missing Referral record as PENDING_PURCHASE
        referral = await tx.referral.create({
          data: {
            referrerId: refereeCustomer.referrerId,
            refereeId: refereeId,
            status: 'PENDING_PURCHASE'
          }
        });
      } else {
        return { success: false, message: "ไม่พบข้อมูลการแนะนำสำหรับลูกค้ารายนี้" };
      }
    }
    
    // COMPLETED แล้วก็ไม่ต้องทำซ้ำ — ถ้าเป็น FAILED_MIN_PURCHASE → อนุญาตให้ retry
    // (เผื่อรอบแรกยอดน้อยไม่ผ่าน แต่รอบถัดไปยอดถึงเกณฑ์ ลูกค้าควรได้)
    if (referral.status === 'COMPLETED') {
      return { success: false, message: "การแนะนำนี้เสร็จสมบูรณ์ไปแล้ว" };
    }
    if (referral.status !== 'PENDING_PURCHASE' && referral.status !== 'FAILED_MIN_PURCHASE') {
      return { success: false, message: "สถานะการแนะนำไม่ถูกต้อง" };
    }

    // 2. Check purchase amount against campaign rules
    const activeCampaign = await campaignService.getActiveCampaign();
    // Default 500 — แก้ใน Prisma Studio (key: minPurchaseForReferral)
    // ใช้ Number() ไม่ใช่ parseInt() เพราะ config อาจเป็นทศนิยม + Number("0") = 0 (ไม่ fallback ผิด)
    const rawMin = getConfig('minPurchaseForReferral');
    const minPurchaseForReferral = (rawMin != null && rawMin !== '') ? Number(rawMin) : 500;

    if (purchaseAmount < minPurchaseForReferral) {
      // Mark referral as FAILED so subsequent purchases don't trigger the bonus
      await tx.referral.update({
        where: { refereeId },
        data: {
          status: 'FAILED_MIN_PURCHASE',
          purchaseAmount: purchaseAmount,
          bonusAwarded: 0,
          completedAt: new Date()
        }
      });
      // Fallback: Ensure referee's Customer record has referrerId set
      await tx.customer.update({
        where: { customerId: refereeId },
        data: { referrerId: referral.referrerId }
      });
      return { success: false, message: `การสั่งซื้อครั้งแรกยอดไม่ถึงเกณฑ์ขั้นต่ำ ${minPurchaseForReferral} บาท (ยอดซื้อจริง: ${purchaseAmount} บาท) การแนะนำจึงไม่ได้รับแต้ม` };
    }

    // 3. Calculate Bonus Points
    const baseBonus = activeCampaign?.baseReferral ?? parseInt(getConfig('standardReferralPoints')) ?? 50;

    // Tier multiplier: คำนวณจาก referrer's monthly count (BEFORE incrementing)
    const startOfMonth = (() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); })();
    const endOfMonth = (() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999); })();
    const referrerMonthCount = await tx.referral.count({
      where: {
        referrerId: referral.referrerId,
        status: 'COMPLETED',
        completedAt: { gte: startOfMonth, lte: endOfMonth },
      },
    });
    const silverMin = parseInt(getConfig('tier_silver_min')) || 3;
    const goldMin = parseInt(getConfig('tier_gold_min')) || 6;
    const silverMul = Number(getConfig('tier_silver_multiplier')) || 1.0;
    const goldMul = Number(getConfig('tier_gold_multiplier')) || 1.0;
    let tierMultiplier = 1.0;
    let tierLabel = '';
    if (referrerMonthCount >= goldMin) { tierMultiplier = goldMul; tierLabel = 'Gold'; }
    else if (referrerMonthCount >= silverMin) { tierMultiplier = silverMul; tierLabel = 'Silver'; }
    const bonusPoints = Math.round(baseBonus * tierMultiplier);
    const tierMessage = (tierMultiplier > 1 && tierLabel)
      ? ` (${tierLabel} x${tierMultiplier})`
      : '';

    let earnedMilestoneBonus = 0;
    let milestoneMessage = '';

    if (activeCampaign && activeCampaign.milestoneTarget > 0 && activeCampaign.milestoneBonus > 0) {
        // We need the latest count of referrals for the referrer to check for milestones
        const referrer = await tx.customer.findUnique({ where: { customerId: referral.referrerId } });
        const newReferralCount = (referrer.referralCount || 0) + 1;

        if (newReferralCount > 0 && newReferralCount % activeCampaign.milestoneTarget === 0) {
            earnedMilestoneBonus = activeCampaign.milestoneBonus;
            milestoneMessage = ` โบนัสแคมเปญ +${earnedMilestoneBonus}`;
        }
    }
    const totalPointsToAdd = bonusPoints + earnedMilestoneBonus;

    // 4. Award points to the referrer and increment their referral count
    await tx.customer.update({
        where: { customerId: referral.referrerId },
        data: {
            points: { increment: totalPointsToAdd },
            referralCount: { increment: 1 }
        }
    });

    // 5. Create a transaction log for the bonus points
    await tx.pointTransaction.create({
        data: {
            customerId: referral.referrerId,
            amount: totalPointsToAdd,
            type: earnedMilestoneBonus > 0 ? 'CAMPAIGN_BONUS' : 'REFERRAL_BONUS',
            detail: `Referral bonus from ${refereeId}.${milestoneMessage}`,
            relatedId: refereeId
        }
    });

    // 6. Update Referral record
    await tx.referral.update({
      where: { refereeId },
      data: {
        status: 'COMPLETED',
        purchaseAmount: purchaseAmount,
        bonusAwarded: totalPointsToAdd,
        completedAt: new Date()
      }
    });

    // 7. Fallback: Ensure referee's Customer record has referrerId set + ใส่ activeCampaignTag
    // (campaign tag จำเป็นสำหรับ countCampaignReferralsByTag — ไม่งั้นกล่องแคมเปญจะนับเป็น 0)
    const campaignTag = activeCampaign?.name || null;
    await tx.customer.update({
      where: { customerId: refereeId },
      data: {
        referrerId: referral.referrerId,
        ...(campaignTag ? { activeCampaignTag: campaignTag } : {}),
      }
    });

    return {
      success: true,
      message: `การแนะนำสำเร็จ! ผู้แนะนำ ${referral.referrerId} ได้รับ ${totalPointsToAdd} แต้ม${tierMessage}${milestoneMessage}`,
      bonus: totalPointsToAdd,
      referralId: referral.id,
      referrerId: referral.referrerId,
    };
  });

  if (!txResult || !txResult.success) return txResult;

  // หลัง tx สำเร็จ → แจ้งเตือนผู้แนะนำว่าได้รับแต้ม (in-app + Telegram)
  try {
    await notifyCustomer({
      customerId: txResult.referrerId,
      kind: 'POINTS_EARNED',
      title: '⭐ ได้รับแต้มจากการแนะนำเพื่อน',
      body: `เพื่อนของคุณ (${refereeId}) ซื้อครั้งแรกสำเร็จ\nคุณได้รับ ${txResult.bonus} แต้ม`,
      link: 'dashboard.html',
      payload: { refereeId, bonus: txResult.bonus, referralRowId: txResult.referralId },
      entityKey: `referral-bonus:${txResult.referralId}`,
      telegramText:
        `⭐ <b>ได้รับแต้มจากการแนะนำเพื่อน!</b>\n\n` +
        `เพื่อนของคุณ (<code>${refereeId}</code>) ซื้อครั้งแรกสำเร็จ\n` +
        `คุณได้รับ <b>+${txResult.bonus} แต้ม</b> 🎉`,
    });
  } catch (e) {
    console.error('[Referral] notify referrer failed:', e.message);
  }

  // หลัง tx สำเร็จ → ลองมอบ reward coupon (best-effort, ไม่กระทบสถานะ referral)
  let rewardSuffix = '';
  const eligibleAmount = await computeEligibleAmount({ orderId, refereeId, fallback: purchaseAmount });
  try {
    const { granted } = await couponService.grantRewardCoupons({
      event: 'REFEREE_FIRST_PURCHASE',
      referrerId: txResult.referrerId,
      refereeId,
      eligibleAmount,
      referralRowId: txResult.referralId,
    });
    if (granted.length > 0) {
      const labelOf = (role) => role === 'REFERRER' ? 'ผู้แนะนำ' : 'ผู้สมัคร';
      const lines = granted.map(g => `🎁 ${g.couponName} → ${labelOf(g.recipientRole)}`);
      rewardSuffix = `\n${lines.join('\n')}`;
    }
  } catch (e) {
    console.error('[Referral] grantRewardCoupons failed:', e.message);
  }

  // หลัง tx สำเร็จ → ลองมอบ Mystery Box (REFEREE_FIRST_PURCHASE) ให้ referrer
  // (best-effort, ไม่กระทบ referral)
  try {
    const { granted: mbGranted } = await mysteryBoxService.grantTickets({
      customerId: txResult.referrerId,
      event: 'REFEREE_FIRST_PURCHASE',
      eligibleAmount,
      referralRowId: txResult.referralId,
      metadata: { refereeId },
    });
    if (mbGranted.length > 0) {
      const lines = mbGranted.map(g => `🎁 ${g.boxName}${g.qty > 1 ? ` ×${g.qty}` : ''}`);
      rewardSuffix += `\n${lines.join('\n')}`;
    }
  } catch (e) {
    console.error('[Referral] grantMysteryBox failed:', e.message);
  }

  return {
    success: true,
    message: txResult.message + rewardSuffix,
    bonus: txResult.bonus,
  };
};


/**
 * Counts the number of completed referrals for a given customer in the current month.
 *
 * @param {string} referrerId - The customer ID of the referrer.
 * @returns {Promise<number>} The count of completed referrals for the current month.
 */
const countMonthlyReferrals = async (referrerId) => {
  try {
    const now = new Date();
    // Get the current date in Bangkok time zone
    const bangkokTime = now.toLocaleString('en-US', { timeZone: 'Asia/Bangkok' });
    const bangkokDate = new Date(bangkokTime);

    // Set to the first day of the current month in Bangkok time
    const startOfMonth = new Date(bangkokDate.getFullYear(), bangkokDate.getMonth(), 1);
    // Set to the last day of the current month in Bangkok time
    const endOfMonth = new Date(bangkokDate.getFullYear(), bangkokDate.getMonth() + 1, 0, 23, 59, 59, 999);

    const count = await prisma.referral.count({
      where: {
        referrerId: referrerId,
        status: 'COMPLETED',
        completedAt: {
          gte: startOfMonth,
          lte: endOfMonth,
        },
      },
    });
    return count;
  } catch (error) {
    console.error("Error counting monthly referrals:", error);
    return 0;
  }
};

export {
  createPendingReferral,
  completeReferral,
  countMonthlyReferrals,
};