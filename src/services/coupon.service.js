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
 * ตรวจสอบความพร้อมของคูปองสำหรับตะกร้าสินค้า (สำหรับ Manual Selection)
 * และส่งข้อความ Error ที่ละเอียดกลับไป
 */
export async function validateCouponForCart(customerId, couponId, cartItems, totalAmount) {
    const customerCoupon = await prisma.customerCoupon.findFirst({
        where: { 
            customerId, 
            couponId, 
            status: 'AVAILABLE'
        },
        include: { coupon: true }
    });

    if (!customerCoupon) {
        throw new Error('ไม่พบคูปองนี้ในกระเป๋าของคุณ');
    }

    const { coupon } = customerCoupon;
    const now = new Date();

    // 1. เช็ควันหมดอายุ (Master)
    if (coupon.validUntil && now > coupon.validUntil) {
        throw new Error('คูปองนี้หมดอายุการใช้งานแล้ว');
    }
    if (coupon.validFrom && now < coupon.validFrom) {
        throw new Error(`คูปองนี้จะเริ่มใช้งานได้วันที่ ${coupon.validFrom.toLocaleDateString('th-TH')}`);
    }

    // 2. เช็คยอดขั้นต่ำ
    if (coupon.minPurchase && totalAmount < Number(coupon.minPurchase)) {
        throw new Error(`ยอดซื้อยังไม่ถึงเงื่อนไข (ขาดอีก ฿${(Number(coupon.minPurchase) - totalAmount).toLocaleString()})`);
    }

    // 3. เช็คเงื่อนไขจำนวนสินค้า (Target Product / Category)
    if (coupon.minQty) {
        let relevantQty = 0;
        let targetName = 'สินค้าที่ร่วมรายการ';

        if (coupon.targetProductId) {
            const product = await prisma.product.findUnique({ where: { id: coupon.targetProductId } });
            targetName = product ? (product.nameEn || product.nameTh) : 'สินค้าที่ระบุ';
            
            relevantQty = cartItems
                .filter(i => i.productId === coupon.targetProductId)
                .reduce((sum, i) => sum + i.qty, 0);
        } else if (coupon.targetCategoryId) {
            const category = await prisma.category.findUnique({ where: { id: coupon.targetCategoryId } });
            targetName = `สินค้าในหมวด ${category ? category.name : 'ที่กำหนด'}`;

            relevantQty = cartItems
                .filter(i => i.categoryId === coupon.targetCategoryId)
                .reduce((sum, i) => sum + i.qty, 0);
        } else {
            relevantQty = cartItems.reduce((sum, i) => sum + i.qty, 0);
        }

        if (relevantQty < coupon.minQty) {
            throw new Error(`เงื่อนไขไม่ครบ: คุณต้องเลือก ${targetName} จำนวนอย่างน้อย ${coupon.minQty} ชิ้น (ขาดอีก ${coupon.minQty - relevantQty} ชิ้น)`);
        }
    }

    // 4. กรณีของแถม (GIFT): ต้องมีสินค้าของแถมอยู่ในตะกร้าด้วย (เพื่อให้แอดมินตัดสต็อกถูก)
    if (coupon.type === 'GIFT' && coupon.giftProductId) {
        const giftInCart = cartItems.find(i => i.productId === coupon.giftProductId);
        const requiredGiftQty = coupon.giftQty || 1;

        if (!giftInCart || giftInCart.qty < requiredGiftQty) {
            const giftProduct = await prisma.product.findUnique({ where: { id: coupon.giftProductId } });
            const giftName = giftProduct ? (giftProduct.nameEn || giftProduct.nameTh) : 'ของแถม';
            const missingQty = giftInCart ? (requiredGiftQty - giftInCart.qty) : requiredGiftQty;
            
            throw new Error(`กรุณาเลือก ${giftName} จำนวน ${requiredGiftQty} ชิ้น ลงในตะกร้าเพื่อรับสิทธิ์ของแถม (ขาดอีก ${missingQty} ชิ้น)`);
        }
    }

    return { success: true, coupon: customerCoupon };
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
            // ตรวจสอบเงื่อนไขจากแม่แบบคูปอง (Live Update)
            coupon: {
                isActive: true,
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

        // 1. เช็คยอดขั้นต่ำ (Min Purchase)
        if (coupon.minPurchase && totalAmount < Number(coupon.minPurchase)) continue;
        
        // 2. เช็คจำนวนขั้นต่ำ (Min Qty)
        let relevantQty = 0;
        if (coupon.targetProductId) {
            // ถ้าระบุสินค้าเจาะจง ให้นับแค่สินค้านั้น
            relevantQty = cartItems
                .filter(i => i.productId === coupon.targetProductId)
                .reduce((sum, i) => sum + i.qty, 0);
        } else if (coupon.targetCategoryId) {
            // ถ้าระบุหมวดหมู่ ให้นับแค่สินค้าในหมวดนั้น
            relevantQty = cartItems
                .filter(i => i.categoryId === coupon.targetCategoryId)
                .reduce((sum, i) => sum + i.qty, 0);
        } else {
            // ถ้าไม่ระบุอะไรเลย ให้นับรวมทั้งตะกร้า
            relevantQty = cartItems.reduce((sum, i) => sum + i.qty, 0);
        }

        if (coupon.minQty && relevantQty < coupon.minQty) continue;

        // 3. เช็คเงื่อนไขหมวดหมู่ (Target Category) - สำหรับกรณีไม่ได้ใช้ minQty
        if (coupon.targetCategoryId && !coupon.targetProductId) {
            const hasTarget = cartItems.some(i => i.categoryId === coupon.targetCategoryId);
            if (!hasTarget) continue;
        }

        // 4. เช็คสินค้าเฉพาะ (Target Product)
        if (coupon.targetProductId) {
            const hasTargetProduct = cartItems.some(i => i.productId === coupon.targetProductId);
            if (!hasTargetProduct) continue;
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
        },
        include: { coupon: true }
    });

    if (!customerCoupon) {
        throw new Error('ไม่พบคูปองนี้ในกระเป๋าของลูกค้า หรือคูปองถูกใช้ไปแล้ว');
    }

    // เช็ควันหมดอายุ (ยึดตามแม่แบบล่าสุด)
    const expiryDate = customerCoupon.coupon.validUntil;
    if (expiryDate && now > expiryDate) {
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
