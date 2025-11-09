// src/services/reward.service.js
import { prisma } from '../db.js';

/**
 * ดึงรายการของรางวัลทั้งหมดจากฐานข้อมูล
 */
export async function listRewards() {
    const rewards = await prisma.reward.findMany({
        select: {
            rewardId: true,
            name: true,
            points: true
        }
    });
    return rewards;
}

/**
 * จัดรูปแบบรายการของรางวัลสำหรับแสดงผลใน Admin Bot
 */
export function formatRewardsForAdmin(rewards) {
    if (!rewards || rewards.length === 0) {
        return "🎁 ยังไม่มีของรางวัลในระบบ";
    }
    
    let rewardList = "<b>🎁 รายการของรางวัลทั้งหมด:</b>\n\n";
    rewards.forEach(r => {
        rewardList += `- <b>${r.rewardId}</b>: ${r.name} (${r.points} แต้ม)\n`;
    });
    return rewardList + "\nใช้คำสั่ง /redeem [รหัสลูกค้า] [รหัสของรางวัล] เพื่อแลก";
}