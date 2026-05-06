// Engagement jobs — daily digest, birthday coupon, win-back
import { prisma } from '../db.js';
import { sendNotificationToCustomer } from '../services/notification.service.js';
import { broadcastNotification, createNotification } from '../services/notification-center.service.js';

const TG_API = (token, method) => `https://api.telegram.org/bot${token}/${method}`;

/**
 * 📰 Daily digest — สรุป KPI วันก่อน ส่งเข้า admin group
 */
export async function runDailyDigestJob() {
    console.log('[DailyDigest] start');
    try {
        const adminToken = process.env.ADMIN_BOT_TOKEN;
        const groupId = process.env.ADMIN_GROUP_ID || process.env.SUPER_ADMIN_TELEGRAM_ID;
        if (!adminToken || !groupId) { console.warn('[DailyDigest] missing token/group'); return; }

        const dayMs = 86400000;
        const since24 = new Date(Date.now() - dayMs);
        const paidStatuses = ['PAID', 'PROCESSING', 'SHIPPED'];

        const [revAgg, newCust, newRef, pendingShip, stockLow] = await Promise.all([
            prisma.order.aggregate({
                where: { kind: 'PRODUCT', status: { in: paidStatuses }, createdAt: { gte: since24 } },
                _sum: { totalAmount: true }, _count: { _all: true },
            }),
            prisma.customer.count({ where: { isDeleted: false, joinDate: { gte: since24 } } }),
            prisma.referral.count({ where: { status: 'COMPLETED', completedAt: { gte: since24 } } }),
            prisma.prizeShipment.count({ where: { status: 'PENDING' } }),
            prisma.product.count({ where: { stockQuantity: { lte: 50 }, status: 'IN_STOCK' } }),
        ]);
        const revenue = Number(revAgg._sum.totalAmount || 0);
        const orders = revAgg._count._all || 0;

        const text =
`☀️ <b>สรุป 24 ชม.</b> (${new Date().toLocaleDateString('th-TH')})

💰 รายได้: <b>฿${revenue.toLocaleString('th-TH', { minimumFractionDigits: 2 })}</b> (${orders} ออเดอร์)
👥 สมาชิกใหม่: <b>${newCust}</b>
🎯 ชวนเพื่อนสำเร็จ: <b>${newRef}</b>
📦 รอจัดส่งของรางวัล: <b>${pendingShip}</b>
⚠️ สินค้าใกล้หมด (≤50): <b>${stockLow}</b>`;

        await fetch(TG_API(adminToken, 'sendMessage'), {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: groupId, text, parse_mode: 'HTML' }),
        });
        console.log('[DailyDigest] sent');
    } catch (e) { console.error('[DailyDigest] error:', e.message); }
}

/**
 * 🎂 Birthday coupon — แจกคูปองให้ลูกค้าที่มีวันเกิดวันนี้
 * ใช้ SystemConfig key='birthday_coupon_id' กำหนด coupon ที่จะแจก
 */
export async function runBirthdayCouponJob() {
    console.log('[Birthday] start');
    try {
        const cfg = await prisma.systemConfig.findUnique({ where: { key: 'birthday_coupon_id' } });
        const couponId = cfg?.value;
        if (!couponId) { console.log('[Birthday] no birthday_coupon_id configured'); return; }
        const coupon = await prisma.coupon.findUnique({ where: { id: couponId } });
        if (!coupon || !coupon.isActive) { console.log('[Birthday] coupon not found/inactive'); return; }

        const now = new Date();
        const month = now.getMonth() + 1, day = now.getDate();
        // PostgreSQL: WHERE EXTRACT(MONTH FROM birthDate) = M AND EXTRACT(DAY FROM birthDate) = D
        const customers = await prisma.$queryRaw`
            SELECT "customerId", "telegramUserId", "firstName" FROM "Customer"
            WHERE "isDeleted" = false AND "birthDate" IS NOT NULL
              AND EXTRACT(MONTH FROM "birthDate") = ${month}
              AND EXTRACT(DAY FROM "birthDate") = ${day}
        `;
        let granted = 0;
        for (const c of customers) {
            // กันซ้ำ — เช็คว่าปีนี้แจกไปยังไม่
            const yearKey = `bday-${now.getFullYear()}-${c.customerId}`;
            const existing = await prisma.customerCoupon.findFirst({
                where: { customerId: c.customerId, couponId, sourceEvent: yearKey },
            });
            if (existing) continue;
            const expiry = coupon.validityDays ? new Date(Date.now() + coupon.validityDays * 86400000) : (coupon.validUntil || null);
            await prisma.customerCoupon.create({
                data: { customerId: c.customerId, couponId, status: 'AVAILABLE', expiryDate: expiry, sourceEvent: yearKey },
            });
            await prisma.coupon.update({ where: { id: couponId }, data: { claimedCount: { increment: 1 } } });
            try {
                await createNotification({
                    customerId: c.customerId, kind: 'REWARD_COUPON_GRANTED',
                    title: '🎂 สุขสันต์วันเกิด!',
                    body: `รับคูปอง "${coupon.name}" เป็นของขวัญจากร้าน`,
                    link: 'dashboard.html#coupons', entityKey: yearKey,
                });
            } catch (e) {}
            if (c.telegramUserId) {
                try {
                    await sendNotificationToCustomer(c.telegramUserId,
                        `🎂 <b>สุขสันต์วันเกิด ${c.firstName || ''}!</b>\n\nรับคูปอง <b>${coupon.name}</b> เป็นของขวัญ — เปิดแอปดูในกระเป๋าได้เลย`);
                } catch (e) {}
            }
            granted += 1;
        }
        console.log(`[Birthday] granted ${granted} coupons`);
    } catch (e) { console.error('[Birthday] error:', e.message); }
}

/**
 * 🔄 Win-back — ลูกค้า inactive > 30 วัน + ไม่ได้ส่ง win-back ภายใน 60 วัน → ส่ง notif (+ optional coupon)
 */
export async function runWinBackJob() {
    console.log('[WinBack] start');
    try {
        const since = new Date(Date.now() - 30 * 86400000);
        const cooldown = new Date(Date.now() - 60 * 86400000);
        // หา customer ที่มี order ล่าสุดเกิน 30 วัน + ยังไม่เคยถูก win-back ภายใน 60 วัน
        const candidates = await prisma.$queryRaw`
            SELECT c."customerId", c."telegramUserId", c."firstName"
            FROM "Customer" c
            WHERE c."isDeleted" = false
              AND EXISTS (SELECT 1 FROM "Order" o WHERE o."customerId" = c."customerId" AND o."status" IN ('PAID','PROCESSING','SHIPPED'))
              AND NOT EXISTS (
                SELECT 1 FROM "Order" o WHERE o."customerId" = c."customerId"
                  AND o."status" IN ('PAID','PROCESSING','SHIPPED') AND o."createdAt" >= ${since}
              )
              AND NOT EXISTS (
                SELECT 1 FROM "Notification" n WHERE n."customerId" = c."customerId"
                  AND n."entityKey" LIKE 'winback-%' AND n."createdAt" >= ${cooldown}
              )
            LIMIT 100
        `;

        const cfg = await prisma.systemConfig.findUnique({ where: { key: 'winback_coupon_id' } });
        const winbackCouponId = cfg?.value || null;
        const coupon = winbackCouponId ? await prisma.coupon.findUnique({ where: { id: winbackCouponId } }) : null;

        let notified = 0;
        for (const c of candidates) {
            const key = `winback-${Date.now()}-${c.customerId}`;
            const couponLine = coupon && coupon.isActive ? `\n\n🎁 มีคูปอง <b>${coupon.name}</b> รออยู่!` : '';
            try {
                await createNotification({
                    customerId: c.customerId, kind: 'ADMIN_BROADCAST',
                    title: 'คิดถึงคุณนะ! 💌',
                    body: `ไม่ได้เจอกันมา 30+ วันแล้ว — กลับมาช้อปวันนี้พร้อมโปรพิเศษ${coupon ? ' + คูปอง ' + coupon.name : ''}`,
                    link: 'home.html', entityKey: key,
                });
            } catch (e) {}
            // grant coupon (กันซ้ำผ่าน sourceEvent)
            if (coupon && coupon.isActive) {
                const exists = await prisma.customerCoupon.findFirst({ where: { customerId: c.customerId, couponId: coupon.id, sourceEvent: { startsWith: 'winback-' } } });
                if (!exists) {
                    const expiry = coupon.validityDays ? new Date(Date.now() + coupon.validityDays * 86400000) : (coupon.validUntil || null);
                    await prisma.customerCoupon.create({ data: { customerId: c.customerId, couponId: coupon.id, status: 'AVAILABLE', expiryDate: expiry, sourceEvent: key } });
                    await prisma.coupon.update({ where: { id: coupon.id }, data: { claimedCount: { increment: 1 } } });
                }
            }
            if (c.telegramUserId) {
                try {
                    await sendNotificationToCustomer(c.telegramUserId,
                        `💌 <b>${c.firstName || 'คุณลูกค้า'} คิดถึงคุณนะ!</b>\n\nไม่ได้เจอกันมา 30+ วัน — กลับมาช้อปวันนี้สิ${couponLine}`);
                } catch (e) {}
            }
            notified += 1;
        }
        console.log(`[WinBack] notified ${notified} customers`);
    } catch (e) { console.error('[WinBack] error:', e.message); }
}

/**
 * 📦 Wishlist restock notify — สำหรับสินค้าที่เพิ่ง restock (status เปลี่ยนเป็น IN_STOCK + stock > 0)
 * เรียกจาก endpoint หลัง update product status (manual trigger หลัง bulk-stock เพิ่ม)
 */
export async function notifyWishlistOnRestock(productId) {
    try {
        const product = await prisma.product.findUnique({ where: { id: productId }, select: { id: true, nameTh: true, nameEn: true, status: true, stockQuantity: true } });
        if (!product || product.status !== 'IN_STOCK' || product.stockQuantity <= 0) return { notified: 0 };
        const wishes = await prisma.wishlist.findMany({
            where: { productId, notifiedAt: null },
            include: { /* none */ },
        });
        if (!wishes.length) return { notified: 0 };
        const customers = await prisma.customer.findMany({
            where: { customerId: { in: wishes.map(w => w.customerId) } },
            select: { customerId: true, telegramUserId: true, firstName: true },
        });
        const cMap = Object.fromEntries(customers.map(c => [c.customerId, c]));
        let notified = 0;
        const name = product.nameTh || product.nameEn || `#${product.id}`;
        for (const w of wishes) {
            const c = cMap[w.customerId];
            if (!c) continue;
            try {
                await createNotification({
                    customerId: w.customerId, kind: 'ADMIN_BROADCAST',
                    title: '📦 สินค้าที่อยากได้กลับมาแล้ว!',
                    body: `${name} กลับเข้า stock แล้ว`,
                    link: 'products.html', entityKey: `wishlist-${w.id}`,
                });
                if (c.telegramUserId) {
                    await sendNotificationToCustomer(c.telegramUserId, `📦 <b>${name}</b> กลับมาแล้ว! รีบเลย ก่อนจะหมดอีกรอบ`);
                }
                await prisma.wishlist.update({ where: { id: w.id }, data: { notifiedAt: new Date() } });
                notified += 1;
            } catch (e) { console.error('[Wishlist] notify err:', e.message); }
        }
        return { notified };
    } catch (e) {
        console.error('[Wishlist] error:', e.message);
        return { notified: 0, error: e.message };
    }
}
