import { prisma } from '../db.js';

/**
 * ลูกค้ากดเก็บคูปอง (First Come, First Served)
 */
export async function claimCoupon(customerId, couponId) {
    return await prisma.$transaction(async (tx) => {
        // 1. ตรวจสอบแม่แบบคูปอง และเช็คโควตา (Atomic check)
        const coupon = await tx.coupon.findUnique({
            where: { id: couponId }
        });

        if (!coupon || !coupon.isActive) {
            throw new Error('คูปองนี้ไม่พร้อมใช้งาน');
        }

        // เช็ควันเริ่ม-หมดอายุ
        const now = new Date();
        if (coupon.startDate && now < coupon.startDate) throw new Error('คูปองยังไม่เริ่มแจก');
        if (coupon.endDate && now > coupon.endDate) throw new Error('คูปองหมดอายุการแจกแล้ว');

        // เช็คจำนวนรวม (FCFS)
        if (coupon.totalQuota !== null && coupon.claimedCount >= coupon.totalQuota) {
            throw new Error('ขออภัย คูปองถูกเก็บจนเต็มจำนวนแล้ว');
        }

        // 2. เช็คโควตาต่อคน
        const existingClaims = await tx.customerCoupon.count({
            where: { customerId, couponId }
        });

        if (existingClaims >= coupon.usageLimitPerUser) {
            throw new Error(`คุณเก็บคูปองนี้ครบตามสิทธิ์แล้ว (${coupon.usageLimitPerUser} ครั้ง)`);
        }

        // 3. ทำการเพิ่มคูปองเข้ากระเป๋า และอัปเดตตัวนับแม่แบบ
        await tx.coupon.update({
            where: { id: couponId },
            data: { claimedCount: { increment: 1 } }
        });

        const customerCoupon = await tx.customerCoupon.create({
            data: {
                customerId,
                couponId,
                status: 'AVAILABLE',
                expiryDate: coupon.validUntil // Copy expiry date from template
            }
        });

        return customerCoupon;
    });
}

/**
 * ดึงรายการคูปองที่ลูกค้ามี (สำหรับแสดงในกระเป๋า)
 */
export async function getCustomerCoupons(customerId) {
    const now = new Date();
    return await prisma.customerCoupon.findMany({
        where: { 
            customerId, 
            status: 'AVAILABLE',
            // 1. เช็ควันหมดอายุที่ติดมากับคูปองใบนี้ (Copy มาตอนเก็บ)
            OR: [
                { expiryDate: null },
                { expiryDate: { gt: now } }
            ],
            // 2. เช็คเงื่อนไขจากแม่แบบคูปอง (เผื่อแอดมินแก้ไขวันเริ่ม/หมดอายุของแม่แบบในภายหลัง)
            coupon: {
                isActive: true, // ต้องยังเปิดใช้งานอยู่
                OR: [
                    { validFrom: null },
                    { validFrom: { lte: now } }
                ],
                AND: [
                    {
                        OR: [
                            { validUntil: null },
                            { validUntil: { gt: now } }
                        ]
                    }
                ]
            }
        },
        include: { coupon: true },
        orderBy: { claimedAt: 'desc' }
    });
}

/**
 * คำนวณหาคูปองที่ดีที่สุด (Best Value)
 * @param {string} customerId - รหัสลูกค้า
 * @param {Array} cartItems - รายการสินค้าในตะกร้า [{productId, categoryId, qty, price}]
 * @param {number} totalAmount - ยอดรวมเงิน (ไม่รวมค่าส่ง)
 */
export async function getBestCoupon(customerId, cartItems, totalAmount) {
    const availableCoupons = await getCustomerCoupons(customerId);
    let bestCoupon = null;
    let maxSaving = 0;

    for (const item of availableCoupons) {
        const { coupon } = item;
        let currentSaving = 0;

        // 1. เช็คเงื่อนไขเบื้องต้น (ยอดขั้นต่ำ, จำนวนขั้นต่ำ)
        if (coupon.minPurchase && totalAmount < Number(coupon.minPurchase)) continue;
        
        const totalQty = cartItems.reduce((sum, i) => sum + i.qty, 0);
        if (coupon.minQty && totalQty < coupon.minQty) continue;

        // 2. เช็คเงื่อนไขเฉพาะหมวดหมู่ (Target Category)
        if (coupon.targetCategoryId) {
            const hasTarget = cartItems.some(i => i.categoryId === coupon.targetCategoryId);
            if (!hasTarget) continue;
        }

        // 3. เช็คสินค้าที่ไม่เข้าร่วม (Excluded Products)
        // ดึงข้อมูลสินค้าในตะกร้าจาก DB เพื่อเช็ค allowCoupons
        const productsInCart = await prisma.product.findMany({
            where: { id: { in: cartItems.map(i => i.productId) } },
            select: { id: true, allowCoupons: true }
        });

        // สำหรับส่วนลด % หรือ บาท เราจะคำนวณจากยอดสินค้าที่ "เข้าร่วม" เท่านั้น
        const eligibleAmount = cartItems.reduce((sum, i) => {
            const productInfo = productsInCart.find(p => p.id === i.productId);
            
            // เงื่อนไขการข้าม (ไม่นำมาคำนวณส่วนลด):
            // 1. สินค้านั้นถูกตั้งค่า allowCoupons = false (ไม่ร่วมรายการทั้งหมด)
            // 2. สินค้านั้นอยู่ในรายชื่อยกเว้นของคูปองใบนี้ (excludedProductIds)
            if (productInfo && !productInfo.allowCoupons) return sum;
            if (coupon.excludedProductIds.includes(i.productId)) return sum;
            
            return sum + (i.price * i.qty);
        }, 0);

        if (eligibleAmount <= 0) continue;

        // 4. คำนวณมูลค่าความคุ้มค่า
        if (coupon.type === 'DISCOUNT_FLAT') {
            currentSaving = Number(coupon.value);
        } 
        else if (coupon.type === 'DISCOUNT_PERCENT') {
            currentSaving = eligibleAmount * (Number(coupon.value) / 100);
        }
        else if (coupon.type === 'GIFT') {
            // ของแถม: ความคุ้มค่าคือราคาของสินค้าแถม (สมมติว่าเราดึงราคามาจาก DB)
            // สำหรับ Logic เบื้องต้น ถ้าเป็นของแถมจะถือว่ามีความคุ้มค่าเท่ากับราคาของมัน
            const giftProduct = await prisma.product.findUnique({ 
                where: { id: coupon.giftProductId },
                include: { category: true }
            });
            currentSaving = giftProduct ? Number(giftProduct.category.price) * coupon.giftQty : 0;
        }

        if (currentSaving > maxSaving) {
            maxSaving = currentSaving;
            bestCoupon = { ...item, calculatedSaving: currentSaving };
        }
    }

    return bestCoupon;
}

/**
 * แอดมินใช้คูปอง (ตัดสิทธิ์)
 */
export async function useCoupon(customerId, couponId, adminName) {
    const now = new Date();
    const customerCoupon = await prisma.customerCoupon.findFirst({
        where: { 
            customerId, 
            couponId, 
            status: 'AVAILABLE'
        }
    });

    if (!customerCoupon) {
        throw new Error('ไม่พบคูปองนี้ในกระเป๋าของลูกค้า หรือคูปองถูกใช้ไปแล้ว');
    }

    // เช็ควันหมดอายุ
    if (customerCoupon.expiryDate && now > customerCoupon.expiryDate) {
        throw new Error('คูปองนี้หมดอายุแล้ว ไม่สามารถใช้งานได้');
    }

    const updated = await prisma.customerCoupon.update({
        where: { id: customerCoupon.id },
        data: {
            status: 'USED',
            usedAt: new Date(),
            usedByAdmin: adminName
        },
        include: { coupon: true }
    });

    return updated;
}

/**
 * แอดมินกู้คืนคูปอง (Undo)
 */
export async function restoreCoupon(customerId, couponId, adminName) {
    const customerCoupon = await prisma.customerCoupon.findFirst({
        where: { customerId, couponId, status: 'USED' },
        orderBy: { usedAt: 'desc' } // เอาใบที่ใช้ล่าสุด
    });

    if (!customerCoupon) {
        throw new Error('ไม่พบประวัติการใช้คูปองนี้ที่สามารถกู้คืนได้');
    }

    const restored = await prisma.customerCoupon.update({
        where: { id: customerCoupon.id },
        data: {
            status: 'AVAILABLE',
            usedAt: null,
            usedByAdmin: null
        },
        include: { coupon: true }
    });

    return restored;
}
