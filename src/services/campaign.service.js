// src/services/campaign.service.js (ฉบับถูกต้อง)

import { prisma } from '../db.js';
import { getConfig } from '../config/config.js';

let activeCampaignCache = null;

/**
 * 🔍 ค้นหาแคมเปญที่กำลัง Active อยู่
 * @returns {object | null} Campaign object หรือ null ถ้าไม่มีแคมเปญที่ Active
 */
export async function getActiveCampaign() {
    // 1. ตรวจสอบ Cache ก่อน หากแคมเปญที่อยู่ใน Cache ยังไม่หมดอายุ
    if (activeCampaignCache && activeCampaignCache.endAt > new Date()) {
        return activeCampaignCache;
    }
    
    const now = new Date();
    
    // 2. ค้นหาใน DB: หาแคมเปญที่ 'ตอนนี้' อยู่ระหว่าง startAt และ endAt
    const campaign = await prisma.campaign.findFirst({
        where: {
            startAt: { lte: now }, // ต้องเริ่มแล้ว
            endAt: { gt: now }     // และยังไม่จบ
        },
        // ถ้า Active พร้อมกัน ให้เลือกแคมเปญที่กำหนดให้จบเร็วที่สุด
        orderBy: { endAt: 'asc' } 
    });

    // 3. อัปเดต Cache
    activeCampaignCache = campaign || null;
    
    // 4. หากไม่มีแคมเปญ Active ให้คืนค่ามาตรฐาน (Standard Campaign)
    if (!campaign) {
        return {
            active: false,
            name: "Standard",
            base: parseInt(getConfig('standardReferralPoints')) || 50,
            linkBonus: parseInt(getConfig('standardLinkBonus')) || 50,
            milestoneTarget: 0,
            milestoneBonus: 0,
            endDate: null 
        };
    }

    return campaign;
}