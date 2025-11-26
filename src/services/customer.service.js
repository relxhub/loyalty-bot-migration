// src/services/customer.service.js

import { prisma } from '../db.js';
import { getActiveCampaign } from './campaign.service.js';
import { addDays, getThaiNow } from '../utils/date.utils.js'; // เพิ่ม getThaiNow
import { sendNotificationToCustomer } from './notification.service.js'; 
import { getConfig } from '../config/config.js';

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

    await prisma.customer.update({
        where: { customerId: referrerId },
        data: {
            points: { increment: bonusPoints },
            expiryDate: finalExpiryDate,
            referralCount: { increment: 1 },
            activeCampaignTag: campaign?.campaignName || campaign?.name || 'Standard'
        }
    });

    const newPoints = referrer.points + bonusPoints;
    const notificationMessage = `💌 ขอบคุณที่แนะนำเพื่อน!\n⭐️ คุณได้รับแต้มโบนัส ${bonusPoints} แต้ม จากการแนะนำคุณ ${newCustomerId}\n💰 แต้มสะสมปัจจุบัน: ${newPoints} แต้ม`;
    
    if (referrer.telegramUserId) {
        await sendNotificationToCustomer(referrer.telegramUserId, notificationMessage);
    }
}