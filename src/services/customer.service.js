import { prisma } from '../db.js';
import { getActiveCampaign } from './campaign.service.js';
import { addDays, getThaiNow } from '../utils/date.utils.js';
import { sendNotificationToCustomer } from './notification.service.js';
import { getConfig } from '../config/config.js';

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

// -----------------------------------------------------------------
// 🆕 [เพิ่มใหม่] คำนวณยอด Referral ที่เกิดขึ้นในช่วง Active Campaign
// -----------------------------------------------------------------
export async function countCampaignReferrals(customerId, startDate) {
    if (!startDate) return 0;

    // นับจำนวน Log ที่มีการให้โบนัสการแนะนำเพื่อน (REFERRAL_BONUS)
    // โดยมีเงื่อนไขว่า Log นั้นต้องเกิดขึ้น "หลัง" วันที่แคมเปญเริ่มต้น
    const count = await prisma.customerLog.count({
        where: {
            customerId: customerId,
            action: 'REFERRAL_BONUS',
            createdAt: {
                gte: startDate // ต้องมากกว่าหรือเท่ากับวันเริ่มต้นแคมเปญ
            }
        }
    });
    
    return count;
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

    await prisma.customer.update({
        where: { customerId: referrerId },
        data: {
            points: { increment: bonusPoints },
            expiryDate: finalExpiryDate,
            referralCount: { increment: 1 },
            activeCampaignTag: campaign?.campaignName || campaign?.name || 'Standard'
        }
    });

    if (referrer.telegramUserId) {
        await prisma.customerLog.create({
            data: {
                telegramUserId: referrer.telegramUserId,
                customerId: referrer.customerId,
                action: 'REFERRAL_BONUS',
                pointsChange: bonusPoints // ใช้ตัวแปร bonusPoints ที่คำนวณไว้ด้านบน
            }
        });
    }

    const newPoints = referrer.points + bonusPoints;
    const notificationMessage = `💌 ขอบคุณที่แนะนำเพื่อน!\n⭐️ คุณได้รับแต้มโบนัส ${bonusPoints} แต้ม จากการแนะนำคุณ ${newCustomerId}\n💰 แต้มสะสมปัจจุบัน: ${newPoints} แต้ม`;
    
    if (referrer.telegramUserId) {
        await sendNotificationToCustomer(referrer.telegramUserId, notificationMessage);
    }
}