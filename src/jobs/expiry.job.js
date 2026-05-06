// src/jobs/expiry.job.js

import { prisma } from '../db.js';
import { sendNotificationToCustomer } from '../services/notification.service.js';
import { notifyOrderStatusChanged, notifyCustomer } from '../services/notification-center.service.js';

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
 * แจ้งเตือนล่วงหน้า 3 วันก่อนคูปองหมดอายุ
 * - รันวันละครั้ง (default 09:00 Bangkok)
 * - หาเฉพาะ AVAILABLE + expiryDate ในช่วง [now+2.5d, now+3.5d]
 * - กันแจ้งซ้ำผ่าน entityKey ใน Notification (unique constraint)
 */
export async function runCouponExpiringWarningJob() {
    try {
        const now = new Date();
        const lowerBound = new Date(now.getTime() + 2.5 * 24 * 60 * 60 * 1000);
        const upperBound = new Date(now.getTime() + 3.5 * 24 * 60 * 60 * 1000);

        const expiring = await prisma.customerCoupon.findMany({
            where: {
                status: 'AVAILABLE',
                expiryDate: { gte: lowerBound, lte: upperBound },
            },
            include: {
                coupon: { select: { id: true, name: true, type: true, value: true, giftQty: true } },
            },
        });

        if (expiring.length === 0) {
            console.log('[CouponExpiringWarning] 💡 ไม่มีคูปองใกล้หมดอายุในช่วง 3 วัน');
            return;
        }

        console.log(`[CouponExpiringWarning] 🔔 Found ${expiring.length} expiring coupons → notifying...`);

        let notified = 0;
        for (const cc of expiring) {
            try {
                const expiryStr = cc.expiryDate
                    ? new Date(cc.expiryDate).toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: 'numeric' })
                    : '';
                const c = cc.coupon;
                let rewardLabel = '';
                if (c.type === 'GIFT') rewardLabel = `รับฟรี${c.giftQty && c.giftQty > 1 ? ` x${c.giftQty}` : ''}`;
                else if (c.type === 'DISCOUNT_PERCENT') rewardLabel = `ลด ${Number(c.value)}%`;
                else if (c.type === 'DISCOUNT_FLAT') rewardLabel = `ลด ฿${Number(c.value)}`;

                await notifyCustomer({
                    customerId: cc.customerId,
                    kind: 'COUPON_EXPIRING_SOON',
                    title: '⏰ คูปองใกล้หมดอายุ',
                    body: `${c.name}${rewardLabel ? ` (${rewardLabel})` : ''}\nหมดอายุ ${expiryStr}`,
                    link: 'dashboard.html',
                    payload: { customerCouponId: cc.id, couponId: c.id },
                    entityKey: `cc:${cc.id}:warn3d`,
                });
                notified += 1;
            } catch (e) {
                console.error(`[CouponExpiringWarning] notify failed for cc=${cc.id}:`, e.message);
            }
        }

        console.log(`[CouponExpiringWarning] ✅ notified=${notified}/${expiring.length}`);
    } catch (e) {
        console.error('[CouponExpiringWarning] error:', e);
    }
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
                createdAt: { lt: cutoffTime },
                mismatchLocked: false, // skip orders awaiting admin top-up confirmation (no expiry)
            },
            select: { id: true, customerId: true }
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

        // In-app notif หลัง tx (best-effort)
        const { emitSocket } = await import('../services/notification-center.service.js');
        for (const o of expiredOrders) {
            try {
                await notifyOrderStatusChanged({
                    orderId: o.id,
                    customerId: o.customerId,
                    status: 'CANCELLED',
                    note: 'หมดเวลาชำระเงิน — ออเดอร์ถูกยกเลิกอัตโนมัติ',
                });
            } catch (e) { /* silent */ }
            // realtime: admin list refresh
            emitSocket('order_update', { id: o.id, status: 'CANCELLED', ts: Date.now() });
        }

    } catch (error) {
         console.error(`[OrderExpiryJob] ❌ Error cancelling expired orders:`, error);
    }
}