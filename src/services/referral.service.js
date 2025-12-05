// src/services/referral.service.js
import { prisma } from '../db.js';

export async function countMonthlyReferrals(customerId) {
    const now = new Date();
    const firstDayOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    try {
        // ✅ แก้ไข: เปลี่ยนจาก customerLog เป็น pointTransaction
        // และเปลี่ยน action: 'REFERRAL_BONUS' เป็น type: 'REFERRAL_BONUS'
        const count = await prisma.pointTransaction.count({
            where: {
                customerId: customerId,
                type: 'REFERRAL_BONUS', // เช็คชื่อ field ใน schema ว่าใช้ type หรือ action (ปกติ schema ใหม่คุณใช้ type)
                createdAt: {
                    gte: firstDayOfMonth
                }
            }
        });
        return count;
    } catch (e) {
        console.error("Error counting monthly referrals:", e.message);
        return 0;
    }
}