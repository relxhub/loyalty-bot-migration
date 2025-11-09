// src/services/customer.service.js

import { prisma } from '../db.js';
import { getActiveCampaign } from './campaign.service.js';
import { addDays } from '../utils/date.utils.js';
import { sendNotificationToCustomer } from './notification.service.js'; 

export async function giveReferralBonus(referrerId, newCustomerId, adminUser) {
    const campaign = await getActiveCampaign();
    const bonusPoints = campaign?.base || 50; 
    const daysToExtend = 7; // ดึงจาก SystemConfig: expiryDaysReferralBonus
    const limitDays = 60; // ดึงจาก SystemConfig: expiryDaysLimitMax

    // 1. ดึงข้อมูลผู้แนะนำ
    const referrer = await prisma.customer.findUnique({ where: { customerId: referrerId } });
    if (!referrer) return;

    const today = addDays(new Date(), 0); // วันนี้ 00:00:00

    // 2. ตรรกะการต่ออายุที่ถูกต้อง (MAX(วันหมดอายุเดิม, วันนี้) + 7 วัน)
    const baseDate = referrer.expiryDate > today ? referrer.expiryDate : today;
    const proposedExpiry = addDays(baseDate, daysToExtend);
    
    // 3. กำหนดเพดานสูงสุด 60 วัน
    const limitDate = addDays(today, limitDays); 
    const finalExpiryDate = proposedExpiry > limitDate ? limitDate : proposedExpiry;

    // 4. อัปเดต DB และบันทึก Log (ใช้ $transaction ถ้ามีการอัปเดตหลายตารางพร้อมกัน)
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
    const notificationMessage = `💌 ขอบคุณที่แนะนำเพื่อน!\n⭐️ คุณได้รับแต้มโบนัส ${bonusPoints} แต้ม\n💰 แต้มสะสมปัจจุบัน: ${newPoints} แต้ม`;
    sendNotificationToCustomer(referrer.telegramUserId, notificationMessage);
}