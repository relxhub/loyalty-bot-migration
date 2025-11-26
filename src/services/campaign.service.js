// src/services/campaign.service.js

import { prisma } from '../db.js';
import { getConfig } from '../config/config.js';

/**
 * 🔍 ค้นหาแคมเปญที่กำลัง Active อยู่ (แบบ Real-time)
 * อ่านจาก Database ทุกครั้ง เพื่อความแม่นยำสูงสุดเมื่อมีการแก้ไขข้อมูล
 */
export async function getActiveCampaign() {
    // 1. สร้างเวลาปัจจุบัน (Node.js จะใช้เวลา Server ซึ่งปกติเป็น UTC ใน Railway)
    const now = new Date();
    
    // 2. ค้นหาใน DB สดๆ ทุกครั้ง
    // Prisma จะแปลง 'now' เป็น UTC ให้อัตโนมัติเพื่อเทียบกับ Database
    const campaign = await prisma.campaign.findFirst({
        where: {
            startAt: { lte: now }, // ต้องเริ่มแล้ว (Start <= Now)
            endAt: { gt: now }     // และยังไม่จบ (End > Now)
        },
        orderBy: { endAt: 'asc' } 
    });

    // 3. หากไม่มีแคมเปญ Active ให้คืนค่ามาตรฐาน (Standard Campaign)
    if (!campaign) {
        return {
            active: false,
            name: "Standard",
            // ดึงค่าจาก Config และแปลงเป็นตัวเลข (ถ้าไม่มีใช้ 50)
            base: parseInt(getConfig('standardReferralPoints')) || 50,
            baseReferral: parseInt(getConfig('standardReferralPoints')) || 50, // ค่าสำหรับผู้แนะนำ
            linkBonus: parseInt(getConfig('standardLinkBonus')) || 50,         // ค่าสำหรับผู้เชื่อมบัญชี
            milestoneTarget: 0,
            milestoneBonus: 0,
            endDate: null 
        };
    }

    return campaign;
}