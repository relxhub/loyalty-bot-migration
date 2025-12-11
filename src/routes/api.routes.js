import express from 'express';
import crypto from 'crypto';
import { prisma } from '../db.js';
import { getActiveCampaign } from '../services/campaign.service.js';
import { getConfig } from '../config/config.js';
import { addDays, formatToBangkok } from '../utils/date.utils.js';
import { getCustomerByTelegramId, updateCustomer, countCampaignReferralsByTag } from '../services/customer.service.js';
import { countMonthlyReferrals } from '../services/referral.service.js';
import * as referralService from '../services/referral.service.js';
import { orderBotToken } from '../../app.js'; // Import orderBotToken directly

const router = express.Router();

console.log("✅ API Routes loaded successfully");

// Modify verifyTelegramWebAppData to accept token as argument
function verifyTelegramWebAppData(telegramInitData, token) {
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
    
    // Use the token passed as argument
    console.log('DEBUG: ORDER_BOT_TOKEN received in verifyTelegramWebAppData:', token ? '✅ FOUND' : '❌ MISSING'); // <<< Log to verify token received

    if (!token) {
        console.error("FATAL: ORDER_BOT_TOKEN is missing. Cannot verify Telegram Web App data.");
        return false; // Return false to indicate authentication failure
    }

    const secret = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
    const _hash = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');

    // Return the result of the comparison
    return _hash === hash;
}

// ==================================================
// 🚪 LOGIN / AUTH
// ==================================================
router.post('/auth', async (req, res) => {
    try {
        const { initData } = req.body;
        // Pass the orderBotToken to the verification function
        if (!verifyTelegramWebAppData(initData, orderBotToken)) { // <-- Pass orderBotToken here
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

        if (customer.firstName !== userData.first_name || customer.lastName !== userData.last_name || customer.username !== userData.username) {
             await updateCustomer(customer.customerId, {
                firstName: userData.first_name,
                lastName: userData.last_name || '',
                username: userData.username || ''
             });
        }

        // ... (rest of the auth logic remains the same)
        const campaign = await getActiveCampaign();
        const totalReferrals = await prisma.customer.count({ where: { referrerId: customer.customerId } });
        const referralCountMonth = await countMonthlyReferrals(customer.customerId);
        
        const customerDataForFrontend = {
            ...customer,
            totalReferrals,
            referralCountMonth,
            // (add other necessary campaign data here)
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

// ... (Other routes like /rewards, /history, /referrals should be kept as they are)

router.get('/rewards', async (req, res) => {
    try {
        const rewards = await prisma.reward.findMany({
            where: { isActive: true }, 
            orderBy: { pointsCost: 'asc' }
        });
        res.json(rewards);
    } catch (error) {
        res.status(500).json({ error: "Internal Server Error" });
    }
});

router.get('/history/:telegramId', async (req, res) => {
    const { telegramId } = req.params;
    const customer = await prisma.customer.findUnique({ where: { telegramUserId: telegramId } });
    if (!customer) return res.json([]);

    const logs = await prisma.pointTransaction.findMany({
        where: { customerId: customer.customerId },
        orderBy: { createdAt: 'desc' },
        take: 20
    });
    res.json(logs);
});

router.get('/referrals/:telegramId', async (req, res) => {
    const { telegramId } = req.params;
    const user = await prisma.customer.findUnique({
        where: { telegramUserId: telegramId },
        select: { customerId: true }
    });
    if (!user) return res.json([]);

    const referrals = await prisma.customer.findMany({
        where: { referrerId: user.customerId },
        orderBy: { joinDate: 'desc' }
    });
    res.json(referrals);
});


export default router;