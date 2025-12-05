import { prisma } from '../db.js';
import * as customerService from './customer.service.js';
import * as campaignService from './campaign.service.js';
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
    const newCustomer = await customerService.createCustomer(refereeData); 

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
 * Completes a referral process after a new user makes their first qualifying purchase.
 * This is triggered by the /refer admin command.
 *
 * @param {string} refereeId - The customer ID of the new user making the purchase.
 * @param {number} purchaseAmount - The amount of the purchase.
 * @returns {Promise<{success: boolean, message: string, bonus?: number}>} Result of the operation.
 */
const completeReferral = async (refereeId, purchaseAmount) => {
  return prisma.$transaction(async (tx) => {
    const referral = await tx.referral.findUnique({
      where: { refereeId }
    });

    // 1. Validate referral status and existence
    if (!referral) {
      return { success: false, message: "ไม่พบข้อมูลการแนะนำสำหรับลูกค้ารายนี้" };
    }
    if (referral.status !== 'PENDING_PURCHASE') {
      return { success: false, message: "การแนะนำนี้เสร็จสมบูรณ์แล้วหรือไม่ถูกต้อง" };
    }

    // 2. Check purchase amount against campaign rules
    const activeCampaign = await campaignService.getActiveCampaign();
    // Assuming campaign or system config has minPurchaseForReferral, otherwise use default 500
    // TODO: Add minPurchaseForReferral to Campaign model or SystemConfig for dynamic configuration
    const minPurchaseForReferral = parseInt(getConfig('minPurchaseForReferral')) || 500; // Use from config or default

    if (purchaseAmount < minPurchaseForReferral) {
      return { success: false, message: `ยอดซื้อไม่ถึงเกณฑ์ขั้นต่ำ ${minPurchaseForReferral} บาท` };
    }

    // 3. Award Bonus to Referrer (using giveReferralBonus for its comprehensive logic)
    // TODO: Refactor customerService.giveReferralBonus to accept a transaction client (tx)
    // and potentially return the awarded points for this transaction context.
    await customerService.giveReferralBonus(referral.referrerId, refereeId, 'System (Auto)');

    // Recalculate awarded points for logging in the Referral table (giveReferralBonus doesn't return it)
    const bonusPoints = activeCampaign?.baseReferral ?? parseInt(getConfig('standardReferralPoints')) ?? 50;
    let earnedMilestoneBonus = 0;
    if (activeCampaign && activeCampaign.milestoneTarget > 0 && activeCampaign.milestoneBonus > 0) {
        const campaignTag = activeCampaign.campaignName || activeCampaign.name || 'Standard';
        const currentCampaignCount = await customerService.countCampaignReferralsByTag(referral.referrerId, campaignTag);
        const newCampaignCount = currentCampaignCount + 1; 

        if (newCampaignCount % activeCampaign.milestoneTarget === 0) {
            earnedMilestoneBonus = activeCampaign.milestoneBonus;
        }
    }
    const totalPointsToAdd = bonusPoints + earnedMilestoneBonus;


    // 4. Update Referral record
    const updatedReferral = await tx.referral.update({
      where: { refereeId },
      data: {
        status: 'COMPLETED',
        purchaseAmount: purchaseAmount,
        bonusAwarded: totalPointsToAdd,
        completedAt: new Date()
      }
    });

    return { success: true, message: `การแนะนำสำเร็จ! ผู้แนะนำ ${referral.referrerId} ได้รับ ${totalPointsToAdd} แต้ม`, bonus: totalPointsToAdd };
  });
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