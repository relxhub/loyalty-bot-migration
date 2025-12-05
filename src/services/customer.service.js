import { prisma } from '../db.js';
import { getActiveCampaign } from './campaign.service.js';
import { addDays, getThaiNow } from '../utils/date.utils.js';
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
        return await prisma.customerLog.count({
            where: {
                customerId: customerId,
                action: 'REFERRAL_BONUS',
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

// 2. สร้างลูกค้าใหม่ (Auto Register)
export async function createCustomer(data) {
    const { telegramId, firstName, lastName, username } = data; // รับ telegramId เข้ามา (ซึ่งจะเป็น null จากแอดมิน)

    // สร้างรหัสสมาชิก (ตัวอย่าง: MEM-เลขสุ่ม)
    const randomSuffix = Math.floor(100000 + Math.random() * 900000); // เลข 6 หลัก
    const newCustomerId = `MEM-${randomSuffix}`;

    // กำหนดวันหมดอายุเริ่มต้น (เช่น 30 วัน)
    const initialDays = parseInt(getConfig('expiryDaysNewMember')) || 30;
    const expiryDate = addDays(new Date(), initialDays);

    return await prisma.customer.create({
        data: {
            customerId: data.customerId || newCustomerId, // ใช้ ID ที่ส่งมา หรือสร้างใหม่
            telegramUserId: telegramId, // ✅ Prisma รองรับ null ได้ถ้าใน schema ไม่ได้บังคับ (String?)
            firstName: firstName,
            lastName: lastName,
            username: username,
            points: 0,
            referralCount: 0,
            expiryDate: addDays(new Date(), 30),
            isDeleted: false,
            // ถ้า data มี verificationCode ให้ใช้ ถ้าไม่มีให้สร้างใหม่
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

    // ⭐️ ใช้เวลาไทยเที่ยงคืน
    const today = getThaiNow();
    today.setHours(0, 0, 0, 0);

    const baseDate = referrer.expiryDate > today ? referrer.expiryDate : today;
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

    // 2. Update Referee (New Customer) with Campaign Tag
    await prisma.customer.update({
        where: { customerId: newCustomerId },
        data: {
            activeCampaignTag: campaign?.campaignName || campaign?.name || 'Standard'
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