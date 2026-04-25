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
        // 1. หา ID ของคูปองแม่แบบที่หมดอายุแล้ว (Global Expiry)
        const expiredMasterCoupons = await prisma.coupon.findMany({
            where: {
                validUntil: { lt: now }
            },
            select: { id: true }
        });

        const expiredIds = expiredMasterCoupons.map(c => c.id);

        let masterExpiredCount = 0;
        if (expiredIds.length > 0) {
            const result = await prisma.customerCoupon.updateMany({
                where: {
                    status: 'AVAILABLE',
                    couponId: { in: expiredIds }
                },
                data: {
                    status: 'EXPIRED'
                }
            });
            masterExpiredCount = result.count;
            console.log(`[CouponExpiryJob] ✂️ Marked ${masterExpiredCount} coupons as EXPIRED based on master templates.`);
        }

        // 2. หาคูปองรายใบที่หมดอายุแล้ว (Individual Expiry - เช่น คูปองมีอายุ 7 วันหลังเก็บ)
        const individualExpiredResult = await prisma.customerCoupon.updateMany({
            where: {
                status: 'AVAILABLE',
                expiryDate: { lt: now }
            },
            data: {
                status: 'EXPIRED'
            }
        });

        console.log(`[CouponExpiryJob] ✂️ Marked ${individualExpiredResult.count} coupons as EXPIRED based on individual validity.`);
        
        if (masterExpiredCount === 0 && individualExpiredResult.count === 0) {
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

/**
 * E-commerce: Auto-cancel pending orders that have exceeded their expiry time.
 */
export async function runOrderExpiryJob() {
    try {
        const storeSetting = await prisma.storeSetting.findUnique({ where: { id: 1 } });
        const expiryMinutes = storeSetting?.orderExpiryMinutes || 30;
        
        // Calculate the cutoff time (orders older than this are expired)
        const cutoffTime = new Date(Date.now() - (expiryMinutes * 60 * 1000));
        
        const expiredOrders = await prisma.order.findMany({
            where: {
                status: 'PENDING_PAYMENT',
                createdAt: { lt: cutoffTime }
            },
            select: { id: true }
        });

        if (expiredOrders.length === 0) return; // Silent return

        console.log(`[OrderExpiryJob] 🔍 Found ${expiredOrders.length} expired orders. Cancelling...`);

        await prisma.$transaction(async (tx) => {
            const orderIds = expiredOrders.map(o => o.id);
            
            await tx.order.updateMany({
                where: { id: { in: orderIds } },
                data: { status: 'CANCELLED' }
            });
            
            await tx.systemLog.create({
                data: {
                    level: 'INFO',
                    source: 'CRON',
                    action: 'ORDER_AUTO_CANCEL',
                    message: `Auto-cancelled ${orderIds.length} expired orders: ${orderIds.join(', ')}`
                }
            });
            
            console.log(`[OrderExpiryJob] ✅ Successfully cancelled orders: ${orderIds.join(', ')}`);
        });

    } catch (error) {
         console.error(`[OrderExpiryJob] ❌ Error cancelling expired orders:`, error);
    }
}