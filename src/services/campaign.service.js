// src/services/campaign.service.js (ฉบับ Real-time)

import { prisma } from '../db.js';
import { getConfig } from '../config/config.js';

// ❌ ลบตัวแปร Cache ออก
// let activeCampaignCache = null;

/**
 * 🔍 ค้นหาแคมเปญที่กำลัง Active อยู่ (แบบ Real-time)
 * อ่านจาก Database ทุกครั้ง เพื่อความแม่นยำสูงสุดเมื่อมีการแก้ไขข้อมูล
 */
export async function getActiveCampaign() {
    // ❌ ลบเงื่อนไขการเช็ค Cache ออก
    /*
    if (activeCampaignCache && activeCampaignCache.endAt > new Date()) {
        return activeCampaignCache;
    }
    */
    
    const now = new Date();
    
    // 1. ค้นหาใน DB สดๆ ทุกครั้ง
    const campaign = await prisma.campaign.findFirst({
        where: {
            startAt: { lte: now }, // ต้องเริ่มแล้ว
            endAt: { gt: now }     // และยังไม่จบ
        },
        orderBy: { endAt: 'asc' } 
    });

    // (ไม่ต้องอัปเดต Cache แล้ว)
    
    // 2. หากไม่มีแคมเปญ Active ให้คืนค่ามาตรฐาน
    if (!campaign) {
        return {
            active: false,
            name: "Standard",
            // แปลงค่าจาก Config เป็นตัวเลข (ถ้าไม่มีใช้ 50)
            base: parseInt(getConfig('standardReferralPoints')) || 50,
            baseReferral: parseInt(getConfig('standardReferralPoints')) || 50, // เพิ่มตัวนี้เผื่อกันเหนียว
            linkBonus: parseInt(getConfig('standardLinkBonus')) || 50,
            milestoneTarget: 0,
            milestoneBonus: 0,
            endDate: null 
        };
    }

    return campaign;
}