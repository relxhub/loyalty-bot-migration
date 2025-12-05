// src/services/referral.service.js
import { prisma } from '../db.js';

export async function countMonthlyReferrals(referrerId) {
    // Get current date parts in Bangkok timezone to correctly identify the month
    const now = new Date();
    const year = Number(now.toLocaleString('en-US', { timeZone: 'Asia/Bangkok', year: 'numeric' }));
    const month = Number(now.toLocaleString('en-US', { timeZone: 'Asia/Bangkok', month: 'numeric' }));

    // Create a new Date object for the first day of the current month, interpreted as UTC
    // The month from toLocaleString is 1-based, while Date.UTC expects a 0-based month.
    const firstDayOfMonthUTC = new Date(Date.UTC(year, month - 1, 1));

    try {
        const count = await prisma.customer.count({
            where: {
                referrerId: referrerId,
                joinDate: {
                    gte: firstDayOfMonthUTC,
                },
            },
        });
        return count;
    } catch (e) {
        console.error("Error counting monthly referrals:", e.message);
        return 0;
    }
}