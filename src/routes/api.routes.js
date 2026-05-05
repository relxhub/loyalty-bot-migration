import express from 'express';
import crypto from 'crypto';
import { prisma } from '../db.js';
import { getActiveCampaign } from '../services/campaign.service.js';
import { getConfig } from '../config/config.js';
import { addDays, formatToBangkok } from '../utils/date.utils.js';
import { getCustomerByTelegramId, updateCustomer, countCampaignReferralsByTag, createCustomer } from '../services/customer.service.js';
import { countMonthlyReferrals } from '../services/referral.service.js';
import * as referralService from '../services/referral.service.js';
import { sendOrderPaidAdminNotification } from '../services/order-notification.service.js';
import { getProductPageData } from '../services/product.service.js';
import * as couponService from '../services/coupon.service.js';
import * as shippingService from '../services/shipping.service.js';
import multer from 'multer';
import rateLimit from 'express-rate-limit';

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } }); // 50MB limit

// --- Rate Limiters (Phase 8: Security) ---
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 200, // Limit each IP to 200 requests per windowMs
    message: { error: 'ส่งคำขอมากเกินไป กรุณารอสักครู่แล้วลองใหม่ (Rate Limit Exceeded)' },
    standardHeaders: true,
    legacyHeaders: false,
});

const strictLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 15, // Limit each IP to 15 requests per windowMs
    message: { error: 'ระบบทำงานหนัก กรุณารอสักครู่ (Strict Rate Limit Exceeded)' },
    standardHeaders: true,
    legacyHeaders: false,
});

router.use(apiLimiter); // Apply globally to all /api routes

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
        const { initData, referrerId } = req.body;
        if (!verifyTelegramWebAppData(initData)) {
            return res.status(401).json({ error: "Invalid Telegram Data" });
        }

        const urlParams = new URLSearchParams(initData);
        const userDataStr = urlParams.get('user');
        if (!userDataStr) return res.status(400).json({ error: "User data missing" });

        const userData = JSON.parse(userDataStr);
        const telegramId = userData.id.toString();

        let customer = await getCustomerByTelegramId(telegramId);
        let isNewCustomer = false;

        if (!customer) {
            console.log(`[Auto-Signup] Creating new customer for Telegram ID: ${telegramId}`);
            
            if (referrerId) {
                console.log(`[Auto-Signup] Processing referral from: ${referrerId}`);
                try {
                    await referralService.createPendingReferral(referrerId, {
                        telegramId: telegramId,
                        firstName: userData.first_name || '',
                        lastName: userData.last_name || null,
                        username: userData.username || null,
                        referrerId: referrerId
                    });
                    customer = await getCustomerByTelegramId(telegramId);
                } catch (e) {
                    console.error("Failed to create pending referral during auto-signup:", e);
                    customer = await createCustomer({
                        telegramId: telegramId,
                        firstName: userData.first_name || '',
                        lastName: userData.last_name || '',
                        username: userData.username || '',
                        referrerId: referrerId
                    }, "AUTO_SIGNUP");
                }
            } else {
                customer = await createCustomer({
                    telegramId: telegramId,
                    firstName: userData.first_name || '',
                    lastName: userData.last_name || '',
                    username: userData.username || '',
                    referrerId: null
                }, "AUTO_SIGNUP");
            }
            isNewCustomer = true;
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
        
        // --- ADDED: Preliminary Stock Check to handle partial availability ---
        const stockIssues = [];
        for (const item of cart) {
            const product = await prisma.product.findUnique({ where: { id: parseInt(item.id, 10) } });
            if (!product) {
                stockIssues.push({ id: item.id, name: item.nameEn, error: 'NOT_FOUND' });
            } else if (product.status === 'OUT_OF_STOCK' || product.stockQuantity <= 0) {
                stockIssues.push({ id: item.id, name: product.nameEn, error: 'OUT_OF_STOCK', available: 0 });
            } else if (product.stockQuantity < item.quantity) {
                stockIssues.push({ id: item.id, name: product.nameEn, error: 'INSUFFICIENT_STOCK', available: product.stockQuantity });
            }
        }

        if (stockIssues.length > 0) {
            return res.status(400).json({ 
                success: false, 
                error: 'สินค้าบางรายการมีการเปลี่ยนแปลงสต็อก', 
                stockIssues 
            });
        }

        const result = await prisma.$transaction(async (tx) => {
            // Re-verify stock inside transaction for safety
            for (const item of cart) {
                const product = await tx.product.findUnique({ where: { id: parseInt(item.id, 10) } });
                if (!product || product.stockQuantity < item.quantity) {
                    throw new Error(`สต็อกสินค้า ${item.nameEn} มีการเปลี่ยนแปลง กรุณาลองใหม่อีกครั้ง`);
                }
            }

            // Verify Coupon if applied
            if (appliedCouponId) {
                const customerCoupon = await tx.customerCoupon.findFirst({
                    where: {
                        customerId: customer.customerId,
                        couponId: appliedCouponId,
                        status: 'AVAILABLE'
                    },
                    include: { coupon: true }
                });
                
                if (!customerCoupon) {
                     throw new Error(`คูปอง ${appliedCouponId} ไม่สามารถใช้งานได้ หรือถูกใช้ไปแล้ว`);
                }
                
                // Do NOT mark coupon as used here anymore to allow users to return and pay later.
                // We will mark it as USED in Phase 3 when the SlipOK API confirms payment.
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

            // Clear the user's cart from the database
            const userCart = await tx.cart.findUnique({ where: { customerId: customer.customerId } });
            if (userCart) {
                await tx.cartItem.deleteMany({ where: { cartId: userCart.id } });
            }

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
                    include: { 
                        product: {
                            include: { category: true }
                        } 
                    }
                },
                customer: {
                    select: { firstName: true, lastName: true }
                }
            }
        });

        if (!order) {
            return res.status(404).json({ error: "ไม่พบรายการสั่งซื้อนี้" });
        }

        // Fetch appropriate active bank accounts based on the total amount
        const activeBankAccounts = await prisma.bankAccount.findMany({
            where: {
                isActive: true,
                AND: [
                    {
                        OR: [
                            { minAmount: null },
                            { minAmount: { lte: order.totalAmount } }
                        ]
                    },
                    {
                        OR: [
                            { maxAmount: null },
                            { maxAmount: { gte: order.totalAmount } }
                        ]
                    }
                ]
            }
        });

        // Filter by active time window in Bangkok Time
        let bankAccount = null;
        
        if (activeBankAccounts.length > 0) {
            const bkkTimeOpts = { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit', hour12: false };
            const currentTimeStr = new Date().toLocaleTimeString('en-US', bkkTimeOpts); // e.g., "14:30"
            
            bankAccount = activeBankAccounts.find(account => {
                if (!account.activeStartTime || !account.activeEndTime) return true; // No time limit
                
                const start = account.activeStartTime;
                const end = account.activeEndTime;
                
                if (start <= end) {
                    // Normal range, e.g., 08:00 to 18:00
                    return currentTimeStr >= start && currentTimeStr <= end;
                } else {
                    // Crosses midnight, e.g., 18:00 to 06:00
                    return currentTimeStr >= start || currentTimeStr <= end;
                }
            });
            
            // Fallback to the first one if none matched the time window (or if you prefer, it can be null to show no accounts available)
            if (!bankAccount) {
                 // Or return null if we strictly want no account shown outside hours
                 // bankAccount = null;
                 bankAccount = activeBankAccounts[0]; 
            }
        }

        const fmt = (n) => Number(n).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

        // Surface mismatch info if order is locked (under-paid waiting top-up)
        let mismatchInfo = null;
        if (order.mismatchLocked) {
            const lastLog = await prisma.systemLog.findFirst({
                where: { source: 'PAYMENT', action: 'AMOUNT_MISMATCH', customerId: order.customerId },
                orderBy: { createdAt: 'desc' },
            });
            if (lastLog?.message) {
                try {
                    const parsed = JSON.parse(lastLog.message);
                    if (parsed.orderId === order.id) {
                        const expected = Number(parsed.expected || order.totalAmount);
                        const actual = Number(parsed.actual || 0);
                        const diff = Number(parsed.diff || 0);
                        const copyMessage =
                            `📌 แจ้งโอนเงินขาด\n\n` +
                            `ออเดอร์: #${order.id}\n` +
                            `ยอดที่ต้องโอน: ฿${fmt(expected)}\n` +
                            `ยอดที่โอนแล้ว: ฿${fmt(actual)}\n` +
                            `ขาดอีก: ฿${fmt(Math.abs(diff))}\n\n` +
                            `ลูกค้า: ${order.customerId}`;
                        mismatchInfo = { expected, actual, diff, copyMessage };
                    }
                } catch (e) {}
            }
        }

        // Surface over-paid info — order is PAID but customer transferred more than total
        // Skip if admin already confirmed refund (overPaidRefundedAt set)
        let overPaidInfo = null;
        if (order.status === 'PAID' && !order.overPaidRefundedAt) {
            const payment = await prisma.payment.findUnique({ where: { orderId: order.id } });
            if (payment && Number(payment.amount) > Number(order.totalAmount) + 0.005) {
                const expected = Number(order.totalAmount);
                const actual = Number(payment.amount);
                const diff = Math.round((actual - expected) * 100) / 100;
                const copyMessage =
                    `📌 แจ้งขอคืนเงินส่วนเกิน\n\n` +
                    `ออเดอร์: #${order.id}\n` +
                    `ยอดที่ต้องโอน: ฿${fmt(expected)}\n` +
                    `ยอดที่โอนแล้ว: ฿${fmt(actual)}\n` +
                    `เกินมา: ฿${fmt(diff)}\n\n` +
                    `ลูกค้า: ${order.customerId}`;
                overPaidInfo = { expected, actual, diff, copyMessage };
            }
        }

        res.json({ success: true, order, bankAccount, mismatchInfo, overPaidInfo });
    } catch (error) {
        console.error("Get Order Error:", error);
        res.status(500).json({ error: "เกิดข้อผิดพลาดในการดึงข้อมูลสั่งซื้อ" });
    }
});

// Fetch user's order history
router.get('/orders/history/:telegramId', async (req, res) => {
    try {
        const { telegramId } = req.params;
        const customer = await prisma.customer.findUnique({
            where: { telegramUserId: telegramId }
        });

        if (!customer) {
            return res.status(404).json({ error: "ไม่พบข้อมูลลูกค้า" });
        }

        let orders = await prisma.order.findMany({
            where: {
                customerId: customer.customerId
            },
            orderBy: { createdAt: 'desc' },
            include: {
                items: {
                    include: { product: true }
                },
                payment: true
            }
        });

        // Manually fetch shipping address for each order if needed + derive overPaidInfo
        const fmtTh = (n) => Number(n).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        orders = await Promise.all(orders.map(async (order) => {
            let shippingAddress = null;
            if (order.shippingAddressId) {
                shippingAddress = await prisma.shippingAddress.findUnique({
                    where: { id: order.shippingAddressId }
                });
            }
            // Derive overPaidInfo for orders that are PAID + over-paid + not yet refunded
            let overPaidInfo = null;
            if (order.status === 'PAID' && !order.overPaidRefundedAt && order.payment) {
                const expected = Number(order.totalAmount);
                const actual = Number(order.payment.amount);
                if (actual > expected + 0.005) {
                    const diff = Math.round((actual - expected) * 100) / 100;
                    overPaidInfo = {
                        expected,
                        actual,
                        diff,
                        copyMessage:
                            `📌 แจ้งขอคืนเงินส่วนเกิน\n\n` +
                            `ออเดอร์: #${order.id}\n` +
                            `ยอดที่ต้องโอน: ฿${fmtTh(expected)}\n` +
                            `ยอดที่โอนแล้ว: ฿${fmtTh(actual)}\n` +
                            `เกินมา: ฿${fmtTh(diff)}\n\n` +
                            `ลูกค้า: ${order.customerId}`,
                    };
                }
            }
            return { ...order, shippingAddress, overPaidInfo };
        }));

        const storeSetting = await prisma.storeSetting.findUnique({ where: { id: 1 } });
        const orderExpiryMinutes = storeSetting?.orderExpiryMinutes || 30;

        const trackingConfig = await prisma.systemConfig.findUnique({ where: { key: 'tracking_url_template' } });
        const trackingUrlTemplate = (trackingConfig && trackingConfig.value && trackingConfig.value.trim() !== '') ? trackingConfig.value.trim() : 'https://track.thailandpost.co.th/?trackNumber={{TRACK}}';

        res.json({ success: true, orders, orderExpiryMinutes, trackingUrlTemplate });
    } catch (error) {
        console.error("Order History Error:", error);
        res.status(500).json({ error: "เกิดข้อผิดพลาดในการดึงข้อมูลประวัติคำสั่งซื้อ" });
    }
});

// Manual Cancel Order
router.post('/orders/:orderId/cancel', async (req, res) => {
    try {
        const { orderId } = req.params;
        const { initData } = req.body;

        if (!verifyTelegramWebAppData(initData)) {
            return res.status(401).json({ error: "Invalid Telegram Data" });
        }

        const urlParams = new URLSearchParams(initData);
        const userData = JSON.parse(urlParams.get('user'));
        const telegramId = userData.id.toString();

        const customer = await getCustomerByTelegramId(telegramId);
        if (!customer) {
            return res.status(404).json({ error: "ไม่พบข้อมูลลูกค้า" });
        }

        const order = await prisma.order.findUnique({ where: { id: orderId } });
        if (!order) return res.status(404).json({ error: "ไม่พบออเดอร์นี้" });
        if (order.customerId !== customer.customerId) return res.status(403).json({ error: "ไม่มีสิทธิ์ยกเลิกออเดอร์นี้" });
        if (order.status !== 'PENDING_PAYMENT') return res.status(400).json({ error: "ออเดอร์นี้ไม่สามารถยกเลิกได้แล้ว" });

        await prisma.order.update({
            where: { id: orderId },
            data: { status: 'CANCELLED' }
        });

        res.json({ success: true });
    } catch (error) {
        console.error("Cancel Order Error:", error);
        res.status(500).json({ error: "เกิดข้อผิดพลาดในการยกเลิกออเดอร์" });
    }
});

// SLIPOK Integration
router.post('/orders/:orderId/verify-slip', upload.array('files'), async (req, res) => {
    try {
        const { orderId } = req.params;
        const files = req.files;

        if (!files || files.length === 0) {
            return res.status(400).json({ success: false, error: 'กรุณาอัปโหลดรูปสลิป' });
        }

        const file = files[0];

        // 1. Get Order
        const order = await prisma.order.findUnique({
            where: { id: orderId },
            include: { 
                items: { include: { product: { include: { category: true } } } },
                customer: true 
            }
        });

        if (!order) return res.status(404).json({ success: false, error: 'ไม่พบออเดอร์นี้' });
        if (order.status !== 'PENDING_PAYMENT') return res.status(400).json({ success: false, error: 'ออเดอร์นี้ชำระเงินไปแล้ว หรือถูกยกเลิก' });

        // Re-upload guard: if order is mismatch-locked, block at the door (admin handles via chat)
        if (order.mismatchLocked) {
            return res.status(409).json({
                success: false,
                lockUpload: true,
                error: 'ออเดอร์นี้รอแอดมินดำเนินการ',
                message: 'ออเดอร์นี้ถูกล็อกรอแอดมิน กรุณาทักเข้ามาในแชทบอทเพื่อดำเนินการต่อ',
            });
        }

        // 2. Call SlipOK API
        // BYPASS is on by default to make end-to-end testing easy without real bank transfers.
        // Set BYPASS_SLIPOK=false in .env to enforce real SlipOK verification in production.
        const BYPASS_SLIPOK = process.env.BYPASS_SLIPOK !== 'false';

        let slipData = {};
        let slipAmount = order.totalAmount;
        let slipTransRef = 'BYPASS-' + Date.now();
        let overPaidNote = '';      // banner injected into admin notif if customer over-paid
        let overPaidDiff = 0;       // amount over (positive) for response to customer

        if (BYPASS_SLIPOK) {
            // Fake data for bypass mode
            slipData = {
                success: true,
                data: {
                    amount: slipAmount,
                    transRef: slipTransRef,
                    url: '' // Will let telegram use the uploaded file or none
                }
            };
        } else {
            const slipOkBranchId = process.env.SLIPOK_BRANCH_ID ? process.env.SLIPOK_BRANCH_ID.trim() : null;
            const slipOkApiKey = process.env.SLIPOK_API_KEY ? process.env.SLIPOK_API_KEY.trim() : null;
            
            if (!slipOkBranchId || !slipOkApiKey) {
                 console.error("Missing SLIPOK_BRANCH_ID or SLIPOK_API_KEY in environment variables.");
                 return res.status(500).json({ success: false, error: 'ระบบตรวจสอบสลิปยังไม่พร้อมใช้งาน (Missing API Keys)' });
            }

            if (isNaN(slipOkBranchId)) {
                 return res.status(500).json({ success: false, error: 'การตั้งค่า SLIPOK_BRANCH_ID ผิดพลาด (ต้องเป็นตัวเลขเท่านั้น)' });
            }

            const formData = new FormData();
            const blob = new Blob([file.buffer], { type: file.mimetype || 'image/jpeg' });
            formData.append('files', blob, file.originalname || 'slip.jpg');

            // L1.1 — 15s timeout via AbortController
            // L1.2 — classify errors: 'ok' / 'reject' (slip bad) / 'down' (service or bank unavailable)
            let slipOkOutcome = 'ok';
            let slipOkErrorReason = '';
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 15000);
                let slipOkRes;
                try {
                    slipOkRes = await fetch(`https://api.slipok.com/api/line/apikey/${slipOkBranchId}`, {
                        method: 'POST',
                        headers: { 'x-authorization': slipOkApiKey },
                        body: formData,
                        signal: controller.signal,
                    });
                } finally {
                    clearTimeout(timeoutId);
                }

                if (slipOkRes.status >= 500) {
                    slipOkOutcome = 'down';
                    slipOkErrorReason = `SlipOK HTTP ${slipOkRes.status}`;
                } else {
                    slipData = await slipOkRes.json();
                    if (slipData?.success === false) {
                        // Heuristic: bank-side / service-side issues that should fall back to manual review
                        const bankDownPattern = /(ปรับปรุง|ปิดปรับปรุง|maintenance|unavailable|ไม่พร้อมให้บริการ|service|ธนาคาร|bank.*down|timeout|อยู่ระหว่าง|ขัดข้อง)/i;
                        const errMsg = String(slipData?.message || slipData?.error || '');
                        if (bankDownPattern.test(errMsg)) {
                            slipOkOutcome = 'down';
                            slipOkErrorReason = errMsg;
                        } else {
                            slipOkOutcome = 'reject';
                            slipOkErrorReason = errMsg || 'สลิปไม่ถูกต้อง';
                        }
                    } else if (!slipData?.data) {
                        slipOkOutcome = 'down';
                        slipOkErrorReason = 'SlipOK returned malformed response';
                    }
                }
            } catch (err) {
                slipOkOutcome = 'down';
                slipOkErrorReason = err?.name === 'AbortError' ? 'TIMEOUT_15S' : (err?.message || 'NETWORK_ERROR');
            }

            // L1.2 — Manual-review fallback when SlipOK service / bank is unavailable
            if (slipOkOutcome === 'down') {
                console.error('[SLIPOK] Service unavailable:', slipOkErrorReason);

                // Audit log
                try {
                    await prisma.systemLog.create({
                        data: {
                            level: 'WARN',
                            source: 'PAYMENT',
                            action: 'SLIPOK_DOWN',
                            customerId: order.customerId,
                            message: JSON.stringify({
                                orderId: order.id,
                                reason: slipOkErrorReason,
                                fileName: file.originalname || null,
                                fileSize: file.size,
                            }),
                        },
                    });
                } catch (logErr) {
                    console.error('SystemLog SLIPOK_DOWN failed:', logErr.message);
                }

                // Notify admin with the customer's uploaded slip via multipart sendPhoto
                (async () => {
                    try {
                        const adminToken = process.env.ADMIN_BOT_TOKEN;
                        const groupId = process.env.ADMIN_GROUP_ID || process.env.SUPER_ADMIN_TELEGRAM_ID;
                        if (!adminToken || !groupId) return;

                        const cust = order.customer || await prisma.customer.findUnique({ where: { customerId: order.customerId } });
                        const custName = [cust?.firstName, cust?.lastName].filter(Boolean).join(' ').trim() || '-';
                        const custUsername = cust?.username ? `@${cust.username}` : '';

                        const fmtTh = (n) => Number(n).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

                        let caption = `🟠 <b>ระบบตรวจสลิปอัตโนมัติขัดข้อง — ต้องตรวจด้วยมือ</b>\n\n`;
                        caption += `<b>ออเดอร์:</b> #${order.id}\n`;
                        caption += `<b>ยอดที่ต้องชำระ:</b> ฿${fmtTh(order.totalAmount)}\n\n`;
                        caption += `👤 <b>[ลูกค้า]</b>\n`;
                        caption += `${custName}${custUsername ? ' · ' + custUsername : ''}\n`;
                        caption += `รหัส: <code>${order.customerId}</code>\n\n`;
                        caption += `⚙️ <b>เหตุผล:</b> ${slipOkErrorReason}\n\n`;
                        caption += `ℹ️ ออเดอร์ยังเป็น <code>PENDING_PAYMENT</code> — ยังไม่ตัดสต็อก/คูปอง\n`;
                        caption += `กรุณารอลูกค้าทักเข้ามาในแชทบอท`;

                        const fd = new FormData();
                        fd.append('chat_id', String(groupId));
                        fd.append('caption', caption);
                        fd.append('parse_mode', 'HTML');
                        const photoBlob = new Blob([file.buffer], { type: file.mimetype || 'image/jpeg' });
                        fd.append('photo', photoBlob, file.originalname || 'slip.jpg');

                        const r = await fetch(`https://api.telegram.org/bot${adminToken}/sendPhoto`, {
                            method: 'POST',
                            body: fd,
                        });
                        if (!r.ok) console.error('SLIPOK_DOWN admin notif Telegram error:', await r.json().catch(() => ({})));
                    } catch (e) {
                        console.error('SLIPOK_DOWN admin notif error:', e.message);
                    }
                })();

                return res.status(503).json({
                    success: false,
                    serviceDown: true,
                    manualReview: true,
                    reason: slipOkErrorReason,
                    error: 'ระบบตรวจสลิปอัตโนมัติขัดข้องชั่วคราว',
                    message: 'ระบบตรวจสลิปขัดข้องชั่วคราว แอดมินจะตรวจสอบให้ภายใน 15 นาที กรุณาทักเข้ามาในแชทบอทเพื่อแจ้งหมายเลขออเดอร์',
                });
            }

            if (slipOkOutcome === 'reject') {
                console.error("SlipOK Verification Rejected:", slipOkErrorReason);
                return res.status(400).json({
                    success: false,
                    error: slipOkErrorReason || 'สลิปไม่ถูกต้อง หรือไม่สามารถตรวจสอบได้',
                });
            }

            slipAmount = slipData.data.amount;
            slipTransRef = slipData.data.transRef;

            // 3. Duplicate slip guard — moved BEFORE amount check so reused slips are rejected first
            const existingPayment = await prisma.payment.findFirst({
                where: { slipOkTransactionId: slipTransRef },
            });
            if (existingPayment) {
                return res.status(400).json({ success: false, error: 'สลิปนี้ถูกใช้งานไปแล้ว' });
            }

            // 4. Validate Amount — split under-paid (lock) vs over-paid (auto-accept)
            const expected = parseFloat(order.totalAmount);
            const actual = parseFloat(slipAmount);
            const diff = Math.round((actual - expected) * 100) / 100;
            const fmtTh = (n) => Number(n).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

            // 4a. UNDER-PAID → lock + deduct stock + USE coupon + Payment(PENDING) + admin notif → return locked
            if (diff <= -0.01) {
                // Audit log
                try {
                    await prisma.systemLog.create({
                        data: {
                            level: 'WARN',
                            source: 'PAYMENT',
                            action: 'AMOUNT_MISMATCH',
                            customerId: order.customerId,
                            message: JSON.stringify({
                                orderId: order.id,
                                expected,
                                actual,
                                diff,
                                transRef: slipTransRef,
                                slipUrl: slipData?.data?.url || null,
                            }),
                        },
                    });
                } catch (logErr) {
                    console.error('SystemLog AMOUNT_MISMATCH failed:', logErr.message);
                }

                // Lock + reserve stock/coupon + Payment(PENDING) — all in one transaction
                try {
                    await prisma.$transaction(async (tx) => {
                        await tx.order.update({
                            where: { id: orderId },
                            data: { mismatchLocked: true },
                        });
                        await tx.payment.create({
                            data: {
                                orderId: order.id,
                                amount: actual,
                                status: 'PENDING',
                                slipUrl: slipData?.data?.url || '',
                                slipOkTransactionId: slipTransRef,
                                payload: JSON.stringify({ ...slipData.data, mismatchUnder: true, expected, actual, diff }),
                            },
                        });
                        for (const item of order.items) {
                            await tx.product.update({
                                where: { id: item.productId },
                                data: { stockQuantity: { decrement: item.quantity } },
                            });
                        }
                        if (order.appliedCouponId) {
                            const cc = await tx.customerCoupon.findFirst({
                                where: { customerId: order.customerId, couponId: order.appliedCouponId, status: 'AVAILABLE' },
                            });
                            if (cc) {
                                await tx.customerCoupon.update({
                                    where: { id: cc.id },
                                    data: { status: 'USED', usedAt: new Date() },
                                });
                            }
                        }
                    });
                } catch (txErr) {
                    console.error('Mismatch lock transaction failed:', txErr);
                    return res.status(500).json({ success: false, error: 'เกิดข้อผิดพลาดในการล็อกออเดอร์' });
                }

                // Admin notif (with action buttons) — best-effort, non-blocking
                (async () => {
                    try {
                        const adminToken = process.env.ADMIN_BOT_TOKEN;
                        if (!adminToken) return;

                        const cust = order.customer || await prisma.customer.findUnique({ where: { customerId: order.customerId } });
                        const custName = [cust?.firstName, cust?.lastName].filter(Boolean).join(' ').trim() || '-';
                        const custUsername = cust?.username ? `@${cust.username}` : '';
                        const custTgId = cust?.telegramUserId || '';
                        const diffAbs = fmtTh(Math.abs(diff));

                        let msg = `⚠️ <b>ยอดสลิปไม่ตรงกับออเดอร์ (โอนน้อยกว่า)</b>\n\n`;
                        msg += `<b>ออเดอร์:</b> #${order.id}\n\n`;
                        msg += `👤 <b>[ลูกค้า]</b>\n`;
                        msg += `${custName}${custUsername ? ' · ' + custUsername : ''}\n`;
                        msg += `รหัส: <code>${order.customerId}</code>\n`;
                        if (custTgId) msg += `Telegram ID: <code>${custTgId}</code>\n`;
                        msg += `\n💰 <b>[ยอดเงิน]</b>\n`;
                        msg += `ต้องชำระ: ฿${fmtTh(expected)}\n`;
                        msg += `ในสลิป: ฿${fmtTh(actual)}\n`;
                        msg += `ขาดอีก: <b>฿${diffAbs}</b>\n\n`;
                        msg += `🔒 ออเดอร์ถูกล็อก — ตัดสต็อก/คูปองแล้ว ห้ามลูกค้า re-upload\n`;
                        msg += `รอลูกค้าทักเข้ามาขอ top-up → กดปุ่มด้านล่างเมื่อโอนครบ`;

                        const replyMarkup = {
                            inline_keyboard: [
                                [{ text: '✅ ยืนยันชำระครบ (top-up เรียบร้อย)', callback_data: `mm_paid_${order.id}` }],
                                [{ text: '❌ ปฏิเสธ + ยกเลิกออเดอร์', callback_data: `mm_reject_${order.id}` }],
                            ],
                        };

                        const photoUrl = slipData?.data?.url || null;
                        const sendOne = async (chatId) => {
                            if (!chatId) return;
                            try {
                                const url = photoUrl
                                    ? `https://api.telegram.org/bot${adminToken}/sendPhoto`
                                    : `https://api.telegram.org/bot${adminToken}/sendMessage`;
                                const body = photoUrl
                                    ? { chat_id: chatId, photo: photoUrl, caption: msg, parse_mode: 'HTML', reply_markup: replyMarkup }
                                    : { chat_id: chatId, text: msg, parse_mode: 'HTML', reply_markup: replyMarkup };
                                const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
                                if (!r.ok) console.error(`Mismatch notif Telegram error for ${chatId}:`, await r.json().catch(() => ({})));
                            } catch (e) {
                                console.error(`Mismatch notif fetch error to ${chatId}:`, e.message);
                            }
                        };

                        const groupId = process.env.ADMIN_GROUP_ID || process.env.SUPER_ADMIN_TELEGRAM_ID;
                        if (groupId) await sendOne(groupId);
                    } catch (notifErr) {
                        console.error('Mismatch notif outer error:', notifErr.message);
                    }
                })();

                // Pre-formatted copy message for customer to paste in chat
                const copyMessage =
                    `📌 แจ้งโอนเงินขาด\n\n` +
                    `ออเดอร์: #${order.id}\n` +
                    `ยอดที่ต้องโอน: ฿${fmtTh(expected)}\n` +
                    `ยอดที่โอนแล้ว: ฿${fmtTh(actual)}\n` +
                    `ขาดอีก: ฿${fmtTh(Math.abs(diff))}\n\n` +
                    `ลูกค้า: ${order.customerId}`;

                return res.status(409).json({
                    success: false,
                    mismatch: true,
                    mismatchType: 'under',
                    lockUpload: true,
                    expectedAmount: expected,
                    slipAmount: actual,
                    diff,
                    copyMessage,
                    error: `ยอดเงินไม่ตรงกัน (ต้องชำระ: ฿${fmtTh(expected)}, ในสลิป: ฿${fmtTh(actual)})`,
                    message: `ยอดที่โอนขาดอยู่ ฿${fmtTh(Math.abs(diff))} กรุณาทักเข้ามาในแชทบอทเพื่อแจ้งแอดมินขอโอนเพิ่ม`,
                });
            }

            // 4b. OVER-PAID → continue to PAID flow (auto-accept) — banner attached at admin notif
            if (diff >= 0.01) {
                overPaidDiff = diff;
                overPaidNote = `💰 <b>ลูกค้าโอนเกิน</b> +฿${fmtTh(diff)} — อาจติดต่อขอคืนเงินส่วนต่าง\n\n`;
            }
        }

        // 5. Update Database in Transaction
        await prisma.$transaction(async (tx) => {
            // A. Update Order Status
            await tx.order.update({
                where: { id: orderId },
                data: { status: 'PAID' }
            });

            // B. Create Payment Record
            await tx.payment.create({
                data: {
                    orderId: order.id,
                    amount: parseFloat(slipAmount),
                    status: 'VERIFIED',
                    slipUrl: slipData.data.url || '',
                    slipOkTransactionId: slipTransRef,
                    payload: JSON.stringify(slipData.data),
                    verifiedAt: new Date()
                }
            });

            // C. Deduct Stock
            for (const item of order.items) {
                await tx.product.update({
                    where: { id: item.productId },
                    data: { stockQuantity: { decrement: item.quantity } }
                });
            }

            // D. Deduct Coupon (if any)
            if (order.appliedCouponId) {
                const customerCoupon = await tx.customerCoupon.findFirst({
                    where: {
                        customerId: order.customerId,
                        couponId: order.appliedCouponId,
                        status: 'AVAILABLE'
                    }
                });
                
                if (customerCoupon) {
                    await tx.customerCoupon.update({
                        where: { id: customerCoupon.id },
                        data: { status: 'USED', usedAt: new Date() }
                    });
                }
            }
        });

        // 5.5 Auto-Complete Referral if applicable
        let referralMsg = '';
        try {
            const referralResult = await referralService.completeReferral(order.customerId, parseFloat(slipAmount));
            if (referralResult && referralResult.success) {
                referralMsg = `\n\n🎉 <b>[โบนัสแนะนำเพื่อน]</b>\n${referralResult.message}`;
            }
        } catch (refErr) {
            console.error('Auto referral completion error:', refErr);
        }

        // 6. Send Notification to Admin (Round-Robin & Detailed Summary)
        try {
            await sendOrderPaidAdminNotification(orderId, {
                slipAmount: parseFloat(slipAmount),
                slipPhotoUrl: slipData?.data?.url || '',
                referralMsg,
                bypassMode: BYPASS_SLIPOK,
                mismatchNote: overPaidNote,
                overPaidRefund: overPaidDiff >= 0.01,
            });
        } catch (notifErr) {
            console.error('Failed to send admin notification:', notifErr);
            // Non-fatal — order is already PAID
        }

        // Build over-paid info for frontend lock UI (refund-pending state)
        let overPaidInfoResp = null;
        if (overPaidDiff >= 0.01) {
            const fmtTh2 = (n) => Number(n).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
            const expectedAmt = parseFloat(order.totalAmount);
            const actualAmt = parseFloat(slipAmount);
            overPaidInfoResp = {
                expected: expectedAmt,
                actual: actualAmt,
                diff: overPaidDiff,
                copyMessage:
                    `📌 แจ้งขอคืนเงินส่วนเกิน\n\n` +
                    `ออเดอร์: #${order.id}\n` +
                    `ยอดที่ต้องโอน: ฿${fmtTh2(expectedAmt)}\n` +
                    `ยอดที่โอนแล้ว: ฿${fmtTh2(actualAmt)}\n` +
                    `เกินมา: ฿${fmtTh2(overPaidDiff)}\n\n` +
                    `ลูกค้า: ${order.customerId}`,
            };
        }

        res.json({
            success: true,
            message: overPaidDiff >= 0.01
                ? `ชำระเงินสำเร็จ — คุณโอนเกิน ฿${overPaidDiff.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} สามารถทักแอดมินเพื่อขอคืนเงินส่วนต่างได้`
                : 'ตรวจสอบสลิปและยืนยันการสั่งซื้อสำเร็จ',
            overPaid: overPaidDiff >= 0.01,
            overPaidDiff,
            overPaidInfo: overPaidInfoResp,
            lockUpload: overPaidDiff >= 0.01, // for over-paid: also lock the page (refund-pending UI)
            slipUrl: slipData.data.url,
        });

    } catch (error) {
        console.error("Verify Slip Error:", error);
        res.status(500).json({ success: false, error: error.message || 'เกิดข้อผิดพลาดในการตรวจสอบสลิป' });
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

router.get('/loading-screens', async (req, res) => {
    try {
        const screens = await prisma.loadingScreen.findMany({
            where: { isActive: true },
            orderBy: { order: 'asc' }
        });
        res.json({ success: true, screens });
    } catch (error) {
        console.error("Loading Screens API Error:", error);
        res.status(500).json({ error: "Could not fetch loading screens." });
    }
});

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
        const { telegramId, sort = 'newest', star } = req.query;

        // Base where clause
        let whereClause = { productId: parseInt(productId) };
        if (star) {
            whereClause.rating = parseInt(star);
        }

        let orderBy = { createdAt: 'desc' };
        if (sort === 'oldest') orderBy = { createdAt: 'asc' };
        else if (sort === 'most_likes') orderBy = { likesCount: 'desc' };
        else if (sort === 'least_likes') orderBy = { likesCount: 'asc' };

        // Fetch all reviews for this product to calculate stats (ignoring star filter)
        const allReviews = await prisma.productReview.findMany({
            where: { productId: parseInt(productId) },
            select: { rating: true }
        });

        const totalReviews = allReviews.length;
        const averageRating = totalReviews > 0 
            ? (allReviews.reduce((sum, r) => sum + r.rating, 0) / totalReviews).toFixed(1) 
            : 0;

        const starCounts = {
            5: allReviews.filter(r => r.rating === 5).length,
            4: allReviews.filter(r => r.rating === 4).length,
            3: allReviews.filter(r => r.rating === 3).length,
            2: allReviews.filter(r => r.rating === 2).length,
            1: allReviews.filter(r => r.rating === 1).length,
        };

        const reviews = await prisma.productReview.findMany({
            where: whereClause,
            orderBy: orderBy,
            include: {
                customer: {
                    select: { firstName: true }
                },
                likes: telegramId ? {
                    where: {
                        customer: {
                            telegramUserId: telegramId
                        }
                    }
                } : false
            }
        });

        const formattedReviews = reviews.map(r => {
            let authorName = r.customer.firstName || 'Anonymous';
            if (r.isAnonymous && authorName !== 'Anonymous') {
                if (authorName.length <= 2) {
                    authorName = authorName[0] + '*';
                } else {
                    authorName = authorName[0] + '*'.repeat(Math.max(1, authorName.length - 2)) + authorName[authorName.length - 1];
                }
            }

            return {
                id: r.id,
                rating: r.rating,
                comment: r.comment,
                tags: r.tags ? r.tags.split(',') : [],
                likesCount: r.likesCount,
                isLikedByMe: r.likes ? r.likes.length > 0 : false,
                createdAt: formatToBangkok(r.createdAt),
                author: authorName
            };
        });

        res.json({ 
            success: true, 
            stats: {
                averageRating,
                totalReviews,
                starCounts
            },
            reviews: formattedReviews 
        });

    } catch (error) {
        console.error("Review Fetch Error:", error);
        res.status(500).json({ error: "Could not fetch reviews." });
    }
});

router.get('/reviews/check-eligibility/:productId', async (req, res) => {
    try {
        const { productId } = req.params;
        const { initData } = req.query;

        if (!verifyTelegramWebAppData(initData)) {
            return res.status(401).json({ error: "Invalid Telegram Data." });
        }
        
        const urlParams = new URLSearchParams(initData);
        const userData = JSON.parse(urlParams.get('user'));
        const telegramId = userData.id.toString();

        const customer = await getCustomerByTelegramId(telegramId);
        if (!customer) {
            return res.status(403).json({ error: "User not found." });
        }

        // 1. Check if already reviewed
        const existingReview = await prisma.productReview.findUnique({
            where: {
                productId_customerId: {
                    productId: parseInt(productId),
                    customerId: customer.customerId
                }
            }
        });

        if (existingReview) {
            return res.json({ eligible: false, reason: "ALREADY_REVIEWED" });
        }

        // 2. Check if purchased
        const hasPurchased = await prisma.orderItem.findFirst({
            where: {
                productId: parseInt(productId),
                order: {
                    customerId: customer.customerId,
                    status: { in: ['PAID', 'PROCESSING', 'SHIPPED'] }
                }
            }
        });

        if (!hasPurchased) {
            return res.json({ eligible: false, reason: "NOT_PURCHASED" });
        }

        res.json({ eligible: true });

    } catch (error) {
        console.error("Review Eligibility Check Error:", error);
        res.status(500).json({ error: "Failed to check eligibility." });
    }
});

router.post('/reviews', async (req, res) => {
    try {
        const { productId, customerId, rating, comment, tags, isAnonymous, initData } = req.body;

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
        if (comment.length > 200) {
            return res.status(400).json({ error: "ความคิดเห็นต้องไม่เกิน 200 ตัวอักษร" });
        }

        // 2.5 Check if user purchased the product
        const hasPurchased = await prisma.orderItem.findFirst({
            where: {
                productId: parseInt(productId),
                order: {
                    customerId: customerId,
                    status: { in: ['PAID', 'PROCESSING', 'SHIPPED'] }
                }
            }
        });

        if (!hasPurchased) {
            return res.status(403).json({ error: "คุณต้องสั่งซื้อสินค้านี้ก่อนจึงจะสามารถรีวิวได้" });
        }

        // 3. Create review & award points inside transaction
        const reviewPoints = parseInt(getConfig('reviewPoints')) || 10; // แต้มที่ได้จากการรีวิว
        
        const result = await prisma.$transaction(async (tx) => {
            const newReview = await tx.productReview.create({
                data: {
                    productId: parseInt(productId),
                    customerId: customerId,
                    rating: rating,
                    comment: comment,
                    tags: Array.isArray(tags) ? tags.join(',') : (tags || null),
                    isAnonymous: !!isAnonymous
                }
            });

            if (reviewPoints > 0) {
                await tx.customer.update({
                    where: { customerId: customerId },
                    data: { points: { increment: reviewPoints } }
                });

                await tx.pointTransaction.create({
                    data: {
                        customerId: customerId,
                        amount: reviewPoints,
                        type: 'OTHER',
                        detail: `ได้รับแต้มจากการรีวิวสินค้า`
                    }
                });
            }

            return newReview;
        });

        res.status(201).json({ success: true, review: result, pointsAwarded: reviewPoints });

    } catch (error) {
        if (error.code === 'P2002') { // Prisma unique constraint violation code
            return res.status(409).json({ error: "คุณเคยรีวิวสินค้านี้ไปแล้ว" });
        }
        console.error("Review Submission Error:", error);
        res.status(500).json({ error: "Failed to submit review." });
    }
});

router.post('/reviews/:reviewId/like', async (req, res) => {
    try {
        const { reviewId } = req.params;
        const { initData } = req.body;

        if (!verifyTelegramWebAppData(initData)) {
            return res.status(401).json({ error: "Invalid Telegram Data. Please reload the app." });
        }
        
        const urlParams = new URLSearchParams(initData);
        const userData = JSON.parse(urlParams.get('user'));
        const telegramId = userData.id.toString();

        const customer = await getCustomerByTelegramId(telegramId);
        if (!customer) {
            return res.status(403).json({ error: "User not found." });
        }

        const reviewIdInt = parseInt(reviewId);
        
        // Toggle Like Logic
        const existingLike = await prisma.reviewLike.findUnique({
            where: {
                reviewId_customerId: {
                    reviewId: reviewIdInt,
                    customerId: customer.customerId
                }
            }
        });

        let isLiked = false;
        
        await prisma.$transaction(async (tx) => {
            if (existingLike) {
                // Unlike
                await tx.reviewLike.delete({
                    where: { id: existingLike.id }
                });
                await tx.productReview.update({
                    where: { id: reviewIdInt },
                    data: { likesCount: { decrement: 1 } }
                });
                isLiked = false;
            } else {
                // Like
                await tx.reviewLike.create({
                    data: {
                        reviewId: reviewIdInt,
                        customerId: customer.customerId
                    }
                });
                await tx.productReview.update({
                    where: { id: reviewIdInt },
                    data: { likesCount: { increment: 1 } }
                });
                isLiked = true;
            }
        });

        const updatedReview = await prisma.productReview.findUnique({ where: { id: reviewIdInt } });

        res.json({ success: true, isLiked, likesCount: updatedReview.likesCount });

    } catch (error) {
        console.error("Review Like Error:", error);
        res.status(500).json({ error: "Failed to toggle like." });
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
        const { telegramId, couponId, cartItems, totalAmount, initData } = req.body;

        if (!verifyTelegramWebAppData(initData)) {
            return res.status(401).json({ error: "Invalid Telegram Data" });
        }

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
        const { telegramId, cartItems, initData } = req.body;

        if (!verifyTelegramWebAppData(initData)) {
            return res.status(401).json({ error: "Invalid Telegram Data" });
        }

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
        const { telegramId, favorites, initData } = req.body;

        if (!verifyTelegramWebAppData(initData)) {
            return res.status(401).json({ error: "Invalid Telegram Data" });
        }

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

// ==========================================
// 🎟️ COUPON NOTIFICATION API
// ==========================================
router.get('/coupons/count', async (req, res) => {
    try {
        const now = new Date();
        // แยกนับคูปองทั่วไป (pointsCost = null)
        const regular = await prisma.coupon.count({
            where: {
                isActive: true,
                pointsCost: null,
                isAutoAssign: false,
                OR: [{ validUntil: null }, { validUntil: { gt: now } }]
            }
        });
        // แยกนับคูปองแลกแต้ม (pointsCost > 0)
        const redeemable = await prisma.coupon.count({
            where: {
                isActive: true,
                pointsCost: { gt: 0 },
                isAutoAssign: false,
                OR: [{ validUntil: null }, { validUntil: { gt: now } }]
            }
        });

        console.log(`[CouponCount] Regular: ${regular}, Redeemable: ${redeemable}`);
        res.json({ success: true, regular, redeemable });
    } catch (error) {
        console.error('Error counting coupons:', error);
        res.status(500).json({ success: false, error: 'Internal Server Error' });
    }
});

// ==================================================
// 📸 TELEGRAM IMAGE PROXY
// ==================================================
router.get('/images/:fileId', async (req, res) => {
    try {
        const { fileId } = req.params;
        const botToken = process.env.ADMIN_BOT_TOKEN;
        if (!botToken) return res.status(500).send('Bot token missing');

        // 1. Get file path from Telegram
        const fileLinkRes = await fetch(`https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`);
        const fileLinkData = await fileLinkRes.json();
        
        if (!fileLinkData.ok) {
             return res.status(404).send('Image not found on Telegram');
        }
        
        const filePath = fileLinkData.result.file_path;
        const fileUrl = `https://api.telegram.org/file/bot${botToken}/${filePath}`;
        
        // 2. Fetch the actual file and stream it to the client
        const imgRes = await fetch(fileUrl);
        if (!imgRes.ok) throw new Error(`Failed to fetch image: ${imgRes.statusText}`);
        
        // Forward content type
        const contentType = imgRes.headers.get('content-type');
        if (contentType) res.setHeader('Content-Type', contentType);
        
        // Send the image buffer
        const arrayBuffer = await imgRes.arrayBuffer();
        res.send(Buffer.from(arrayBuffer));

    } catch (e) {
        console.error('Error proxying telegram image:', e);
        res.status(500).send('Error loading image');
    }
});

export default router;