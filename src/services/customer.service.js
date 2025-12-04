import { prisma } from '../db.js';
import { getActiveCampaign } from './campaign.service.js';
import { addDays, getThaiNow } from '../utils/date.utils.js';
import { sendNotificationToCustomer } from './notification.service.js';
import { getConfig } from '../config/config.js';

// -----------------------------------------------------------------
// คำนวณยอด Referral ที่เกิดขึ้นในช่วง Active Campaign (เพิ่ม Try-Catch ป้องกันค้าง)
// -----------------------------------------------------------------
export async function countCampaignReferrals(customerId, startDate) {
    if (!startDate) return 0;

    try {
        // Update: Count from Customer table directly for robustness.
        // We count users who list this 'customerId' as their referrer
        // AND were referred during the active campaign period (using 'activeCampaignTag' on the referee).

        const campaign = await getActiveCampaign();
        const currentTagName = campaign?.campaignName || 'Active';

        const count = await prisma.customer.count({
            where: {
                referrerId: customerId,
                activeCampaignTag: currentTagName
            }
        });

        return count;

    } catch (e) {
        console.error("Error counting campaign referrals:", e.message);
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

    // 1. Update Referrer (Points & Total Referral Count)
    await prisma.customer.update({
        where: { customerId: referrerId },
        data: {
            points: { increment: bonusPoints },
            expiryDate: finalExpiryDate,
            referralCount: { increment: 1 }
            // Note: We do NOT update activeCampaignTag on the referrer here,
            // as that field should represent the campaign the user was acquired from, not the one they are promoting.
        }
    });

    // 2. Update Referee (New Customer) with Campaign Tag & Ensure Link
    // This allows us to track which campaign acquired this specific user.
    // Also ensures referrerId is linked, solving the "Ghost Referral" issue.
    await prisma.customer.update({
        where: { customerId: newCustomerId },
        data: {
            referrerId: referrerId, // ✅ Force link to Referrer
            activeCampaignTag: campaign?.campaignName || campaign?.name || 'Standard'
        }
    });

    // 3. Log System (Auto) in AdminLog (Restored as requested)
    await prisma.adminLog.create({
        data: {
            admin: 'System (Auto)',
            action: 'REFERRAL_BONUS',
            customerId: referrer.customerId,
            pointsChange: bonusPoints,
            details: `From ${newCustomerId}.`
        }
    });

    // 4. Customer Log (For Campaign Counting)
    if (referrer.telegramUserId) {
        await prisma.customerLog.create({
            data: {
                telegramUserId: referrer.telegramUserId,
                customerId: referrer.customerId,
                action: 'REFERRAL_BONUS',
                pointsChange: bonusPoints
            }
        });
    }

    const newPoints = referrer.points + bonusPoints;
    const notificationMessage = `💌 ขอบคุณที่แนะนำเพื่อน!\n⭐️ คุณได้รับแต้มโบนัส ${bonusPoints} แต้ม จากการแนะนำคุณ ${newCustomerId}\n💰 แต้มสะสมปัจจุบัน: ${newPoints} แต้ม`;
    
    if (referrer.telegramUserId) {
        await sendNotificationToCustomer(referrer.telegramUserId, notificationMessage);
    }
}