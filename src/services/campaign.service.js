// src/services/campaign.service.js

import { prisma } from '../db.js';
import { getConfig } from '../config/config.js';


export async function getActiveCampaign() {
    const now = new Date();

    // ต้อง active=true + อยู่ในช่วงเวลา
    const campaign = await prisma.campaign.findFirst({
        where: {
            isActive: true,
            startDate: { lte: now },
            endDate: { gt: now }
        },
        orderBy: { endDate: 'asc' }
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