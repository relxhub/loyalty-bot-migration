import express from 'express';
import crypto from 'crypto';
import { prisma } from '../db.js';
import { getActiveCampaign } from '../services/campaign.service.js';
import { getConfig } from '../config/config.js';
import { addDays, formatToBangkok } from '../utils/date.utils.js';
import { getCustomerByTelegramId, updateCustomer, countCampaignReferralsByTag } from '../services/customer.service.js';
import { countMonthlyReferrals } from '../services/referral.service.js';
import * as referralService from '../services/referral.service.js';
import { getProductPageData } from '../services/product.service.js';
import * as couponService from '../services/coupon.service.js';
import * as shippingService from '../services/shipping.service.js';
// No longer import orderBotToken directly here due to module issues.

const router = express.Router();

console.log("✅ API Routes loaded successfully");

// Helper function to get token for verification, directly from process.env
// This ensures it works even if module imports are tricky on Railway
function getVerificationToken() {
    const token = process.env.ORDER_BOT_TOKEN;
    if (!token) {
        console.error("FATAL: ORDER_BOT_TOKEN is missing when trying to verify Telegram Web App data. Please set it in Railway env vars.");
    }
    return token;
}

// Modify verifyTelegramWebAppData to take token internally from getVerificationToken
function verifyTelegramWebAppData(telegramInitData) {
    if (!telegramInitData) {
        console.error("Error: telegramInitData is missing.");
        return false;
    }
    const encoded = decodeURIComponent(telegramInitData);
    const arr = encoded.split('&');
    const hashIndex = arr.findIndex(str => str.startsWith('hash='));
    if (hashIndex === -1) {
        console.error("Error: Hash parameter not found in initData.");
        return false;
    }
    const hash = arr.splice(hashIndex, 1)[0].split('=')[1];
    arr.sort((a, b) => a.localeCompare(b));
    const dataCheckString = arr.join('\n');

    const token = getVerificationToken(); // Get token internally
    console.log('DEBUG: ORDER_BOT_TOKEN direct access in verifyTelegramWebAppData (inside function):', token ? '✅ FOUND' : '❌ MISSING');

    if (!token) {
        console.error("FATAL: ORDER_BOT_TOKEN is missing. Cannot verify Telegram Web App data. (Inside verifyTelegramWebAppData)");
        return false;
    }

    const secret = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
    const _hash = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');

    return _hash === hash;
}

// ==================================================
// 🚪 LOGIN / AUTH
// ==================================================
router.post('/auth', async (req, res) => {
    try {
        const { initData } = req.body;
        if (!verifyTelegramWebAppData(initData)) {
            return res.status(401).json({ error: "Invalid Telegram Data" });
        }

        const urlParams = new URLSearchParams(initData);
        const userDataStr = urlParams.get('user');
        if (!userDataStr) return res.status(400).json({ error: "User data missing" });

        const userData = JSON.parse(userDataStr);
        const telegramId = userData.id.toString();

        let customer = await getCustomerByTelegramId(telegramId);
        
        if (!customer) {
            return res.json({ success: true, isMember: false });
        }

        const hasPhone = !!customer.phoneNumber;

        // Check if the user is also an admin to get their role
        const admin = await prisma.admin.findUnique({
            where: { telegramId: telegramId }
        });
        if (admin) {
            customer.role = admin.role; // Add role to customer object
        }

        // Update Info
        if (customer.firstName !== userData.first_name || customer.lastName !== userData.last_name || customer.username !== userData.username) {
             await updateCustomer(customer.customerId, {
                firstName: userData.first_name,
                lastName: userData.last_name || '',
                username: userData.username || ''
             });
             // Update customer object in memory for current request
             customer.firstName = userData.first_name;
             customer.lastName = userData.last_name;
             customer.username = userData.username;
        }

        // Campaign Logic (Restored with full details)
        let campaignReferralCount = 0;
        let referralTarget = 0;
        let activeCampaignTag = 'Standard';
        let milestoneBonus = 0; 
        let totalReferrals = 0; 
        let referralCountMonth = 0;
        let campaignStartAt = null;
        let campaignEndAt = null;
        let referralBasePoints = parseInt(getConfig('standardReferralPoints')) || 50;

        try {
            totalReferrals = await prisma.customer.count({ where: { referrerId: customer.customerId } });
            referralCountMonth = await countMonthlyReferrals(customer.customerId);
            const campaign = await getActiveCampaign();
            
            if (campaign) {
                 referralBasePoints = campaign.baseReferral || campaign.base || referralBasePoints; // Fallback for old schema
            }

            if (campaign && campaign.startDate) { // Use campaign.startDate based on schema
                activeCampaignTag = campaign.name || 'Active';
                referralTarget = campaign.milestoneTarget;
                milestoneBonus = campaign.milestoneBonus;
                campaignStartAt = campaign.startDate;
                campaignEndAt = campaign.endDate;
                campaignReferralCount = await countCampaignReferralsByTag(customer.customerId, activeCampaignTag);
            }
        } catch (campaignError) {
            console.error("⚠️ Failed to load/calculate campaign data:", campaignError.message);
        }

        // Check for pending referral status
        const pendingReferral = await prisma.referral.findFirst({
            where: {
                refereeId: customer.customerId,
                status: 'PENDING_PURCHASE'
            }
        });

        const customerDataForFrontend = {
            ...customer,
            referralCount: customer.referralCount, // Ensure this is from DB
            totalReferrals: totalReferrals,
            referralCountMonth: referralCountMonth,
            campaignReferralCount: campaignReferralCount,
            referralTarget: referralTarget,
            milestoneBonus: milestoneBonus, 
            activeCampaignTag: activeCampaignTag,
            campaignStartAt: campaignStartAt,
            campaignEndAt: campaignEndAt,
            referralBasePoints: referralBasePoints,
            isPendingReferral: !!pendingReferral, // Add this flag
            orderBotUsername: getConfig('orderBotUsername', 'Onehub_bot') // Add bot username
        };

        return res.json({ success: true, isMember: true, customer: customerDataForFrontend, hasPhone });

    } catch (error) {
        console.error("Auth Error:", error);
        res.status(500).json({ error: 'Auth failed: ' + error.message });
    }
});

// ==================================================
// 📱 UPDATE PHONE
// ==================================================
router.post('/update-phone', async (req, res) => {
    try {
        const { initData, phoneNumber } = req.body;
        
        if (!verifyTelegramWebAppData(initData)) {
            return res.status(401).json({ error: "Invalid Telegram Data" });
        }

        if (!phoneNumber || phoneNumber.trim() === '') {
            return res.status(400).json({ error: "กรุณากรอกเบอร์โทรศัพท์" });
        }

        const urlParams = new URLSearchParams(initData);
        const userData = JSON.parse(urlParams.get('user'));
        const telegramId = userData.id.toString();

        let customer = await getCustomerByTelegramId(telegramId);
        if (!customer) {
            return res.status(404).json({ error: "ไม่พบข้อมูลลูกค้า กรุณาเข้าสู่ระบบก่อน" });
        }

        // Check if phone number is already used by someone else
        const existingPhone = await prisma.customer.findUnique({
            where: { phoneNumber: phoneNumber }
        });

        if (existingPhone && existingPhone.customerId !== customer.customerId) {
            return res.status(400).json({ error: "เบอร์โทรศัพท์นี้ถูกใช้งานโดยบัญชีอื่นแล้ว" });
        }

        // Update phone number
        await updateCustomer(customer.customerId, {
            phoneNumber: phoneNumber
        });

        res.json({ success: true, message: "บันทึกเบอร์โทรศัพท์สำเร็จ" });

    } catch (error) {
        console.error("Update Phone Error:", error);
        res.status(500).json({ error: "เกิดข้อผิดพลาดในการบันทึกเบอร์โทรศัพท์" });
    }
});

// ==================================================
// 🛍️ ORDERS & CHECKOUT
// ==================================================
router.post('/orders/checkout', async (req, res) => {
    try {
        const { initData, cart, shippingAddressId, appliedCouponId, discountAmount, totalAmount } = req.body;
        
        if (!verifyTelegramWebAppData(initData)) {
            return res.status(401).json({ error: "Invalid Telegram Data" });
        }

        const urlParams = new URLSearchParams(initData);
        const userData = JSON.parse(urlParams.get('user'));
        const telegramId = userData.id.toString();

        let customer = await getCustomerByTelegramId(telegramId);
        if (!customer) {
            return res.status(404).json({ error: "ไม่พบข้อมูลลูกค้า" });
        }

        if (!cart || cart.length === 0) {
            return res.status(400).json({ error: "ตะกร้าสินค้าว่างเปล่า" });
        }

        if (!shippingAddressId) {
            return res.status(400).json({ error: "กรุณาเลือกที่อยู่จัดส่ง" });
        }

        // 1. Verify Stock & Generate Order ID inside a transaction
        const orderId = `ORD-${Date.now().toString().slice(-6)}-${Math.floor(1000 + Math.random() * 9000)}`;
        
        const result = await prisma.$transaction(async (tx) => {
            // Verify stock for all items
            for (const item of cart) {
                const product = await tx.product.findUnique({ where: { id: parseInt(item.id, 10) } });
                if (!product) {
                    throw new Error(`ไม่พบสินค้า: ${item.nameEn}`);
                }
                if (product.stockQuantity < item.quantity) {
                    throw new Error(`สินค้า ${product.nameEn} มีไม่พอ (เหลือ ${product.stockQuantity} ชิ้น)`);
                }
            }

            // Verify Coupon if applied
            if (appliedCouponId) {
                const customerCoupon = await tx.customerCoupon.findFirst({
                    where: {
                        customerId: customer.customerId,
                        couponId: appliedCouponId,
                        isUsed: false
                    },
                    include: { coupon: true }
                });
                
                if (!customerCoupon) {
                     throw new Error(`คูปอง ${appliedCouponId} ไม่สามารถใช้งานได้ หรือถูกใช้ไปแล้ว`);
                }
                
                // Mark coupon as used immediately to prevent double spending
                // If payment fails/cancels later, we can implement a refund logic.
                await tx.customerCoupon.update({
                    where: { id: customerCoupon.id },
                    data: { isUsed: true, usedAt: new Date() }
                });
            }

            // Create Order
            const newOrder = await tx.order.create({
                data: {
                    id: orderId,
                    customerId: customer.customerId,
                    totalAmount: parseFloat(totalAmount),
                    status: 'PENDING_PAYMENT',
                    shippingAddressId: parseInt(shippingAddressId, 10),
                    appliedCouponId: appliedCouponId,
                    discountAmount: parseFloat(discountAmount) || 0,
                    items: {
                        create: cart.map(item => ({
                            productId: parseInt(item.id, 10),
                            quantity: parseInt(item.quantity, 10),
                            priceAtPurchase: parseFloat(item.price)
                        }))
                    }
                }
            });

            return newOrder;
        });

        res.json({ success: true, orderId: result.id });

    } catch (error) {
        console.error("Checkout Error:", error);
        res.status(400).json({ error: error.message || "เกิดข้อผิดพลาดในการสร้างรายการสั่งซื้อ" });
    }
});

router.get('/orders/:orderId', async (req, res) => {
    try {
        const { orderId } = req.params;
        const order = await prisma.order.findUnique({
            where: { id: orderId },
            include: {
                items: {
                    include: { product: true }
                },
                customer: {
                    select: { firstName: true, lastName: true }
                }
            }
        });

        if (!order) {
            return res.status(404).json({ error: "ไม่พบรายการสั่งซื้อนี้" });
        }

        res.json({ success: true, order });
    } catch (error) {
        console.error("Get Order Error:", error);
        res.status(500).json({ error: "เกิดข้อผิดพลาดในการดึงข้อมูลสั่งซื้อ" });
    }
});

// ==================================================
// 🔗 LINK ACCOUNT
// ==================================================
router.post('/link', async (req, res) => {
    const { telegramId, customerId, verificationCode } = req.body;

    if (!telegramId || !customerId || !verificationCode) {
        return res.status(400).json({ error: "ข้อมูลไม่ครบถ้วน" });
    }

    try {
        const searchId = customerId.toUpperCase();
        const existingLink = await prisma.customer.findUnique({ where: { telegramUserId: telegramId } });
        if (existingLink) return res.status(400).json({ error: "Telegram นี้เชื่อมบัญชีไปแล้ว" });

        const customer = await prisma.customer.findUnique({ where: { customerId: searchId, isDeleted: false } });
        if (!customer) return res.status(404).json({ error: "ไม่พบรหัสสมาชิกนี้" });
        if (customer.telegramUserId) return res.status(400).json({ error: "รหัสสมาชิกนี้ถูกเชื่อมไปแล้ว" });

        if (customer.verificationCode && String(customer.verificationCode) !== String(verificationCode)) {
            return res.status(400).json({ error: "รหัสยืนยันไม่ถูกต้อง" });
        }

        const campaign = await getActiveCampaign();
        const bonusPoints = campaign?.linkBonus || parseInt(getConfig('standardLinkBonus')) || 50;
        const daysToExtend = parseInt(getConfig('expiryDaysLinkAccount')) || 7;

        const currentExpiry = customer.expiryDate ? new Date(customer.expiryDate) : new Date();
        const today = new Date(); today.setHours(0,0,0,0);
        const baseDate = currentExpiry > today ? currentExpiry : today;
        const newExpiryDate = addDays(baseDate, daysToExtend);

        await prisma.customer.update({
            where: { customerId: searchId },
            data: {
                telegramUserId: telegramId,
                points: { increment: bonusPoints },
                expiryDate: newExpiryDate,
                verificationCode: null
            }
        });

        await prisma.pointTransaction.create({
            data: {
                customerId: searchId,
                amount: bonusPoints,
                type: 'LINK_BONUS',
                detail: `Link Account with Telegram ID: ${telegramId}`
            }
        });

        res.json({
            success: true,
            message: "เชื่อมต่อสำเร็จ",
            points: customer.points + bonusPoints,
            bonus: bonusPoints
        });

    } catch (error) {
        console.error("Link API Error:", error);
        res.status(500).json({ error: "เกิดข้อผิดพลาดในการเชื่อมต่อ" });
    }
});

// ==================================================
// 📦 PRODUCTS
// ==================================================
router.get('/products', async (req, res) => {
    console.log('[API TRACE] Received request for /api/products');
    try {
        const productPageData = await getProductPageData();
        console.log('[API TRACE] Successfully fetched data. Sending response...');
        res.json(productPageData);
    } catch (error) {
        console.error("[API ERROR] in /api/products:", error);
        // Send detailed error back to the client for debugging
        res.status(500).json({ 
            error: "Could not fetch products.",
            message: error.message,
            stack: error.stack 
        });
    }
});

router.patch('/products/:id/status', async (req, res) => {
    try {
        const { id } = req.params;
        const { status, initData } = req.body;

        // 1. Verify SuperAdmin Identity
        if (!verifyTelegramWebAppData(initData)) {
            return res.status(401).json({ error: "Invalid Telegram Data" });
        }
        
        const urlParams = new URLSearchParams(initData);
        const userData = JSON.parse(urlParams.get('user'));
        const telegramId = userData.id.toString();

        const admin = await prisma.admin.findUnique({
            where: { telegramId: telegramId }
        });

        if (!admin || admin.role !== 'SuperAdmin') {
            return res.status(403).json({ error: "Unauthorized: SuperAdmin access required" });
        }

        // 2. Update Status in Prisma
        const updatedProduct = await prisma.product.update({
            where: { id: parseInt(id) },
            data: { status: status }
        });

        // 3. Broadcast Change via Socket.io
        // We access io through the app instance which should be attached to the request
        const io = req.app.get('socketio');
        if (io) {
            io.emit('product_update', {
                productId: updatedProduct.id,
                status: updatedProduct.status,
                stock: updatedProduct.stock
            });
            console.log(`[SOCKET] Broadcasted status update for product ${id}: ${status}`);
        }

        res.json({ success: true, product: updatedProduct });

    } catch (error) {
        console.error("Product Status Update Error:", error);
        res.status(500).json({ error: "Failed to update product status" });
    }
});

// ==================================================
// 📜 HISTORY
// ==================================================
function mapActionName(action) {
    const map = {
        'REFERRAL_BONUS': 'แนะนำเพื่อน',
        'LINK_BONUS': 'โบนัสผูกบัญชี',
        'ADMIN_ADJUST': 'Admin ปรับปรุงยอด',
        'SYSTEM_ADJUST': 'ระบบปรับปรุงยอด',
        'CAMPAIGN_BONUS': 'โบนัสแคมเปญ',
        'REDEEM_REWARD': 'แลกของรางวัล',
        'OTHER': 'อื่นๆ'
    };
    return map[action] || action;
}

router.get('/history/:telegramId', async (req, res) => {
    try {
        const { telegramId } = req.params;
        const customer = await prisma.customer.findUnique({
            where: { telegramUserId: telegramId }
        });

        if (!customer) return res.json({ success: true, logs: [] });

        const logs = await prisma.pointTransaction.findMany({
            where: { customerId: customer.customerId },
            orderBy: { createdAt: 'desc' },
            take: 20,
            select: {
                type: true,
                amount: true,
                createdAt: true,
                detail: true // Ensure detail is selected for mapping
            }
        });

        const formattedLogs = logs.map(log => ({
            action: mapActionName(log.type),
            points: log.amount > 0 ? `+${log.amount}` : `${log.amount}`,
            date: formatToBangkok(log.createdAt),
            isPositive: log.amount > 0,
            detail: log.detail // Include detail for richer display if needed
        }));

        res.json({ success: true, logs: formattedLogs });

    } catch (error) {
        console.error("History API Error:", error);
        res.status(500).json({ error: "ดึงข้อมูลประวัติไม่สำเร็จ" });
    }
});

// ==================================================
// 👥 REFERRALS
// ==================================================

router.post('/referral/register', async (req, res) => {
    const { referrerId, telegramId, firstName, lastName, username } = req.body;

    if (!referrerId || !telegramId || !firstName) {
        return res.status(400).json({ error: 'Missing required referral data.' });
    }

    try {
        const refereeData = { telegramId, firstName, lastName, username, referrerId };
        const result = await referralService.createPendingReferral(referrerId, refereeData);
        
        res.status(201).json({ 
            success: true, 
            message: 'Pending referral created successfully.',
            refereeCustomerId: result.refereeId, // Send back the new customer ID
            orderBotUsername: getConfig('orderBotUsername', 'Onehub_bot') // Include bot username
        });
    } catch (error) {
        console.error("🚨 Referral Registration API Error:", error);
        
        if (error.message.includes("unique constraint")) {
             return res.status(409).json({ error: 'This user is already registered or has a pending referral.' });
        }
        
        res.status(500).json({ error: 'Failed to create pending referral.' });
    }
});

router.get('/referrals/:telegramId', async (req, res) => {
    console.log("==================== DEBUG: /api/referrals ====================");
    try {
        const { telegramId } = req.params;
        console.log(`[1] Received request for telegramId: ${telegramId}`);

        const user = await prisma.customer.findUnique({
            where: { telegramUserId: telegramId },
            select: { customerId: true }
        });

        if (!user) {
            console.log(`[2] ❌ User not found in DB with telegramId: ${telegramId}`);
            console.log("=============================================================");
            return res.json({ success: false, message: "User not found" });
        }

        console.log(`[2] ✅ Found user. CustomerID is: ${user.customerId}`);

        // Fetch referral records from the new Referral table
        const referrals = await prisma.referral.findMany({
            where: { referrerId: user.customerId },
            orderBy: { createdAt: 'desc' }, // Order by when the referral was created (link clicked)
            include: {
                referee: { // Include the actual customer data for the referred person
                    select: {
                        customerId: true,
                        firstName: true,
                        lastName: true,
                        joinDate: true,
                        referralCount: true, // This is referrer's referralCount
                        activeCampaignTag: true
                    }
                }
            }
        });

        console.log(`[3] Found ${referrals.length} referral records for customerId: ${user.customerId}`);

        const formattedList = await Promise.all(referrals.map(async (ref) => {
            const referee = ref.referee; // The customer who was referred

            // --- New Tier-2 Logic (remains mostly same, queries customer table for referee's referrals) ---
            let tier2Referrals = [];
            const tier2Count = await prisma.customer.count({ where: { referrerId: referee.customerId } });

            if (tier2Count > 0) {
                const tier2Customers = await prisma.customer.findMany({
                    where: { referrerId: referee.customerId },
                    orderBy: { joinDate: 'desc' },
                    select: {
                        customerId: true,
                        firstName: true,
                        lastName: true,
                        joinDate: true
                    },
                    take: 10 // Limit to 10 for performance
                });

                tier2Referrals = tier2Customers.map(t2 => {
                    const id = t2.customerId;
                    const maskedId = id.length > 4 ? `${id.substring(0, 2)}****${id.substring(id.length - 2)}` : id;
                    return {
                        id: maskedId,
                        name: `${t2.firstName || ''} ${t2.lastName || ''}`.trim() || 'Guest',
                        joinDate: formatToBangkok(t2.joinDate)
                    };
                });
            }
            // --- End New Logic ---

            return {
                name: `${referee.firstName || 'Guest'} ${referee.lastName || ''}`.trim() || referee.customerId,
                id: referee.customerId,
                joinedAt: formatToBangkok(referee.joinDate), // Use referee's joinDate
                earnedAt: ref.status === 'COMPLETED' ? formatToBangkok(ref.completedAt) : '-',
                tier2Count: tier2Count,
                earned: ref.status === 'COMPLETED' ? ref.bonusAwarded : 0, // Use bonusAwarded from Referral table
                status: ref.status, // Add referral status
                campaign: referee.activeCampaignTag || 'Standard', // Use referee's campaign tag
                tier2Referrals: tier2Referrals // Add the new array
            };
        }));

        console.log(`[4] Successfully formatted list of ${formattedList.length} items. Sending response.`);
        console.log("=============================================================");
        res.json({ success: true, count: referrals.length, data: formattedList });

    } catch (error) {
        console.error("🚨 Referral API Error:", error);
        console.log("=============================================================");
        res.status(500).json({ error: "ดึงข้อมูลการแนะนำไม่สำเร็จ" });
    }
});


// ==================================================
// ⭐️ REVIEWS
// ==================================================

router.get('/reviews/:productId', async (req, res) => {
    try {
        const { productId } = req.params;
        const reviews = await prisma.productReview.findMany({
            where: { productId: parseInt(productId) },
            orderBy: { createdAt: 'desc' },
            include: {
                customer: {
                    select: { firstName: true }
                }
            }
        });

        const formattedReviews = reviews.map(r => ({
            id: r.id,
            rating: r.rating,
            comment: r.comment,
            createdAt: formatToBangkok(r.createdAt),
            author: r.customer.firstName || 'Anonymous'
        }));

        res.json({ success: true, reviews: formattedReviews });

    } catch (error) {
        console.error("Review Fetch Error:", error);
        res.status(500).json({ error: "Could not fetch reviews." });
    }
});

router.post('/reviews', async (req, res) => {
    try {
        const { productId, customerId, rating, comment, initData } = req.body;

        // 1. Validate user identity
        if (!verifyTelegramWebAppData(initData)) {
            return res.status(401).json({ error: "Invalid Telegram Data. Please reload the app." });
        }
        
        const urlParams = new URLSearchParams(initData);
        const userData = JSON.parse(urlParams.get('user'));
        const telegramId = userData.id.toString();

        const customer = await getCustomerByTelegramId(telegramId);
        if (!customer || customer.customerId !== customerId) {
            return res.status(403).json({ error: "User identity mismatch." });
        }

        // 2. Validate input
        if (!productId || !rating || !comment) {
            return res.status(400).json({ error: "Product, rating, and comment are required." });
        }
        if (rating < 1 || rating > 5) {
            return res.status(400).json({ error: "Rating must be between 1 and 5." });
        }

        // 3. Create review
        const newReview = await prisma.productReview.create({
            data: {
                productId: parseInt(productId),
                customerId: customerId,
                rating: rating,
                comment: comment,
            }
        });

        res.status(201).json({ success: true, review: newReview });

    } catch (error) {
        if (error.code === 'P2002') { // Prisma unique constraint violation code
            return res.status(409).json({ error: "You have already reviewed this product." });
        }
        console.error("Review Submission Error:", error);
        res.status(500).json({ error: "Failed to submit review." });
    }
});

// ==================================================
// 🎟️ COUPONS
// ==================================================

/**
 * ดึงรายการคูปองทั้งหมด (สำหรับ Coupon Center - เฉพาะคูปองที่แจกฟรี)
 * รองรับการเช็คว่า user นี้เก็บไปครบหรือยัง
 */
router.get('/coupons', async (req, res) => {
    try {
        const { telegramId } = req.query;
        
        const now = new Date();
        const coupons = await prisma.coupon.findMany({
            where: {
                isActive: true,
                pointsCost: null, // เฉพาะคูปองที่ไม่ต้องใช้แต้มแลก
                isAutoAssign: false, // ซ่อนคูปองที่ตั้งให้แจกอัตโนมัติ
                OR: [
                    { endDate: null },
                    { endDate: { gt: now } } // ยังไม่หมดเขตแจก
                ],
                AND: [
                    {
                        OR: [
                            { validUntil: null },
                            { validUntil: { gt: now } } // ยังไม่หมดอายุการใช้งาน
                        ]
                    }
                ]
            },
            orderBy: { createdAt: 'desc' }
        });
        // ถ้ามีการส่ง telegramId มา ให้เช็คด้วยว่าเก็บไปครบหรือยัง
        if (telegramId) {
            const user = await prisma.customer.findUnique({
                where: { telegramUserId: telegramId },
                select: { customerId: true }
            });

            if (user) {
                const userClaims = await prisma.customerCoupon.findMany({
                    where: { customerId: user.customerId },
                    select: { couponId: true }
                });

                // นับจำนวนที่เก็บไปแล้วในแต่ละคูปอง
                const claimCounts = userClaims.reduce((acc, c) => {
                    acc[c.couponId] = (acc[c.couponId] || 0) + 1;
                    return acc;
                }, {});

                const couponsWithStatus = coupons.map(c => ({
                    ...c,
                    isUserLimitReached: (claimCounts[c.id] || 0) >= c.usageLimitPerUser
                }));

                return res.json({ success: true, coupons: couponsWithStatus });
            }
        }

        res.json({ success: true, coupons });
    } catch (error) {
        console.error("Fetch Coupons Error:", error);
        res.status(500).json({ error: "ดึงข้อมูลคูปองไม่สำเร็จ" });
    }
});

/**
 * ดึงรายการคูปองที่ต้องใช้แต้มแลก (สำหรับ Reward Center)
 */
router.get('/coupons/redeemable', async (req, res) => {
    try {
        const { telegramId } = req.query;
        
        const now = new Date();
        const coupons = await prisma.coupon.findMany({
            where: { 
                isActive: true,
                pointsCost: { gt: 0 }, // เฉพาะคูปองที่ต้องใช้แต้มแลก
                isAutoAssign: false, // ซ่อนคูปองที่ตั้งให้แจกอัตโนมัติ
                OR: [
                    { endDate: null },
                    { endDate: { gt: now } } // ยังไม่หมดเขตแจก
                ],
                AND: [
                    {
                        OR: [
                            { validUntil: null },
                            { validUntil: { gt: now } } // ยังไม่หมดอายุการใช้งาน
                        ]
                    }
                ]
            },
            orderBy: { pointsCost: 'asc' }
        });
        // ถ้ามีการส่ง telegramId มา ให้เช็คโควตาด้วย
        if (telegramId) {
            const user = await prisma.customer.findUnique({
                where: { telegramUserId: telegramId },
                select: { customerId: true, points: true }
            });

            if (user) {
                const userClaims = await prisma.customerCoupon.findMany({
                    where: { customerId: user.customerId },
                    select: { couponId: true }
                });

                const claimCounts = userClaims.reduce((acc, c) => {
                    acc[c.couponId] = (acc[c.couponId] || 0) + 1;
                    return acc;
                }, {});

                const couponsWithStatus = coupons.map(c => ({
                    ...c,
                    isUserLimitReached: (claimCounts[c.id] || 0) >= c.usageLimitPerUser,
                    hasEnoughPoints: user.points >= c.pointsCost
                }));

                return res.json({ success: true, coupons: couponsWithStatus, userPoints: user.points });
            }
        }

        res.json({ success: true, coupons });
    } catch (error) {
        console.error("Fetch Redeemable Coupons Error:", error);
        res.status(500).json({ error: "ดึงข้อมูลคูปองไม่สำเร็จ" });
    }
});

/**
 * ลูกค้าใช้แต้มแลกคูปอง
 */
router.post('/coupons/redeem', async (req, res) => {
    try {
        const { telegramId, couponId, initData } = req.body;

        // Verify Identity
        if (!verifyTelegramWebAppData(initData)) {
            return res.status(401).json({ error: "Invalid Telegram Data" });
        }

        const user = await prisma.customer.findUnique({
            where: { telegramUserId: telegramId },
            select: { customerId: true }
        });

        if (!user) return res.status(404).json({ error: "ไม่พบข้อมูลลูกค้า" });

        const result = await couponService.redeemCouponWithPoints(user.customerId, couponId);
        res.json({ 
            success: true, 
            message: "แลกคูปองสำเร็จ!", 
            coupon: result.customerCoupon,
            remainingPoints: result.remainingPoints
        });
    } catch (error) {
        console.error("Redeem Coupon Error:", error);
        res.status(400).json({ error: error.message });
    }
});

/**
 * ดึงคูปองส่วนตัวของลูกค้า
 */
router.get('/coupons/my/:telegramId', async (req, res) => {
    try {
        const { telegramId } = req.params;
        const user = await prisma.customer.findUnique({
            where: { telegramUserId: telegramId },
            select: { customerId: true }
        });

        if (!user) return res.status(404).json({ error: "ไม่พบข้อมูลลูกค้า" });

        const myCoupons = await couponService.getCustomerCoupons(user.customerId);
        res.json({ success: true, coupons: myCoupons });
    } catch (error) {
        console.error("Fetch My Coupons Error:", error);
        res.status(500).json({ error: "ดึงข้อมูลคูปองส่วนตัวไม่สำเร็จ" });
    }
});

/**
 * ลูกค้ากดเก็บคูปอง (FCFS)
 */
router.post('/coupons/claim', async (req, res) => {
    try {
        const { telegramId, couponId, initData } = req.body;

        // Verify Identity
        if (!verifyTelegramWebAppData(initData)) {
            return res.status(401).json({ error: "Invalid Telegram Data" });
        }

        const user = await prisma.customer.findUnique({
            where: { telegramUserId: telegramId },
            select: { customerId: true }
        });

        if (!user) return res.status(404).json({ error: "ไม่พบข้อมูลลูกค้า" });

        const result = await couponService.claimCoupon(user.customerId, couponId);
        res.json({ success: true, message: "เก็บคูปองสำเร็จ!", coupon: result });
    } catch (error) {
        console.error("Claim Coupon Error:", error);
        res.status(400).json({ error: error.message });
    }
});

/**
 * คำนวณหาคูปองที่ดีที่สุดสำหรับตะกร้าสินค้า
 */
router.post('/coupons/best', async (req, res) => {
    try {
        const { telegramId, cartItems, totalAmount } = req.body;

        const user = await prisma.customer.findUnique({
            where: { telegramUserId: telegramId },
            select: { customerId: true }
        });

        if (!user) return res.status(404).json({ error: "ไม่พบข้อมูลลูกค้า" });

        const bestCoupon = await couponService.getBestCoupon(user.customerId, cartItems, totalAmount);
        res.json({ success: true, bestCoupon });
    } catch (error) {
        console.error("Calculate Best Coupon Error:", error);
        res.status(500).json({ error: "คำนวณคูปองไม่สำเร็จ" });
    }
});

/**
 * ตรวจสอบคูปองที่ลูกค้าเลือกเอง (Manual Selection)
 */
router.post('/coupons/validate', async (req, res) => {
    try {
        const { telegramId, couponId, cartItems, totalAmount } = req.body;

        const user = await prisma.customer.findUnique({
            where: { telegramUserId: telegramId },
            select: { customerId: true }
        });

        if (!user) return res.status(404).json({ error: "ไม่พบข้อมูลลูกค้า" });

        const result = await couponService.validateCouponForCart(user.customerId, couponId, cartItems, totalAmount);
        res.json(result);
    } catch (error) {
        console.error("Validate Coupon Error:", error);
        res.status(400).json({ success: false, error: error.message });
    }
});

// --- System Config ---
router.get('/config/shipping', async (req, res) => {
    try {
        const configs = await prisma.systemConfig.findMany({
            where: {
                key: { in: ['shipping_fee', 'free_shipping_min'] }
            }
        });
        
        const configMap = configs.reduce((acc, c) => {
            acc[c.key] = parseFloat(c.value);
            return acc;
        }, { shipping_fee: 60, free_shipping_min: 500 }); // Default values

        res.json({
            success: true,
            shippingFee: configMap.shipping_fee,
            freeShippingMin: configMap.free_shipping_min
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==================================================
// 🏠 SHIPPING ADDRESSES
// ==================================================

router.get('/shipping-addresses/:telegramId', async (req, res) => {
    try {
        const { telegramId } = req.params;
        const user = await prisma.customer.findUnique({
            where: { telegramUserId: telegramId },
            select: { customerId: true }
        });

        if (!user) return res.status(404).json({ error: "ไม่พบข้อมูลลูกค้า" });

        const addresses = await shippingService.getShippingAddresses(user.customerId);
        res.json({ success: true, addresses });
    } catch (error) {
        console.error("Fetch Addresses Error:", error);
        res.status(500).json({ error: "ดึงข้อมูลที่อยู่ไม่สำเร็จ" });
    }
});

router.post('/shipping-addresses', async (req, res) => {
    try {
        const { telegramId, initData, addressData } = req.body;

        if (!verifyTelegramWebAppData(initData)) {
            return res.status(401).json({ error: "Invalid Telegram Data" });
        }

        const user = await prisma.customer.findUnique({
            where: { telegramUserId: telegramId },
            select: { customerId: true }
        });

        if (!user) return res.status(404).json({ error: "ไม่พบข้อมูลลูกค้า" });

        const address = await shippingService.saveShippingAddress(user.customerId, addressData);
        res.json({ success: true, address });
    } catch (error) {
        console.error("Save Address Error:", error);
        res.status(500).json({ error: "บันทึกที่อยู่ไม่สำเร็จ" });
    }
});

router.delete('/shipping-addresses/:telegramId/:addressId', async (req, res) => {
    try {
        const { telegramId, addressId } = req.params;
        const user = await prisma.customer.findUnique({
            where: { telegramUserId: telegramId },
            select: { customerId: true }
        });

        if (!user) return res.status(404).json({ error: "ไม่พบข้อมูลลูกค้า" });

        await shippingService.deleteShippingAddress(user.customerId, addressId);
        res.json({ success: true, message: "ลบที่อยู่สำเร็จ" });
    } catch (error) {
        console.error("Delete Address Error:", error);
        res.status(500).json({ error: "ลบที่อยู่ไม่สำเร็จ" });
    }
});

// ==================================================
// 🇹🇭 THAI ADDRESS AUTO-COMPLETE
// ==================================================

router.get('/thai-addresses/search', async (req, res) => {
    try {
        const { q } = req.query;
        const suggestions = await shippingService.searchThaiAddress(q);
        res.json({ success: true, suggestions });
    } catch (error) {
        console.error("Thai Address Search Error:", error);
        res.status(500).json({ error: "ค้นหาที่อยู่ไม่สำเร็จ" });
    }
});

// ==========================================
// 🛒 CART API
// ==========================================

router.get('/cart/:telegramId', async (req, res) => {
    try {
        const { telegramId } = req.params;
        const user = await prisma.customer.findUnique({
            where: { telegramUserId: telegramId },
            include: { cart: { include: { items: true } } }
        });

        if (!user) return res.status(404).json({ success: false, error: 'User not found' });

        if (!user.cart) {
            return res.json({ success: true, items: [] });
        }

        // Return standard cart items format
        const items = user.cart.items.map(i => ({
            id: i.productId,
            quantity: i.quantity
        }));

        res.json({ success: true, items });
    } catch (error) {
        console.error('GET Cart Error:', error);
        res.status(500).json({ success: false, error: 'Internal Server Error' });
    }
});

router.post('/cart/sync', async (req, res) => {
    try {
        const { telegramId, cartItems } = req.body;
        // cartItems: [{ id: productId, quantity: 2 }, ...]

        const user = await prisma.customer.findUnique({
            where: { telegramUserId: telegramId }
        });

        if (!user) return res.status(404).json({ success: false, error: 'User not found' });

        // Upsert cart
        let cart = await prisma.cart.findUnique({ where: { customerId: user.customerId } });
        if (!cart) {
            cart = await prisma.cart.create({ data: { customerId: user.customerId } });
        }

        // Instead of complex upserts, just clear and re-create items for simple sync
        // (Since it's a small array, this is fast and robust)
        await prisma.cartItem.deleteMany({ where: { cartId: cart.id } });
        
        if (cartItems && cartItems.length > 0) {
            await prisma.cartItem.createMany({
                data: cartItems.map(item => ({
                    cartId: cart.id,
                    productId: item.id,
                    quantity: item.quantity
                }))
            });
        }

        res.json({ success: true });
    } catch (error) {
        console.error('Sync Cart Error:', error);
        res.status(500).json({ success: false, error: 'Internal Server Error' });
    }
});

// ==========================================
// ❤️ FAVORITES API
// ==========================================

router.get('/favorites/:telegramId', async (req, res) => {
    try {
        const { telegramId } = req.params;
        const user = await prisma.customer.findUnique({
            where: { telegramUserId: telegramId },
            include: { favorites: true }
        });

        if (!user) return res.status(404).json({ success: false, error: 'User not found' });

        const favorites = user.favorites.map(f => f.productId);
        res.json({ success: true, favorites });
    } catch (error) {
        console.error('GET Favorites Error:', error);
        res.status(500).json({ success: false, error: 'Internal Server Error' });
    }
});

router.post('/favorites/sync', async (req, res) => {
    try {
        const { telegramId, favorites } = req.body;
        // favorites: [productId1, productId2, ...]

        const user = await prisma.customer.findUnique({
            where: { telegramUserId: telegramId }
        });

        if (!user) return res.status(404).json({ success: false, error: 'User not found' });

        // Clear existing favorites and replace
        await prisma.favorite.deleteMany({ where: { customerId: user.customerId } });
        
        if (favorites && favorites.length > 0) {
            await prisma.favorite.createMany({
                data: favorites.map(productId => ({
                    customerId: user.customerId,
                    productId: productId
                }))
            });
        }

        res.json({ success: true });
    } catch (error) {
        console.error('Sync Favorites Error:', error);
        res.status(500).json({ success: false, error: 'Internal Server Error' });
    }
});

export default router;