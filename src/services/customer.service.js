import { prisma } from '../db.js';
import { getActiveCampaign } from './campaign.service.js';
import { addDays } from '../utils/date.utils.js';
import { sendNotificationToCustomer } from './notification.service.js';
import { getConfig } from '../config/config.js';

// -----------------------------------------------------------------
// คำนวณยอด Referral ตาม Tag แคมเปญ (แม่นยำกว่าการใช้วันที่)
// -----------------------------------------------------------------
export async function countCampaignReferralsByTag(referrerId, campaignTag) {
    if (!referrerId || !campaignTag) return 0;

    try {
        const count = await prisma.customer.count({
            where: {
                referrerId: referrerId,
                activeCampaignTag: campaignTag
            }
        });
        return count;
    } catch (e) {
        console.error("Error counting campaign referrals by tag:", e.message);
        return 0;
    }
}

// Keep old function for compatibility (if needed elsewhere) or redirect
export async function countCampaignReferrals(customerId, startDate) {
    // Legacy support: still counts logs by date
    if (!startDate) return 0;
    try {
        return await prisma.PointTransaction.count({
            where: {
                customerId: customerId,
                type: 'REFERRAL_BONUS',
                createdAt: { gte: startDate }
            }
        });
    } catch (e) {
        return 0;
    }
}

// ==========================================
// 🆕 ส่วนที่เพิ่มเข้ามา (เพื่อให้ API ทำงานได้)
// ==========================================

// 1. ค้นหาลูกค้าด้วย Telegram ID
export async function getCustomerByTelegramId(telegramId) {
    return await prisma.customer.findUnique({
        where: { telegramUserId: telegramId.toString() }
    });
}

/**
 * Generates the next sequential customer ID with the prefix "OT".
 * It finds the highest existing number from IDs like "OT1", "OT999", etc.,
 * and returns the next ID in the sequence (e.g., "OT1000").
 * @returns {Promise<string>} The next customer ID.
 */
async function generateNextCustomerId() {
    // 1. Find all customers with IDs starting with "OT"
    const otCustomers = await prisma.customer.findMany({
        where: {
            customerId: {
                startsWith: 'OT'
            }
        },
        select: {
            customerId: true
        }
    });

    let maxId = 0;
    // 2. Loop through them to find the highest number
    otCustomers.forEach(customer => {
        // Extract the numeric part of the ID
        const numericPart = parseInt(customer.customerId.substring(2), 10);
        if (!isNaN(numericPart) && numericPart > maxId) {
            maxId = numericPart;
        }
    });

    // 3. The next ID is the max found + 1
    const nextId = maxId + 1;
    return `OT${nextId}`;
}

// 2. สร้างลูกค้าใหม่ (Auto Register)
export async function createCustomer(data) {
    const { telegramId, firstName, lastName, username } = data;

    // Generate the next sequential customer ID (e.g., "OT1001")
    const newCustomerId = await generateNextCustomerId();

    // Set default expiry date (e.g., 30 days)
    const initialDays = parseInt(getConfig('expiryDaysNewMember')) || 30;
    const expiryDate = addDays(new Date(), initialDays);

    return await prisma.customer.create({
        data: {
            customerId: newCustomerId, // Use the new sequential ID
            telegramUserId: telegramId,
            firstName: firstName,
            lastName: lastName,
            username: username,
            points: 0,
            referralCount: 0,
            expiryDate: expiryDate,
            isDeleted: false,
            verificationCode: data.verificationCode || Math.floor(1000 + Math.random() * 9000).toString()
        }
    });
}

// ✅ แบบที่ถูกต้อง (แก้เป็นแบบนี้)
export async function updateCustomer(custID, data) { // ตั้งชื่อตัวแปรให้ชัดเจน (เช่น custID)
    return await prisma.customer.update({
        where: { customerId: custID }, // เอาตัวแปร custID มาใส่ตรงนี้
        data: data
    });
}

// ==========================================
// ✅ ฟังก์ชันเดิมของคุณ (คงไว้เหมือนเดิม)
// ==========================================

export async function giveReferralBonus(referrerId, newCustomerId, adminUser) {
    const campaign = await getActiveCampaign();
    const bonusPoints = campaign?.baseReferral ?? campaign?.base ?? getConfig('standardReferralPoints') ?? 50;
    
    const daysToExtend = getConfig('expiryDaysReferralBonus') || 7;
    const limitDays = getConfig('expiryDaysLimitMax') || 60;

    const referrer = await prisma.customer.findUnique({ where: { customerId: referrerId } });
    if (!referrer) return;

    // Get the start of today in Bangkok, represented as a UTC timestamp for accurate comparison
    const now = new Date();
    const year = Number(now.toLocaleString('en-US', { timeZone: 'Asia/Bangkok', year: 'numeric' }));
    const month = Number(now.toLocaleString('en-US', { timeZone: 'Asia/Bangkok', month: 'numeric' }));
    const day = Number(now.toLocaleString('en-US', { timeZone: 'Asia/Bangkok', day: 'numeric' }));
    const today = new Date(Date.UTC(year, month - 1, day));

    const baseDate = (referrer.expiryDate && referrer.expiryDate > today) ? referrer.expiryDate : today;
    const proposedExpiry = addDays(baseDate, daysToExtend);
    const limitDate = addDays(today, limitDays); 
    const finalExpiryDate = proposedExpiry > limitDate ? limitDate : proposedExpiry;

    // ---------------------------------------------------------
    // 🆕 Milestone Bonus Logic (Recurring)
    // ---------------------------------------------------------
    let earnedMilestoneBonus = 0;

    // Check if campaign has milestone configured
    if (campaign && campaign.milestoneTarget > 0 && campaign.milestoneBonus > 0) {
        // Use Tag-based counting for precise campaign tracking
        // Note: The new user (referee) is NOT yet tagged in DB (step 2 happens below),
        // so countCampaignReferralsByTag returns the count *before* this one.
        const campaignTag = campaign.campaignName || campaign.name || 'Standard';
        const currentCampaignCount = await countCampaignReferralsByTag(referrer.customerId, campaignTag);

        // The new total including this one
        const newCampaignCount = currentCampaignCount + 1;

        // Check if milestone reached (Recurring: 3, 6, 9, ...)
        if (newCampaignCount % campaign.milestoneTarget === 0) {
            earnedMilestoneBonus = campaign.milestoneBonus;
        }
    }

    // 1. Update Referrer (Points, Total Referral Count)
    // Increment points by (Base + Milestone if any)
    const totalPointsToAdd = bonusPoints + earnedMilestoneBonus;

    await prisma.customer.update({
        where: { customerId: referrerId },
        data: {
            points: { increment: totalPointsToAdd },
            expiryDate: finalExpiryDate,
            referralCount: { increment: 1 }
        }
    });

    // 2. IMPORTANT: Update Referee with referrerId and Campaign Tag
    const campaignTag = campaign?.name || 'Standard';
    await prisma.customer.update({
        where: { customerId: newCustomerId },
        data: {
            referrerId: referrerId,
            activeCampaignTag: campaignTag
        }
    });


    // 3. Log System (Auto) in AdminLog
    await prisma.AdminAuditLog.create({
        data: {
            adminName: 'System (Auto)',
            action: 'REFERRAL_BONUS',
            targetId: referrer.customerId,
            details: `From ${newCustomerId}. Points: +${bonusPoints}`
        }
    });

    // Milestone Log (if earned)
    if (earnedMilestoneBonus > 0) {
        await prisma.AdminAuditLog.create({
            data: {
                adminName: 'System (Auto)',
                action: 'CAMPAIGN_BONUS',
                targetId: referrer.customerId,
                details: `Milestone reached! (${campaign.milestoneTarget} referrals). Points: +${earnedMilestoneBonus}`
            }
        });
    }

    // 4. Customer Log (For Campaign Counting & User History)
    if (referrer.telegramUserId) {
        // Base Log for the referral
        await prisma.PointTransaction.create({
            data: {
                customerId: referrer.customerId,
                amount: bonusPoints,
                type: 'REFERRAL_BONUS',
                detail: `From new customer ${newCustomerId}`
            }
        });

        // Milestone Log if bonus was earned
        if (earnedMilestoneBonus > 0) {
            await prisma.PointTransaction.create({
                data: {
                    customerId: referrer.customerId,
                    amount: earnedMilestoneBonus,
                    type: 'CAMPAIGN_BONUS',
                    detail: `Milestone reached for referring ${newCustomerId}`
                }
            });
        }
    }

    // 5. System Logging
    try {
        await prisma.SystemLog.create({
            data: {
                level: 'INFO',
                source: 'SYSTEM',
                action: 'REFERRAL_BONUS',
                customerId: referrerId,
                points: bonusPoints,
                message: `Referrer ${referrerId} received ${bonusPoints} points for referring ${newCustomerId}.`
            }
        });

        if (earnedMilestoneBonus > 0) {
            await prisma.SystemLog.create({
                data: {
                    level: 'INFO',
                    source: 'SYSTEM',
                    action: 'CAMPAIGN_BONUS',
                    customerId: referrerId,
                    points: earnedMilestoneBonus,
                    message: `Referrer ${referrerId} earned milestone bonus of ${earnedMilestoneBonus} points.`
                }
            });
        }
    } catch (logError) {
        console.error("Failed to create SystemLog for referral bonus:", logError);
    }

    // 6. Notification
    const newPoints = referrer.points + totalPointsToAdd;
    let notificationMessage = `💌 ขอบคุณที่แนะนำเพื่อน!\n⭐️ คุณได้รับแต้มแนะนำ ${bonusPoints} แต้ม จากการแนะนำคุณ ${newCustomerId}`;

    if (earnedMilestoneBonus > 0) {
        notificationMessage += `\n🎉 และได้รับโบนัสพิเศษ ${earnedMilestoneBonus} แต้ม! (ครบตามเป้าหมาย)`;
    }

    notificationMessage += `\n💰 แต้มสะสมปัจจุบัน: ${newPoints} แต้ม`;
    
    if (referrer.telegramUserId) {
        await sendNotificationToCustomer(referrer.telegramUserId, notificationMessage);
    }
}