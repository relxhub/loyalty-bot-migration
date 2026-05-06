import { prisma } from '../db.js';
import { notifyCustomer } from './notification-center.service.js';

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

        // เช็คจำนวนรวมเบื้องต้น (FCFS)
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
        const updatedCoupon = await tx.coupon.update({
            where: { id: couponId },
            data: { claimedCount: { increment: 1 } }
        });

        // 4. เช็คความถูกต้องหลังอัปเดต (ป้องกันการแย่งกันกด - Race Condition)
        if (updatedCoupon.totalQuota !== null && updatedCoupon.claimedCount > updatedCoupon.totalQuota) {
            throw new Error('ขออภัย คูปองถูกเก็บจนเต็มจำนวนแล้ว'); // จะทำให้ Transaction Rollback ทันที
        }

        let calculatedExpiry = coupon.validUntil;
        if (coupon.validityDays) {
            calculatedExpiry = new Date();
            calculatedExpiry.setDate(calculatedExpiry.getDate() + coupon.validityDays);
        }

        const customerCoupon = await tx.customerCoupon.create({
            data: {
                customerId,
                couponId,
                status: 'AVAILABLE',
                expiryDate: calculatedExpiry
            }
        });

        return customerCoupon;
    });
}

/**
 * ลูกค้าใช้แต้มแลกคูปอง
 */
export async function redeemCouponWithPoints(customerId, couponId) {
    return await prisma.$transaction(async (tx) => {
        const coupon = await tx.coupon.findUnique({
            where: { id: couponId }
        });

        if (!coupon || !coupon.isActive) {
            throw new Error('คูปองนี้ไม่พร้อมใช้งาน');
        }

        if (coupon.pointsCost === null || coupon.pointsCost <= 0) {
            throw new Error('คูปองนี้ไม่ได้เปิดให้ใช้แต้มแลก (โปรดไปเก็บที่ศูนย์คูปองแทน)');
        }

        // เช็ควันเริ่ม-หมดอายุ
        const now = new Date();
        if (coupon.startDate && now < coupon.startDate) throw new Error('คูปองยังไม่เริ่มให้แลก');
        if (coupon.endDate && now > coupon.endDate) throw new Error('คูปองหมดอายุการแลกแล้ว');

        // เช็คจำนวนรวมเบื้องต้น (FCFS)
        if (coupon.totalQuota !== null && coupon.claimedCount >= coupon.totalQuota) {
            throw new Error('ขออภัย สิทธิ์คูปองถูกแลกจนเต็มแล้ว');
        }

        // เช็คโควตาต่อคน
        const existingClaims = await tx.customerCoupon.count({
            where: { customerId, couponId }
        });

        if (existingClaims >= coupon.usageLimitPerUser) {
            throw new Error(`คุณแลกคูปองนี้ครบตามสิทธิ์แล้ว (${coupon.usageLimitPerUser} ครั้ง)`);
        }

        // ตรวจสอบว่าลูกค้ามีแต้มพอไหม
        const customer = await tx.customer.findUnique({
            where: { customerId }
        });

        if (customer.points < coupon.pointsCost) {
            throw new Error(`แต้มไม่พอ (คูปองนี้ใช้ ${coupon.pointsCost} แต้ม แต่คุณมี ${customer.points} แต้ม)`);
        }

        // 1. หักแต้ม
        await tx.customer.update({
            where: { customerId },
            data: { points: { decrement: coupon.pointsCost } }
        });

        // 2. บันทึกประวัติการเสียแต้ม
        await tx.pointTransaction.create({
            data: {
                customerId,
                amount: -coupon.pointsCost,
                type: 'REDEEM_REWARD',
                detail: `แลกคูปอง ${coupon.name} (ID: ${coupon.id})`
            }
        });

        // 3. เพิ่มยอดการแลกของคูปอง
        const updatedCoupon = await tx.coupon.update({
            where: { id: couponId },
            data: { claimedCount: { increment: 1 } }
        });

        // 4. เช็คความถูกต้องหลังอัปเดต (ป้องกัน Race Condition)
        if (updatedCoupon.totalQuota !== null && updatedCoupon.claimedCount > updatedCoupon.totalQuota) {
            throw new Error('ขออภัย สิทธิ์คูปองถูกแลกจนเต็มแล้ว'); // จะทำให้ Transaction Rollback (คืนแต้มอัตโนมัติ)
        }

        let calculatedExpiry = coupon.validUntil;
        if (coupon.validityDays) {
            calculatedExpiry = new Date();
            calculatedExpiry.setDate(calculatedExpiry.getDate() + coupon.validityDays);
        }

        // 5. นำคูปองเข้ากระเป๋า
        const customerCoupon = await tx.customerCoupon.create({
            data: {
                customerId,
                couponId,
                status: 'AVAILABLE',
                expiryDate: calculatedExpiry
            }
        });

        // คืนค่าเพื่อให้รู้ว่าแลกสำเร็จ และเหลือแต้มเท่าไหร่
        return { customerCoupon, remainingPoints: customer.points - coupon.pointsCost };
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

    // 0. กล่องสุ่มที่ยังไม่ได้เปิด — ใช้ไม่ได้
    if (customerCoupon.isMysteryBoxLocked) {
        throw new Error('กล่องสุ่มยังไม่ได้เปิด — กรุณาเปิดกล่องในหน้า "คูปองของฉัน" ก่อน');
    }

    const { coupon } = customerCoupon;
    const now = new Date();

    // 1. เช็ควันหมดอายุ (Master & Individual)
    if (coupon.validUntil && now > coupon.validUntil) {
        throw new Error('คูปองนี้หมดอายุการใช้งานแล้ว (แคมเปญสิ้นสุด)');
    }
    if (customerCoupon.expiryDate && now > customerCoupon.expiryDate) {
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
    if (coupon.type === 'GIFT') {
        const requiredGiftQty = coupon.giftQty || 1;
        const requiredMinQty = coupon.minQty || 0;
        
        let availableForGift = 0;
        let totalRequired = requiredGiftQty;
        let giftName = 'ของแถม';

        if (coupon.giftCategoryId) {
            const category = await prisma.category.findUnique({ where: { id: coupon.giftCategoryId } });
            giftName = `สินค้าในหมวด ${category ? category.name : 'ที่กำหนด'}`;

            const totalInCat = cartItems
                .filter(i => i.categoryId === coupon.giftCategoryId)
                .reduce((sum, i) => sum + i.qty, 0);

            if (coupon.targetCategoryId === coupon.giftCategoryId) {
                availableForGift = totalInCat - requiredMinQty;
                totalRequired = requiredMinQty + requiredGiftQty;
            } else {
                availableForGift = totalInCat;
            }
        } else if (coupon.giftProductId) {
            const product = await prisma.product.findUnique({ where: { id: coupon.giftProductId } });
            giftName = product ? (product.nameEn || product.nameTh) : 'สินค้าที่ระบุ';

            const totalInProd = cartItems
                .filter(i => i.productId === coupon.giftProductId)
                .reduce((sum, i) => sum + i.qty, 0);

            if (coupon.targetProductId === coupon.giftProductId) {
                availableForGift = totalInProd - requiredMinQty;
                totalRequired = requiredMinQty + requiredGiftQty;
            } else {
                availableForGift = totalInProd;
            }
        } else {
            // ถ้าไม่ได้ตั้งค่าอะไรเป็นพิเศษ ให้ผ่านเลย (Fallback)
            availableForGift = requiredGiftQty;
        }

        if (availableForGift < requiredGiftQty) {
            const missingQty = requiredGiftQty - Math.max(0, availableForGift);
            throw new Error(`เงื่อนไขของแถม: คุณต้องมี ${giftName} จำนวน ${totalRequired} ชิ้น (สำหรับเงื่อนไขการซื้อ ${requiredMinQty} และแถมฟรี ${requiredGiftQty}) ขาดอีก ${missingQty} ชิ้น`);
        }
    }

    return { success: true, coupon: customerCoupon };
}

/**
 * ดึงรายการคูปองที่ลูกค้ามี (สำหรับแสดงในกระเป๋า)
 * ไม่ได้กรอง validFrom ออก เพื่อให้แสดงคูปองที่ยังไม่ถึงเวลาเริ่มใช้ได้
 */
export async function getCustomerCoupons(customerId) {
    const now = new Date();
    return await prisma.customerCoupon.findMany({
        where: { 
            customerId, 
            status: 'AVAILABLE',
            // เช็ควันหมดอายุของคูปองรายใบ
            OR: [
                { expiryDate: null },
                { expiryDate: { gt: now } }
            ],
            // ตรวจสอบเงื่อนไขจากแม่แบบคูปอง (Live Update)
            coupon: {
                isActive: true,
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
    const now = new Date();
    let bestCoupon = null;
    let maxSaving = 0;

    for (const item of availableCoupons) {
        const { coupon } = item;
        let currentSaving = 0;

        // 0a. กล่องสุ่มที่ยังไม่ได้เปิด — ใช้ไม่ได้
        if (item.isMysteryBoxLocked) continue;

        // 0. ตรวจสอบวันเริ่มใช้งาน (เพราะ getCustomerCoupons ดึงอันที่ยังไม่เริ่มมาด้วย)
        if (coupon.validFrom && new Date(coupon.validFrom) > now) continue;

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

        // 5. เช็คเงื่อนไขของแถม (GIFT) ว่ามีในตะกร้าครบหรือไม่
        if (coupon.type === 'GIFT') {
            const requiredGiftQty = coupon.giftQty || 1;
            const requiredMinQty = coupon.minQty || 0;
            let availableForGift = 0;

            if (coupon.giftCategoryId) {
                const totalInCat = cartItems.filter(i => i.categoryId === coupon.giftCategoryId).reduce((sum, i) => sum + i.qty, 0);
                availableForGift = (coupon.targetCategoryId === coupon.giftCategoryId) ? (totalInCat - requiredMinQty) : totalInCat;
            } else if (coupon.giftProductId) {
                const totalInProd = cartItems.filter(i => i.productId === coupon.giftProductId).reduce((sum, i) => sum + i.qty, 0);
                availableForGift = (coupon.targetProductId === coupon.giftProductId) ? (totalInProd - requiredMinQty) : totalInProd;
            } else {
                availableForGift = requiredGiftQty; // Fallback
            }

            if (availableForGift < requiredGiftQty) continue; // ถ้าหยิบของแถมมาไม่ครบ ให้ข้ามคูปองนี้ไป (ไม่เลือกให้เป็น Best Coupon)
        }

        // 6. เช็คสินค้าที่ไม่เข้าร่วม (Excluded Products)
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
            // ของแถม: ความคุ้มค่าคือราคาของหมวดหมู่สินค้าแถม
            if (coupon.giftCategoryId) {
                const category = await prisma.category.findUnique({ where: { id: coupon.giftCategoryId } });
                currentSaving = category ? Number(category.price) * coupon.giftQty : 0;
            } else if (coupon.giftProductId) {
                const giftProduct = await prisma.product.findUnique({ 
                    where: { id: coupon.giftProductId },
                    include: { category: true }
                });
                currentSaving = giftProduct ? Number(giftProduct.category.price) * coupon.giftQty : 0;
            }
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
    
    // ดึงคูปองที่เป็นไปได้ทั้งหมด แล้วเลือกใบที่ใกล้หมดอายุที่สุด
    const availableCoupons = await prisma.customerCoupon.findMany({
        where: { 
            customerId, 
            couponId, 
            status: 'AVAILABLE'
        },
        include: { coupon: true }
    });

    if (!availableCoupons || availableCoupons.length === 0) {
        throw new Error('ไม่พบคูปองนี้ในกระเป๋าของลูกค้า หรือคูปองถูกใช้ไปแล้ว');
    }

    // กรองเอาเฉพาะที่ยังไม่หมดอายุ
    const validCoupons = availableCoupons.filter(c => {
        const globalExpiry = c.coupon.validUntil;
        const individualExpiry = c.expiryDate;
        
        if (globalExpiry && now > globalExpiry) return false;
        if (individualExpiry && now > individualExpiry) return false;
        if (c.coupon.validFrom && now < c.coupon.validFrom) return false;
        
        return true;
    });

    if (validCoupons.length === 0) {
        throw new Error('คูปองนี้หมดอายุแล้ว ไม่สามารถใช้งานได้');
    }

    // เรียงลำดับ: ใบที่มีวันหมดอายุ (expiryDate หรือ validUntil) ใกล้ที่สุดมาก่อน
    // ถ้าไม่มีวันหมดอายุเลย ให้อยู่ท้ายสุด
    validCoupons.sort((a, b) => {
        const expiryA = a.expiryDate || a.coupon.validUntil;
        const expiryB = b.expiryDate || b.coupon.validUntil;
        
        if (!expiryA && !expiryB) return 0;
        if (!expiryA) return 1;
        if (!expiryB) return -1;
        
        return new Date(expiryA).getTime() - new Date(expiryB).getTime();
    });

    const customerCoupon = validCoupons[0];

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

/**
 * แจกคูปองอัตโนมัติให้กับสมาชิกรหัสใหม่
 * @param {string} customerId
 * @param {string} triggerSource - "MAGIC_LINK", "REFERRAL", or "ADMIN_GENCODE"
 */
export async function assignAutoCoupons(customerId, triggerSource = "ALL") {
    const now = new Date();
    
    // ดึงคูปองทั้งหมดที่เปิดโหมดแจกอัตโนมัติ
    const autoCoupons = await prisma.coupon.findMany({
        where: {
            isActive: true,
            isAutoAssign: true,
            autoAssignQty: { gt: 0 },
            OR: [
                { endDate: null },
                { endDate: { gt: now } }
            ]
        }
    });

    if (autoCoupons.length === 0) return;

    let couponsToCreate = [];

    for (const coupon of autoCoupons) {
        // 1. เช็คว่าทริกเกอร์ตรงไหม
        // ถ้าคูปองตั้งว่า ALL คือแจกหมด, ถ้าไม่ จะแจกเฉพาะ trigger ที่ตรงกัน
        if (coupon.autoAssignTrigger && coupon.autoAssignTrigger !== "ALL") {
             if (coupon.autoAssignTrigger !== triggerSource) continue;
        }

        // 2. เช็คว่าคูปองเริ่มแจกหรือยัง
        if (coupon.startDate && now < coupon.startDate) continue;
        
        // เช็คโควตากลาง ถ้าเต็มแล้วข้าม
        if (coupon.totalQuota !== null && coupon.claimedCount + coupon.autoAssignQty > coupon.totalQuota) continue;

        let expiryDate = null;
        if (coupon.validityDays) {
            expiryDate = new Date(now.getTime() + coupon.validityDays * 24 * 60 * 60 * 1000);
        } else if (coupon.validUntil) {
            expiryDate = coupon.validUntil;
        }

        // เตรียมข้อมูลสร้างคูปองตามจำนวน autoAssignQty
        for (let i = 0; i < coupon.autoAssignQty; i++) {
            couponsToCreate.push({
                customerId: customerId,
                couponId: coupon.id,
                expiryDate: expiryDate,
                status: 'AVAILABLE'
            });
        }
        
        // อัปเดตยอดการแจกของคูปองนั้นๆ
        await prisma.coupon.update({
            where: { id: coupon.id },
            data: { claimedCount: { increment: coupon.autoAssignQty } }
        });
    }

    if (couponsToCreate.length > 0) {
        await prisma.customerCoupon.createMany({
            data: couponsToCreate
        });
        console.log(`[Auto Coupon] Assigned ${couponsToCreate.length} coupons to new customer ${customerId}`);
    }
}

/**
 * Grant Reward Coupons เมื่อเกิด event เช่น referee ซื้อครั้งแรกผ่านเกณฑ์
 *
 * @param {object} params
 * @param {string} params.event           - "REFEREE_FIRST_PURCHASE" (ตรงกับ enum RewardTrigger)
 * @param {string} params.referrerId      - customerId ของผู้แนะนำ (User A)
 * @param {string} params.refereeId       - customerId ของผู้ถูกแนะนำ (User B)
 * @param {number} params.eligibleAmount  - ยอดที่ใช้เทียบเงื่อนไข (subtotal - discount, ไม่รวมค่าส่ง)
 * @param {number} [params.referralRowId] - Referral.id (ใช้กันแจกซ้ำ)
 * @returns {Promise<{ granted: Array<{couponId,couponName,recipientId,recipientRole}>, skipped: Array }>}
 */
export async function grantRewardCoupons({ event, referrerId, refereeId, eligibleAmount, referralRowId = null }) {
    const granted = [];
    const skipped = [];

    if (!event) return { granted, skipped };

    const now = new Date();
    let coupons = [];
    try {
        coupons = await prisma.coupon.findMany({
            where: {
                isActive: true,
                rewardTrigger: event,
                AND: [
                    { OR: [{ startDate: null }, { startDate: { lte: now } }] },
                    { OR: [{ endDate: null }, { endDate: { gte: now } }] },
                ],
            },
        });
    } catch (e) {
        console.error('[RewardCoupon] lookup failed:', e.message);
        return { granted, skipped };
    }

    if (coupons.length === 0) return { granted, skipped };

    const amount = Number(eligibleAmount) || 0;
    const toNotify = []; // { coupon, recipient } เก็บไว้แจ้งเตือนหลัง tx ทั้งหมดเสร็จ

    for (const coupon of coupons) {
        // 1) check amount range
        if (coupon.rewardMinAmount != null && amount < Number(coupon.rewardMinAmount)) {
            skipped.push({ couponId: coupon.id, reason: 'BELOW_MIN' });
            continue;
        }
        if (coupon.rewardMaxAmount != null && amount > Number(coupon.rewardMaxAmount)) {
            skipped.push({ couponId: coupon.id, reason: 'ABOVE_MAX' });
            continue;
        }

        // 2) decide recipients
        const recipients = [];
        const role = coupon.rewardRecipient || 'REFERRER';
        if (role === 'REFERRER' || role === 'BOTH') recipients.push({ id: referrerId, role: 'REFERRER' });
        if (role === 'REFEREE' || role === 'BOTH') recipients.push({ id: refereeId, role: 'REFEREE' });

        for (const rcp of recipients) {
            if (!rcp.id) continue;
            try {
                await prisma.$transaction(async (tx) => {
                    // 3) กันแจกซ้ำ — ถ้า rewardOncePerReferral && referralRowId มีอยู่ → เช็คก่อน
                    if (coupon.rewardOncePerReferral && referralRowId) {
                        const dup = await tx.customerCoupon.findFirst({
                            where: {
                                customerId: rcp.id,
                                couponId: coupon.id,
                                sourceReferralId: referralRowId,
                            },
                        });
                        if (dup) {
                            skipped.push({ couponId: coupon.id, recipientId: rcp.id, reason: 'ALREADY_GRANTED' });
                            return;
                        }
                    }

                    // 4) เช็คโควตา
                    if (coupon.totalQuota !== null && coupon.claimedCount >= coupon.totalQuota) {
                        skipped.push({ couponId: coupon.id, recipientId: rcp.id, reason: 'QUOTA_FULL' });
                        return;
                    }

                    let expiryDate = coupon.validUntil;
                    if (coupon.validityDays) {
                        expiryDate = new Date(now.getTime() + coupon.validityDays * 24 * 60 * 60 * 1000);
                    }

                    await tx.customerCoupon.create({
                        data: {
                            customerId: rcp.id,
                            couponId: coupon.id,
                            status: 'AVAILABLE',
                            expiryDate,
                            sourceReferralId: referralRowId,
                            sourceEvent: event,
                            isMysteryBoxLocked: !!coupon.isMysteryBox,
                        },
                    });

                    const updated = await tx.coupon.update({
                        where: { id: coupon.id },
                        data: { claimedCount: { increment: 1 } },
                    });
                    if (updated.totalQuota !== null && updated.claimedCount > updated.totalQuota) {
                        // เกินโควตา → rollback ทั้ง tx
                        throw new Error('QUOTA_RACE');
                    }

                    granted.push({
                        couponId: coupon.id,
                        couponName: coupon.name,
                        recipientId: rcp.id,
                        recipientRole: rcp.role,
                    });
                    toNotify.push({ coupon, recipient: rcp });
                });
            } catch (e) {
                if (String(e.message).includes('QUOTA_RACE')) {
                    skipped.push({ couponId: coupon.id, recipientId: rcp.id, reason: 'QUOTA_RACE' });
                } else {
                    console.error(`[RewardCoupon] grant failed (${coupon.id} → ${rcp.id}):`, e.message);
                    skipped.push({ couponId: coupon.id, recipientId: rcp.id, reason: 'ERROR' });
                }
            }
        }
    }

    if (granted.length > 0) {
        console.log(`[RewardCoupon] event=${event} granted=${granted.length} skipped=${skipped.length}`);
    }

    // ส่งแจ้งเตือนหลัง tx ทั้งหมดเสร็จ — best-effort, ไม่กระทบ result
    for (const t of toNotify) {
        try {
            await sendRewardCouponNotif({
                coupon: t.coupon,
                recipientId: t.recipient.id,
                recipientRole: t.recipient.role,
                referrerId,
                refereeId,
                referralRowId,
            });
        } catch (e) {
            console.error('[RewardCoupon] notify failed:', e.message);
        }
    }

    return { granted, skipped };
}

/**
 * แจ้งเตือนเมื่อได้รับ reward coupon — สร้าง in-app notif + ส่ง Telegram chat
 */
async function sendRewardCouponNotif({ coupon, recipientId, recipientRole, referrerId, refereeId, referralRowId }) {
    const fmt = (n) => Number(n).toLocaleString('th-TH', {
        minimumFractionDigits: n % 1 ? 2 : 0,
        maximumFractionDigits: 2
    });

    const isMystery = !!coupon.isMysteryBox;

    let rewardLabel = '';
    if (coupon.type === 'GIFT') {
        const qty = coupon.giftQty && coupon.giftQty > 1 ? ` x${coupon.giftQty}` : '';
        rewardLabel = `รับฟรี${qty}`;
    } else if (coupon.type === 'DISCOUNT_PERCENT') {
        rewardLabel = `ลด ${fmt(coupon.value)}%`;
    } else if (coupon.type === 'DISCOUNT_FLAT') {
        rewardLabel = `ลด ฿${fmt(coupon.value)}`;
    }

    // Mystery Box → ปกปิดของรางวัล ให้ลูกค้าตื่นเต้นเปิดเอง
    const title = isMystery ? '🎁 ได้รับกล่องสุ่มพิเศษ!' : '🎁 ได้รับคูปองพิเศษ!';
    let body;
    if (isMystery) {
        if (recipientRole === 'REFERRER') {
            body = `เพื่อนของคุณ (${refereeId}) ซื้อครั้งแรกสำเร็จแล้ว\nคุณได้รับ "กล่องสุ่ม" — เปิดใน "คูปองของฉัน" เพื่อลุ้นรางวัล`;
        } else if (recipientRole === 'REFEREE') {
            body = `ขอบคุณที่สมัครผ่านลิงก์ของ ${referrerId}\nคุณได้รับ "กล่องสุ่ม" — เปิดใน "คูปองของฉัน" เพื่อลุ้นรางวัล`;
        } else {
            body = `คุณได้รับ "กล่องสุ่ม" — เปิดใน "คูปองของฉัน" เพื่อลุ้นรางวัล`;
        }
    } else {
        if (recipientRole === 'REFERRER') {
            body = `เพื่อนของคุณ (${refereeId}) ซื้อครั้งแรกสำเร็จแล้ว\nคุณได้รับ: ${coupon.name} (${rewardLabel})`;
        } else if (recipientRole === 'REFEREE') {
            body = `ขอบคุณที่สมัครผ่านลิงก์ของ ${referrerId}\nคุณได้รับ: ${coupon.name} (${rewardLabel})`;
        } else {
            body = `คุณได้รับ: ${coupon.name} (${rewardLabel})`;
        }
        if (coupon.validityDays) {
            body += `\nใช้ภายใน ${coupon.validityDays} วันหลังได้รับ`;
        }
    }

    const telegramText = isMystery
        ? `🎁 <b>ได้รับกล่องสุ่มพิเศษ!</b>\n\n` +
          (recipientRole === 'REFERRER'
              ? `เพื่อนของคุณ (<code>${refereeId}</code>) ซื้อครั้งแรกสำเร็จแล้ว\n\n`
              : `ขอบคุณที่สมัครผ่านลิงก์ของ <code>${referrerId}</code>\n\n`) +
          `📦 เปิดที่ "คูปองของฉัน" เพื่อลุ้นรางวัลพิเศษ ✨`
        : `🎁 <b>ได้รับคูปองพิเศษ!</b>\n\n` +
          (recipientRole === 'REFERRER'
              ? `เพื่อนของคุณ (<code>${refereeId}</code>) ซื้อครั้งแรกสำเร็จแล้ว\n`
              : `ขอบคุณที่สมัครผ่านลิงก์ของ <code>${referrerId}</code>\n`) +
          `\n<b>${escapeHtml(coupon.name)}</b>\n${escapeHtml(rewardLabel)}\n` +
          (coupon.validityDays ? `\n⏱ ใช้ภายใน ${coupon.validityDays} วัน` : '');

    await notifyCustomer({
        customerId: recipientId,
        kind: 'REWARD_COUPON_GRANTED',
        title,
        body,
        link: 'dashboard.html',
        payload: { couponId: coupon.id, role: recipientRole, referralRowId, mystery: isMystery },
        entityKey: `coupon:${coupon.id}:ref:${referralRowId || 'na'}:role:${recipientRole}`,
        telegramText,
    });
}

function escapeHtml(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}
