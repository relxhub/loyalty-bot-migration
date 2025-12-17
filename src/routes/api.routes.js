import express from 'express';
import crypto from 'crypto';
import { prisma } from '../db.js';
import { getActiveCampaign } from '../services/campaign.service.js';
import { getConfig } from '../config/config.js';
import { addDays, formatToBangkok } from '../utils/date.utils.js';
import { getCustomerByTelegramId, updateCustomer, countCampaignReferralsByTag } from '../services/customer.service.js';
import { countMonthlyReferrals } from '../services/referral.service.js';
import * as referralService from '../services/referral.service.js';
// No longer import orderBotToken directly here due to module issues.

const router = express.Router();

console.log("✅ API Routes loaded successfully");

// Helper function to get token for verification, directly from process.env
// This ensures it works even if module imports are tricky on Railway
function getVerificationToken() {
    const token = process.env.ORDER_BOT_TOKEN;
    if (!token) {
        console.error("FATAL: ORDER_BOT_TOKEN is missing when trying to verify Telegram Web App data. Please set it in Railway env vars.");
    }
    return token;
}

// Modify verifyTelegramWebAppData to take token internally from getVerificationToken
function verifyTelegramWebAppData(telegramInitData) {
    if (!telegramInitData) {
        console.error("Error: telegramInitData is missing.");
        return false;
    }
    const encoded = decodeURIComponent(telegramInitData);
    const arr = encoded.split('&');
    const hashIndex = arr.findIndex(str => str.startsWith('hash='));
    if (hashIndex === -1) {
        console.error("Error: Hash parameter not found in initData.");
        return false;
    }
    const hash = arr.splice(hashIndex, 1)[0].split('=')[1];
    arr.sort((a, b) => a.localeCompare(b));
    const dataCheckString = arr.join('\n');

    const token = getVerificationToken(); // Get token internally
    console.log('DEBUG: ORDER_BOT_TOKEN direct access in verifyTelegramWebAppData (inside function):', token ? '✅ FOUND' : '❌ MISSING');

    if (!token) {
        console.error("FATAL: ORDER_BOT_TOKEN is missing. Cannot verify Telegram Web App data. (Inside verifyTelegramWebAppData)");
        return false;
    }

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
             // Update customer object in memory for current request
             customer.firstName = userData.first_name;
             customer.lastName = userData.last_name;
             customer.username = userData.username;
        }

        // Campaign Logic (Restored with full details)
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
                 referralBasePoints = campaign.baseReferral || campaign.base || referralBasePoints; // Fallback for old schema
            }

            if (campaign && campaign.startDate) { // Use campaign.startDate based on schema
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

        // Check for pending referral status
        const pendingReferral = await prisma.referral.findFirst({
            where: {
                refereeId: customer.customerId,
                status: 'PENDING_PURCHASE'
            }
        });

        const customerDataForFrontend = {
            ...customer,
            referralCount: customer.referralCount, // Ensure this is from DB
            totalReferrals: totalReferrals,
            referralCountMonth: referralCountMonth,
            campaignReferralCount: campaignReferralCount,
            referralTarget: referralTarget,
            milestoneBonus: milestoneBonus, 
            activeCampaignTag: activeCampaignTag,
            campaignStartAt: campaignStartAt,
            campaignEndAt: campaignEndAt,
            referralBasePoints: referralBasePoints,
            isPendingReferral: !!pendingReferral, // Add this flag
            orderBotUsername: getConfig('orderBotUsername', 'Onehub_bot') // Add bot username
        };

        return res.json({ success: true, isMember: true, customer: customerDataForFrontend });

    } catch (error) {
        console.error("Auth Error:", error);
        res.status(500).json({ error: 'Auth failed: ' + error.message });
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
// 🎁 REWARDS
// ==================================================
router.get('/rewards', async (req, res) => {
    try {
        const rewards = await prisma.reward.findMany({
            where: { isActive: true }, 
            orderBy: { pointsCost: 'asc' }
        });
        // Frontend expects 'points' field instead of 'pointsCost'
        const formattedRewards = rewards.map(r => ({ ...r, points: r.pointsCost }));
        res.json(formattedRewards);
    } catch (error) {
        console.error("Reward API Error:", error);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

// ==================================================
// 📜 HISTORY
// ==================================================
function mapActionName(action) {
    const map = {
        'REFERRAL_BONUS': 'แนะนำเพื่อน',
        'LINK_BONUS': 'โบนัสผูกบัญชี',
        'ADMIN_ADJUST': 'Admin ปรับปรุงยอด',
        'SYSTEM_ADJUST': 'ระบบปรับปรุงยอด',
        'CAMPAIGN_BONUS': 'โบนัสแคมเปญ',
        'REDEEM_REWARD': 'แลกของรางวัล',
        'OTHER': 'อื่นๆ'
    };
    return map[action] || action;
}

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
                createdAt: true,
                detail: true // Ensure detail is selected for mapping
            }
        });

        const formattedLogs = logs.map(log => ({
            action: mapActionName(log.type),
            points: log.amount > 0 ? `+${log.amount}` : `${log.amount}`,
            date: formatToBangkok(log.createdAt),
            isPositive: log.amount > 0,
            detail: log.detail // Include detail for richer display if needed
        }));

        res.json({ success: true, logs: formattedLogs });

    } catch (error) {
        console.error("History API Error:", error);
        res.status(500).json({ error: "ดึงข้อมูลประวัติไม่สำเร็จ" });
    }
});

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

        // Fetch referral records from the new Referral table
        const referrals = await prisma.referral.findMany({
            where: { referrerId: user.customerId },
            orderBy: { createdAt: 'desc' }, // Order by when the referral was created (link clicked)
            include: {
                referee: { // Include the actual customer data for the referred person
                    select: {
                        customerId: true,
                        firstName: true,
                        lastName: true,
                        joinDate: true,
                        referralCount: true, // This is referrer's referralCount
                        activeCampaignTag: true
                    }
                }
            }
        });

        console.log(`[3] Found ${referrals.length} referral records for customerId: ${user.customerId}`);

        const formattedList = await Promise.all(referrals.map(async (ref) => {
            const referee = ref.referee; // The customer who was referred

            // --- New Tier-2 Logic (remains mostly same, queries customer table for referee's referrals) ---
            let tier2Referrals = [];
            const tier2Count = await prisma.customer.count({ where: { referrerId: referee.customerId } });

            if (tier2Count > 0) {
                const tier2Customers = await prisma.customer.findMany({
                    where: { referrerId: referee.customerId },
                    orderBy: { joinDate: 'desc' },
                    select: {
                        customerId: true,
                        firstName: true,
                        lastName: true,
                        joinDate: true
                    },
                    take: 10 // Limit to 10 for performance
                });

                tier2Referrals = tier2Customers.map(t2 => {
                    const id = t2.customerId;
                    const maskedId = id.length > 4 ? `${id.substring(0, 2)}****${id.substring(id.length - 2)}` : id;
                    return {
                        id: maskedId,
                        name: `${t2.firstName || ''} ${t2.lastName || ''}`.trim() || 'Guest',
                        joinDate: formatToBangkok(t2.joinDate)
                    };
                });
            }
            // --- End New Logic ---

            return {
                name: `${referee.firstName || 'Guest'} ${referee.lastName || ''}`.trim() || referee.customerId,
                id: referee.customerId,
                joinedAt: formatToBangkok(referee.joinDate), // Use referee's joinDate
                earnedAt: ref.status === 'COMPLETED' ? formatToBangkok(ref.completedAt) : '-',
                tier2Count: tier2Count,
                earned: ref.status === 'COMPLETED' ? ref.bonusAwarded : 0, // Use bonusAwarded from Referral table
                status: ref.status, // Add referral status
                campaign: referee.activeCampaignTag || 'Standard', // Use referee's campaign tag
                tier2Referrals: tier2Referrals // Add the new array
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