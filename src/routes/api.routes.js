// src/routes/api.routes.js

import express from 'express';
import { prisma } from '../db.js';
import { getActiveCampaign } from '../services/campaign.service.js';
import { getConfig } from '../config/config.js';
import { addDays } from '../utils/date.utils.js';

const router = express.Router();

// ==================================================
// 1. 👤 ดึงข้อมูลลูกค้า (Dashboard Data)
// ==================================================
router.get('/user/:telegramId', async (req, res) => {
    const { telegramId } = req.params;

    try {
        // ค้นหาลูกค้าจาก Telegram ID
        const customer = await prisma.customer.findUnique({
            where: { telegramUserId: telegramId, isDeleted: false }
        });

        if (!customer) {
            return res.status(404).json({ 
                linked: false, 
                message: "User not linked" 
            });
        }

        // ดึงข้อมูลแคมเปญเพื่อคำนวณ Progress Bar
        const campaign = await getActiveCampaign();
        const target = campaign.milestoneTarget || 0;
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

        // ส่งข้อมูลกลับไปให้ Mini App
        res.json({
            linked: true,
            customerId: customer.customerId,
            points: customer.points,
            expiryDate: customer.expiryDate,
            referralCount: customer.referralCount,
            campaignProgress: progress
        });

    } catch (error) {
        console.error("API Error:", error);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

// ==================================================
// 2. 🎁 ดึงรายการของรางวัล (Reward List)
// ==================================================
router.get('/rewards', async (req, res) => {
    try {
        const rewards = await prisma.reward.findMany({
            orderBy: { points: 'asc' } // เรียงตามแต้มจากน้อยไปมาก
        });
        res.json(rewards);
    } catch (error) {
        res.status(500).json({ error: "Internal Server Error" });
    }
});

// ==================================================
// 3. 🔗 เชื่อมต่อบัญชี (Link Account) - API Version
// ==================================================
router.post('/link', async (req, res) => {
    const { telegramId, customerId, verificationCode } = req.body;

    if (!telegramId || !customerId || !verificationCode) {
        return res.status(400).json({ error: "ข้อมูลไม่ครบถ้วน" });
    }

    try {
        const searchId = customerId.toUpperCase();

        // เช็คซ้ำ: บัญชีนี้เชื่อมไปแล้วหรือยัง?
        const existingLink = await prisma.customer.findUnique({ where: { telegramUserId: telegramId } });
        if (existingLink) {
            return res.status(400).json({ error: "Telegram นี้เชื่อมบัญชีไปแล้ว" });
        }

        // เช็คข้อมูลลูกค้า
        const customer = await prisma.customer.findUnique({ where: { customerId: searchId, isDeleted: false } });
        if (!customer) return res.status(404).json({ error: "ไม่พบรหัสสมาชิกนี้" });
        if (customer.telegramUserId) return res.status(400).json({ error: "รหัสสมาชิกนี้ถูกเชื่อมไปแล้ว" });

        // เช็ครหัสยืนยัน
        if (customer.verificationCode && String(customer.verificationCode) !== String(verificationCode)) {
            return res.status(400).json({ error: "รหัสยืนยันไม่ถูกต้อง" });
        }

        // --- ตรรกะให้แต้ม (เหมือนใน Bot) ---
        const campaign = await getActiveCampaign();
        const bonusPoints = campaign?.linkBonus || parseInt(getConfig('standardLinkBonus')) || 50;
        const daysToExtend = parseInt(getConfig('expiryDaysLinkAccount')) || 7;

        const currentExpiry = customer.expiryDate;
        const today = new Date(); today.setHours(0,0,0,0);
        const baseDate = currentExpiry > today ? currentExpiry : today;
        const newExpiryDate = addDays(baseDate, daysToExtend);

        // อัปเดต
        await prisma.customer.update({
            where: { customerId: searchId },
            data: {
                telegramUserId: telegramId,
                points: { increment: bonusPoints },
                expiryDate: newExpiryDate,
                verificationCode: null
            }
        });

        // บันทึก Log (CustomerLog)
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