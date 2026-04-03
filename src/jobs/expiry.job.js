// src/jobs/expiry.job.js

import { prisma } from '../db.js';
import { sendNotificationToCustomer } from '../services/notification.service.js';

// ⭐️ ฟังก์ชันตัดแต้มหมดอายุ (แก้ไขใหม่: เพิ่ม Log ละเอียด)
export async function runPointExpiryJob() {
    const now = new Date();
    console.log(`[ExpiryJob] 🔍 Checking for points expiring before: ${now.toISOString()}`);

    try {
        // 1. ค้นหาลูกค้าที่ (แต้ม > 0) และ (วันหมดอายุ < ตอนนี้)
        const expiredCustomers = await prisma.customer.findMany({
            where: {
                points: { gt: 0 },
                expiryDate: { lt: now }
            }
        });

        console.log(`[ExpiryJob] 💡 Found ${expiredCustomers.length} users to expire.`);

        if (expiredCustomers.length === 0) return;

        // 2. วนลูปตัดแต้มทีละคน
        for (const customer of expiredCustomers) {
            const pointsLost = customer.points;

            // A. อัปเดตแต้มเป็น 0
            await prisma.customer.update({
                where: { customerId: customer.customerId },
                data: { points: 0 }
            });

            // B. บันทึก Log ลง AdminLog (ถ้ามีตารางนี้) หรือข้ามไปถ้าไม่มี
            // (ในที่นี้เราเน้นตัดแต้มก่อน)
            
            // C. ส่งข้อความแจ้งเตือนลูกค้า
            const msg = `🔔 <b>แจ้งเตือน:</b> แต้มสะสม <b>${pointsLost}</b> แต้มของคุณหมดอายุแล้วค่ะ`;
            if (customer.telegramUserId) {
                await sendNotificationToCustomer(customer.telegramUserId, msg);
            }

            console.log(`[ExpiryJob] ✂️ Cut ${pointsLost} points from ${customer.customerId}`);
        }

        console.log(`[ExpiryJob] ✅ Successfully processed point expiry for ${expiredCustomers.length} users.`);

    } catch (error) {
        console.error(`[ExpiryJob] ❌ Error in runPointExpiryJob:`, error);
    }
}

/**
 * ฟังก์ชันตรวจสอบและอัปเดตสถานะคูปองที่หมดอายุ (Housekeeping)
 */
export async function runCouponExpiryJob() {
    const now = new Date();
    console.log(`[CouponExpiryJob] 🔍 Checking for coupons expiring before: ${now.toISOString()}`);

    try {
        const expiredCoupons = await prisma.customerCoupon.updateMany({
            where: {
                status: 'AVAILABLE',
                expiryDate: { lt: now }
            },
            data: {
                status: 'EXPIRED'
            }
        });

        if (expiredCoupons.count > 0) {
            console.log(`[CouponExpiryJob] ✂️ Marked ${expiredCoupons.count} coupons as EXPIRED.`);
        } else {
            console.log(`[CouponExpiryJob] 💡 No expired coupons found.`);
        }

    } catch (error) {
        console.error(`[CouponExpiryJob] ❌ Error in runCouponExpiryJob:`, error);
    }
}

// ⭐️ ฟังก์ชันแจ้งเตือนล่วงหน้า (คงเดิมไว้ก่อน)
export async function runReminderJob() {
    console.log("[ReminderJob] Checking for upcoming expiry...");
    // (ใส่ตรรกะแจ้งเตือนที่นี่ ถ้าต้องการ)
}