// src/services/customer.service.js

import { prisma } from '../db.js';
import { getActiveCampaign } from './campaign.service.js';
import { addDays } from '../utils/date.utils.js';
import { sendNotificationToCustomer } from './notification.service.js'; 
import { getConfig } from '../config/config.js';

export async function giveReferralBonus(referrerId, newCustomerId, adminUser) {
    const campaign = await getActiveCampaign();
    
    // ⭐️ แก้ไขจุดที่ผิด: อ่านค่า baseReferral (จาก DB) หรือ base (จากค่า Default)
    const bonusPoints = campaign?.baseReferral || campaign?.base || getConfig('standardReferralPoints') || 50; 
    
    const daysToExtend = getConfig('expiryDaysReferralBonus') || 7;
    const limitDays = getConfig('expiryDaysLimitMax') || 60;

    // 1. ดึงข้อมูลผู้แนะนำ
    const referrer = await prisma.customer.findUnique({ where: { customerId: referrerId } });
    if (!referrer) return;

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // 2. ตรรกะการต่ออายุ
    const baseDate = referrer.expiryDate > today ? referrer.expiryDate : today;
    const proposedExpiry = addDays(baseDate, daysToExtend);
    const limitDate = addDays(today, limitDays); 
    const finalExpiryDate = proposedExpiry > limitDate ? limitDate : proposedExpiry;

    // 3. อัปเดต DB
    await prisma.customer.update({
        where: { customerId: referrerId },
        data: {
            points: { increment: bonusPoints },
            expiryDate: finalExpiryDate,
            referralCount: { increment: 1 },
            // ใช้ campaignName หรือ name แล้วแต่ว่ามาจาก DB หรือ Default
            activeCampaignTag: campaign?.campaignName || campaign?.name || null 
        }
    });

    // 4. ส่ง Notification
    const newPoints = referrer.points + bonusPoints;
    const notificationMessage = `💌 ขอบคุณที่แนะนำเพื่อน!\n⭐️ คุณได้รับแต้มโบนัส ${bonusPoints} แต้ม จากการแนะนำคุณ ${newCustomerId}\n💰 แต้มสะสมปัจจุบัน: ${newPoints} แต้ม`;
    
    if (referrer.telegramUserId) {
        await sendNotificationToCustomer(referrer.telegramUserId, notificationMessage);
    }
}