// src/services/campaign.service.js

import { prisma } from '../db.js';
import { getConfig } from '../config/config.js';
import { getThaiNow } from '../utils/date.utils.js'; // Import ตัวใหม่

export async function getActiveCampaign() {
    // 1. ใช้เวลาไทยในการตรวจสอบ
    const now = getThaiNow();
    
    // 2. ค้นหาใน DB 
    // (เทียบเวลาไทยปัจจุบัน กับ เวลาที่คุณกรอกใน DB)
    const campaign = await prisma.campaign.findFirst({
        where: {
            startAt: { lte: now }, 
            endAt: { gt: now }     
        },
        orderBy: { endAt: 'asc' } 
    });

    if (!campaign) {
        return {
            active: false,
            name: "Standard",
            base: parseInt(getConfig('standardReferralPoints')) || 50,
            baseReferral: parseInt(getConfig('standardReferralPoints')) || 50,
            linkBonus: parseInt(getConfig('standardLinkBonus')) || 50,
            milestoneTarget: 0,
            milestoneBonus: 0,
            endDate: null 
        };
    }

    return campaign;
}