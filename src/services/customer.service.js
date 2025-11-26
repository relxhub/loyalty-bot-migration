// src/services/customer.service.js

import { prisma } from '../db.js';
import { getActiveCampaign } from './campaign.service.js';
import { addDays } from '../utils/date.utils.js';
import { sendNotificationToCustomer } from './notification.service.js'; 
import { getConfig } from '../config/config.js';

/**
 * ฟังก์ชันให้แต้มโบนัสผู้แนะนำ
 */
export async function giveReferralBonus(referrerId, newCustomerId, adminUser) {
    const campaign = await getActiveCampaign();
    // ดึงค่า Config หรือใช้ค่า Default
    const bonusPoints = campaign?.base || getConfig('standardReferralPoints') || 50; 
    const daysToExtend = getConfig('expiryDaysReferralBonus') || 7;
    const limitDays = getConfig('expiryDaysLimitMax') || 60;

    // 1. ดึงข้อมูลผู้แนะนำ
    const referrer = await prisma.customer.findUnique({ where: { customerId: referrerId } });
    if (!referrer) return;

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // 2. ตรรกะการต่ออายุ: MAX(วันหมดอายุเดิม, วันนี้) + 7 วัน
    const baseDate = referrer.expiryDate > today ? referrer.expiryDate : today;
    const proposedExpiry = addDays(baseDate, daysToExtend);
    
    // 3. กำหนดเพดานสูงสุด (ไม่เกิน Limit)
    const limitDate = addDays(today, limitDays); 
    const finalExpiryDate = proposedExpiry > limitDate ? limitDate : proposedExpiry;

    // 4. อัปเดต DB
    await prisma.customer.update({
        where: { customerId: referrerId },
        data: {
            points: { increment: bonusPoints },
            expiryDate: finalExpiryDate,
            referralCount: { increment: 1 },
            activeCampaignTag: campaign?.name || null
        }
    });

    // 5. ส่ง Notification ไปหาผู้แนะนำ (ผ่าน Order Bot)
    const newPoints = referrer.points + bonusPoints;
    const notificationMessage = `💌 ขอบคุณที่แนะนำเพื่อน!\n⭐️ คุณได้รับแต้มโบนัส ${bonusPoints} แต้ม จากการแนะนำคุณ ${newCustomerId}\n💰 แต้มสะสมปัจจุบัน: ${newPoints} แต้ม`;
    
    // ส่งข้อความ (ถ้าผู้แนะนำเชื่อม Telegram ไว้)
    if (referrer.telegramUserId) {
        await sendNotificationToCustomer(referrer.telegramUserId, notificationMessage);
    }
}