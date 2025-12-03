import express from 'express';
import crypto from 'crypto';
import { prisma } from '../db.js';
import { getActiveCampaign } from '../services/campaign.service.js';
import { getConfig } from '../config/config.js';
import { addDays } from '../utils/date.utils.js';
// ❌ เอา createCustomer ออกตามที่ขอ (ห้ามสมัครเอง)
import { getCustomerByTelegramId, updateCustomer } from '../services/customer.service.js'; 

const router = express.Router();

// ... (Helper function: verifyTelegramWebAppData เหมือนเดิม) ...
function verifyTelegramWebAppData(telegramInitData) {
    if (!telegramInitData) return false;
    const encoded = decodeURIComponent(telegramInitData);
    const arr = encoded.split('&');
    const hashIndex = arr.findIndex(str => str.startsWith('hash='));
    if (hashIndex === -1) return false;
    const hash = arr.splice(hashIndex, 1)[0].split('=')[1];
    arr.sort((a, b) => a.localeCompare(b));
    const dataCheckString = arr.join('\n');
    const token = getConfig('customerBotToken'); 
    const secret = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
    const _hash = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');
    return _hash === hash;
}

// ==================================================
// 🚪 LOGIN / AUTH (ปรับปรุงใหม่: ห้ามสมัครเอง)
// ==================================================
router.post('/auth', async (req, res) => {
    try {
        const { initData } = req.body;

        // 1. Verify (Production ควรเปิดใช้)
        const isValid = verifyTelegramWebAppData(initData);
        if (!isValid) console.warn("⚠️ Invalid InitData Signature");

        // 2. แกะข้อมูล
        const urlParams = new URLSearchParams(initData);
        const userJson = urlParams.get('user');
        if (!userJson) return res.status(400).json({ error: "User data missing" });

        const userData = JSON.parse(userJson);
        console.log(`👤 Login Request: ${userData.first_name} (${userData.id})`);

        // 3. ค้นหาลูกค้า
        let customer = await getCustomerByTelegramId(userData.id.toString());
        
        if (!customer) {
            // 🛑 ถ้าไม่เจอ -> ไม่สร้างใหม่ แต่ส่งสถานะ isMember: false
            // หน้าบ้านจะรับค่านี้ไปเปิดหน้า "บังคับเชื่อมบัญชี"
            console.log("⛔️ User not found (Registration Restricted)");
            return res.json({ 
                success: true, 
                isMember: false, 
                telegramId: userData.id.toString() 
            });
        } else {
             // ✅ ถ้าเจอ -> อัปเดตชื่อและส่งข้อมูลกลับ (เข้า Dashboard ได้)
             await updateCustomer(customer.customerId, {
                firstName: userData.first_name,
                lastName: userData.last_name || '',
                username: userData.username || ''
            });
            return res.json({ success: true, isMember: true, customer });
        }

    } catch (error) {
        console.error("Auth Error:", error);
        res.status(500).json({ error: 'Auth failed: ' + error.message });
    }
});

// ==================================================
// 👤 ส่วนที่ 3: ดึงข้อมูลลูกค้า (Dashboard Data)
// ==================================================
router.get('/user/:telegramId', async (req, res) => {
    const { telegramId } = req.params;

    try {
        const customer = await prisma.customer.findUnique({
            where: { telegramUserId: telegramId, isDeleted: false }
        });

        if (!customer) {
            return res.status(404).json({ linked: false, message: "User not linked" });
        }

        const campaign = await getActiveCampaign();
        const target = campaign?.milestoneTarget || 0;
        let progress = null;

        if (target > 0) {
            const current = customer.referralCount % target;
            progress = {
                name: campaign.campaignName || campaign.name,
                current: current,
                target: target,
                remaining: target - current,
                bonus: campaign.milestoneBonus
            };
        }

        res.json({
            linked: true,
            customerId: customer.customerId,
            points: customer.points,
            expiryDate: customer.expiryDate,
            referralCount: customer.referralCount,
            campaignProgress: progress
        });

    } catch (error) {
        console.error("User API Error:", error);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

// ==================================================
// 🎁 ส่วนที่ 4: ดึงรายการของรางวัล (Reward List)
// ==================================================
router.get('/rewards', async (req, res) => {
    try {
        const rewards = await prisma.reward.findMany({
            where: { isDeleted: false },
            orderBy: { points: 'asc' }
        });
        res.json(rewards);
    } catch (error) {
        res.status(500).json({ error: "Internal Server Error" });
    }
});

// ==================================================
// 🔗 ส่วนที่ 5: เชื่อมต่อบัญชี (Link Account)
// ==================================================
router.post('/link', async (req, res) => {
    const { telegramId, customerId, verificationCode } = req.body;

    if (!telegramId || !customerId || !verificationCode) {
        return res.status(400).json({ error: "ข้อมูลไม่ครบถ้วน" });
    }

    try {
        const searchId = customerId.toUpperCase();
        const existingLink = await prisma.customer.findUnique({ where: { telegramUserId: telegramId } });
        if (existingLink) return res.status(400).json({ error: "Telegram นี้เชื่อมบัญชีไปแล้ว" });

        const customer = await prisma.customer.findUnique({ where: { customerId: searchId, isDeleted: false } });
        if (!customer) return res.status(404).json({ error: "ไม่พบรหัสสมาชิกนี้" });
        if (customer.telegramUserId) return res.status(400).json({ error: "รหัสสมาชิกนี้ถูกเชื่อมไปแล้ว" });

        if (customer.verificationCode && String(customer.verificationCode) !== String(verificationCode)) {
            return res.status(400).json({ error: "รหัสยืนยันไม่ถูกต้อง" });
        }

        const campaign = await getActiveCampaign();
        const bonusPoints = campaign?.linkBonus || parseInt(getConfig('standardLinkBonus')) || 50;
        const daysToExtend = parseInt(getConfig('expiryDaysLinkAccount')) || 7;

        const currentExpiry = customer.expiryDate ? new Date(customer.expiryDate) : new Date();
        const today = new Date(); today.setHours(0,0,0,0);
        const baseDate = currentExpiry > today ? currentExpiry : today;
        const newExpiryDate = addDays(baseDate, daysToExtend);

        await prisma.customer.update({
            where: { customerId: searchId },
            data: {
                telegramUserId: telegramId,
                points: { increment: bonusPoints },
                expiryDate: newExpiryDate,
                verificationCode: null
            }
        });

        await prisma.customerLog.create({
            data: {
                telegramUserId: telegramId,
                customerId: searchId,
                action: "LINK_ACCOUNT_API",
                pointsChange: bonusPoints
            }
        });

        res.json({ 
            success: true, 
            message: "เชื่อมต่อสำเร็จ", 
            points: customer.points + bonusPoints,
            bonus: bonusPoints 
        });

    } catch (error) {
        console.error("Link API Error:", error);
        res.status(500).json({ error: "เกิดข้อผิดพลาดในการเชื่อมต่อ" });
    }
});

// ==================================================
// 📜 ส่วนที่ 6: ดึงประวัติการได้แต้ม (History)
// ==================================================
router.get('/history/:telegramId', async (req, res) => {
    try {
        const { telegramId } = req.params;
        
        // ดึงข้อมูล 20 รายการล่าสุด
        const logs = await prisma.customerLog.findMany({
            where: { telegramUserId: telegramId },
            orderBy: { createdAt: 'desc' },
            take: 20,
            select: {
                action: true,
                pointsChange: true,
                createdAt: true
            }
        });

        // จัด Format วันที่และ Action ให้สวยงามก่อนส่งกลับ
        const formattedLogs = logs.map(log => ({
            action: mapActionName(log.action), // แปลงชื่อ Action เป็นภาษาไทย
            points: log.pointsChange > 0 ? `+${log.pointsChange}` : `${log.pointsChange}`,
            date: new Date(log.createdAt).toLocaleDateString('th-TH', {
                day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'
            }),
            isPositive: log.pointsChange > 0
        }));

        res.json({ success: true, logs: formattedLogs });

    } catch (error) {
        console.error("History API Error:", error);
        res.status(500).json({ error: "ดึงข้อมูลประวัติไม่สำเร็จ" });
    }
});

// ฟังก์ชันช่วยแปลชื่อ Action (ใส่ไว้ในไฟล์เดียวกันหรือแยก Utils ก็ได้)
function mapActionName(action) {
    const map = {
        'LINK_ACCOUNT_API': 'เชื่อมบัญชีสมาชิก',
        'LINK_BONUS': 'โบนัสเชื่อมบัญชี',
        'REFERRAL_BONUS': 'แนะนำเพื่อน',
        'ADMIN_ADD_POINTS': 'Admin เติมแต้มให้',   // ✅ เพิ่ม
        'ADMIN_REDEEM': 'แลกของรางวัล (หน้าร้าน)', // ✅ เพิ่ม
        'ADMIN_ADJUST': 'Admin ปรับปรุงยอด'
    };
    return map[action] || action;
}

// --------------------------------------------------
// 👥 ส่วนที่ 7: ดึงข้อมูลเครือข่ายเพื่อน (Referral Network)
// --------------------------------------------------
router.get('/referrals/:telegramId', async (req, res) => {
    try {
        const { telegramId } = req.params;

        // 1. หาข้อมูลของตัว User เองก่อน เพื่อเอา ID
        const user = await prisma.customer.findUnique({
            where: { telegramUserId: telegramId },
            select: { customerId: true }
        });

        if (!user) return res.json({ success: false, message: "User not found" });

        // 2. ค้นหา "ลูกข่าย" (คนที่ User นี้เป็นคนแนะนำ)
        const referrals = await prisma.customer.findMany({
            where: { referrerId: user.customerId },
            orderBy: { createdAt: 'desc' }, // เรียงตามวันที่ล่าสุด
            select: {
                customerId: true,
                firstName: true,
                lastName: true,
                createdAt: true,     // วันที่สมัคร
                referralCount: true, // ⭐ ทีเด็ด! ดูว่าเขาไปชวนต่ออีกกี่คน
                points: true         // ดูแต้มปัจจุบันของเขา (เผื่ออยากโชว์ความเทพ)
            }
        });

        // 3. จัด Format ข้อมูลให้สวยงามก่อนส่งกลับ
        const formattedList = referrals.map(ref => ({
            name: `${ref.firstName || 'Guest'} ${ref.lastName || ''}`.trim() || ref.customerId,
            id: ref.customerId,
            joinedAt: new Date(ref.createdAt).toLocaleDateString('th-TH', {
                day: 'numeric', month: 'short', year: '2-digit',
                hour: '2-digit', minute: '2-digit'
            }),
            tier2Count: ref.referralCount, // จำนวนคนที่เขาไปชวนต่อ
            earned: 50 // (สมมติว่าได้ 50 แต้มต่อหัว หรือจะดึงจาก Config ก็ได้)
        }));

        res.json({ success: true, count: referrals.length, data: formattedList });

    } catch (error) {
        console.error("Referral API Error:", error);
        res.status(500).json({ error: "ดึงข้อมูลเพื่อนไม่สำเร็จ" });
    }
});

export default router;