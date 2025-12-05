import express from 'express';
import crypto from 'crypto';
import { prisma } from '../db.js';
import { getActiveCampaign } from '../services/campaign.service.js';
import { getConfig } from '../config/config.js';
import { addDays, formatToBangkok } from '../utils/date.utils.js';
import { getCustomerByTelegramId, updateCustomer, countCampaignReferralsByTag } from '../services/customer.service.js';
import { countMonthlyReferrals } from '../services/referral.service.js';

const router = express.Router();

// ✅ Debug Log: เช็คว่าไฟล์นี้ถูกโหลดจริงไหม
console.log("✅ API Routes loaded successfully");

// ... (Helper function: verifyTelegramWebAppData) ...
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
// 🚪 LOGIN / AUTH
// ==================================================
router.post('/auth', async (req, res) => {
    try {
        const { initData } = req.body;
        if (!verifyTelegramWebAppData(initData)) {
            return res.status(401).json({ error: "Invalid Telegram Data" });
        }

        const urlParams = new URLSearchParams(initData);
        const userDataStr = urlParams.get('user');
        if (!userDataStr) return res.status(400).json({ error: "User data missing" });

        const userData = JSON.parse(userDataStr);
        const telegramId = userData.id.toString();

        let customer = await getCustomerByTelegramId(telegramId);
        
        if (!customer) {
            return res.json({ success: true, isMember: false });
        }

        // Update Info
        if (customer.firstName !== userData.first_name || customer.lastName !== userData.last_name || customer.username !== userData.username) {
             await updateCustomer(customer.customerId, {
                firstName: userData.first_name,
                lastName: userData.last_name || '',
                username: userData.username || ''
             });
             customer.firstName = userData.first_name;
             customer.lastName = userData.last_name;
             customer.username = userData.username;
        }

        // Campaign Logic
        let campaignReferralCount = 0;
        let referralTarget = 0;
        let activeCampaignTag = 'Standard';
        let milestoneBonus = 0; 
        let totalReferrals = 0; 
        let referralCountMonth = 0;
        let campaignStartAt = null;
        let campaignEndAt = null;
        let referralBasePoints = parseInt(getConfig('standardReferralPoints')) || 50;

        try {
            totalReferrals = await prisma.customer.count({ where: { referrerId: customer.customerId } });
            referralCountMonth = await countMonthlyReferrals(customer.customerId);
            const campaign = await getActiveCampaign();
            
            if (campaign) {
                 referralBasePoints = campaign.baseReferral || campaign.base || referralBasePoints;
            }

            if (campaign && campaign.startDate) { // แก้ startAt -> startDate ตาม Schema
                activeCampaignTag = campaign.name || 'Active';
                referralTarget = campaign.milestoneTarget;
                milestoneBonus = campaign.milestoneBonus;
                campaignStartAt = campaign.startDate;
                campaignEndAt = campaign.endDate;
                campaignReferralCount = await countCampaignReferralsByTag(customer.customerId, activeCampaignTag);
            }
        } catch (campaignError) {
            console.error("⚠️ Failed to load/calculate campaign data:", campaignError.message);
        }

        const customerDataForFrontend = {
            ...customer,
            referralCount: customer.referralCount,
            totalReferrals: totalReferrals,
            referralCountMonth: referralCountMonth,
            campaignReferralCount: campaignReferralCount,
            referralTarget: referralTarget,
            milestoneBonus: milestoneBonus, 
            activeCampaignTag: activeCampaignTag,
            campaignStartAt: campaignStartAt,
            campaignEndAt: campaignEndAt,
            referralBasePoints: referralBasePoints
        };

        return res.json({ success: true, isMember: true, customer: customerDataForFrontend });

    } catch (error) {
        console.error("Auth Error:", error);
        res.status(500).json({ error: 'Auth failed: ' + error.message });
    }
});

// ==================================================
// 👤 USER DATA
// ==================================================
router.get('/user/:telegramId', async (req, res) => {
    const { telegramId } = req.params;
    try {
        const customer = await prisma.customer.findUnique({
            where: { telegramUserId: telegramId, isDeleted: false }
        });

        if (!customer) return res.status(404).json({ linked: false, message: "User not linked" });

        const campaign = await getActiveCampaign();
        const target = campaign?.milestoneTarget || 0;
        const totalReferrals = await prisma.customer.count({ where: { referrerId: customer.customerId } });

        let progress = null;
        if (target > 0) {
            const current = customer.referralCount % target;
            progress = {
                name: campaign.name,
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
            totalReferrals: totalReferrals,
            campaignProgress: progress
        });

    } catch (error) {
        console.error("User API Error:", error);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

// ==================================================
// 🎁 REWARDS
// ==================================================
router.get('/rewards', async (req, res) => {
    try {
        const rewards = await prisma.reward.findMany({
            where: { isActive: true }, 
            orderBy: { pointsCost: 'asc' }
        });
        const formattedRewards = rewards.map(r => ({ ...r, points: r.pointsCost }));
        res.json(formattedRewards);
    } catch (error) {
        console.error("Reward API Error:", error);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

// ==================================================
// 🔗 LINK ACCOUNT
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

        // บันทึก Log ลง PointTransaction
        await prisma.pointTransaction.create({
            data: {
                customerId: searchId,
                amount: bonusPoints,
                type: 'LINK_BONUS',
                detail: `Link Account with Telegram ID: ${telegramId}`
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
// ⚠️ VERIFY LOGIN (Fallback for Manual Login)
// ✅ เพิ่มส่วนนี้เพื่อแก้ปัญหา 404 เวลาหน้าเว็บเรียก /api/verify-login
// ==================================================
router.post('/verify-login', async (req, res) => {
    // ใช้ Logic เดียวกับ /link หรือส่งไป /link แทน
    // แต่เพื่อป้องกัน 404 เราต้องมี Route นี้รองรับไว้
    return res.status(400).json({ error: "กรุณาใช้เมนู 'เชื่อมบัญชี' (Link Account) แทนการ Login ปกติ" });
});

// ==================================================
// 📜 HISTORY
// ==================================================
router.get('/history/:telegramId', async (req, res) => {
    try {
        const { telegramId } = req.params;
        const customer = await prisma.customer.findUnique({
            where: { telegramUserId: telegramId }
        });

        if (!customer) return res.json({ success: true, logs: [] });

        const logs = await prisma.pointTransaction.findMany({
            where: { customerId: customer.customerId },
            orderBy: { createdAt: 'desc' },
            take: 20,
            select: {
                type: true,
                amount: true,
                createdAt: true
            }
        });

        const formattedLogs = logs.map(log => ({
            action: mapActionName(log.type),
            points: log.amount > 0 ? `+${log.amount}` : `${log.amount}`,
            date: formatToBangkok(log.createdAt),
            isPositive: log.amount > 0
        }));

        res.json({ success: true, logs: formattedLogs });

    } catch (error) {
        console.error("History API Error:", error);
        res.status(500).json({ error: "ดึงข้อมูลประวัติไม่สำเร็จ" });
    }
});

function mapActionName(action) {
    const map = {
        'REFERRAL_BONUS': 'แนะนำเพื่อน',
        'LINK_BONUS': 'โบนัสผูกบัญชี',
        'LINK_ACCOUNT_API': 'โบนัสผูกบัญชี',
        'REDEEM_REWARD': 'แลกของรางวัล',
        'ADMIN_ADJUST': 'Admin ปรับปรุงยอด',
        'SYSTEM_ADJUST': 'ระบบปรับปรุงยอด',
        'CAMPAIGN_BONUS': 'โบนัสแคมเปญ',
        'ADMIN_ADD_POINTS': 'Admin เติมแต้ม',
        'OTHER': 'อื่นๆ'
    };
    return map[action] || action;
}

// ==================================================
// 👥 REFERRALS
// ==================================================
router.get('/referrals/:telegramId', async (req, res) => {
    console.log("==================== DEBUG: /api/referrals ====================");
    try {
        const { telegramId } = req.params;
        console.log(`[1] Received request for telegramId: ${telegramId}`);

        const user = await prisma.customer.findUnique({
            where: { telegramUserId: telegramId },
            select: { customerId: true }
        });

        if (!user) {
            console.log(`[2] ❌ User not found in DB with telegramId: ${telegramId}`);
            console.log("=============================================================");
            return res.json({ success: false, message: "User not found" });
        }

        console.log(`[2] ✅ Found user. CustomerID is: ${user.customerId}`);

        const referrals = await prisma.customer.findMany({
            where: { referrerId: user.customerId },
            orderBy: { joinDate: 'desc' },
            select: {
                customerId: true,
                firstName: true,
                lastName: true,
                joinDate: true,
                referralCount: true,
                activeCampaignTag: true
            }
        });

        console.log(`[3] Found ${referrals.length} referrals for customerId: ${user.customerId}`);

        const formattedList = await Promise.all(referrals.map(async (ref) => {
            const bonusLog = await prisma.pointTransaction.findFirst({
                where: {
                    customerId: user.customerId,
                    type: 'REFERRAL_BONUS',
                    // Use ref.joinDate for date comparison
                    createdAt: {
                        gte: new Date(ref.joinDate.getTime() - 86400000), 
                        lte: new Date(ref.joinDate.getTime() + 86400000)
                    },
                    detail: {
                        contains: ref.customerId // Link bonus log to specific referred customer
                    }
                },
                orderBy: { createdAt: 'desc' }
            });

            const tier2Count = await prisma.customer.count({
                 where: { referrerId: ref.customerId }
            });

            return {
                name: `${ref.firstName || 'Guest'} ${ref.lastName || ''}`.trim() || ref.customerId,
                id: ref.customerId,
                joinedAt: formatToBangkok(ref.joinDate), // Use ref.joinDate
                earnedAt: bonusLog ? formatToBangkok(bonusLog.createdAt) : '-',
                tier2Count: tier2Count,
                earned: bonusLog ? bonusLog.amount : 0,
                campaign: ref.activeCampaignTag || 'Standard'
            };
        }));
        
        console.log(`[4] Successfully formatted list of ${formattedList.length} items. Sending response.`);
        console.log("=============================================================");
        res.json({ success: true, count: referrals.length, data: formattedList });

    } catch (error) {
        console.error("🚨 Referral API Error:", error);
        console.log("=============================================================");
        res.status(500).json({ error: "ดึงข้อมูลการแนะนำไม่สำเร็จ" });
    }
});

export default router;