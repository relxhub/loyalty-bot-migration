// src/services/referral.service.js
import { prisma } from '../db.js';

export async function countMonthlyReferrals(referrerId) {
    const now = new Date();
    const firstDayOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    try {
        const count = await prisma.customer.count({
            where: {
                referrerId: referrerId,
                joinDate: { // Using the customer's join date for accuracy
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