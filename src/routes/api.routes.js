import express from 'express';
import crypto from 'crypto';
import { prisma } from '../db.js';
import { getConfig } from '../config/config.js';
import { getActiveCampaign } from '../services/campaign.service.js';
import { addDays } from '../utils/date.utils.js';
import { getCustomerByTelegramId, createCustomer, updateCustomer } from '../services/customer.service.js';

const router = express.Router();

// ==================================================
// 🔐 ส่วนที่ 1: HELPER FUNCTIONS (ความปลอดภัย)
// ==================================================

// ฟังก์ชันตรวจสอบลายเซ็นจาก Telegram (กันการปลอมตัว)
function verifyTelegramWebAppData(telegramInitData) {
    if (!telegramInitData) return false;

    const encoded = decodeURIComponent(telegramInitData);
    const arr = encoded.split('&');
    const hashIndex = arr.findIndex(str => str.startsWith('hash='));
    
    if (hashIndex === -1) return false;
    
    const hash = arr.splice(hashIndex, 1)[0].split('=')[1];
    
    arr.sort((a, b) => a.localeCompare(b));
    const dataCheckString = arr.join('\n');
    
    const token = getConfig('customerBotToken'); // ใช้ Token ของ Customer Bot
    const secret = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
    const _hash = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');
    
    return _hash === hash;
}

// ==================================================
// 🚪 ส่วนที่ 2: LOGIN / AUTH (ต้องมีเพื่อให้ Mini App ใช้งานได้)
// ==================================================
router.post('/auth', async (req, res) => {
    try {
        const { initData } = req.body;

        // 1. ตรวจสอบความถูกต้อง
        if (!verifyTelegramWebAppData(initData)) {
            return res.status(403).json({ error: 'Invalid authentication data' });
        }

        // 2. แกะข้อมูล User
        const urlParams = new URLSearchParams(initData);
        const userData = JSON.parse(urlParams.get('user'));
        
        console.log(`👤 Login: ${userData.first_name} (${userData.id})`);

        // 3. หาหรือสร้าง User ใหม่
        let customer = await getCustomerByTelegramId(userData.id.toString());
        
        if (!customer) {
            customer = await createCustomer({
                telegramId: userData.id.toString(),
                firstName: userData.first_name,
                lastName: userData.last_name || '',
                username: userData.username || ''
            });
        } else {
             await updateCustomer(customer.id, {
                firstName: userData.first_name,
                lastName: userData.last_name || '',
                username: userData.username || ''
            });
        }

        res.json({ success: true, customer });
    } catch (error) {
        console.error("Auth Error:", error);
        res.status(500).json({ error: 'Auth failed' });
    }
});

// ==================================================
// 👤 ส่วนที่ 3: ดึงข้อมูลลูกค้า (Dashboard Data) - จากโค้ดคุณ
// ==================================================
router.get('/user/:telegramId', async (req, res) => {
    const { telegramId } = req.params;

    try {
        // ค้นหาลูกค้า
        const customer = await prisma.customer.findUnique({
            where: { telegramUserId: telegramId, isDeleted: false }
        });

        if (!customer) {
            return res.status(404).json({ linked: false, message: "User not linked" });
        }

        // คำนวณ Progress Bar แคมเปญ
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
// 🎁 ส่วนที่ 4: ดึงรายการของรางวัล (Reward List) - จากโค้ดคุณ
// ==================================================
router.get('/rewards', async (req, res) => {
    try {
        const rewards = await prisma.reward.findMany({
            where: { isDeleted: false }, // เพิ่มกันพลาด: ไม่เอาของที่ลบแล้ว
            orderBy: { points: 'asc' }
        });
        res.json(rewards);
    } catch (error) {
        res.status(500).json({ error: "Internal Server Error" });
    }
});

// ==================================================
// 🔗 ส่วนที่ 5: เชื่อมต่อบัญชี (Link Account) - จากโค้ดคุณ
// ==================================================
router.post('/link', async (req, res) => {
    const { telegramId, customerId, verificationCode } = req.body;

    if (!telegramId || !customerId || !verificationCode) {
        return res.status(400).json({ error: "ข้อมูลไม่ครบถ้วน" });
    }

    try {
        const searchId = customerId.toUpperCase();

        // เช็คซ้ำ
        const existingLink = await prisma.customer.findUnique({ where: { telegramUserId: telegramId } });
        if (existingLink) return res.status(400).json({ error: "Telegram นี้เชื่อมบัญชีไปแล้ว" });

        // เช็คข้อมูลลูกค้า
        const customer = await prisma.customer.findUnique({ where: { customerId: searchId, isDeleted: false } });
        if (!customer) return res.status(404).json({ error: "ไม่พบรหัสสมาชิกนี้" });
        if (customer.telegramUserId) return res.status(400).json({ error: "รหัสสมาชิกนี้ถูกเชื่อมไปแล้ว" });

        // เช็ครหัสยืนยัน
        if (customer.verificationCode && String(customer.verificationCode) !== String(verificationCode)) {
            return res.status(400).json({ error: "รหัสยืนยันไม่ถูกต้อง" });
        }

        // คำนวณโบนัส
        const campaign = await getActiveCampaign();
        const bonusPoints = campaign?.linkBonus || parseInt(getConfig('standardLinkBonus')) || 50;
        const daysToExtend = parseInt(getConfig('expiryDaysLinkAccount')) || 7;

        const currentExpiry = customer.expiryDate ? new Date(customer.expiryDate) : new Date();
        const today = new Date(); today.setHours(0,0,0,0);
        const baseDate = currentExpiry > today ? currentExpiry : today;
        const newExpiryDate = addDays(baseDate, daysToExtend);

        // อัปเดต DB
        await prisma.customer.update({
            where: { customerId: searchId },
            data: {
                telegramUserId: telegramId,
                points: { increment: bonusPoints },
                expiryDate: newExpiryDate,
                verificationCode: null
            }
        });

        // Log
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

export default router;