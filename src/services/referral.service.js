import { prisma } from '../db.js';

export async function countMonthlyReferrals(customerId) {
    const now = new Date();
    const firstDayOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    // Using CustomerLog 'REFERRAL_BONUS' as the source of truth for "When the referral happened/was credited"
    // This matches how we count campaign referrals.
    try {
        const count = await prisma.customerLog.count({
            where: {
                customerId: customerId,
                action: 'REFERRAL_BONUS',
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
