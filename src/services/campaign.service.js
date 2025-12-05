// src/services/campaign.service.js

import { prisma } from '../db.js';
import { getConfig } from '../config/config.js';
import { getThaiNow } from '../utils/date.utils.js';

export async function getActiveCampaign() {
    const now = getThaiNow();
    
    // ✅ แก้ไข: เปลี่ยน startAt -> startDate และ endAt -> endDate
    const campaign = await prisma.campaign.findFirst({
        where: {
            startDate: { lte: now }, // แก้ตรงนี้
            endDate: { gt: now }     // แก้ตรงนี้
        },
        orderBy: { endDate: 'asc' }  // แก้ตรงนี้
    });

    if (!campaign) {
        return {
            active: false,
            name: "Standard",
            base: parseInt(getConfig('standardReferralPoints')) || 50,
            baseReferral: parseInt(getConfig('standardReferralPoints')) || 50, // เพิ่มเผื่อไว้
            linkBonus: parseInt(getConfig('standardLinkBonus')) || 50,
            milestoneTarget: 0,
            milestoneBonus: 0,
            endDate: null 
        };
    }

    return campaign;
}