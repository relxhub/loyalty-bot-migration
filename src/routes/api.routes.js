import express from 'express';
import crypto from 'crypto';
import { prisma } from '../db.js';
import { getActiveCampaign } from '../services/campaign.service.js';
import { getConfig, loadConfig } from '../config/config.js';
import { addDays, formatToBangkok } from '../utils/date.utils.js';
import { getCustomerByTelegramId, updateCustomer, countCampaignReferralsByTag, createCustomer } from '../services/customer.service.js';
import { countMonthlyReferrals } from '../services/referral.service.js';
import * as referralService from '../services/referral.service.js';
import { sendOrderPaidAdminNotification } from '../services/order-notification.service.js';
import { sendNotificationToCustomer } from '../services/notification.service.js';
import { recordAdminMessage, stripAdminMessageButtons, notifyAdminOrderActionFromMiniApp } from '../services/admin-message.service.js';
import * as notifCenter from '../services/notification-center.service.js';
import * as mysteryBox from '../services/mystery-box.service.js';
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
                    // ⚠️ FIX: customer อาจถูกสร้างไปแล้วก่อน tx fail (เพราะ createCustomer
                    // รัน OUTSIDE tx) — ต้อง re-check ก่อน เพื่อกัน P2002 unique violation
                    customer = await getCustomerByTelegramId(telegramId);
                    if (!customer) {
                        customer = await createCustomer({
                            telegramId: telegramId,
                            firstName: userData.first_name || '',
                            lastName: userData.last_name || '',
                            username: userData.username || '',
                            referrerId: referrerId
                        }, "AUTO_SIGNUP");
                    }
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

            // Safety: ถ้าหา/สร้างไม่ได้จริงๆ → คืน 500 ที่มีข้อความชัดเจน
            if (!customer) {
                console.error(`[Auto-Signup] FATAL: customer null after creation for tg ${telegramId}`);
                return res.status(500).json({ error: 'ไม่สามารถสร้างบัญชีลูกค้าใหม่ได้ กรุณาลองใหม่' });
            }
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

            // คำนวณ subtotal/shippingFee จาก cart + ตัวเลขที่ส่งมา
            // subtotal  = ผลรวมราคาสินค้า (ก่อนหักคูปอง)
            // shipping  = totalAmount - (subtotal - discountAmount)  (กันค่าติดลบ)
            const subtotalCalc = cart.reduce(
                (s, item) => s + (parseFloat(item.price) || 0) * (parseInt(item.quantity, 10) || 0),
                0
            );
            const discountCalc = parseFloat(discountAmount) || 0;
            const totalCalc = parseFloat(totalAmount) || 0;
            const shippingCalc = Math.max(0, Math.round((totalCalc - (subtotalCalc - discountCalc)) * 100) / 100);

            // Create Order
            const newOrder = await tx.order.create({
                data: {
                    id: orderId,
                    customerId: customer.customerId,
                    totalAmount: totalCalc,
                    status: 'PENDING_PAYMENT',
                    shippingAddressId: parseInt(shippingAddressId, 10),
                    appliedCouponId: appliedCouponId,
                    discountAmount: discountCalc,
                    subtotal: subtotalCalc,
                    shippingFee: shippingCalc,
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

        // ถ้าเป็น PRIZE_DELIVERY → load prize shipment + tickets เพิ่ม
        let prizeShipment = null;
        if (order.kind === 'PRIZE_DELIVERY') {
            const sh = await prisma.prizeShipment.findFirst({
                where: { orderId: order.id },
                include: {
                    tickets: {
                        include: { awardedPrize: { select: { id: true, name: true, imageUrl: true, description: true } } },
                    },
                },
            });
            if (sh) {
                prizeShipment = {
                    id: sh.id,
                    status: sh.status,
                    shippingFee: Number(sh.shippingFeeSnapshot),
                    prizes: sh.tickets.map(t => ({
                        ticketId: t.id,
                        name: t.awardedPrize?.name,
                        description: t.awardedPrize?.description,
                        imageUrl: t.awardedPrize?.imageUrl,
                    })),
                };
            }
        }

        res.json({ success: true, order, bankAccount, mismatchInfo, overPaidInfo, prizeShipment });
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

        // In-app notif (ลูกค้าเป็นคนกดเอง — ไม่ส่ง Telegram ซ้ำ)
        try {
            await notifCenter.notifyOrderStatusChanged({
                orderId,
                customerId: customer.customerId,
                status: 'CANCELLED',
                note: 'คุณยกเลิกออเดอร์นี้',
            });
        } catch (e) { /* silent */ }

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
                        const hasPhoto = !!photoUrl;
                        const sendOne = async (chatId) => {
                            if (!chatId) return null;
                            try {
                                const url = photoUrl
                                    ? `https://api.telegram.org/bot${adminToken}/sendPhoto`
                                    : `https://api.telegram.org/bot${adminToken}/sendMessage`;
                                const body = photoUrl
                                    ? { chat_id: chatId, photo: photoUrl, caption: msg, parse_mode: 'HTML', reply_markup: replyMarkup }
                                    : { chat_id: chatId, text: msg, parse_mode: 'HTML', reply_markup: replyMarkup };
                                const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
                                if (!r.ok) {
                                    console.error(`Mismatch notif Telegram error for ${chatId}:`, await r.json().catch(() => ({})));
                                    return null;
                                }
                                return await r.json();
                            } catch (e) {
                                console.error(`Mismatch notif fetch error to ${chatId}:`, e.message);
                                return null;
                            }
                        };

                        const groupId = process.env.ADMIN_GROUP_ID || process.env.SUPER_ADMIN_TELEGRAM_ID;
                        if (groupId) {
                            const res = await sendOne(groupId);
                            if (res?.result?.message_id) {
                                await recordAdminMessage({
                                    orderId: order.id,
                                    kind: 'MISMATCH_UNDER',
                                    chatId: groupId,
                                    messageId: res.result.message_id,
                                    hasPhoto,
                                });
                            }
                        }
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

        // 5.4 In-app notif: order PAID (best-effort)
        try {
            await notifCenter.notifyOrderStatusChanged({
                orderId: order.id,
                customerId: order.customerId,
                status: 'PAID',
                note: `ยอดชำระ ฿${parseFloat(slipAmount).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
            });
        } catch (e) { /* silent */ }

        // 5.45 Mystery Box: PURCHASE_MILESTONE — เช็คยอดสะสม lifetime ของลูกค้า
        // (best-effort — ไม่กระทบ flow ออเดอร์)
        // skip ถ้าเป็น PRIZE_DELIVERY เพราะค่าส่งของรางวัลไม่ใช่การ "ซื้อ" จริง
        if (order.kind !== 'PRIZE_DELIVERY') try {
            const lifetime = await prisma.order.aggregate({
                where: {
                    customerId: order.customerId,
                    status: { in: ['PAID', 'PROCESSING', 'SHIPPED'] },
                    kind: 'PRODUCT',
                },
                _sum: { totalAmount: true },
            });
            const totalSpend = Number(lifetime._sum.totalAmount) || 0;
            await mysteryBox.grantTickets({
                customerId: order.customerId,
                event: 'PURCHASE_MILESTONE',
                eligibleAmount: totalSpend, // grantTickets ใช้ minPurchaseAmount/maxPurchaseAmount เป็นเงื่อนไข
                metadata: { orderId: order.id, lifetimeSpend: totalSpend },
            });
        } catch (e) { /* silent */ }

        // 5.5 Auto-Complete Referral if applicable
        let referralMsg = '';
        // skip ถ้าเป็น PRIZE_DELIVERY (ค่าส่งไม่ใช่การซื้อสินค้าครั้งแรกจริง)
        if (order.kind !== 'PRIZE_DELIVERY') try {
            const referralResult = await referralService.completeReferral(order.customerId, parseFloat(slipAmount), order.id);
            if (referralResult && referralResult.success) {
                referralMsg = `\n\n🎉 <b>[โบนัสแนะนำเพื่อน]</b>\n${referralResult.message}`;
            }
        } catch (refErr) {
            console.error('Auto referral completion error:', refErr);
        }

        // 6. Send Notification to Admin
        try {
            // ถ้าเป็น PRIZE_DELIVERY → ใช้ notif แบบเฉพาะ (รายการของรางวัลแทนสินค้า)
            if (order.kind === 'PRIZE_DELIVERY') {
                await mysteryBox.sendPrizeOrderAdminNotification(orderId, { isFree: false });
            } else {
                await sendOrderPaidAdminNotification(orderId, {
                    slipAmount: parseFloat(slipAmount),
                    slipPhotoUrl: slipData?.data?.url || '',
                    referralMsg,
                    bypassMode: BYPASS_SLIPOK,
                    mismatchNote: overPaidNote,
                    overPaidRefund: overPaidDiff >= 0.01,
                });
            }
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
function mapActionName(action, detail) {
    const d = (detail || '').trim();

    switch (action) {
        case 'REFERRAL_BONUS': {
            // detail format: "Referral bonus from OT12345.[milestone msg]"
            const m = d.match(/from\s+([A-Za-z0-9_-]+)/);
            return m ? `แนะนำเพื่อน • ${m[1]}` : 'แนะนำเพื่อน';
        }
        case 'LINK_BONUS': {
            if (/Welcome bonus from referral/i.test(d)) return 'โบนัสต้อนรับสมาชิกใหม่';
            if (/Link Account/i.test(d)) return 'โบนัสผูกบัญชี Telegram';
            return 'โบนัสผูกบัญชี';
        }
        case 'CAMPAIGN_BONUS': {
            const m = d.match(/from\s+([A-Za-z0-9_-]+)/);
            return m ? `โบนัสแคมเปญ • แนะนำ ${m[1]}` : 'โบนัสแคมเปญ';
        }
        case 'REDEEM_REWARD': {
            // detail format: "แลกคูปอง <name> (ID: <id>)"
            const m = d.match(/^แลกคูปอง\s+(.+?)\s*\(ID:/);
            if (m) return `แลกคูปอง: ${m[1]}`;
            return d || 'แลกของรางวัล';
        }
        case 'ADMIN_ADJUST':
            return d ? `Admin ปรับปรุงยอด — ${d}` : 'Admin ปรับปรุงยอด';
        case 'SYSTEM_ADJUST':
            return d || 'ระบบปรับปรุงยอด';
        case 'OTHER': {
            if (/รีวิว/.test(d)) return 'คะแนนจากการรีวิวสินค้า';
            return d || 'อื่นๆ';
        }
        default:
            return d || action;
    }
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
            action: mapActionName(log.type, log.detail),
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

// Reward coupons ที่ active (สำหรับ banner หน้าแนะนำเพื่อน)
// ส่งกลับเฉพาะ coupon ที่มี rewardTrigger ตั้งค่าไว้ใน Prisma Studio
router.get('/referral/reward-coupons', async (req, res) => {
    try {
        const now = new Date();
        // กรองเฉพาะ trigger ที่เกี่ยวกับการชวนเพื่อน — ตัด MYSTERY_BOX ออก
        // (MYSTERY_BOX ออกได้เฉพาะเมื่อเปิดกล่องสุ่ม → ไม่ควรโชว์ในหน้าแนะนำเพื่อน)
        const coupons = await prisma.coupon.findMany({
            where: {
                isActive: true,
                rewardTrigger: 'REFEREE_FIRST_PURCHASE',
                AND: [
                    { OR: [{ startDate: null }, { startDate: { lte: now } }] },
                    { OR: [{ endDate: null }, { endDate: { gte: now } }] },
                ],
            },
            orderBy: { createdAt: 'desc' },
            select: {
                id: true,
                name: true,
                nameEn: true,
                description: true,
                descriptionEn: true,
                type: true,
                value: true,
                giftQty: true,
                rewardTrigger: true,
                rewardRecipient: true,
                rewardMinAmount: true,
                rewardMaxAmount: true,
                validityDays: true,
                endDate: true,
            },
        });

        // คืนค่า primitives ที่ frontend แปลงได้ตรงๆ (Decimal → number)
        const out = coupons.map((c) => ({
            id: c.id,
            name: c.name,
            nameEn: c.nameEn,
            description: c.description,
            descriptionEn: c.descriptionEn,
            type: c.type, // DISCOUNT_PERCENT | DISCOUNT_FLAT | GIFT
            value: c.value != null ? Number(c.value) : null,
            giftQty: c.giftQty,
            rewardTrigger: c.rewardTrigger, // REFEREE_FIRST_PURCHASE
            rewardRecipient: c.rewardRecipient || 'REFERRER', // REFERRER | REFEREE | BOTH
            rewardMinAmount: c.rewardMinAmount != null ? Number(c.rewardMinAmount) : null,
            rewardMaxAmount: c.rewardMaxAmount != null ? Number(c.rewardMaxAmount) : null,
            validityDays: c.validityDays,
            endDate: c.endDate,
        }));

        res.json({ success: true, rewards: out });
    } catch (error) {
        console.error('Reward coupons API error:', error);
        res.status(500).json({ success: false, error: 'ดึงข้อมูล reward coupons ไม่สำเร็จ' });
    }
});

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

        // Mystery Box: หากเป็นรีวิวครั้งแรกของลูกค้า → grant ticket REVIEW_PRODUCT
        try {
            const totalReviews = await prisma.productReview.count({ where: { customerId } });
            if (totalReviews === 1) {
                await mysteryBox.grantTickets({
                    customerId,
                    event: 'REVIEW_PRODUCT',
                    metadata: { productId: parseInt(productId) },
                });
            }
        } catch (e) {
            console.error('[Review→MysteryBox] grant failed:', e.message);
        }

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
                rewardTrigger: null, // ซ่อนคูปองที่ตั้งเป็น reward (จะไปแจกผ่าน event เท่านั้น)
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
                rewardTrigger: null, // ซ่อนคูปองที่ตั้งเป็น reward (จะไปแจกผ่าน event เท่านั้น)
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

// Tier config (Bronze/Silver/Gold) สำหรับ referral.html
// อ่านจาก SystemConfig — admin แก้ใน Prisma Studio ได้
router.get('/config/tiers', async (req, res) => {
    try {
        const keys = [
            'tier_silver_min', 'tier_gold_min',
            'tier_bronze_label', 'tier_silver_label', 'tier_gold_label',
            'tier_silver_multiplier', 'tier_gold_multiplier',
        ];
        const rows = await prisma.systemConfig.findMany({ where: { key: { in: keys } } });
        const map = rows.reduce((acc, r) => { acc[r.key] = r.value; return acc; }, {});
        res.json({
            success: true,
            tiers: {
                silverMin: parseInt(map.tier_silver_min) || 3,
                goldMin: parseInt(map.tier_gold_min) || 6,
                bronzeLabel: map.tier_bronze_label || 'Bronze',
                silverLabel: map.tier_silver_label || 'Silver',
                goldLabel: map.tier_gold_label || 'Gold',
                silverMultiplier: Number(map.tier_silver_multiplier) || 1.0,
                goldMultiplier: Number(map.tier_gold_multiplier) || 1.0,
            },
        });
    } catch (e) {
        console.error('Tier config error:', e);
        res.status(500).json({ success: false, error: 'load tier config failed' });
    }
});

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
                rewardTrigger: null,
                OR: [{ validUntil: null }, { validUntil: { gt: now } }]
            }
        });
        // แยกนับคูปองแลกแต้ม (pointsCost > 0)
        const redeemable = await prisma.coupon.count({
            where: {
                isActive: true,
                pointsCost: { gt: 0 },
                isAutoAssign: false,
                rewardTrigger: null,
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

// ==================================================
// 🔔 IN-APP NOTIFICATIONS
// ==================================================
// Helper: หา customer จาก telegramId แล้วคืน customerId — null ถ้าไม่เจอ
async function customerIdFromTelegramId(telegramId) {
    if (!telegramId) return null;
    const c = await prisma.customer.findUnique({
        where: { telegramUserId: String(telegramId) },
        select: { customerId: true },
    });
    return c?.customerId || null;
}

// 1. รายการ notification ของลูกค้า + unread count
router.get('/notifications/:telegramId', async (req, res) => {
    try {
        const { telegramId } = req.params;
        const limit = parseInt(req.query.limit) || 30;
        const customerId = await customerIdFromTelegramId(telegramId);
        if (!customerId) return res.json({ success: true, items: [], unread: 0 });

        const [items, unread] = await Promise.all([
            notifCenter.listNotifications(customerId, { limit }),
            notifCenter.getUnreadCount(customerId),
        ]);
        res.json({ success: true, items, unread });
    } catch (e) {
        console.error('Notifications list error:', e);
        res.status(500).json({ success: false, error: 'โหลด notifications ไม่สำเร็จ' });
    }
});

// 2. unread count อย่างเดียว (สำหรับ badge polling fallback / เปิดแอป)
router.get('/notifications/:telegramId/unread-count', async (req, res) => {
    try {
        const { telegramId } = req.params;
        const customerId = await customerIdFromTelegramId(telegramId);
        if (!customerId) return res.json({ success: true, unread: 0 });
        const unread = await notifCenter.getUnreadCount(customerId);
        res.json({ success: true, unread });
    } catch (e) {
        console.error('Unread count error:', e);
        res.status(500).json({ success: false, error: 'ดึง unread count ไม่สำเร็จ' });
    }
});

// 3. Mark notification ตัวเดียวว่าอ่านแล้ว
router.post('/notifications/:telegramId/:id/read', async (req, res) => {
    try {
        const { telegramId, id } = req.params;
        const customerId = await customerIdFromTelegramId(telegramId);
        if (!customerId) return res.status(404).json({ success: false, error: 'ไม่พบลูกค้า' });
        const row = await notifCenter.markRead(customerId, id);
        res.json({ success: !!row });
    } catch (e) {
        console.error('Mark read error:', e);
        res.status(500).json({ success: false, error: 'mark read ไม่สำเร็จ' });
    }
});

// ==================================================
// 🎁 MYSTERY BOX
// ==================================================

// Catalog: รายการกล่องที่ active + prize pool พร้อม %
// รับ ?telegramId=... เพื่อใส่ user-specific claimed count
router.get('/mystery-box/catalog', async (req, res) => {
    try {
        let customerId = null;
        if (req.query.telegramId) {
            customerId = await customerIdFromTelegramId(req.query.telegramId);
        }
        const boxes = await mysteryBox.listActiveBoxes(customerId);
        res.json({ success: true, boxes });
    } catch (e) {
        console.error('Mystery box catalog error:', e);
        res.status(500).json({ success: false, error: 'โหลด catalog ไม่สำเร็จ' });
    }
});

// ตั๋วของลูกค้า + จำนวนยังไม่เปิด
router.get('/mystery-box/my/:telegramId', async (req, res) => {
    try {
        const customerId = await customerIdFromTelegramId(req.params.telegramId);
        if (!customerId) return res.json({ success: true, tickets: [], unopened: 0 });

        const [tickets, unopened] = await Promise.all([
            mysteryBox.listMyTickets(customerId),
            mysteryBox.getUnopenedCount(customerId),
        ]);
        res.json({ success: true, tickets, unopened });
    } catch (e) {
        console.error('Mystery box my error:', e);
        res.status(500).json({ success: false, error: 'โหลดตั๋วไม่สำเร็จ' });
    }
});

// จำนวนยังไม่เปิด (สำหรับ badge บน dashboard)
router.get('/mystery-box/my/:telegramId/unopened-count', async (req, res) => {
    try {
        const customerId = await customerIdFromTelegramId(req.params.telegramId);
        if (!customerId) return res.json({ success: true, unopened: 0 });
        const unopened = await mysteryBox.getUnopenedCount(customerId);
        res.json({ success: true, unopened });
    } catch (e) {
        console.error('Mystery box unopened error:', e);
        res.status(500).json({ success: false, error: 'นับตั๋วไม่สำเร็จ' });
    }
});

// Claim กล่อง JOIN_CHANNEL — verify membership ก่อนแจก
router.post('/mystery-box/:boxId/claim-channel', async (req, res) => {
    try {
        const { initData } = req.body || {};
        if (!verifyTelegramWebAppData(initData)) {
            return res.status(401).json({ success: false, error: 'Invalid Telegram Data' });
        }
        const urlParams = new URLSearchParams(initData);
        const userData = JSON.parse(urlParams.get('user'));
        const telegramId = userData.id.toString();
        const customerId = await customerIdFromTelegramId(telegramId);
        if (!customerId) return res.status(404).json({ success: false, error: 'ไม่พบลูกค้า' });

        // verify ว่ากล่องนี้เป็น trigger=JOIN_CHANNEL จริง
        const box = await prisma.mysteryBox.findUnique({ where: { id: req.params.boxId } });
        if (!box || !box.isActive || box.trigger !== 'JOIN_CHANNEL') {
            return res.status(400).json({ success: false, error: 'กล่องนี้ไม่ใช่ประเภท join channel' });
        }

        // verify membership ผ่าน Telegram getChatMember
        const orderBotToken = process.env.ORDER_BOT_TOKEN;
        const channelId = getConfig('channelId');
        if (!orderBotToken || !channelId) {
            return res.status(500).json({ success: false, error: 'ระบบยังไม่ได้ตั้งค่า channel' });
        }
        try {
            const url = `https://api.telegram.org/bot${orderBotToken}/getChatMember?chat_id=${channelId}&user_id=${telegramId}`;
            const r = await fetch(url);
            const data = await r.json();
            if (!data.ok) return res.status(400).json({ success: false, error: 'ไม่สามารถตรวจสอบสมาชิก channel ได้' });
            const status = data.result?.status;
            if (!['creator', 'administrator', 'member', 'restricted'].includes(status)) {
                return res.status(400).json({ success: false, error: 'คุณยังไม่ได้เข้าร่วม channel — กดเข้าก่อนแล้วลองใหม่' });
            }
        } catch (e) {
            return res.status(500).json({ success: false, error: 'ตรวจสอบ channel ไม่สำเร็จ' });
        }

        // grant (relies on box.maxPerUser=1 to dedup ตอนเรียกซ้ำ)
        const result = await mysteryBox.grantTickets({
            customerId,
            event: 'JOIN_CHANNEL',
            metadata: { telegramId },
        });

        if (result.granted.length === 0) {
            const skip = result.skipped[0];
            const msg = skip?.reason === 'MAX_PER_USER_REACHED'
                ? 'คุณรับสิทธิ์นี้ไปแล้ว'
                : 'ไม่สามารถรับสิทธิ์ได้ในขณะนี้';
            return res.status(400).json({ success: false, error: msg });
        }

        res.json({ success: true, granted: result.granted });
    } catch (e) {
        console.error('Claim channel mystery box error:', e);
        res.status(500).json({ success: false, error: 'รับสิทธิ์ไม่สำเร็จ' });
    }
});

// 🎁 ของรางวัลของฉัน (physical) — สำหรับแท็บ "ของรางวัลของฉัน"
router.get('/mystery-box/my-prizes/:telegramId', async (req, res) => {
    try {
        const customerId = await customerIdFromTelegramId(req.params.telegramId);
        if (!customerId) return res.json({ success: true, prizes: [] });
        const prizes = await mysteryBox.listMyPrizes(customerId);
        res.json({ success: true, prizes });
    } catch (e) {
        console.error('My prizes error:', e);
        res.status(500).json({ success: false, error: 'โหลดของรางวัลไม่สำเร็จ' });
    }
});

// 🚚 ขอจัดส่งของรางวัล (batch)
router.post('/mystery-box/request-delivery', async (req, res) => {
    try {
        const { initData, ticketIds, shippingAddressId, customerNote } = req.body || {};
        if (!verifyTelegramWebAppData(initData)) {
            return res.status(401).json({ success: false, error: 'Invalid Telegram Data' });
        }
        const urlParams = new URLSearchParams(initData);
        const userData = JSON.parse(urlParams.get('user'));
        const telegramId = userData.id.toString();
        const customerId = await customerIdFromTelegramId(telegramId);
        if (!customerId) return res.status(404).json({ success: false, error: 'ไม่พบลูกค้า' });

        const result = await mysteryBox.requestPrizeDelivery({
            customerId,
            ticketIds,
            shippingAddressId,
            customerNote,
        });
        if (!result.success) {
            const map = {
                INVALID_INPUT: 'ข้อมูลไม่ครบ',
                NO_VALID_TICKETS: 'ไม่มีของรางวัลที่ขอส่งได้',
                INVALID_ADDRESS: 'ที่อยู่ไม่ถูกต้อง',
                NOT_OWNER: 'ของรางวัลบางชิ้นไม่ใช่ของคุณ',
                NOT_OPENED: 'ของรางวัลบางชิ้นยังไม่ได้เปิดกล่อง',
                NOT_PHYSICAL: 'ของรางวัลบางชิ้นไม่ใช่ของจริง (เป็นคูปอง)',
                ALREADY_REQUESTED: 'ของรางวัลบางชิ้นถูกขอส่งไปแล้ว',
                TICKETS_NOT_FOUND: 'ไม่พบของรางวัลบางชิ้น',
            };
            return res.status(400).json({ success: false, error: map[result.error] || 'ขอจัดส่งไม่สำเร็จ' });
        }
        res.json(result);
    } catch (e) {
        console.error('Request delivery error:', e);
        res.status(500).json({ success: false, error: 'ขอจัดส่งไม่สำเร็จ' });
    }
});

// เปิดกล่อง
router.post('/mystery-box/ticket/:ticketId/open', async (req, res) => {
    try {
        const { initData } = req.body || {};
        if (!verifyTelegramWebAppData(initData)) {
            return res.status(401).json({ success: false, error: 'Invalid Telegram Data' });
        }
        const urlParams = new URLSearchParams(initData);
        const userData = JSON.parse(urlParams.get('user'));
        const telegramId = userData.id.toString();
        const customerId = await customerIdFromTelegramId(telegramId);
        if (!customerId) return res.status(404).json({ success: false, error: 'ไม่พบลูกค้า' });

        const result = await mysteryBox.openTicket({ customerId, ticketId: req.params.ticketId });
        if (!result.success) {
            const map = {
                NOT_FOUND: 'ไม่พบตั๋ว',
                NOT_OWNER: 'ตั๋วนี้ไม่ใช่ของคุณ',
                NO_PRIZES_CONFIGURED: 'กล่องนี้ยังไม่ได้ตั้งค่ารางวัล',
                INVALID_WEIGHTS: 'การตั้งค่ารางวัลไม่ถูกต้อง',
                OPEN_FAILED: 'เปิดกล่องไม่สำเร็จ',
                INVALID_INPUT: 'ข้อมูลไม่ครบ',
            };
            return res.status(400).json({ success: false, error: map[result.error] || 'เปิดกล่องไม่สำเร็จ' });
        }
        res.json(result);
    } catch (e) {
        console.error('Open mystery box ticket error:', e);
        res.status(500).json({ success: false, error: 'เปิดกล่องไม่สำเร็จ' });
    }
});

// 4. Mark ทั้งหมดเป็นอ่านแล้ว
router.post('/notifications/:telegramId/read-all', async (req, res) => {
    try {
        const { telegramId } = req.params;
        const customerId = await customerIdFromTelegramId(telegramId);
        if (!customerId) return res.status(404).json({ success: false, error: 'ไม่พบลูกค้า' });
        const count = await notifCenter.markAllRead(customerId);
        res.json({ success: true, count });
    } catch (e) {
        console.error('Mark all read error:', e);
        res.status(500).json({ success: false, error: 'mark all read ไม่สำเร็จ' });
    }
});

// ==================================================
// 🛡️ ADMIN MINI APP (Phase 1 — Prize shipments management)
// ==================================================

// Auth helper: ตรวจ initData + role
async function authAdmin(req, allowedRoles = ['Admin', 'SuperAdmin', 'Owner']) {
    const initData = (req.body && req.body.initData) || req.headers['x-init-data'];
    if (!verifyTelegramWebAppData(initData)) return { ok: false, status: 401, error: 'Invalid Telegram data' };
    let telegramId;
    try {
        const userData = JSON.parse(new URLSearchParams(initData).get('user') || '{}');
        telegramId = String(userData.id || '');
    } catch (e) { return { ok: false, status: 400, error: 'Bad initData' }; }
    if (!telegramId) return { ok: false, status: 400, error: 'No telegramId' };
    const admin = await prisma.admin.findUnique({ where: { telegramId } });
    if (!admin || !allowedRoles.includes(admin.role)) {
        return { ok: false, status: 403, error: 'Forbidden — admin only' };
    }
    return { ok: true, telegramId, admin };
}

// All sections that can be permission-gated. Owner เห็นทุก section + 'admins'+'rbac'+'dashboard' เสมอ
const RBAC_SECTIONS = [
    'orders', 'shipments', 'customers', 'coupons', 'mystery-boxes',
    'products', 'categories', 'banners', 'campaigns',
    'broadcast', 'audit', 'settings', 'ship-sync',
];
const RBAC_DEFAULT = {
    Admin: ['orders', 'shipments', 'customers'],
    SuperAdmin: ['orders', 'shipments', 'customers', 'coupons', 'mystery-boxes', 'products', 'categories', 'banners', 'campaigns', 'broadcast', 'audit', 'settings', 'ship-sync'],
};

async function getRbacMatrix() {
    const row = await prisma.systemConfig.findUnique({ where: { key: 'rbac_matrix' } });
    if (!row?.value) return { ...RBAC_DEFAULT, custom: {} };
    try {
        const parsed = JSON.parse(row.value);
        const customClean = {};
        if (parsed.custom && typeof parsed.custom === 'object') {
            for (const [name, perms] of Object.entries(parsed.custom)) {
                if (typeof name !== 'string' || !name.trim()) continue;
                if (!Array.isArray(perms)) continue;
                customClean[name] = perms.filter(s => RBAC_SECTIONS.includes(s));
            }
        }
        return {
            Admin: Array.isArray(parsed.Admin) ? parsed.Admin.filter(s => RBAC_SECTIONS.includes(s)) : RBAC_DEFAULT.Admin,
            SuperAdmin: Array.isArray(parsed.SuperAdmin) ? parsed.SuperAdmin.filter(s => RBAC_SECTIONS.includes(s)) : RBAC_DEFAULT.SuperAdmin,
            custom: customClean,
        };
    } catch (e) { return { ...RBAC_DEFAULT, custom: {} }; }
}

async function getPermissionsFor(role, customRoleName = null) {
    if (role === 'Owner') return [...RBAC_SECTIONS]; // Owner เห็นทุก section ผ่าน gate
    const matrix = await getRbacMatrix();
    if (customRoleName && matrix.custom?.[customRoleName]) {
        return matrix.custom[customRoleName];
    }
    return matrix[role] || [];
}

// GET /api/admin/me — ใช้ตรวจสิทธิ์ตอน admin-app load
router.get('/admin/me', async (req, res) => {
    const a = await authAdmin(req);
    if (!a.ok) return res.status(a.status).json({ success: false, error: a.error });
    const permissions = await getPermissionsFor(a.admin.role, a.admin.customRoleName);
    let menuOrder = null;
    try { menuOrder = a.admin.menuOrder ? JSON.parse(a.admin.menuOrder) : null; } catch (e) {}
    res.json({
        success: true, telegramId: a.telegramId, role: a.admin.role, name: a.admin.name,
        customRoleName: a.admin.customRoleName || null,
        permissions, allSections: RBAC_SECTIONS,
        menuOrder,
    });
});

// PATCH /admin/me/menu-order { order: ['orders','customers',...] } — บันทึกลำดับเมนูของตัวเอง
router.patch('/admin/me/menu-order', async (req, res) => {
    const a = await authAdmin(req);
    if (!a.ok) return res.status(a.status).json({ success: false, error: a.error });
    try {
        const order = req.body?.order;
        if (order !== null && !Array.isArray(order)) return res.status(400).json({ success: false, error: 'order ต้องเป็น array หรือ null' });
        const cleaned = order ? order.filter(x => typeof x === 'string').slice(0, 50) : null;
        await prisma.admin.update({
            where: { telegramId: a.telegramId },
            data: { menuOrder: cleaned ? JSON.stringify(cleaned) : null },
        });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message || 'failed' }); }
});

// GET /api/admin/rbac-matrix — Owner only
router.get('/admin/rbac-matrix', async (req, res) => {
    const a = await authAdmin(req, ['Owner']);
    if (!a.ok) return res.status(a.status).json({ success: false, error: a.error });
    const matrix = await getRbacMatrix();
    if (!matrix.custom) matrix.custom = {};
    res.json({ success: true, matrix, sections: RBAC_SECTIONS, defaults: RBAC_DEFAULT });
});

// PATCH /api/admin/rbac-matrix — Owner only (รองรับ custom roles)
router.patch('/admin/rbac-matrix', async (req, res) => {
    const a = await authAdmin(req, ['Owner']);
    if (!a.ok) return res.status(a.status).json({ success: false, error: a.error });
    try {
        const m = req.body?.matrix;
        if (!m || typeof m !== 'object') return res.status(400).json({ success: false, error: 'matrix ต้องเป็น object' });
        const customClean = {};
        if (m.custom && typeof m.custom === 'object') {
            for (const [name, perms] of Object.entries(m.custom)) {
                if (typeof name !== 'string' || !name.trim()) continue;
                if (!Array.isArray(perms)) continue;
                customClean[name.trim()] = perms.filter(s => RBAC_SECTIONS.includes(s));
            }
        }
        const cleaned = {
            Admin: Array.isArray(m.Admin) ? m.Admin.filter(s => RBAC_SECTIONS.includes(s)) : [],
            SuperAdmin: Array.isArray(m.SuperAdmin) ? m.SuperAdmin.filter(s => RBAC_SECTIONS.includes(s)) : [],
            custom: customClean,
        };
        await prisma.systemConfig.upsert({
            where: { key: 'rbac_matrix' },
            update: { value: JSON.stringify(cleaned) },
            create: { key: 'rbac_matrix', value: JSON.stringify(cleaned) },
        });
        await prisma.adminAuditLog.create({ data: { adminName: a.admin?.name || a.telegramId, action: 'RBAC_UPDATE', details: JSON.stringify({ Admin: cleaned.Admin.length, SuperAdmin: cleaned.SuperAdmin.length, customCount: Object.keys(customClean).length }) } });
        res.json({ success: true, matrix: cleaned });
    } catch (e) { res.status(500).json({ success: false, error: e.message || 'update failed' }); }
});

// POST /admin/custom-roles { name, permissions[] } — Owner only — สร้างหรือ rename
router.post('/admin/custom-roles', async (req, res) => {
    const a = await authAdmin(req, ['Owner']);
    if (!a.ok) return res.status(a.status).json({ success: false, error: a.error });
    try {
        const name = String(req.body?.name || '').trim();
        const perms = Array.isArray(req.body?.permissions) ? req.body.permissions.filter(s => RBAC_SECTIONS.includes(s)) : [];
        if (!name) return res.status(400).json({ success: false, error: 'name ห้ามว่าง' });
        if (['Admin', 'SuperAdmin', 'Owner'].includes(name)) return res.status(400).json({ success: false, error: 'ห้ามใช้ชื่อ built-in role' });
        const matrix = await getRbacMatrix();
        matrix.custom[name] = perms;
        await prisma.systemConfig.upsert({
            where: { key: 'rbac_matrix' },
            update: { value: JSON.stringify(matrix) },
            create: { key: 'rbac_matrix', value: JSON.stringify(matrix) },
        });
        await prisma.adminAuditLog.create({ data: { adminName: a.admin?.name || a.telegramId, action: 'CUSTOM_ROLE_UPSERT', details: JSON.stringify({ name, permsCount: perms.length }) } });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message || 'create failed' }); }
});

// DELETE /admin/custom-roles/:name — Owner only
router.delete('/admin/custom-roles/:name', async (req, res) => {
    const a = await authAdmin(req, ['Owner']);
    if (!a.ok) return res.status(a.status).json({ success: false, error: a.error });
    try {
        const name = req.params.name;
        // ถ้ามี admin ใช้ role นี้อยู่ → block
        const used = await prisma.admin.count({ where: { customRoleName: name } });
        if (used > 0) return res.status(400).json({ success: false, error: `ลบไม่ได้ — มี admin ${used} คนใช้ role นี้อยู่` });
        const matrix = await getRbacMatrix();
        if (!matrix.custom[name]) return res.status(404).json({ success: false, error: 'ไม่พบ role' });
        delete matrix.custom[name];
        await prisma.systemConfig.update({
            where: { key: 'rbac_matrix' }, data: { value: JSON.stringify(matrix) },
        });
        await prisma.adminAuditLog.create({ data: { adminName: a.admin?.name || a.telegramId, action: 'CUSTOM_ROLE_DELETE', details: JSON.stringify({ name }) } });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message || 'delete failed' }); }
});

// GET /api/admin/prize-shipments — list ตามสถานะ
router.get('/admin/prize-shipments', async (req, res) => {
    const a = await authAdmin(req);
    if (!a.ok) return res.status(a.status).json({ success: false, error: a.error });
    try {
        const status = String(req.query.status || 'PENDING').toUpperCase();
        const shipments = await prisma.prizeShipment.findMany({
            where: status === 'ALL' ? {} : { status },
            include: {
                tickets: { include: { awardedPrize: { select: { id: true, name: true, imageUrl: true } } } },
                order: { select: { id: true, status: true, totalAmount: true } },
            },
            orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
            take: 100,
        });
        // attach address + customer info
        const out = await Promise.all(shipments.map(async (sh) => {
            const addr = await prisma.shippingAddress.findUnique({ where: { id: sh.shippingAddressId } });
            const cust = await prisma.customer.findUnique({
                where: { customerId: sh.customerId },
                select: { customerId: true, firstName: true, lastName: true, telegramUserId: true, phoneNumber: true },
            });
            return {
                id: sh.id,
                status: sh.status,
                shippingFee: Number(sh.shippingFeeSnapshot),
                trackingNumber: sh.trackingNumber,
                shippedAt: sh.shippedAt,
                createdAt: sh.createdAt,
                customer: cust,
                address: addr,
                order: sh.order ? { id: sh.order.id, status: sh.order.status, totalAmount: Number(sh.order.totalAmount) } : null,
                prizes: sh.tickets.map(t => ({
                    ticketId: t.id,
                    name: t.awardedPrize?.name || '—',
                    imageUrl: t.awardedPrize?.imageUrl,
                })),
            };
        }));
        res.json({ success: true, shipments: out });
    } catch (e) {
        console.error('admin prize shipments error:', e);
        res.status(500).json({ success: false, error: 'load failed' });
    }
});

// ---------- 📦 ORDERS ----------
// GET /admin/orders?status=...&q=...&kind=PRODUCT|PRIZE_DELIVERY|ALL
// status: ALL | PENDING_PAYMENT | NEEDS_VERIFY | PAID | PROCESSING | SHIPPED | CANCELLED
//   "NEEDS_VERIFY" = status PAID + payment.status PENDING (สลิปอัปแล้วยังไม่อนุมัติ)
router.get('/admin/orders', async (req, res) => {
    const a = await authAdmin(req);
    if (!a.ok) return res.status(a.status).json({ success: false, error: a.error });
    try {
        const status = String(req.query.status || 'NEEDS_VERIFY').toUpperCase();
        const kind = String(req.query.kind || 'ALL').toUpperCase();
        const q = String(req.query.q || '').trim();
        const take = Math.min(parseInt(req.query.take) || 50, 200);

        const where = {};
        if (kind !== 'ALL') where.kind = kind;
        if (status === 'NEEDS_VERIFY') {
            where.payment = { status: 'PENDING' };
            where.status = { in: ['PENDING_PAYMENT', 'PAID'] };
        } else if (status !== 'ALL') {
            where.status = status;
        }
        // role-based scope (Admin = ตัวเอง+orphan, SuperAdmin/Owner = ทั้งหมด) + search ใช้ AND ของ ORs
        const ands = [];
        if (a.admin.role === 'Admin') {
            ands.push({ OR: [
                { assignedAdminId: a.telegramId },
                { assignedAdminId: null }, // ยังไม่ assign (PENDING_PAYMENT/orphan) — ทุก admin เห็นได้
            ]});
        }
        if (q) {
            ands.push({ OR: [
                { id: { contains: q, mode: 'insensitive' } },
                { customerId: { contains: q, mode: 'insensitive' } },
                { customer: { phoneNumber: { contains: q } } },
                { customer: { firstName: { contains: q, mode: 'insensitive' } } },
                { customer: { lastName: { contains: q, mode: 'insensitive' } } },
            ]});
        }
        if (ands.length) where.AND = ands;
        const orders = await prisma.order.findMany({
            where,
            include: {
                customer: { select: { customerId: true, firstName: true, lastName: true, phoneNumber: true } },
                payment: { select: { status: true, amount: true, slipUrl: true, verifiedAt: true, createdAt: true } },
                items: { select: { quantity: true } },
            },
            orderBy: { createdAt: 'desc' },
            take,
        });
        // map assignedAdminId → name สำหรับแสดง (SuperAdmin/Owner เท่านั้น)
        const assignedIds = [...new Set(orders.map(o => o.assignedAdminId).filter(Boolean))];
        const assignedAdmins = assignedIds.length ? await prisma.admin.findMany({
            where: { telegramId: { in: assignedIds } },
            select: { telegramId: true, name: true },
        }) : [];
        const adminNameMap = Object.fromEntries(assignedAdmins.map(x => [x.telegramId, x.name]));
        const out = orders.map(o => ({
            id: o.id,
            kind: o.kind,
            status: o.status,
            totalAmount: Number(o.totalAmount),
            subtotal: o.subtotal != null ? Number(o.subtotal) : null,
            shippingFee: o.shippingFee != null ? Number(o.shippingFee) : null,
            discountAmount: Number(o.discountAmount || 0),
            mismatchLocked: o.mismatchLocked,
            overPaidRefundedAt: o.overPaidRefundedAt,
            billNumber: o.billNumber,
            trackingNumber: o.trackingNumber,
            assignedAdminId: o.assignedAdminId,
            assignedAdminName: o.assignedAdminId ? (adminNameMap[o.assignedAdminId] || null) : null,
            createdAt: o.createdAt,
            updatedAt: o.updatedAt,
            itemCount: o.items.reduce((s, i) => s + i.quantity, 0),
            customer: o.customer,
            payment: o.payment ? {
                status: o.payment.status,
                amount: Number(o.payment.amount),
                hasSlip: !!o.payment.slipUrl,
                verifiedAt: o.payment.verifiedAt,
                createdAt: o.payment.createdAt,
            } : null,
        }));

        // counts สำหรับ tab badges (in-flight statuses เท่านั้น เพื่อไม่ให้ช้า)
        const counts = {};
        const statusesForBadge = ['NEEDS_VERIFY', 'PENDING_PAYMENT', 'PAID', 'PROCESSING'];
        const scopeWhere = a.admin.role === 'Admin' ? {
            OR: [{ assignedAdminId: a.telegramId }, { assignedAdminId: null }],
        } : {};
        await Promise.all(statusesForBadge.map(async (s) => {
            if (s === 'NEEDS_VERIFY') {
                counts[s] = await prisma.order.count({ where: { ...scopeWhere, payment: { status: 'PENDING' }, status: { in: ['PENDING_PAYMENT', 'PAID'] } } });
            } else {
                counts[s] = await prisma.order.count({ where: { ...scopeWhere, status: s } });
            }
        }));
        res.json({ success: true, orders: out, counts });
    } catch (e) {
        console.error('admin orders list error:', e);
        res.status(500).json({ success: false, error: e.message || 'load failed' });
    }
});

// GET /admin/orders/:id — full detail
router.get('/admin/orders/:id', async (req, res) => {
    const a = await authAdmin(req);
    if (!a.ok) return res.status(a.status).json({ success: false, error: a.error });
    try {
        // ถ้า Admin role + order มี assignedAdminId ที่ไม่ใช่ตน → block
        if (a.admin.role === 'Admin') {
            const meta = await prisma.order.findUnique({ where: { id: req.params.id }, select: { assignedAdminId: true } });
            if (meta?.assignedAdminId && meta.assignedAdminId !== a.telegramId) {
                return res.status(403).json({ success: false, error: 'ออเดอร์นี้ไม่ได้อยู่ในความดูแลของคุณ' });
            }
        }
        const order = await prisma.order.findUnique({
            where: { id: req.params.id },
            include: {
                customer: true,
                items: { include: { product: { include: { category: { select: { id: true, name: true } } } } } },
                payment: true,
                prizeShipment: { include: { tickets: { include: { awardedPrize: { select: { name: true, imageUrl: true } } } } } },
            },
        });
        if (!order) return res.status(404).json({ success: false, error: 'ไม่พบออเดอร์' });

        let address = null;
        if (order.shippingAddressId) {
            address = await prisma.shippingAddress.findUnique({ where: { id: order.shippingAddressId } });
        }
        let coupon = null;
        if (order.appliedCouponId) {
            coupon = await prisma.coupon.findUnique({
                where: { id: order.appliedCouponId },
                select: { id: true, name: true, type: true, value: true },
            });
        }
        // audit log: actions ที่เคยเกิดกับออเดอร์นี้
        const audit = await prisma.adminAuditLog.findMany({
            where: { details: { contains: order.id } },
            orderBy: { createdAt: 'desc' },
            take: 20,
            select: { adminName: true, action: true, createdAt: true, details: true },
        });

        res.json({
            success: true,
            order: {
                id: order.id,
                kind: order.kind,
                status: order.status,
                customerId: order.customerId,
                totalAmount: Number(order.totalAmount),
                subtotal: order.subtotal != null ? Number(order.subtotal) : null,
                shippingFee: order.shippingFee != null ? Number(order.shippingFee) : null,
                discountAmount: Number(order.discountAmount || 0),
                appliedCouponId: order.appliedCouponId,
                billNumber: order.billNumber,
                trackingNumber: order.trackingNumber,
                refundSlipUrl: order.refundSlipUrl,
                mismatchLocked: order.mismatchLocked,
                overPaidRefundedAt: order.overPaidRefundedAt,
                createdAt: order.createdAt,
                updatedAt: order.updatedAt,
                customer: order.customer ? {
                    customerId: order.customer.customerId,
                    firstName: order.customer.firstName, lastName: order.customer.lastName,
                    username: order.customer.username, phoneNumber: order.customer.phoneNumber,
                    telegramUserId: order.customer.telegramUserId, points: order.customer.points,
                } : null,
                items: order.items.map(it => ({
                    id: it.id, quantity: it.quantity, priceAtPurchase: Number(it.priceAtPurchase),
                    product: { id: it.product.id, name: it.product.name, nameEn: it.product.nameEn, imageUrl: it.product.imageUrl, category: it.product.category },
                })),
                payment: order.payment ? {
                    id: order.payment.id, status: order.payment.status,
                    amount: Number(order.payment.amount), slipUrl: order.payment.slipUrl,
                    slipOkTransactionId: order.payment.slipOkTransactionId,
                    verifiedAt: order.payment.verifiedAt, createdAt: order.payment.createdAt,
                } : null,
                address, coupon,
                prizeShipment: order.prizeShipment ? {
                    id: order.prizeShipment.id, status: order.prizeShipment.status,
                    trackingNumber: order.prizeShipment.trackingNumber,
                    prizes: order.prizeShipment.tickets.map(t => ({ name: t.awardedPrize?.name, imageUrl: t.awardedPrize?.imageUrl })),
                } : null,
                audit,
            },
        });
    } catch (e) {
        console.error('admin order detail error:', e);
        res.status(500).json({ success: false, error: e.message || 'load failed' });
    }
});

// helper: emit realtime event เมื่อออเดอร์ถูกแก้
function emitOrderUpdate(req, orderId, newStatus = null) {
    try {
        req.app.get('socketio')?.emit('order_update', { id: orderId, status: newStatus, ts: Date.now() });
    } catch (e) {}
}
function emitShipmentUpdate(req, shipmentId, newStatus = null) {
    try {
        req.app.get('socketio')?.emit('shipment_update', { id: shipmentId, status: newStatus, ts: Date.now() });
    } catch (e) {}
}

// POST /admin/orders/:id/approve — เห็นยอด under-paid + ยืนยันว่ารับ top-up จากลูกค้าแล้ว
router.post('/admin/orders/:id/approve', async (req, res) => {
    const a = await authAdmin(req);
    if (!a.ok) return res.status(a.status).json({ success: false, error: a.error });
    try {
        const order = await prisma.order.findUnique({
            where: { id: req.params.id },
            include: { payment: true, customer: true },
        });
        if (!order) return res.status(404).json({ success: false, error: 'ไม่พบออเดอร์' });
        if (order.status !== 'PENDING_PAYMENT') {
            return res.status(400).json({ success: false, error: 'ออเดอร์นี้ดำเนินการไปแล้ว' });
        }
        await prisma.$transaction(async (tx) => {
            await tx.order.update({ where: { id: order.id }, data: { status: 'PAID', mismatchLocked: false } });
            if (order.payment) {
                let prevPayload = {};
                try { prevPayload = order.payment.payload ? JSON.parse(order.payment.payload) : {}; } catch (e) {}
                await tx.payment.update({
                    where: { id: order.payment.id },
                    data: {
                        amount: Number(order.totalAmount), status: 'VERIFIED', verifiedAt: new Date(),
                        payload: JSON.stringify({ ...prevPayload, acceptedByAdmin: a.telegramId, viaMiniApp: true, topUpCompleted: true }),
                    },
                });
            }
            await tx.adminAuditLog.create({
                data: { adminName: a.admin?.name || a.telegramId, action: 'MISMATCH_ACCEPT', targetId: order.customerId,
                    details: JSON.stringify({ orderId: order.id, totalAmount: Number(order.totalAmount), via: 'mini-app' }) },
            });
        });
        try { await notifCenter.notifyOrderStatusChanged({ orderId: order.id, customerId: order.customerId, status: 'PAID' }); } catch (e) {}
        try { await referralService.completeReferral(order.customerId, Number(order.totalAmount), order.id); } catch (e) {}
        // cross-channel: ลบปุ่มใน TG + reply note
        try {
            await stripAdminMessageButtons(order.id, ['MISMATCH_UNDER', 'NEW_ORDER']);
            await notifyAdminOrderActionFromMiniApp({ orderId: order.id, action: '✅ อนุมัติสลิป (รับยอดเต็ม)', byAdmin: a.admin?.name || a.telegramId, kindFilter: ['MISMATCH_UNDER', 'NEW_ORDER'] });
        } catch (e) {}
        emitOrderUpdate(req, order.id, 'PAID');
        res.json({ success: true });
    } catch (e) {
        console.error('admin order approve error:', e);
        res.status(500).json({ success: false, error: e.message || 'approve failed' });
    }
});

// POST /admin/orders/:id/reject — ปฏิเสธสลิป + ยกเลิกออเดอร์ (mismatch under-paid case)
router.post('/admin/orders/:id/reject', async (req, res) => {
    const a = await authAdmin(req);
    if (!a.ok) return res.status(a.status).json({ success: false, error: a.error });
    try {
        const order = await prisma.order.findUnique({
            where: { id: req.params.id },
            include: { items: true, payment: true, customer: true },
        });
        if (!order) return res.status(404).json({ success: false, error: 'ไม่พบออเดอร์' });
        if (order.status === 'CANCELLED') return res.status(400).json({ success: false, error: 'ออเดอร์ถูกยกเลิกไปแล้ว' });
        if (order.status !== 'PENDING_PAYMENT') return res.status(400).json({ success: false, error: 'ออเดอร์นี้ดำเนินการไปแล้ว' });

        const wasLocked = !!order.mismatchLocked;
        const paidAmount = order.payment?.amount ? Number(order.payment.amount) : 0;

        await prisma.$transaction(async (tx) => {
            await tx.order.update({ where: { id: order.id }, data: { status: 'CANCELLED', mismatchLocked: false } });
            if (wasLocked) {
                for (const item of order.items) {
                    await tx.product.update({ where: { id: item.productId }, data: { stockQuantity: { increment: item.quantity } } });
                }
                if (order.appliedCouponId) {
                    const cc = await tx.customerCoupon.findFirst({ where: { customerId: order.customerId, couponId: order.appliedCouponId } });
                    if (cc && cc.status === 'USED') {
                        await tx.customerCoupon.update({ where: { id: cc.id }, data: { status: 'AVAILABLE', usedAt: null } });
                    }
                }
            }
            if (order.payment) {
                await tx.payment.update({ where: { id: order.payment.id }, data: { status: 'REJECTED' } });
            }
            await tx.adminAuditLog.create({
                data: { adminName: a.admin?.name || a.telegramId, action: 'MISMATCH_REJECT', targetId: order.customerId,
                    details: JSON.stringify({ orderId: order.id, totalAmount: Number(order.totalAmount), paidAmount, wasLocked, via: 'mini-app' }) },
            });
        });
        try {
            await notifCenter.notifyOrderStatusChanged({
                orderId: order.id, customerId: order.customerId, status: 'CANCELLED',
                note: 'ยอดสลิปไม่ตรงกับยอดที่ต้องชำระ',
            });
        } catch (e) {}
        try {
            await stripAdminMessageButtons(order.id, ['MISMATCH_UNDER', 'NEW_ORDER']);
            await notifyAdminOrderActionFromMiniApp({
                orderId: order.id, action: '❌ ปฏิเสธสลิป + ยกเลิกออเดอร์',
                byAdmin: a.admin?.name || a.telegramId, kindFilter: ['MISMATCH_UNDER', 'NEW_ORDER'],
                extra: paidAmount > 0 ? `⚠️ ลูกค้าโอนมาแล้ว ฿${paidAmount.toLocaleString('th-TH', { minimumFractionDigits: 2 })} — กรุณา refund` : '',
            });
        } catch (e) {}
        emitOrderUpdate(req, order.id, 'CANCELLED');
        res.json({ success: true, paidAmount });
    } catch (e) {
        console.error('admin order reject error:', e);
        res.status(500).json({ success: false, error: e.message || 'reject failed' });
    }
});

// POST /admin/orders/:id/confirm-overpaid-refund
router.post('/admin/orders/:id/confirm-overpaid-refund', async (req, res) => {
    const a = await authAdmin(req);
    if (!a.ok) return res.status(a.status).json({ success: false, error: a.error });
    try {
        const order = await prisma.order.findUnique({ where: { id: req.params.id }, include: { payment: true } });
        if (!order) return res.status(404).json({ success: false, error: 'ไม่พบออเดอร์' });
        if (order.overPaidRefundedAt) return res.status(400).json({ success: false, error: 'ยืนยันคืนเงินไปแล้ว' });
        const expected = Number(order.totalAmount);
        const actual = order.payment ? Number(order.payment.amount) : 0;
        const diff = Math.round((actual - expected) * 100) / 100;
        if (diff <= 0) return res.status(400).json({ success: false, error: 'ออเดอร์นี้ไม่ใช่กรณีจ่ายเกิน' });
        await prisma.$transaction(async (tx) => {
            await tx.order.update({ where: { id: order.id }, data: { overPaidRefundedAt: new Date() } });
            await tx.adminAuditLog.create({
                data: { adminName: a.admin?.name || a.telegramId, action: 'OVERPAID_REFUND_CONFIRM', targetId: order.customerId,
                    details: JSON.stringify({ orderId: order.id, expected, actual, diff, via: 'mini-app' }) },
            });
        });
        try {
            await stripAdminMessageButtons(order.id, 'NEW_ORDER');
            await notifyAdminOrderActionFromMiniApp({
                orderId: order.id, action: '💸 ยืนยันคืนเงินส่วนเกินแล้ว',
                byAdmin: a.admin?.name || a.telegramId, kindFilter: 'NEW_ORDER',
                extra: `จ่ายเกิน ฿${diff.toLocaleString('th-TH', { minimumFractionDigits: 2 })}`,
            });
        } catch (e) {}
        emitOrderUpdate(req, order.id);
        res.json({ success: true, diff });
    } catch (e) {
        console.error('admin overpaid refund error:', e);
        res.status(500).json({ success: false, error: e.message || 'confirm failed' });
    }
});

// POST /admin/orders/:id/set-bill { billNumber } — set billNumber + status PROCESSING
router.post('/admin/orders/:id/set-bill', async (req, res) => {
    const a = await authAdmin(req);
    if (!a.ok) return res.status(a.status).json({ success: false, error: a.error });
    try {
        const billNumber = String(req.body?.billNumber || '').trim();
        if (!billNumber) return res.status(400).json({ success: false, error: 'billNumber ห้ามว่าง' });
        const order = await prisma.order.findUnique({ where: { id: req.params.id } });
        if (!order) return res.status(404).json({ success: false, error: 'ไม่พบออเดอร์' });
        if (order.kind === 'PRIZE_DELIVERY') {
            const r = await mysteryBox.markShipmentShipped({ orderId: order.id, trackingNumber: billNumber, adminName: a.admin?.name || a.telegramId });
            if (!r.success) return res.status(400).json({ success: false, error: r.error });
            return res.json({ success: true, kind: 'PRIZE_DELIVERY' });
        }
        if (!['PAID', 'PROCESSING'].includes(order.status)) {
            return res.status(400).json({ success: false, error: 'สถานะออเดอร์ไม่อนุญาตให้ใส่บิล (ต้อง PAID/PROCESSING)' });
        }
        // ตรวจสอบ BillAttempt: นับครั้งใส่บิล + flag suspicious
        const prevAttempts = await prisma.billAttempt.findMany({
            where: { orderId: order.id }, orderBy: { createdAt: 'asc' },
        });
        const attemptNo = prevAttempts.length + 1;
        // suspicious heuristic: bill สั้นกว่า 5 ตัว = น่าสงสัย "เปล่าๆเพื่อทำเวลา"
        const billLen = billNumber.length;
        const isShort = billLen < 5;
        // backfill: ถ้ารอบใหม่นี้ยาวพอ + รอบก่อนๆ มีอันสั้น → flag อันสั้นย้อนหลังว่า suspicious
        await prisma.$transaction(async (tx) => {
            await tx.order.update({
                where: { id: order.id },
                data: {
                    billNumber, status: 'PROCESSING', updatedAt: new Date(),
                    billAttempts: { increment: 1 },
                    ...(order.firstBillAt == null ? { firstBillAt: new Date() } : {}),
                },
            });
            await tx.billAttempt.create({
                data: { orderId: order.id, adminId: a.telegramId, billNumber, billLength: billLen, attemptNo, suspicious: isShort && attemptNo === 1 ? false : false },
            });
            // หากรอบนี้ยาว >= 5 → mark รอบก่อนๆ ที่สั้นว่า suspicious (admin ใส่เลขสั้นๆ ทำเวลาก่อน แล้วมาแก้ใส่เลขจริง)
            if (!isShort && attemptNo > 1) {
                const shortIds = prevAttempts.filter(x => x.billLength < 5).map(x => x.id);
                if (shortIds.length) {
                    await tx.billAttempt.updateMany({ where: { id: { in: shortIds } }, data: { suspicious: true } });
                }
            }
            await tx.adminAuditLog.create({
                data: { adminName: a.admin?.name || a.telegramId, action: 'SET_BILL', targetId: order.customerId,
                    details: JSON.stringify({ orderId: order.id, billNumber, attemptNo, billLength: billLen, via: 'mini-app' }) },
            });
        });
        try { await notifCenter.notifyOrderStatusChanged({ orderId: order.id, customerId: order.customerId, status: 'PROCESSING', note: `เลขบิล: ${billNumber}` }); } catch (e) {}
        try {
            await stripAdminMessageButtons(order.id, 'NEW_ORDER');
            await notifyAdminOrderActionFromMiniApp({
                orderId: order.id, action: '📝 แนบเลขบิลแล้ว',
                byAdmin: a.admin?.name || a.telegramId, kindFilter: 'NEW_ORDER',
                extra: `บิล: <code>${billNumber}</code>`,
            });
        } catch (e) {}
        emitOrderUpdate(req, order.id, 'PROCESSING');
        res.json({ success: true });
    } catch (e) {
        console.error('admin set-bill error:', e);
        res.status(500).json({ success: false, error: e.message || 'set bill failed' });
    }
});

// POST /admin/orders/:id/set-tracking { trackingNumber } — set tracking + status SHIPPED
router.post('/admin/orders/:id/set-tracking', async (req, res) => {
    const a = await authAdmin(req);
    if (!a.ok) return res.status(a.status).json({ success: false, error: a.error });
    try {
        const trackingNumber = String(req.body?.trackingNumber || '').trim();
        if (!trackingNumber) return res.status(400).json({ success: false, error: 'trackingNumber ห้ามว่าง' });
        const order = await prisma.order.findUnique({ where: { id: req.params.id } });
        if (!order) return res.status(404).json({ success: false, error: 'ไม่พบออเดอร์' });
        if (!['PAID', 'PROCESSING', 'SHIPPED'].includes(order.status)) {
            return res.status(400).json({ success: false, error: 'สถานะไม่อนุญาตให้ใส่ tracking' });
        }
        await prisma.$transaction(async (tx) => {
            await tx.order.update({ where: { id: order.id }, data: { trackingNumber, status: 'SHIPPED', updatedAt: new Date() } });
            await tx.adminAuditLog.create({
                data: { adminName: a.admin?.name || a.telegramId, action: 'SET_TRACKING', targetId: order.customerId,
                    details: JSON.stringify({ orderId: order.id, trackingNumber, via: 'mini-app' }) },
            });
        });
        try { await notifCenter.notifyOrderStatusChanged({ orderId: order.id, customerId: order.customerId, status: 'SHIPPED', note: `เลขพัสดุ: ${trackingNumber}` }); } catch (e) {}
        try {
            await stripAdminMessageButtons(order.id, 'NEW_ORDER');
            await notifyAdminOrderActionFromMiniApp({
                orderId: order.id, action: '🚚 จัดส่งแล้ว',
                byAdmin: a.admin?.name || a.telegramId, kindFilter: 'NEW_ORDER',
                extra: `เลขพัสดุ: <code>${trackingNumber}</code>`,
            });
        } catch (e) {}
        emitOrderUpdate(req, order.id, 'SHIPPED');
        res.json({ success: true });
    } catch (e) {
        console.error('admin set-tracking error:', e);
        res.status(500).json({ success: false, error: e.message || 'set tracking failed' });
    }
});

// PATCH /admin/orders/:id/note { adminNote }
router.patch('/admin/orders/:id/note', async (req, res) => {
    const a = await authAdmin(req);
    if (!a.ok) return res.status(a.status).json({ success: false, error: a.error });
    try {
        const order = await prisma.order.findUnique({ where: { id: req.params.id }, select: { id: true, customerId: true } });
        if (!order) return res.status(404).json({ success: false, error: 'ไม่พบออเดอร์' });
        const note = (req.body?.adminNote ?? '').toString();
        await prisma.order.update({ where: { id: order.id }, data: { adminNote: note || null } });
        await prisma.adminAuditLog.create({
            data: { adminName: a.admin?.name || a.telegramId, action: 'ORDER_NOTE',
                targetId: order.customerId, details: JSON.stringify({ orderId: order.id, len: note.length }) },
        });
        emitOrderUpdate(req, order.id);
        res.json({ success: true });
    } catch (e) {
        console.error('admin order note error:', e);
        res.status(500).json({ success: false, error: e.message || 'note failed' });
    }
});

// DELETE /admin/orders/:id/items/:itemId — ลบ item ออกจากออเดอร์ + คืนสต็อก
// ถ้าออเดอร์ไม่เหลือ item เลย → CANCELLED (คืนคูปองด้วย)
router.delete('/admin/orders/:id/items/:itemId', async (req, res) => {
    const a = await authAdmin(req);
    if (!a.ok) return res.status(a.status).json({ success: false, error: a.error });
    try {
        const itemId = parseInt(req.params.itemId);
        const order = await prisma.order.findUnique({
            where: { id: req.params.id },
            include: { items: true, customer: true },
        });
        if (!order) return res.status(404).json({ success: false, error: 'ไม่พบออเดอร์' });
        if (order.kind !== 'PRODUCT') return res.status(400).json({ success: false, error: 'แก้ไขได้เฉพาะ PRODUCT order' });
        if (order.status === 'CANCELLED' || order.status === 'SHIPPED') {
            return res.status(400).json({ success: false, error: 'สถานะไม่อนุญาตให้แก้ไขสินค้า' });
        }
        const target = order.items.find(it => it.id === itemId);
        if (!target) return res.status(404).json({ success: false, error: 'ไม่พบ item' });

        let cancelled = false;
        await prisma.$transaction(async (tx) => {
            await tx.orderItem.delete({ where: { id: itemId } });
            await tx.product.update({ where: { id: target.productId }, data: { stockQuantity: { increment: target.quantity } } });
            const remaining = order.items.filter(it => it.id !== itemId);
            if (remaining.length === 0) {
                await tx.order.update({ where: { id: order.id }, data: { status: 'CANCELLED' } });
                if (order.appliedCouponId) {
                    const cc = await tx.customerCoupon.findFirst({ where: { customerId: order.customerId, couponId: order.appliedCouponId } });
                    if (cc && cc.status === 'USED') {
                        await tx.customerCoupon.update({ where: { id: cc.id }, data: { status: 'AVAILABLE', usedAt: null } });
                    }
                }
                cancelled = true;
            } else {
                // อัปเดต subtotal/totalAmount แบบประมาณ — recalc จาก remaining items
                const newSubtotal = remaining.reduce((s, it) => s + Number(it.priceAtPurchase) * it.quantity, 0);
                const shippingFee = order.shippingFee != null ? Number(order.shippingFee) : 0;
                const discount = Number(order.discountAmount || 0);
                const newTotal = Math.max(0, newSubtotal + shippingFee - discount);
                await tx.order.update({ where: { id: order.id }, data: { subtotal: newSubtotal, totalAmount: newTotal } });
            }
            await tx.adminAuditLog.create({
                data: { adminName: a.admin?.name || a.telegramId, action: 'ORDER_REMOVE_ITEM',
                    targetId: order.customerId, details: JSON.stringify({ orderId: order.id, productId: target.productId, qty: target.quantity, cancelled }) },
            });
        });
        if (cancelled) {
            try { await notifCenter.notifyOrderStatusChanged({ orderId: order.id, customerId: order.customerId, status: 'CANCELLED', note: 'สินค้าถูกลบทั้งหมด' }); } catch (e) {}
        }
        emitOrderUpdate(req, order.id, cancelled ? 'CANCELLED' : null);
        res.json({ success: true, cancelled });
    } catch (e) {
        console.error('admin order remove-item error:', e);
        res.status(500).json({ success: false, error: e.message || 'remove failed' });
    }
});

// POST /admin/orders/:id/refund-slip (multipart 'file') — แอดมินอัปสลิปคืนเงิน → upload Telegram → save /api/images/<file_id>
router.post('/admin/orders/:id/refund-slip', upload.single('file'), async (req, res) => {
    // initData อาจมาทาง body หรือ header (multipart ต้องใช้ header)
    const a = await authAdmin(req);
    if (!a.ok) return res.status(a.status).json({ success: false, error: a.error });
    try {
        if (!req.file) return res.status(400).json({ success: false, error: 'ไม่มีรูปแนบมา' });
        const order = await prisma.order.findUnique({ where: { id: req.params.id }, include: { customer: true } });
        if (!order) return res.status(404).json({ success: false, error: 'ไม่พบออเดอร์' });

        // 1) upload ไปที่ Telegram admin group เพื่อให้ได้ file_id
        const adminToken = process.env.ADMIN_BOT_TOKEN;
        const targetChatId = process.env.ADMIN_GROUP_ID || process.env.SUPER_ADMIN_TELEGRAM_ID;
        if (!adminToken || !targetChatId) return res.status(500).json({ success: false, error: 'ไม่ได้ตั้งค่า ADMIN_BOT_TOKEN/ADMIN_GROUP_ID' });

        const FormData = (await import('form-data')).default;
        const fd = new FormData();
        fd.append('chat_id', targetChatId);
        fd.append('caption', `💸 สลิปคืนเงินออเดอร์ #${order.id}\nโดย admin: ${a.admin?.name || a.telegramId}`);
        fd.append('photo', req.file.buffer, { filename: req.file.originalname || 'refund.jpg', contentType: req.file.mimetype });
        const tgRes = await fetch(`https://api.telegram.org/bot${adminToken}/sendPhoto`, { method: 'POST', body: fd, headers: fd.getHeaders() });
        const tgData = await tgRes.json();
        if (!tgData.ok) {
            console.error('Telegram sendPhoto error:', tgData);
            return res.status(500).json({ success: false, error: 'ส่งรูปไป Telegram ไม่สำเร็จ' });
        }
        const photos = tgData.result?.photo || [];
        const fileId = photos[photos.length - 1]?.file_id;
        if (!fileId) return res.status(500).json({ success: false, error: 'ไม่ได้ file_id จาก Telegram' });
        const refundSlipUrl = `/api/images/${fileId}`;

        await prisma.order.update({ where: { id: order.id }, data: { refundSlipUrl } });
        await prisma.adminAuditLog.create({
            data: { adminName: a.admin?.name || a.telegramId, action: 'ORDER_REFUND_SLIP',
                targetId: order.customerId, details: JSON.stringify({ orderId: order.id, fileId }) },
        });

        // แจ้งลูกค้า
        if (order.customer?.telegramUserId) {
            try {
                const msg = `💸 <b>แอดมินได้โอนเงินคืนแล้ว</b>\n\nออเดอร์ <b>#${order.id}</b> มีสลิปการโอนคืน กรุณาเช็คในแชทบอทเพื่อดูสลิป`;
                await sendNotificationToCustomer(order.customer.telegramUserId, msg);
            } catch (e) {}
        }
        emitOrderUpdate(req, order.id);
        res.json({ success: true, refundSlipUrl });
    } catch (e) {
        console.error('admin refund-slip error:', e);
        res.status(500).json({ success: false, error: e.message || 'upload failed' });
    }
});

// POST /admin/orders/:id/cancel — ยกเลิก (PAID/PROCESSING) + คืนสต็อก/คูปอง
router.post('/admin/orders/:id/cancel', async (req, res) => {
    const a = await authAdmin(req);
    if (!a.ok) return res.status(a.status).json({ success: false, error: a.error });
    try {
        const order = await prisma.order.findUnique({
            where: { id: req.params.id },
            include: { items: true, customer: true },
        });
        if (!order) return res.status(404).json({ success: false, error: 'ไม่พบออเดอร์' });
        if (order.status === 'CANCELLED') return res.status(400).json({ success: false, error: 'ยกเลิกไปแล้ว' });
        if (order.status === 'SHIPPED') return res.status(400).json({ success: false, error: 'ออเดอร์ส่งแล้ว ยกเลิกไม่ได้' });

        await prisma.$transaction(async (tx) => {
            await tx.order.update({ where: { id: order.id }, data: { status: 'CANCELLED' } });
            if (order.kind === 'PRODUCT') {
                for (const item of order.items) {
                    await tx.product.update({ where: { id: item.productId }, data: { stockQuantity: { increment: item.quantity } } });
                }
                if (order.appliedCouponId) {
                    const cc = await tx.customerCoupon.findFirst({ where: { customerId: order.customerId, couponId: order.appliedCouponId } });
                    if (cc && cc.status === 'USED') {
                        await tx.customerCoupon.update({ where: { id: cc.id }, data: { status: 'AVAILABLE', usedAt: null } });
                    }
                }
            }
            await tx.adminAuditLog.create({
                data: { adminName: a.admin?.name || a.telegramId, action: 'ORDER_CANCEL', targetId: order.customerId,
                    details: JSON.stringify({ orderId: order.id, prevStatus: order.status, via: 'mini-app' }) },
            });
        });
        try { await notifCenter.notifyOrderStatusChanged({ orderId: order.id, customerId: order.customerId, status: 'CANCELLED' }); } catch (e) {}
        try {
            await stripAdminMessageButtons(order.id, ['NEW_ORDER', 'MISMATCH_UNDER']);
            await notifyAdminOrderActionFromMiniApp({
                orderId: order.id, action: '🗑 ยกเลิกออเดอร์',
                byAdmin: a.admin?.name || a.telegramId, kindFilter: ['NEW_ORDER', 'MISMATCH_UNDER'],
            });
        } catch (e) {}
        emitOrderUpdate(req, order.id, 'CANCELLED');
        res.json({ success: true });
    } catch (e) {
        console.error('admin order cancel error:', e);
        res.status(500).json({ success: false, error: e.message || 'cancel failed' });
    }
});

// ---------- 👥 CUSTOMERS ----------
// GET /admin/customers/search?q=... — by customerId / phone / firstName / lastName / username
router.get('/admin/customers/search', async (req, res) => {
    const a = await authAdmin(req);
    if (!a.ok) return res.status(a.status).json({ success: false, error: a.error });
    try {
        const q = String(req.query.q || '').trim();
        if (q.length < 2) return res.json({ success: true, customers: [] });
        const customers = await prisma.customer.findMany({
            where: {
                isDeleted: false,
                OR: [
                    { customerId: { contains: q, mode: 'insensitive' } },
                    { phoneNumber: { contains: q } },
                    { firstName: { contains: q, mode: 'insensitive' } },
                    { lastName: { contains: q, mode: 'insensitive' } },
                    { username: { contains: q, mode: 'insensitive' } },
                    { telegramUserId: { equals: q } },
                ],
            },
            select: { customerId: true, firstName: true, lastName: true, phoneNumber: true, points: true, expiryDate: true, telegramUserId: true, joinDate: true },
            take: 30,
            orderBy: { joinDate: 'desc' },
        });
        res.json({ success: true, customers });
    } catch (e) {
        console.error('admin customer search error:', e);
        res.status(500).json({ success: false, error: 'search failed' });
    }
});

// GET /admin/customers/:customerId — detail + recent orders + coupons + referrals
router.get('/admin/customers/:customerId', async (req, res) => {
    const a = await authAdmin(req);
    if (!a.ok) return res.status(a.status).json({ success: false, error: a.error });
    try {
        const cust = await prisma.customer.findUnique({
            where: { customerId: req.params.customerId },
        });
        if (!cust) return res.status(404).json({ success: false, error: 'ไม่พบลูกค้า' });

        const [orders, coupons, referralsMade, recentTx] = await Promise.all([
            prisma.order.findMany({
                where: { customerId: cust.customerId },
                orderBy: { createdAt: 'desc' },
                take: 10,
                select: { id: true, kind: true, status: true, totalAmount: true, createdAt: true },
            }),
            prisma.customerCoupon.count({
                where: { customerId: cust.customerId, status: 'AVAILABLE' },
            }),
            prisma.referral.count({
                where: { referrerId: cust.customerId, status: 'COMPLETED' },
            }),
            prisma.pointTransaction.findMany({
                where: { customerId: cust.customerId },
                orderBy: { createdAt: 'desc' },
                take: 8,
                select: { amount: true, type: true, detail: true, createdAt: true },
            }),
        ]);

        res.json({
            success: true,
            customer: cust,
            stats: { availableCoupons: coupons, completedReferrals: referralsMade },
            recentOrders: orders,
            recentTransactions: recentTx,
        });
    } catch (e) {
        console.error('admin customer detail error:', e);
        res.status(500).json({ success: false, error: 'load failed' });
    }
});

// POST /admin/customers/:customerId/adjust-points — เพิ่ม/ลดแต้ม + audit log
router.post('/admin/customers/:customerId/adjust-points', async (req, res) => {
    const a = await authAdmin(req);
    if (!a.ok) return res.status(a.status).json({ success: false, error: a.error });
    try {
        const { delta, reason } = req.body || {};
        const amount = parseInt(delta);
        if (!Number.isFinite(amount) || amount === 0) {
            return res.status(400).json({ success: false, error: 'delta ต้องเป็นเลข ≠ 0' });
        }
        const cust = await prisma.customer.findUnique({ where: { customerId: req.params.customerId } });
        if (!cust) return res.status(404).json({ success: false, error: 'ไม่พบลูกค้า' });
        if (cust.points + amount < 0) {
            return res.status(400).json({ success: false, error: 'แต้มไม่พอ จะติดลบ' });
        }

        await prisma.$transaction(async (tx) => {
            await tx.customer.update({
                where: { customerId: cust.customerId },
                data: { points: { increment: amount } },
            });
            await tx.pointTransaction.create({
                data: {
                    customerId: cust.customerId,
                    amount,
                    type: 'ADMIN_ADJUST',
                    detail: reason || `Adjusted by ${a.admin.name || a.telegramId}`,
                },
            });
            await tx.adminAuditLog.create({
                data: {
                    adminName: a.admin.name || a.telegramId,
                    action: 'ADJUST_POINTS',
                    targetId: cust.customerId,
                    details: JSON.stringify({ delta: amount, reason: reason || null }),
                },
            });
        });
        res.json({ success: true, newPoints: cust.points + amount });
    } catch (e) {
        console.error('admin adjust points error:', e);
        res.status(500).json({ success: false, error: 'adjust failed' });
    }
});

// ---------- 🎫 COUPONS ----------
// GET /admin/coupons — list ทั้งหมด พร้อม claimed count
router.get('/admin/coupons', async (req, res) => {
    const a = await authAdmin(req);
    if (!a.ok) return res.status(a.status).json({ success: false, error: a.error });
    try {
        const coupons = await prisma.coupon.findMany({
            orderBy: [{ isActive: 'desc' }, { createdAt: 'desc' }],
            select: {
                id: true, name: true, nameEn: true, type: true, value: true, giftQty: true,
                pointsCost: true, isActive: true, isAutoAssign: true, autoAssignTrigger: true,
                rewardTrigger: true, totalQuota: true, claimedCount: true,
                startDate: true, endDate: true, validFrom: true, validUntil: true, validityDays: true,
                createdAt: true,
            },
        });
        res.json({ success: true, coupons });
    } catch (e) {
        console.error('admin coupons list error:', e);
        res.status(500).json({ success: false, error: 'load failed' });
    }
});

// GET /admin/coupons/:id/detail — full row สำหรับ edit form
router.get('/admin/coupons/:id/detail', async (req, res) => {
    const a = await authAdmin(req);
    if (!a.ok) return res.status(a.status).json({ success: false, error: a.error });
    try {
        const c = await prisma.coupon.findUnique({ where: { id: req.params.id } });
        if (!c) return res.status(404).json({ success: false, error: 'ไม่พบคูปอง' });
        res.json({ success: true, coupon: c });
    } catch (e) {
        res.status(500).json({ success: false, error: 'load failed' });
    }
});

// POST /admin/coupons — create
router.post('/admin/coupons', async (req, res) => {
    const a = await authAdmin(req);
    if (!a.ok) return res.status(a.status).json({ success: false, error: a.error });
    try {
        const b = req.body || {};
        if (!b.id || !b.name || !b.type) return res.status(400).json({ success: false, error: 'id/name/type ห้ามว่าง' });
        const exist = await prisma.coupon.findUnique({ where: { id: b.id } });
        if (exist) return res.status(400).json({ success: false, error: 'รหัสคูปองนี้มีอยู่แล้ว' });
        const data = sanitizeCouponPayload(b);
        const created = await prisma.coupon.create({ data: { id: b.id, ...data } });
        res.json({ success: true, coupon: { id: created.id } });
    } catch (e) {
        console.error('admin coupon create error:', e);
        res.status(500).json({ success: false, error: e.message || 'create failed' });
    }
});

// PATCH /admin/coupons/:id — update full
router.patch('/admin/coupons/:id', async (req, res) => {
    const a = await authAdmin(req);
    if (!a.ok) return res.status(a.status).json({ success: false, error: a.error });
    try {
        const exist = await prisma.coupon.findUnique({ where: { id: req.params.id } });
        if (!exist) return res.status(404).json({ success: false, error: 'ไม่พบคูปอง' });
        const data = sanitizeCouponPayload(req.body || {});
        const updated = await prisma.coupon.update({ where: { id: exist.id }, data });
        res.json({ success: true, coupon: { id: updated.id } });
    } catch (e) {
        console.error('admin coupon update error:', e);
        res.status(500).json({ success: false, error: e.message || 'update failed' });
    }
});

// DELETE /admin/coupons/:id — hard delete ถ้าไม่เคยถูก claim, มิฉะนั้น soft delete
router.delete('/admin/coupons/:id', async (req, res) => {
    const a = await authAdmin(req);
    if (!a.ok) return res.status(a.status).json({ success: false, error: a.error });
    try {
        const exist = await prisma.coupon.findUnique({ where: { id: req.params.id } });
        if (!exist) return res.status(404).json({ success: false, error: 'ไม่พบคูปอง' });
        const claimed = await prisma.customerCoupon.count({ where: { couponId: exist.id } });
        if (claimed > 0) {
            await prisma.coupon.update({ where: { id: exist.id }, data: { isActive: false } });
            return res.json({ success: true, softDeleted: true, claimed });
        }
        await prisma.coupon.delete({ where: { id: exist.id } });
        res.json({ success: true });
    } catch (e) {
        console.error('admin coupon delete error:', e);
        res.status(500).json({ success: false, error: e.message || 'delete failed' });
    }
});

// ---------- 📊 OWNER FINANCIAL DASHBOARD ----------
router.get('/admin/dashboard/financial', async (req, res) => {
    const a = await authAdmin(req, ['Owner']);
    if (!a.ok) return res.status(a.status).json({ success: false, error: a.error });
    try {
        const period = (req.query.period || '30').toString();
        const categoryId = req.query.categoryId ? parseInt(req.query.categoryId) : null;
        // Custom date range — มี priority สูงกว่า period preset
        let since = null, until = null;
        if (req.query.startDate) since = new Date(req.query.startDate);
        if (req.query.endDate) {
            until = new Date(req.query.endDate);
            until.setHours(23, 59, 59, 999); // include the end day
        }
        if (!since && !until) {
            since = period === 'all' ? null : new Date(Date.now() - parseInt(period) * 86400000);
        }
        const dateFilter = {};
        if (since) dateFilter.createdAt = { ...(dateFilter.createdAt || {}), gte: since };
        if (until) dateFilter.createdAt = { ...(dateFilter.createdAt || {}), lte: until };
        const paidStatuses = ['PAID', 'PROCESSING', 'SHIPPED'];

        // revenue (PRODUCT only — PRIZE_DELIVERY คือค่าส่ง ไม่ใช่ยอดขาย)
        const ordersAgg = await prisma.order.aggregate({
            where: { ...dateFilter, kind: 'PRODUCT', status: { in: paidStatuses } },
            _sum: { totalAmount: true },
            _count: { _all: true },
        });
        const revenue = Number(ordersAgg._sum.totalAmount || 0);
        const paidOrders = ordersAgg._count._all || 0;
        const aov = paidOrders ? revenue / paidOrders : 0;

        // customers
        const [newCustomers, totalCustomers] = await Promise.all([
            prisma.customer.count({ where: { isDeleted: false, ...(since ? { joinDate: { gte: since } } : {}) } }),
            prisma.customer.count({ where: { isDeleted: false } }),
        ]);

        // referrals
        const [completedReferrals, pendingReferrals] = await Promise.all([
            prisma.referral.count({ where: { status: 'COMPLETED', ...(since ? { completedAt: { gte: since } } : {}) } }),
            prisma.referral.count({ where: { status: 'PENDING_PURCHASE' } }),
        ]);

        // points
        const pointsAgg = await prisma.customer.aggregate({ _sum: { points: true } });
        const pointsOutstanding = Number(pointsAgg._sum.points || 0);
        const issuedAgg = await prisma.pointTransaction.aggregate({
            where: { ...(since ? { createdAt: { gte: since } } : {}), amount: { gt: 0 } },
            _sum: { amount: true },
        });
        const pointsIssued = Number(issuedAgg._sum.amount || 0);

        // coupons
        const couponsClaimed = await prisma.customerCoupon.count({ where: since ? { claimedAt: { gte: since } } : {} });
        const couponsUsed = await prisma.customerCoupon.count({ where: { status: 'USED', ...(since ? { usedAt: { gte: since } } : {}) } });

        // top products (in revenue) — group by productId, join name
        // รองรับ filter category: ถ้ามี categoryId → join ผ่าน product
        const itemFilter = { order: { ...dateFilter, kind: 'PRODUCT', status: { in: paidStatuses } } };
        if (categoryId) itemFilter.product = { categoryId };
        const itemsGrouped = await prisma.orderItem.groupBy({
            by: ['productId'],
            where: itemFilter,
            _sum: { quantity: true },
            orderBy: { _sum: { quantity: 'desc' } },
            take: 10,
        });
        const productIds = itemsGrouped.map(i => i.productId);
        const products = productIds.length ? await prisma.product.findMany({
            where: { id: { in: productIds } },
            select: { id: true, nameTh: true, nameEn: true, category: { select: { price: true } } },
        }) : [];
        // หา revenue จาก orderItem.priceAtPurchase (ที่จ่ายจริง) — แม่นกว่าใช้ category.price
        const revenueByProduct = await prisma.orderItem.groupBy({
            by: ['productId'],
            where: { productId: { in: productIds }, order: { ...dateFilter, kind: 'PRODUCT', status: { in: paidStatuses } } },
            _sum: { quantity: true },
        });
        const qtyMap = new Map(revenueByProduct.map(r => [r.productId, r._sum.quantity || 0]));
        // คำนวณ revenue ต่อ product
        const itemsAll = await prisma.orderItem.findMany({
            where: { productId: { in: productIds }, order: { ...dateFilter, kind: 'PRODUCT', status: { in: paidStatuses } } },
            select: { productId: true, quantity: true, priceAtPurchase: true },
        });
        const revMap = new Map();
        for (const it of itemsAll) {
            const cur = revMap.get(it.productId) || 0;
            revMap.set(it.productId, cur + Number(it.priceAtPurchase) * it.quantity);
        }
        const pMap = new Map(products.map(p => [p.id, p]));
        const topProducts = itemsGrouped.map(i => {
            const p = pMap.get(i.productId);
            const name = p?.nameTh || p?.nameEn || `#${i.productId}`;
            return { id: i.productId, name, qty: i._sum.quantity || 0, revenue: revMap.get(i.productId) || 0 };
        });

        // tier distribution — best-effort: ใช้ referralCount จาก Customer (ตามนิยาม Bronze<3 / Silver 3-5 / Gold 6+)
        const allCust = await prisma.customer.findMany({ where: { isDeleted: false }, select: { referralCount: true } });
        const tierCounts = { Bronze: 0, Silver: 0, Gold: 0 };
        for (const c of allCust) {
            if (c.referralCount >= 6) tierCounts.Gold++;
            else if (c.referralCount >= 3) tierCounts.Silver++;
            else tierCounts.Bronze++;
        }

        // mystery box stats
        const [ticketsIssued, opened, shipmentsPending] = await Promise.all([
            prisma.mysteryBoxTicket.count({ where: since ? { createdAt: { gte: since } } : {} }),
            prisma.mysteryBoxTicket.count({ where: { status: 'OPENED', ...(since ? { openedAt: { gte: since } } : {}) } }),
            prisma.prizeShipment.count({ where: { status: 'PENDING' } }),
        ]);

        // ⭐ NEW: top categories by revenue
        const allItemsForCat = await prisma.orderItem.findMany({
            where: { order: { ...dateFilter, kind: 'PRODUCT', status: { in: paidStatuses } } },
            include: { product: { select: { categoryId: true, category: { select: { id: true, name: true } } } } },
        });
        const catRevMap = new Map();
        for (const it of allItemsForCat) {
            const cat = it.product.category;
            const key = cat?.id ?? 0;
            if (!catRevMap.has(key)) catRevMap.set(key, { id: cat?.id || null, name: cat?.name || 'ไม่มีหมวด', revenue: 0, qty: 0 });
            const g = catRevMap.get(key);
            g.revenue += Number(it.priceAtPurchase) * it.quantity;
            g.qty += it.quantity;
        }
        const topCategories = [...catRevMap.values()].sort((a, b) => b.revenue - a.revenue).slice(0, 8);
        const allCategoriesMeta = await prisma.category.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } });

        // ⭐ NEW: order status breakdown (pie data) ใน period
        const statusBreakdown = await prisma.order.groupBy({
            by: ['status'],
            where: { ...dateFilter, kind: 'PRODUCT' },
            _count: { _all: true },
            _sum: { totalAmount: true },
        });
        const statusBreak = statusBreakdown.map(s => ({ status: s.status, count: s._count._all, totalAmount: Number(s._sum.totalAmount || 0) }));

        // ⭐ NEW: daily revenue trend — ครอบคลุมช่วงที่เลือก (since→until)
        // ถ้าใช้ preset period: เริ่มจาก N วันก่อนถึงวันนี้
        // ถ้าใช้ custom: เริ่มจาก startDate ถึง endDate (clamp 365 วัน)
        let trendStart = since || new Date(Date.now() - (period === 'all' ? 30 : parseInt(period) || 30) * 86400000);
        const trendEnd = until || new Date();
        const maxTrendDays = 365;
        const trendDays = Math.min(maxTrendDays, Math.max(1, Math.ceil((trendEnd - trendStart) / 86400000) + 1));
        // ถ้า range ใหญ่เกิน clamp → ปรับ trendStart
        if ((trendEnd - trendStart) / 86400000 > maxTrendDays) trendStart = new Date(trendEnd.getTime() - (maxTrendDays - 1) * 86400000);

        const dailyRows = await prisma.$queryRaw`
            SELECT DATE("createdAt" AT TIME ZONE 'Asia/Bangkok') AS day,
                   SUM("totalAmount") AS revenue,
                   COUNT(*) AS orders
            FROM "Order"
            WHERE "kind" = 'PRODUCT' AND "status" IN ('PAID','PROCESSING','SHIPPED')
              AND "createdAt" >= ${trendStart} AND "createdAt" <= ${trendEnd}
            GROUP BY DATE("createdAt" AT TIME ZONE 'Asia/Bangkok')
            ORDER BY day ASC
        `;
        const trendMap = new Map();
        for (const r of dailyRows) trendMap.set(new Date(r.day).toISOString().slice(0, 10), { revenue: Number(r.revenue), orders: Number(r.orders) });
        const trend = [];
        for (let i = 0; i < trendDays; i++) {
            const d = new Date(trendStart.getTime() + i * 86400000).toISOString().slice(0, 10);
            const m = trendMap.get(d) || { revenue: 0, orders: 0 };
            trend.push({ date: d, revenue: m.revenue, orders: m.orders });
        }

        // ⭐ NEW: repeat customer rate (ใน period นี้ → ลูกค้ากี่ % ที่มีออเดอร์ ≥ 2)
        const customerOrderCounts = await prisma.order.groupBy({
            by: ['customerId'],
            where: { ...dateFilter, kind: 'PRODUCT', status: { in: paidStatuses } },
            _count: { _all: true },
        });
        const totalUnique = customerOrderCounts.length;
        const repeat = customerOrderCounts.filter(x => x._count._all >= 2).length;
        const repeatRate = totalUnique ? Math.round((repeat / totalUnique) * 100) : 0;

        // ⭐ NEW: cancel/refund rates
        const totalAllStatus = await prisma.order.count({ where: { ...dateFilter, kind: 'PRODUCT' } });
        const cancelled = await prisma.order.count({ where: { ...dateFilter, kind: 'PRODUCT', status: 'CANCELLED' } });
        const overpaidRefunded = await prisma.order.count({ where: { ...dateFilter, kind: 'PRODUCT', overPaidRefundedAt: { not: null } } });
        const cancelRate = totalAllStatus ? Math.round((cancelled / totalAllStatus) * 100) : 0;

        res.json({
            success: true,
            data: {
                revenue, paidOrders, aov,
                newCustomers, totalCustomers,
                completedReferrals, pendingReferrals,
                pointsOutstanding, pointsIssued,
                couponsClaimed, couponsUsed,
                topProducts,
                topCategories,
                tierCounts,
                boxStats: { ticketsIssued, opened, shipmentsPending },
                statusBreakdown: statusBreak,
                trend, trendDays,
                repeatStats: { totalUnique, repeat, repeatRate },
                healthStats: { totalOrders: totalAllStatus, cancelled, cancelRate, overpaidRefunded },
                allCategories: allCategoriesMeta,
                filter: { categoryId, period, startDate: since?.toISOString() || null, endDate: until?.toISOString() || null },
            },
        });
    } catch (e) {
        console.error('admin dashboard error:', e);
        res.status(500).json({ success: false, error: e.message || 'load failed' });
    }
});

// ---------- 🛍️ PRODUCTS ----------
router.get('/admin/products', async (req, res) => {
    const a = await authAdmin(req);
    if (!a.ok) return res.status(a.status).json({ success: false, error: a.error });
    try {
        const q = String(req.query.q || '').trim();
        const where = q ? {
            OR: [
                { nameTh: { contains: q, mode: 'insensitive' } },
                { nameEn: { contains: q, mode: 'insensitive' } },
            ],
        } : {};
        const products = await prisma.product.findMany({
            where,
            include: { category: { select: { id: true, name: true } } },
            orderBy: [{ status: 'asc' }, { id: 'desc' }],
            take: 200,
        });
        res.json({ success: true, products: products.map(p => ({
            id: p.id, nameTh: p.nameTh, nameEn: p.nameEn, imageUrl: p.imageUrl, status: p.status,
            stockQuantity: p.stockQuantity, isNew: p.isNew, isHot: p.isHot,
            allowCoupons: p.allowCoupons, nicotine: p.nicotine,
            category: p.category,
        })) });
    } catch (e) {
        console.error('admin products list error:', e);
        res.status(500).json({ success: false, error: 'load failed' });
    }
});

router.get('/admin/products/:id/detail', async (req, res) => {
    const a = await authAdmin(req);
    if (!a.ok) return res.status(a.status).json({ success: false, error: a.error });
    try {
        const p = await prisma.product.findUnique({ where: { id: parseInt(req.params.id) } });
        if (!p) return res.status(404).json({ success: false, error: 'ไม่พบสินค้า' });
        res.json({ success: true, product: p });
    } catch (e) {
        res.status(500).json({ success: false, error: 'load failed' });
    }
});

router.post('/admin/products', async (req, res) => {
    const a = await authAdmin(req);
    if (!a.ok) return res.status(a.status).json({ success: false, error: a.error });
    try {
        const b = req.body || {};
        if (!b.imageUrl || (!b.nameTh && !b.nameEn)) return res.status(400).json({ success: false, error: 'ต้องมี name + imageUrl' });
        const data = sanitizeProductPayload(b);
        const created = await prisma.product.create({ data });
        res.json({ success: true, product: { id: created.id } });
    } catch (e) {
        console.error('admin product create error:', e);
        res.status(500).json({ success: false, error: e.message || 'create failed' });
    }
});

router.patch('/admin/products/:id', async (req, res) => {
    const a = await authAdmin(req);
    if (!a.ok) return res.status(a.status).json({ success: false, error: a.error });
    try {
        const id = parseInt(req.params.id);
        const exist = await prisma.product.findUnique({ where: { id } });
        if (!exist) return res.status(404).json({ success: false, error: 'ไม่พบสินค้า' });
        const data = sanitizeProductPayload(req.body || {});
        const updated = await prisma.product.update({ where: { id }, data });
        // realtime broadcast (เหมือน /products/:id/status)
        try { req.app.get('socketio')?.emit('product_update', { id: updated.id, status: updated.status, stockQuantity: updated.stockQuantity }); } catch (e) {}
        res.json({ success: true });
    } catch (e) {
        console.error('admin product update error:', e);
        res.status(500).json({ success: false, error: e.message || 'update failed' });
    }
});

router.delete('/admin/products/:id', async (req, res) => {
    const a = await authAdmin(req);
    if (!a.ok) return res.status(a.status).json({ success: false, error: a.error });
    try {
        const id = parseInt(req.params.id);
        const used = await prisma.orderItem.count({ where: { productId: id } });
        if (used > 0) {
            // soft delete via OUT_OF_STOCK + stock=0
            await prisma.product.update({ where: { id }, data: { status: 'OUT_OF_STOCK', stockQuantity: 0 } });
            return res.json({ success: true, softDeleted: true, used });
        }
        await prisma.product.delete({ where: { id } });
        res.json({ success: true });
    } catch (e) {
        console.error('admin product delete error:', e);
        res.status(500).json({ success: false, error: e.message || 'delete failed' });
    }
});

// ---------- 📡 ACTIVITY DASHBOARD ----------
// GET /admin/activity — admin online (active in last 5 min) + recent actions
router.get('/admin/activity', async (req, res) => {
    const a = await authAdmin(req);
    if (!a.ok) return res.status(a.status).json({ success: false, error: a.error });
    try {
        const since5min = new Date(Date.now() - 5 * 60 * 1000);
        const since24h = new Date(Date.now() - 86400000);
        // ใครเพิ่ง active ใน 5 นาที (ดู audit log)
        const recentActions = await prisma.adminAuditLog.findMany({
            where: { createdAt: { gte: since5min } },
            orderBy: { createdAt: 'desc' },
        });
        const activeAdminNames = [...new Set(recentActions.map(l => l.adminName).filter(Boolean))];
        // นับ action 24 ชม. ต่อ admin
        const today24h = await prisma.adminAuditLog.findMany({
            where: { createdAt: { gte: since24h } },
            select: { adminName: true, action: true },
        });
        const counts = {};
        for (const l of today24h) {
            if (!counts[l.adminName]) counts[l.adminName] = { total: 0, byAction: {} };
            counts[l.adminName].total += 1;
            counts[l.adminName].byAction[l.action] = (counts[l.adminName].byAction[l.action] || 0) + 1;
        }
        // top action types ใน 24 ชม.
        const actionTotals = {};
        for (const l of today24h) actionTotals[l.action] = (actionTotals[l.action] || 0) + 1;
        const topActions = Object.entries(actionTotals).sort((a, b) => b[1] - a[1]).slice(0, 10);
        res.json({
            success: true,
            activeAdmins: activeAdminNames,
            activeCount: activeAdminNames.length,
            recentActions: recentActions.slice(0, 30),
            adminStats24h: counts,
            topActions24h: topActions,
        });
    } catch (e) { res.status(500).json({ success: false, error: e.message || 'load failed' }); }
});

// ---------- ⏪ ROLLBACK (Owner only) ----------
// GET /admin/rollback/options/:auditLogId — แสดงรายละเอียด + ระบุว่า rollback ได้หรือไม่
// POST /admin/rollback/:auditLogId — execute rollback
const ROLLBACK_SUPPORTED = ['ADJUST_POINTS', 'ORDER_NOTE', 'CUSTOMER_NOTE', 'SET_BILL', 'SET_TRACKING', 'CONFIG_UPDATE'];
router.get('/admin/rollback/options/:auditLogId', async (req, res) => {
    const a = await authAdmin(req, ['Owner']);
    if (!a.ok) return res.status(a.status).json({ success: false, error: a.error });
    try {
        const log = await prisma.adminAuditLog.findUnique({ where: { id: parseInt(req.params.auditLogId) } });
        if (!log) return res.status(404).json({ success: false, error: 'ไม่พบ log' });
        const supported = ROLLBACK_SUPPORTED.includes(log.action);
        const ageMin = (Date.now() - new Date(log.createdAt).getTime()) / 60000;
        res.json({ success: true, log, supported, ageMinutes: ageMin, reasonIfNot: supported ? null : `action "${log.action}" ไม่รองรับการ rollback` });
    } catch (e) { res.status(500).json({ success: false, error: 'load failed' }); }
});

router.post('/admin/rollback/:auditLogId', async (req, res) => {
    const a = await authAdmin(req, ['Owner']);
    if (!a.ok) return res.status(a.status).json({ success: false, error: a.error });
    try {
        const log = await prisma.adminAuditLog.findUnique({ where: { id: parseInt(req.params.auditLogId) } });
        if (!log) return res.status(404).json({ success: false, error: 'ไม่พบ log' });
        if (!ROLLBACK_SUPPORTED.includes(log.action)) return res.status(400).json({ success: false, error: `action "${log.action}" ไม่รองรับการ rollback` });

        let parsed = {};
        try { parsed = JSON.parse(log.details || '{}'); } catch (e) {}

        let result = '';
        if (log.action === 'ADJUST_POINTS' && log.targetId) {
            const delta = parsed.delta;
            if (typeof delta !== 'number') return res.status(400).json({ success: false, error: 'delta ไม่ถูกต้อง' });
            await prisma.$transaction(async (tx) => {
                await tx.customer.update({ where: { customerId: log.targetId }, data: { points: { increment: -delta } } });
                await tx.pointTransaction.create({
                    data: { customerId: log.targetId, amount: -delta, type: 'ADMIN_ADJUST', detail: `Rollback ของ log #${log.id} (เดิม: ${parsed.reason || ''})` },
                });
            });
            result = `Reverted ${delta} แต้มจาก ${log.targetId}`;
        } else if (log.action === 'ORDER_NOTE') {
            const orderId = parsed.orderId;
            if (!orderId) return res.status(400).json({ success: false, error: 'ไม่มี orderId ใน log' });
            await prisma.order.update({ where: { id: orderId }, data: { adminNote: null } });
            result = `Cleared adminNote ของ ${orderId}`;
        } else if (log.action === 'CUSTOMER_NOTE') {
            await prisma.customer.update({ where: { customerId: log.targetId }, data: { adminNote: null } });
            result = `Cleared adminNote ของ ${log.targetId}`;
        } else if (log.action === 'SET_BILL') {
            const orderId = parsed.orderId;
            await prisma.order.update({ where: { id: orderId }, data: { billNumber: null, status: 'PAID' } });
            result = `Cleared billNumber + status → PAID ของ ${orderId}`;
        } else if (log.action === 'SET_TRACKING') {
            const orderId = parsed.orderId;
            await prisma.order.update({ where: { id: orderId }, data: { trackingNumber: null, status: 'PROCESSING' } });
            result = `Cleared trackingNumber + status → PROCESSING ของ ${orderId}`;
        } else if (log.action === 'CONFIG_UPDATE') {
            return res.status(400).json({ success: false, error: 'CONFIG_UPDATE rollback ต้อง manual edit (ดู audit details)' });
        }

        await prisma.adminAuditLog.create({
            data: { adminName: a.admin?.name || a.telegramId, action: 'ROLLBACK',
                targetId: log.targetId, details: JSON.stringify({ rolledBackLogId: log.id, originalAction: log.action, result }) },
        });
        res.json({ success: true, result });
    } catch (e) {
        console.error('rollback error:', e);
        res.status(500).json({ success: false, error: e.message || 'rollback failed' });
    }
});

// ---------- 💾 DB BACKUP (Owner only — generate via pg_dump) ----------
// POST /admin/db-backup — return CSV dump ของ critical tables (ไม่ใช่ pg_dump เต็มเพราะ Railway containers)
router.post('/admin/db-backup', async (req, res) => {
    const a = await authAdmin(req, ['Owner']);
    if (!a.ok) return res.status(a.status).json({ success: false, error: a.error });
    try {
        // export critical tables เป็น JSON file (ลูกค้า Owner download เก็บไว้)
        const [customers, orders, payments, transactions, coupons, customerCoupons] = await Promise.all([
            prisma.customer.findMany({}),
            prisma.order.findMany({}),
            prisma.payment.findMany({}),
            prisma.pointTransaction.findMany({}),
            prisma.coupon.findMany({}),
            prisma.customerCoupon.findMany({}),
        ]);
        const dump = {
            generatedAt: new Date().toISOString(),
            generatedBy: a.admin?.name || a.telegramId,
            note: 'Critical tables snapshot. ใช้ Prisma Studio หรือ Railway dashboard สำหรับ pg_dump เต็ม.',
            counts: {
                customers: customers.length, orders: orders.length, payments: payments.length,
                transactions: transactions.length, coupons: coupons.length, customerCoupons: customerCoupons.length,
            },
            data: { customers, orders, payments, transactions, coupons, customerCoupons },
        };
        await prisma.adminAuditLog.create({
            data: { adminName: a.admin?.name || a.telegramId, action: 'DB_BACKUP',
                details: JSON.stringify({ counts: dump.counts }) },
        });
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="backup_${Date.now()}.json"`);
        res.send(JSON.stringify(dump, null, 2));
    } catch (e) {
        console.error('backup error:', e);
        res.status(500).json({ success: false, error: e.message || 'backup failed' });
    }
});

// ---------- 🤖 ENGAGEMENT JOBS (manual trigger) ----------
import { runDailyDigestJob, runBirthdayCouponJob, runWinBackJob, notifyWishlistOnRestock } from '../jobs/engagement.job.js';

router.post('/admin/jobs/daily-digest', async (req, res) => {
    const a = await authAdmin(req, ['SuperAdmin', 'Owner']);
    if (!a.ok) return res.status(a.status).json({ success: false, error: a.error });
    runDailyDigestJob().catch(() => {});
    res.json({ success: true, message: 'triggered (running async)' });
});
router.post('/admin/jobs/birthday', async (req, res) => {
    const a = await authAdmin(req, ['SuperAdmin', 'Owner']);
    if (!a.ok) return res.status(a.status).json({ success: false, error: a.error });
    runBirthdayCouponJob().catch(() => {});
    res.json({ success: true, message: 'triggered (running async)' });
});
router.post('/admin/jobs/winback', async (req, res) => {
    const a = await authAdmin(req, ['SuperAdmin', 'Owner']);
    if (!a.ok) return res.status(a.status).json({ success: false, error: a.error });
    runWinBackJob().catch(() => {});
    res.json({ success: true, message: 'triggered (running async)' });
});

// ---------- 📦 WISHLIST (customer-facing) ----------
router.post('/wishlist/toggle', async (req, res) => {
    try {
        const initData = req.body?.initData;
        if (!verifyTelegramWebAppData(initData)) return res.status(401).json({ success: false, error: 'Invalid Telegram data' });
        const userData = JSON.parse(new URLSearchParams(initData).get('user') || '{}');
        const tgId = String(userData.id || '');
        const cust = await prisma.customer.findUnique({ where: { telegramUserId: tgId }, select: { customerId: true } });
        if (!cust) return res.status(404).json({ success: false, error: 'ไม่พบลูกค้า' });
        const productId = parseInt(req.body?.productId);
        if (!productId) return res.status(400).json({ success: false, error: 'productId ห้ามว่าง' });
        const exist = await prisma.wishlist.findUnique({ where: { customerId_productId: { customerId: cust.customerId, productId } } });
        if (exist) {
            await prisma.wishlist.delete({ where: { id: exist.id } });
            return res.json({ success: true, in: false });
        }
        await prisma.wishlist.create({ data: { customerId: cust.customerId, productId } });
        res.json({ success: true, in: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message || 'failed' }); }
});

router.get('/wishlist', async (req, res) => {
    try {
        const initData = req.query.initData;
        if (!verifyTelegramWebAppData(initData)) return res.status(401).json({ success: false, error: 'Invalid' });
        const userData = JSON.parse(new URLSearchParams(initData).get('user') || '{}');
        const tgId = String(userData.id || '');
        const cust = await prisma.customer.findUnique({ where: { telegramUserId: tgId }, select: { customerId: true } });
        if (!cust) return res.json({ success: true, items: [] });
        const wishes = await prisma.wishlist.findMany({
            where: { customerId: cust.customerId },
            orderBy: { createdAt: 'desc' },
        });
        const productIds = wishes.map(w => w.productId);
        const products = productIds.length ? await prisma.product.findMany({
            where: { id: { in: productIds } },
            select: { id: true, nameTh: true, nameEn: true, imageUrl: true, status: true, stockQuantity: true },
        }) : [];
        const pMap = Object.fromEntries(products.map(p => [p.id, p]));
        res.json({ success: true, items: wishes.map(w => ({ id: w.id, productId: w.productId, product: pMap[w.productId], notifiedAt: w.notifiedAt, createdAt: w.createdAt })) });
    } catch (e) { res.status(500).json({ success: false, error: e.message || 'failed' }); }
});

// ---------- 📊 ANALYTICS ----------

// GET /admin/analytics/customer/:customerId — drill-down: LTV + RFM + orders + prizes + referrals
router.get('/admin/analytics/customer/:customerId', async (req, res) => {
    const a = await authAdmin(req);
    if (!a.ok) return res.status(a.status).json({ success: false, error: a.error });
    try {
        const cid = req.params.customerId;
        const cust = await prisma.customer.findUnique({ where: { customerId: cid } });
        if (!cust) return res.status(404).json({ success: false, error: 'ไม่พบลูกค้า' });
        const paidStatuses = ['PAID', 'PROCESSING', 'SHIPPED'];
        const [allOrders, last90, prizes, ref, coupons] = await Promise.all([
            prisma.order.findMany({
                where: { customerId: cid, kind: 'PRODUCT', status: { in: paidStatuses } },
                select: { totalAmount: true, createdAt: true, id: true, status: true },
                orderBy: { createdAt: 'desc' },
            }),
            prisma.order.count({
                where: { customerId: cid, kind: 'PRODUCT', status: { in: paidStatuses }, createdAt: { gte: new Date(Date.now() - 90 * 86400000) } },
            }),
            prisma.mysteryBoxTicket.findMany({
                where: { customerId: cid, status: 'OPENED' },
                include: { awardedPrize: { select: { name: true } } },
                take: 20,
            }),
            prisma.referral.findMany({
                where: { referrerId: cid },
                select: { refereeId: true, status: true, createdAt: true, completedAt: true },
                orderBy: { createdAt: 'desc' },
            }),
            prisma.customerCoupon.findMany({
                where: { customerId: cid, status: 'USED' },
                include: { coupon: { select: { name: true } } },
                orderBy: { usedAt: 'desc' }, take: 10,
            }),
        ]);
        const ltv = allOrders.reduce((s, o) => s + Number(o.totalAmount), 0);
        const orderCount = allOrders.length;
        const aov = orderCount ? ltv / orderCount : 0;
        const lastOrderAt = allOrders[0]?.createdAt || null;
        const daysSinceLast = lastOrderAt ? Math.floor((Date.now() - new Date(lastOrderAt).getTime()) / 86400000) : null;
        // RFM segment (rough)
        let segment = 'New';
        if (orderCount >= 10 && daysSinceLast != null && daysSinceLast <= 30) segment = 'Champion';
        else if (orderCount >= 5 && daysSinceLast != null && daysSinceLast <= 60) segment = 'Loyal';
        else if (daysSinceLast != null && daysSinceLast > 90) segment = 'At-risk';
        else if (daysSinceLast != null && daysSinceLast > 180) segment = 'Lost';

        res.json({
            success: true,
            ltv, orderCount, aov, lastOrderAt, daysSinceLast, last90Orders: last90, segment,
            prizesWon: prizes.map(p => ({ name: p.awardedPrize?.name, openedAt: p.openedAt })),
            referrals: ref,
            recentCoupons: coupons.map(c => ({ couponName: c.coupon?.name, usedAt: c.usedAt })),
        });
    } catch (e) { res.status(500).json({ success: false, error: e.message || 'load failed' }); }
});

// GET /admin/analytics/product-heatmap — qty ขายต่อ (วันสัปดาห์ × ชั่วโมง) ใน 90 วันล่าสุด
router.get('/admin/analytics/product-heatmap', async (req, res) => {
    const a = await authAdmin(req);
    if (!a.ok) return res.status(a.status).json({ success: false, error: a.error });
    try {
        const since = new Date(Date.now() - 90 * 86400000);
        const items = await prisma.orderItem.findMany({
            where: { order: { kind: 'PRODUCT', status: { in: ['PAID', 'PROCESSING', 'SHIPPED'] }, createdAt: { gte: since } } },
            include: { order: { select: { createdAt: true } } },
        });
        // grid 7 × 24 (BKK time)
        const grid = Array.from({ length: 7 }, () => Array(24).fill(0));
        const tzOffsetMin = -7 * 60; // UTC → BKK adds 7 hours
        for (const it of items) {
            const t = new Date(it.order.createdAt.getTime() - tzOffsetMin * 60000);
            const dow = t.getUTCDay(); // 0-6
            const hour = t.getUTCHours();
            grid[dow][hour] += it.quantity;
        }
        // top combo (dow, hour) ที่ขายเยอะสุด
        const flat = [];
        for (let d = 0; d < 7; d++) for (let h = 0; h < 24; h++) flat.push({ dow: d, hour: h, qty: grid[d][h] });
        const top = flat.sort((a, b) => b.qty - a.qty).slice(0, 5);
        res.json({ success: true, grid, top, since });
    } catch (e) { res.status(500).json({ success: false, error: e.message || 'load failed' }); }
});

// GET /admin/analytics/coupon-roi — ทุกคูปอง: usedCount, totalDiscount, additionalRevenue
router.get('/admin/analytics/coupon-roi', async (req, res) => {
    const a = await authAdmin(req);
    if (!a.ok) return res.status(a.status).json({ success: false, error: a.error });
    try {
        const period = String(req.query.period || '90');
        const since = period === 'all' ? null : new Date(Date.now() - parseInt(period) * 86400000);
        const where = { appliedCouponId: { not: null }, status: { in: ['PAID', 'PROCESSING', 'SHIPPED'] }, kind: 'PRODUCT' };
        if (since) where.createdAt = { gte: since };
        const orders = await prisma.order.findMany({
            where, select: { appliedCouponId: true, totalAmount: true, discountAmount: true, customerId: true },
        });
        const grouped = new Map(); // couponId → { usedCount, totalDiscount, totalRevenue, customers:Set }
        for (const o of orders) {
            const id = o.appliedCouponId;
            if (!grouped.has(id)) grouped.set(id, { id, usedCount: 0, totalDiscount: 0, totalRevenue: 0, customers: new Set() });
            const g = grouped.get(id);
            g.usedCount += 1;
            g.totalDiscount += Number(o.discountAmount || 0);
            g.totalRevenue += Number(o.totalAmount);
            g.customers.add(o.customerId);
        }
        const ids = [...grouped.keys()];
        const couponNames = ids.length ? await prisma.coupon.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, type: true } }) : [];
        const nameMap = Object.fromEntries(couponNames.map(c => [c.id, c]));
        const result = [...grouped.values()].map(g => ({
            id: g.id,
            name: nameMap[g.id]?.name || g.id,
            type: nameMap[g.id]?.type || '?',
            usedCount: g.usedCount, totalDiscount: g.totalDiscount, totalRevenue: g.totalRevenue,
            uniqueCustomers: g.customers.size,
            roi: g.totalDiscount > 0 ? (g.totalRevenue / g.totalDiscount) : null, // revenue per ฿1 discount
        })).sort((a, b) => b.totalRevenue - a.totalRevenue);
        res.json({ success: true, since, coupons: result });
    } catch (e) { res.status(500).json({ success: false, error: e.message || 'load failed' }); }
});

// GET /admin/analytics/admin-perf — รายงานประสิทธิภาพ admin + time-to-bill + suspicious detection
router.get('/admin/analytics/admin-perf', async (req, res) => {
    const a = await authAdmin(req);
    if (!a.ok) return res.status(a.status).json({ success: false, error: a.error });
    try {
        const period = String(req.query.period || '30');
        const since = period === 'all' ? null : new Date(Date.now() - parseInt(period) * 86400000);
        const dateFilter = since ? { createdAt: { gte: since } } : {};
        const orders = await prisma.order.findMany({
            where: { ...dateFilter, assignedAdminId: { not: null }, kind: 'PRODUCT' },
            select: { id: true, assignedAdminId: true, assignedAt: true, firstBillAt: true, billAttempts: true, status: true },
        });
        // group by adminId
        const byAdmin = new Map();
        for (const o of orders) {
            const id = o.assignedAdminId;
            if (!byAdmin.has(id)) byAdmin.set(id, {
                adminId: id, totalAssigned: 0, billed: 0, completed: 0,
                timeToBillMs: [], totalAttempts: 0,
            });
            const g = byAdmin.get(id);
            g.totalAssigned += 1;
            if (o.firstBillAt) {
                g.billed += 1;
                if (o.assignedAt) g.timeToBillMs.push(new Date(o.firstBillAt).getTime() - new Date(o.assignedAt).getTime());
            }
            if (o.status === 'SHIPPED') g.completed += 1;
            g.totalAttempts += o.billAttempts || 0;
        }
        // suspicious bills count
        const suspiciousAttempts = await prisma.billAttempt.groupBy({
            by: ['adminId'], where: { suspicious: true, ...(since ? { createdAt: { gte: since } } : {}) },
            _count: { _all: true },
        });
        const suspMap = Object.fromEntries(suspiciousAttempts.map(x => [x.adminId, x._count._all]));

        const adminIds = [...byAdmin.keys()];
        const admins = adminIds.length ? await prisma.admin.findMany({ where: { telegramId: { in: adminIds } }, select: { telegramId: true, name: true, role: true } }) : [];
        const adminMap = Object.fromEntries(admins.map(x => [x.telegramId, x]));

        const out = [...byAdmin.values()].map(g => {
            const med = g.timeToBillMs.length
                ? Math.round([...g.timeToBillMs].sort((a, b) => a - b)[Math.floor(g.timeToBillMs.length / 2)] / 1000)
                : null;
            const avg = g.timeToBillMs.length
                ? Math.round((g.timeToBillMs.reduce((s, n) => s + n, 0) / g.timeToBillMs.length) / 1000)
                : null;
            return {
                adminId: g.adminId, name: adminMap[g.adminId]?.name || null, role: adminMap[g.adminId]?.role || '?',
                totalAssigned: g.totalAssigned, billed: g.billed, completed: g.completed,
                avgTimeToBillSec: avg, medianTimeToBillSec: med,
                totalBillAttempts: g.totalAttempts, avgAttemptsPerOrder: g.billed ? Math.round((g.totalAttempts / g.billed) * 10) / 10 : 0,
                suspiciousBills: suspMap[g.adminId] || 0,
                completionRate: g.totalAssigned ? Math.round((g.completed / g.totalAssigned) * 100) : 0,
            };
        }).sort((a, b) => b.completed - a.completed);
        res.json({ success: true, since, admins: out });
    } catch (e) { res.status(500).json({ success: false, error: e.message || 'load failed' }); }
});

// GET /admin/stock-alert — สินค้าที่ stock < threshold
router.get('/admin/stock-alert', async (req, res) => {
    const a = await authAdmin(req);
    if (!a.ok) return res.status(a.status).json({ success: false, error: a.error });
    try {
        const setting = await prisma.storeSetting.findUnique({ where: { id: 1 } });
        const lowT = setting?.lowStockThreshold ?? 50;
        const outT = setting?.outOfStockThreshold ?? 20;
        const products = await prisma.product.findMany({
            where: { stockQuantity: { lte: lowT }, status: 'IN_STOCK' },
            include: { category: { select: { id: true, name: true } } },
            orderBy: { stockQuantity: 'asc' },
        });
        const out = products.map(p => ({
            id: p.id, nameTh: p.nameTh, nameEn: p.nameEn, imageUrl: p.imageUrl,
            stockQuantity: p.stockQuantity, category: p.category,
            level: p.stockQuantity <= outT ? 'critical' : 'low',
        }));
        res.json({ success: true, lowThreshold: lowT, outThreshold: outT, products: out });
    } catch (e) { res.status(500).json({ success: false, error: 'load failed' }); }
});

// POST /admin/products/bulk-price { mode: 'pct'|'flat', value, categoryId? }
router.post('/admin/products/bulk-price', async (req, res) => {
    const a = await authAdmin(req, ['SuperAdmin', 'Owner']);
    if (!a.ok) return res.status(a.status).json({ success: false, error: a.error });
    try {
        const mode = String(req.body?.mode || ''); // 'pct' (เปอร์เซ็นต์), 'flat' (เพิ่ม/ลดบาท), 'set' (ปรับเป็นค่าเดียวกัน)
        const value = Number(req.body?.value);
        const categoryId = req.body?.categoryId ? parseInt(req.body.categoryId) : null;
        if (!['pct', 'flat', 'set'].includes(mode)) return res.status(400).json({ success: false, error: 'mode ต้อง pct/flat/set' });
        if (isNaN(value)) return res.status(400).json({ success: false, error: 'value ไม่ถูกต้อง' });
        if (!categoryId) return res.status(400).json({ success: false, error: 'ระบุ categoryId (Product schema ไม่มีราคารายตัว — ราคาฐานอยู่ที่ Category)' });
        const cat = await prisma.category.findUnique({ where: { id: categoryId } });
        if (!cat) return res.status(404).json({ success: false, error: 'ไม่พบหมวด' });
        const before = Number(cat.price);
        let after;
        if (mode === 'pct') after = Math.max(0, Math.round((before * (1 + value / 100)) * 100) / 100);
        else if (mode === 'flat') after = Math.max(0, Math.round((before + value) * 100) / 100);
        else after = Math.max(0, Math.round(value * 100) / 100);
        await prisma.category.update({ where: { id: categoryId }, data: { price: after } });
        await prisma.adminAuditLog.create({
            data: { adminName: a.admin?.name || a.telegramId, action: 'BULK_PRICE_' + mode.toUpperCase(),
                details: JSON.stringify({ categoryId, categoryName: cat.name, mode, value, before, after }) },
        });
        res.json({ success: true, before, after, categoryName: cat.name });
    } catch (e) {
        console.error('bulk-price error:', e);
        res.status(500).json({ success: false, error: e.message || 'failed' });
    }
});

// GET /admin/orders/export — CSV ตาม filter
router.get('/admin/orders/export', async (req, res) => {
    const a = await authAdmin(req);
    if (!a.ok) return res.status(a.status).json({ success: false, error: a.error });
    try {
        const status = String(req.query.status || 'ALL').toUpperCase();
        const since = req.query.since ? new Date(req.query.since) : null;
        const where = {};
        // รองรับ NEEDS_VERIFY แบบเดียวกับ /admin/orders
        if (status === 'NEEDS_VERIFY') {
            where.payment = { status: 'PENDING' };
            where.status = { in: ['PENDING_PAYMENT', 'PAID'] };
        } else if (status !== 'ALL') {
            const validStatuses = ['PENDING_PAYMENT', 'PAID', 'PROCESSING', 'SHIPPED', 'CANCELLED'];
            if (!validStatuses.includes(status)) return res.status(400).json({ success: false, error: 'invalid status: ' + status });
            where.status = status;
        }
        if (since) where.createdAt = { gte: since };
        // role-scoping ใช้ AND of OR เพื่อไม่ทับ where.OR ที่อาจมีจาก NEEDS_VERIFY
        if (a.admin.role === 'Admin') {
            where.AND = [{ OR: [{ assignedAdminId: a.telegramId }, { assignedAdminId: null }] }];
        }
        const orders = await prisma.order.findMany({
            where,
            include: {
                customer: { select: { customerId: true, firstName: true, lastName: true, phoneNumber: true } },
                items: { include: { product: { select: { nameTh: true, nameEn: true } } } },
                payment: { select: { amount: true, status: true } },
            },
            orderBy: { createdAt: 'desc' },
            take: 5000,
        });
        // CSV header
        const headers = ['orderId','status','kind','createdAt','customerId','customerName','phone','totalAmount','paidAmount','paymentStatus','itemCount','items','billNumber','trackingNumber','assignedAdmin'];
        const rows = orders.map(o => {
            const itemList = o.items.map(it => `${it.product.nameTh || it.product.nameEn || '#'+it.productId}×${it.quantity}`).join('; ');
            const cust = `${o.customer?.firstName||''} ${o.customer?.lastName||''}`.trim();
            const cells = [
                o.id, o.status, o.kind, o.createdAt.toISOString(),
                o.customerId, cust, o.customer?.phoneNumber || '',
                Number(o.totalAmount), o.payment ? Number(o.payment.amount) : '',
                o.payment?.status || '', o.items.reduce((s,i)=>s+i.quantity,0),
                itemList, o.billNumber || '', o.trackingNumber || '',
                o.assignedAdminId || '',
            ];
            return cells.map(c => {
                const s = String(c ?? '');
                return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
            }).join(',');
        });
        const csv = '﻿' + [headers.join(','), ...rows].join('\n'); // BOM สำหรับ Excel TH
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="orders_${Date.now()}.csv"`);
        res.send(csv);
    } catch (e) {
        console.error('export error:', e);
        res.status(500).json({ success: false, error: e.message || 'export failed' });
    }
});

// PATCH /admin/customers/:customerId/admin-note { adminNote }
router.patch('/admin/customers/:customerId/admin-note', async (req, res) => {
    const a = await authAdmin(req);
    if (!a.ok) return res.status(a.status).json({ success: false, error: a.error });
    try {
        const cust = await prisma.customer.findUnique({ where: { customerId: req.params.customerId } });
        if (!cust) return res.status(404).json({ success: false, error: 'ไม่พบลูกค้า' });
        const note = (req.body?.adminNote ?? '').toString();
        await prisma.customer.update({ where: { customerId: cust.customerId }, data: { adminNote: note || null } });
        await prisma.adminAuditLog.create({
            data: { adminName: a.admin?.name || a.telegramId, action: 'CUSTOMER_NOTE',
                targetId: cust.customerId, details: JSON.stringify({ len: note.length }) },
        });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message || 'failed' }); }
});

// GET /admin/global-search?q= — ค้นหาทุก entity (orders/customers/products/coupons)
router.get('/admin/global-search', async (req, res) => {
    const a = await authAdmin(req);
    if (!a.ok) return res.status(a.status).json({ success: false, error: a.error });
    try {
        const q = String(req.query.q || '').trim();
        if (q.length < 2) return res.json({ success: true, orders: [], customers: [], products: [], coupons: [] });
        const [orders, customers, products, coupons] = await Promise.all([
            prisma.order.findMany({
                where: { OR: [{ id: { contains: q, mode: 'insensitive' } }, { customerId: { contains: q, mode: 'insensitive' } }] },
                select: { id: true, status: true, totalAmount: true, customerId: true }, take: 10,
            }),
            prisma.customer.findMany({
                where: { isDeleted: false, OR: [
                    { customerId: { contains: q, mode: 'insensitive' } },
                    { phoneNumber: { contains: q } },
                    { firstName: { contains: q, mode: 'insensitive' } },
                    { lastName: { contains: q, mode: 'insensitive' } },
                ]},
                select: { customerId: true, firstName: true, lastName: true, phoneNumber: true, points: true }, take: 10,
            }),
            prisma.product.findMany({
                where: { OR: [
                    { nameTh: { contains: q, mode: 'insensitive' } },
                    { nameEn: { contains: q, mode: 'insensitive' } },
                ]},
                select: { id: true, nameTh: true, nameEn: true, stockQuantity: true, status: true }, take: 10,
            }),
            prisma.coupon.findMany({
                where: { OR: [
                    { id: { contains: q, mode: 'insensitive' } },
                    { name: { contains: q, mode: 'insensitive' } },
                ]},
                select: { id: true, name: true, isActive: true }, take: 10,
            }),
        ]);
        res.json({
            success: true,
            orders: orders.map(o => ({ ...o, totalAmount: Number(o.totalAmount) })),
            customers, products, coupons,
        });
    } catch (e) {
        console.error('global-search error:', e);
        res.status(500).json({ success: false, error: e.message || 'search failed' });
    }
});

// POST /admin/products/bulk-stock { mode: 'add'|'sub'|'set', adjustments: [{id, value}] }
router.post('/admin/products/bulk-stock', async (req, res) => {
    const a = await authAdmin(req);
    if (!a.ok) return res.status(a.status).json({ success: false, error: a.error });
    try {
        const mode = String(req.body?.mode || '').toLowerCase();
        if (!['add', 'sub', 'set'].includes(mode)) return res.status(400).json({ success: false, error: 'mode ต้องเป็น add/sub/set' });
        const adjustments = Array.isArray(req.body?.adjustments) ? req.body.adjustments : [];
        if (!adjustments.length) return res.status(400).json({ success: false, error: 'ไม่มีรายการที่จะปรับ' });
        // 'set' mode = SuperAdmin/Owner only (เปลี่ยนสต็อกตรงๆ ความเสี่ยงสูง)
        if (mode === 'set' && !['SuperAdmin', 'Owner'].includes(a.admin.role)) {
            return res.status(403).json({ success: false, error: 'mode "ปรับ" ใช้ได้เฉพาะ SuperAdmin/Owner' });
        }
        const ids = adjustments.map(x => parseInt(x.id)).filter(Boolean);
        const products = await prisma.product.findMany({ where: { id: { in: ids } }, select: { id: true, nameTh: true, nameEn: true, stockQuantity: true } });
        const pMap = new Map(products.map(p => [p.id, p]));
        const changes = []; // { id, name, before, after, diff, capped }
        await prisma.$transaction(async (tx) => {
            for (const adj of adjustments) {
                const id = parseInt(adj.id);
                const p = pMap.get(id);
                if (!p) continue;
                const v = Math.abs(parseInt(adj.value)) || 0;
                if (v === 0 && mode !== 'set') continue;
                const before = p.stockQuantity;
                let after = before;
                let capped = false;
                if (mode === 'add') after = before + v;
                else if (mode === 'sub') {
                    after = Math.max(0, before - v);
                    if (before - v < 0) capped = true;
                } else if (mode === 'set') {
                    after = Math.max(0, parseInt(adj.value) || 0);
                }
                if (after === before && mode !== 'set') continue;
                await tx.product.update({ where: { id }, data: { stockQuantity: after } });
                changes.push({ id, name: p.nameTh || p.nameEn || `#${id}`, before, after, diff: after - before, capped });
            }
            await tx.adminAuditLog.create({
                data: { adminName: a.admin?.name || a.telegramId, action: 'BULK_STOCK_' + mode.toUpperCase(),
                    details: JSON.stringify({ mode, count: changes.length, changes: changes.slice(0, 50) }) },
            });
        });
        // realtime broadcast
        try {
            const io = req.app.get('socketio');
            if (io) for (const ch of changes) io.emit('product_update', { id: ch.id, stockQuantity: ch.after });
        } catch (e) {}
        // wishlist notify — สำหรับสินค้าที่เพิ่ง restock (before=0, after>0)
        const restocked = changes.filter(c => c.before === 0 && c.after > 0);
        if (restocked.length) {
            (async () => {
                for (const ch of restocked) {
                    try { await notifyWishlistOnRestock(ch.id); } catch (e) {}
                }
            })();
        }
        res.json({ success: true, mode, changes });
    } catch (e) {
        console.error('admin bulk-stock error:', e);
        res.status(500).json({ success: false, error: e.message || 'bulk update failed' });
    }
});

function sanitizeProductPayload(b) {
    const num = (v) => (v === '' || v == null ? null : Number(v));
    const intOrNull = (v) => (v === '' || v == null ? null : parseInt(v));
    return {
        nameTh: b.nameTh ?? null, nameEn: b.nameEn ?? null,
        tagline: b.tagline ?? null, taglineEn: b.taglineEn ?? null,
        description: b.description ?? null, descriptionEn: b.descriptionEn ?? null,
        imageUrl: b.imageUrl ?? undefined, flavorIconUrl: b.flavorIconUrl ?? null,
        status: b.status === 'OUT_OF_STOCK' ? 'OUT_OF_STOCK' : 'IN_STOCK',
        isNew: !!b.isNew, isHot: !!b.isHot,
        stockQuantity: intOrNull(b.stockQuantity) ?? 0,
        nicotine: intOrNull(b.nicotine),
        coolnessLevel: intOrNull(b.coolnessLevel) ?? 0,
        sweetnessLevel: intOrNull(b.sweetnessLevel) ?? 0,
        flavorIntensityLevel: intOrNull(b.flavorIntensityLevel) ?? 0,
        color: b.color ?? null, battery: b.battery ?? null, wattage: b.wattage ?? null,
        allowCoupons: b.allowCoupons !== false,
        categoryId: intOrNull(b.categoryId),
    };
}

// ---------- 📦 SHIPPING SYNC (SuperAdmin/Owner) ----------
// POST /admin/shipping/sync-sheet { sheetUrl }
router.post('/admin/shipping/sync-sheet', async (req, res) => {
    const a = await authAdmin(req, ['SuperAdmin', 'Owner']);
    if (!a.ok) return res.status(a.status).json({ success: false, error: a.error });
    try {
        const sheetUrl = String(req.body?.sheetUrl || '').trim();
        if (!sheetUrl.includes('docs.google.com/spreadsheets')) {
            return res.status(400).json({ success: false, error: 'URL ต้องเป็น Google Sheets' });
        }
        const stats = await shippingService.syncShippingFromGoogleSheet(sheetUrl);
        await prisma.adminAuditLog.create({
            data: { adminName: a.admin?.name || a.telegramId, action: 'SHIPPING_SYNC',
                details: JSON.stringify({ sheetUrl, ...stats, errors: stats.errors?.slice(0, 10) }) },
        });
        res.json({ success: true, stats });
    } catch (e) {
        console.error('shipping sync error:', e);
        res.status(500).json({ success: false, error: e.message || 'sync failed' });
    }
});

// ---------- ⚙️ SETTINGS ----------
const KNOWN_CONFIG_KEYS = [
    { key: 'store_is_open', label: '🚪 เปิดร้าน (true/false)', type: 'text' },
    { key: 'store_closed_message', label: '🚪 ข้อความหน้าปิดร้าน', type: 'text' },
    { key: 'shipping_fee', label: 'ค่าจัดส่ง (บาท)', type: 'number' },
    { key: 'free_shipping_min', label: 'ส่งฟรีเมื่อยอดถึง (บาท)', type: 'number' },
    { key: 'standardReferralPoints', label: 'แต้มชวนเพื่อนพื้นฐาน', type: 'number' },
    { key: 'standardLinkBonus', label: 'แต้มผูกบัญชีพื้นฐาน', type: 'number' },
    { key: 'expiryDaysNewMember', label: 'วันหมดอายุแต้มสมาชิกใหม่', type: 'number' },
    { key: 'expiryDaysAddPoints', label: 'วันหมดอายุเมื่อเติมแต้ม', type: 'number' },
    { key: 'expiryDaysReferralBonus', label: 'วันหมดอายุโบนัสชวนเพื่อน', type: 'number' },
    { key: 'expiryDaysLinkAccount', label: 'วันหมดอายุโบนัสผูกบัญชี', type: 'number' },
    { key: 'expiryDaysLimitMax', label: 'จำนวนวันหมดอายุสูงสุด', type: 'number' },
    { key: 'tier_silver_min', label: 'จำนวนเพื่อนถึง Silver', type: 'number' },
    { key: 'tier_gold_min', label: 'จำนวนเพื่อนถึง Gold', type: 'number' },
    { key: 'tier_silver_multiplier', label: 'ตัวคูณแต้ม Silver', type: 'number' },
    { key: 'tier_gold_multiplier', label: 'ตัวคูณแต้ม Gold', type: 'number' },
    { key: 'minPurchaseForReferral', label: 'ยอดขั้นต่ำเพื่อนับ referral', type: 'number' },
    { key: 'reviewPoints', label: 'แต้มจากการรีวิว', type: 'number' },
    { key: 'orderBotUsername', label: 'Username บอทออเดอร์', type: 'text' },
    { key: 'tracking_url_template', label: 'Template URL พัสดุ', type: 'text' },
    { key: 'channelId', label: 'Channel ID (โพสต์ของรางวัล)', type: 'text' },
    { key: 'expiryCutoffTime', label: 'เวลาตัดแต้มหมดอายุ (HH:mm)', type: 'text' },
    { key: 'reminderNotificationTime', label: 'เวลาเตือนแต้มใกล้หมด (HH:mm)', type: 'text' },
];

router.get('/admin/system-config', async (req, res) => {
    const a = await authAdmin(req);
    if (!a.ok) return res.status(a.status).json({ success: false, error: a.error });
    try {
        const rows = await prisma.systemConfig.findMany();
        const map = Object.fromEntries(rows.map(r => [r.key, r.value]));
        const items = KNOWN_CONFIG_KEYS.map(k => ({ ...k, value: map[k.key] ?? '' }));
        // include any extra keys ใน DB ที่ไม่อยู่ใน known list
        const knownSet = new Set(KNOWN_CONFIG_KEYS.map(k => k.key));
        for (const r of rows) if (!knownSet.has(r.key)) items.push({ key: r.key, label: r.key, type: 'text', value: r.value });
        res.json({ success: true, items });
    } catch (e) { res.status(500).json({ success: false, error: 'load failed' }); }
});

router.patch('/admin/system-config', async (req, res) => {
    const a = await authAdmin(req, ['Owner', 'SuperAdmin']);
    if (!a.ok) return res.status(a.status).json({ success: false, error: a.error });
    try {
        const updates = req.body?.updates;
        if (!Array.isArray(updates)) return res.status(400).json({ success: false, error: 'updates ต้องเป็น array' });
        for (const { key, value } of updates) {
            if (!key) continue;
            await prisma.systemConfig.upsert({
                where: { key }, update: { value: String(value ?? '') },
                create: { key, value: String(value ?? '') },
            });
        }
        await prisma.adminAuditLog.create({ data: { adminName: a.admin?.name || a.telegramId, action: 'CONFIG_UPDATE', details: JSON.stringify({ count: updates.length, keys: updates.map(u => u.key) }) } });
        // hot-reload cache so changes take effect immediately (no server restart)
        try { await loadConfig(); } catch (e) { console.error('config hot-reload failed:', e); }
        res.json({ success: true, count: updates.length });
    } catch (e) { res.status(500).json({ success: false, error: e.message || 'update failed' }); }
});

// Public: GET /store-status (ลูกค้าใช้)
router.get('/store-status', async (req, res) => {
    const isOpen = String(getConfig('store_is_open', 'true')).toLowerCase() !== 'false';
    res.json({ success: true, isOpen, closedMessage: getConfig('store_closed_message', '') || '' });
});

router.get('/admin/store-setting', async (req, res) => {
    const a = await authAdmin(req);
    if (!a.ok) return res.status(a.status).json({ success: false, error: a.error });
    try {
        let s = await prisma.storeSetting.findUnique({ where: { id: 1 } });
        if (!s) s = await prisma.storeSetting.create({ data: { id: 1 } });
        res.json({ success: true, setting: s });
    } catch (e) { res.status(500).json({ success: false, error: 'load failed' }); }
});

router.patch('/admin/store-setting', async (req, res) => {
    const a = await authAdmin(req, ['Owner', 'SuperAdmin']);
    if (!a.ok) return res.status(a.status).json({ success: false, error: a.error });
    try {
        const b = req.body || {};
        const data = {};
        if (b.lowStockThreshold !== undefined) data.lowStockThreshold = parseInt(b.lowStockThreshold) || 0;
        if (b.outOfStockThreshold !== undefined) data.outOfStockThreshold = parseInt(b.outOfStockThreshold) || 0;
        if (b.orderExpiryMinutes !== undefined) data.orderExpiryMinutes = parseInt(b.orderExpiryMinutes) || 30;
        await prisma.storeSetting.upsert({ where: { id: 1 }, update: data, create: { id: 1, ...data } });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message || 'update failed' }); }
});

router.get('/admin/bank-accounts', async (req, res) => {
    const a = await authAdmin(req);
    if (!a.ok) return res.status(a.status).json({ success: false, error: a.error });
    try {
        const accounts = await prisma.bankAccount.findMany({ orderBy: [{ isActive: 'desc' }, { id: 'asc' }] });
        res.json({ success: true, accounts });
    } catch (e) { res.status(500).json({ success: false, error: 'load failed' }); }
});

router.post('/admin/bank-accounts', async (req, res) => {
    const a = await authAdmin(req, ['Owner', 'SuperAdmin']);
    if (!a.ok) return res.status(a.status).json({ success: false, error: a.error });
    try {
        const data = sanitizeBankPayload(req.body || {}, true);
        const created = await prisma.bankAccount.create({ data });
        res.json({ success: true, account: { id: created.id } });
    } catch (e) { res.status(500).json({ success: false, error: e.message || 'create failed' }); }
});

router.patch('/admin/bank-accounts/:id', async (req, res) => {
    const a = await authAdmin(req, ['Owner', 'SuperAdmin']);
    if (!a.ok) return res.status(a.status).json({ success: false, error: a.error });
    try {
        const id = parseInt(req.params.id);
        const data = sanitizeBankPayload(req.body || {}, false);
        await prisma.bankAccount.update({ where: { id }, data });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message || 'update failed' }); }
});

router.delete('/admin/bank-accounts/:id', async (req, res) => {
    const a = await authAdmin(req, ['Owner', 'SuperAdmin']);
    if (!a.ok) return res.status(a.status).json({ success: false, error: a.error });
    try {
        await prisma.bankAccount.delete({ where: { id: parseInt(req.params.id) } });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message || 'delete failed' }); }
});

function sanitizeBankPayload(b, isCreate) {
    const out = {
        bankName: b.bankName ?? undefined,
        accountName: b.accountName ?? undefined,
        accountNumber: b.accountNumber ?? undefined,
        promptPayId: b.promptPayId ?? undefined,
        activeStartTime: b.activeStartTime || null,
        activeEndTime: b.activeEndTime || null,
        isActive: b.isActive !== false,
    };
    if (b.minAmount !== undefined) out.minAmount = b.minAmount === '' ? null : Number(b.minAmount);
    if (b.maxAmount !== undefined) out.maxAmount = b.maxAmount === '' ? null : Number(b.maxAmount);
    if (!isCreate) Object.keys(out).forEach(k => out[k] === undefined && delete out[k]);
    return out;
}

// ---------- 📣 BROADCAST ----------
// POST /admin/broadcast { title, body, link?, sendTelegram?, filter: 'all'|'bronze'|'silver'|'gold'|'new'|'inactive' }
router.post('/admin/broadcast', async (req, res) => {
    const a = await authAdmin(req);
    if (!a.ok) return res.status(a.status).json({ success: false, error: a.error });
    try {
        const b = req.body || {};
        if (!b.title || !b.body) return res.status(400).json({ success: false, error: 'title/body ห้ามว่าง' });
        const filter = String(b.filter || 'all');
        const sendTelegram = !!b.sendTelegram;

        // คำนวณ excludeCustomerIds (กลับด้านจาก filter)
        let excludeCustomerIds = [];
        if (filter !== 'all') {
            const all = await prisma.customer.findMany({
                where: { isDeleted: false },
                select: { customerId: true, referralCount: true, joinDate: true },
            });
            const now = Date.now();
            const includeSet = new Set();
            for (const c of all) {
                let match = false;
                if (filter === 'bronze') match = c.referralCount < 3;
                else if (filter === 'silver') match = c.referralCount >= 3 && c.referralCount < 6;
                else if (filter === 'gold') match = c.referralCount >= 6;
                else if (filter === 'new') match = (now - new Date(c.joinDate).getTime()) <= 7 * 86400000;
                if (match) includeSet.add(c.customerId);
            }
            if (filter === 'inactive') {
                // ลูกค้าที่ไม่มี order ใน 30 วัน
                const since = new Date(Date.now() - 30 * 86400000);
                const recent = await prisma.order.findMany({
                    where: { createdAt: { gte: since } },
                    select: { customerId: true }, distinct: ['customerId'],
                });
                const recentSet = new Set(recent.map(o => o.customerId));
                for (const c of all) if (!recentSet.has(c.customerId)) includeSet.add(c.customerId);
            }
            excludeCustomerIds = all.map(c => c.customerId).filter(id => !includeSet.has(id));
        }

        const broadcastId = `bc-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
        const result = await notifCenter.broadcastNotification({
            kind: 'ADMIN_BROADCAST',
            title: b.title, body: b.body, link: b.link || null,
            broadcastId, sendTelegram, excludeCustomerIds,
        });
        await prisma.adminAuditLog.create({
            data: { adminName: a.admin?.name || a.telegramId, action: 'BROADCAST',
                details: JSON.stringify({ broadcastId, filter, title: b.title, sendTelegram, ...result }) },
        });
        res.json({ success: true, broadcastId, ...result });
    } catch (e) {
        console.error('admin broadcast error:', e);
        res.status(500).json({ success: false, error: e.message || 'broadcast failed' });
    }
});

// ---------- 👨‍💼 ADMIN MANAGEMENT (Owner only) ----------
router.get('/admin/admins', async (req, res) => {
    const a = await authAdmin(req, ['Owner']);
    if (!a.ok) return res.status(a.status).json({ success: false, error: a.error });
    try {
        const admins = await prisma.admin.findMany({ orderBy: { role: 'asc' } });
        res.json({ success: true, admins });
    } catch (e) { res.status(500).json({ success: false, error: 'load failed' }); }
});

router.post('/admin/admins', async (req, res) => {
    const a = await authAdmin(req, ['Owner']);
    if (!a.ok) return res.status(a.status).json({ success: false, error: a.error });
    try {
        const b = req.body || {};
        if (!b.telegramId) return res.status(400).json({ success: false, error: 'telegramId ห้ามว่าง' });
        const allowed = ['Admin', 'SuperAdmin'];
        const role = allowed.includes(b.role) ? b.role : 'Admin';
        const customRoleName = b.customRoleName ? String(b.customRoleName).trim() : null;
        // ถ้าระบุ customRoleName → ต้องมีจริงใน matrix
        if (customRoleName) {
            const matrix = await getRbacMatrix();
            if (!matrix.custom?.[customRoleName]) return res.status(400).json({ success: false, error: 'ไม่พบ custom role: ' + customRoleName });
        }
        const created = await prisma.admin.create({ data: { telegramId: String(b.telegramId), name: b.name || null, role, customRoleName } });
        await prisma.adminAuditLog.create({ data: { adminName: a.admin?.name || a.telegramId, action: 'ADMIN_ADD',
            details: JSON.stringify({ targetTelegramId: created.telegramId, role, customRoleName }) } });
        res.json({ success: true });
    } catch (e) {
        if (e.code === 'P2002') return res.status(400).json({ success: false, error: 'มี admin telegram id นี้อยู่แล้ว' });
        res.status(500).json({ success: false, error: e.message || 'create failed' });
    }
});

router.patch('/admin/admins/:telegramId', async (req, res) => {
    const a = await authAdmin(req, ['Owner']);
    if (!a.ok) return res.status(a.status).json({ success: false, error: a.error });
    try {
        const tgId = req.params.telegramId;
        const exist = await prisma.admin.findUnique({ where: { telegramId: tgId } });
        if (!exist) return res.status(404).json({ success: false, error: 'ไม่พบ admin' });
        if (exist.role === 'Owner') return res.status(400).json({ success: false, error: 'แก้ไข Owner ไม่ได้' });
        const b = req.body || {};
        const allowed = ['Admin', 'SuperAdmin'];
        const data = {};
        if (b.name !== undefined) data.name = b.name || null;
        if (b.role !== undefined) {
            if (!allowed.includes(b.role)) return res.status(400).json({ success: false, error: 'role ไม่ถูกต้อง (Admin/SuperAdmin)' });
            data.role = b.role;
        }
        if (b.customRoleName !== undefined) {
            const cn = b.customRoleName ? String(b.customRoleName).trim() : null;
            if (cn) {
                const matrix = await getRbacMatrix();
                if (!matrix.custom?.[cn]) return res.status(400).json({ success: false, error: 'ไม่พบ custom role: ' + cn });
            }
            data.customRoleName = cn;
        }
        await prisma.admin.update({ where: { telegramId: tgId }, data });
        await prisma.adminAuditLog.create({ data: { adminName: a.admin?.name || a.telegramId, action: 'ADMIN_EDIT',
            details: JSON.stringify({ targetTelegramId: tgId, changes: data }) } });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message || 'update failed' }); }
});

router.delete('/admin/admins/:telegramId', async (req, res) => {
    const a = await authAdmin(req, ['Owner']);
    if (!a.ok) return res.status(a.status).json({ success: false, error: a.error });
    try {
        const tgId = req.params.telegramId;
        const exist = await prisma.admin.findUnique({ where: { telegramId: tgId } });
        if (!exist) return res.status(404).json({ success: false, error: 'ไม่พบ admin' });
        if (exist.role === 'Owner') return res.status(400).json({ success: false, error: 'ลบ Owner ไม่ได้' });
        await prisma.admin.delete({ where: { telegramId: tgId } });
        await prisma.adminAuditLog.create({ data: { adminName: a.admin?.name || a.telegramId, action: 'ADMIN_REMOVE',
            details: JSON.stringify({ targetTelegramId: tgId, prevRole: exist.role }) } });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message || 'delete failed' }); }
});

// ---------- 🕐 ADMIN SHIFTS (SuperAdmin/Owner) ----------
// GET /admin/shifts — list ทุก admin + ตารางสัปดาห์
router.get('/admin/shifts', async (req, res) => {
    const a = await authAdmin(req, ['SuperAdmin', 'Owner']);
    if (!a.ok) return res.status(a.status).json({ success: false, error: a.error });
    try {
        const admins = await prisma.admin.findMany({
            orderBy: { role: 'asc' },
            include: { adminShifts: true },
        });
        const out = admins.map(ad => ({
            telegramId: ad.telegramId, name: ad.name, role: ad.role,
            shifts: ad.adminShifts.map(s => ({
                id: s.id, dayOfWeek: s.dayOfWeek,
                shift1Start: s.shift1Start, shift1End: s.shift1End,
                shift2Start: s.shift2Start, shift2End: s.shift2End,
                shift3Start: s.shift3Start, shift3End: s.shift3End,
            })),
        }));
        res.json({ success: true, admins: out });
    } catch (e) {
        console.error('admin shifts list error:', e);
        res.status(500).json({ success: false, error: 'load failed' });
    }
});

// PUT /admin/shifts/:telegramId/:dayOfWeek — upsert 1 row (วัน × admin)
router.put('/admin/shifts/:telegramId/:dayOfWeek', async (req, res) => {
    const a = await authAdmin(req, ['SuperAdmin', 'Owner']);
    if (!a.ok) return res.status(a.status).json({ success: false, error: a.error });
    try {
        const tgId = req.params.telegramId;
        const day = parseInt(req.params.dayOfWeek);
        if (isNaN(day) || day < 0 || day > 6) return res.status(400).json({ success: false, error: 'dayOfWeek ต้อง 0-6' });
        const exist = await prisma.admin.findUnique({ where: { telegramId: tgId } });
        if (!exist) return res.status(404).json({ success: false, error: 'ไม่พบ admin' });
        const b = req.body || {};
        const data = {
            shift1Start: b.shift1Start || null, shift1End: b.shift1End || null,
            shift2Start: b.shift2Start || null, shift2End: b.shift2End || null,
            shift3Start: b.shift3Start || null, shift3End: b.shift3End || null,
        };
        await prisma.adminShift.upsert({
            where: { adminTelegramId_dayOfWeek: { adminTelegramId: tgId, dayOfWeek: day } },
            update: data,
            create: { adminTelegramId: tgId, dayOfWeek: day, ...data },
        });
        await prisma.adminAuditLog.create({
            data: { adminName: a.admin?.name || a.telegramId, action: 'SHIFT_UPDATE',
                details: JSON.stringify({ targetTelegramId: tgId, dayOfWeek: day, ...data }) },
        });
        res.json({ success: true });
    } catch (e) {
        console.error('admin shift upsert error:', e);
        res.status(500).json({ success: false, error: e.message || 'update failed' });
    }
});

// POST /admin/shifts/reset { telegramId? } — ลบทั้งหมด หรือเฉพาะคน
router.post('/admin/shifts/reset', async (req, res) => {
    const a = await authAdmin(req, ['SuperAdmin', 'Owner']);
    if (!a.ok) return res.status(a.status).json({ success: false, error: a.error });
    try {
        const tgId = req.body?.telegramId ? String(req.body.telegramId) : null;
        const where = tgId ? { adminTelegramId: tgId } : {};
        const result = await prisma.adminShift.deleteMany({ where });
        await prisma.adminAuditLog.create({
            data: { adminName: a.admin?.name || a.telegramId, action: 'SHIFT_RESET',
                details: JSON.stringify({ scope: tgId ? 'single' : 'all', targetTelegramId: tgId, deleted: result.count }) },
        });
        res.json({ success: true, deleted: result.count });
    } catch (e) { res.status(500).json({ success: false, error: e.message || 'reset failed' }); }
});

// DELETE /admin/shifts/:telegramId/:dayOfWeek — clear ทั้งวัน
router.delete('/admin/shifts/:telegramId/:dayOfWeek', async (req, res) => {
    const a = await authAdmin(req, ['SuperAdmin', 'Owner']);
    if (!a.ok) return res.status(a.status).json({ success: false, error: a.error });
    try {
        const tgId = req.params.telegramId;
        const day = parseInt(req.params.dayOfWeek);
        await prisma.adminShift.deleteMany({ where: { adminTelegramId: tgId, dayOfWeek: day } });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message || 'delete failed' }); }
});

// ---------- 📜 AUDIT LOG ----------
router.get('/admin/audit-log', async (req, res) => {
    const a = await authAdmin(req);
    if (!a.ok) return res.status(a.status).json({ success: false, error: a.error });
    try {
        const take = Math.min(parseInt(req.query.take) || 100, 500);
        const action = req.query.action ? String(req.query.action) : null;
        const where = action ? { action } : {};
        const logs = await prisma.adminAuditLog.findMany({ where, orderBy: { createdAt: 'desc' }, take });
        res.json({ success: true, logs });
    } catch (e) { res.status(500).json({ success: false, error: 'load failed' }); }
});

// ---------- 🎞️ BANNERS ----------
router.get('/admin/banners', async (req, res) => {
    const a = await authAdmin(req);
    if (!a.ok) return res.status(a.status).json({ success: false, error: a.error });
    try {
        const banners = await prisma.banner.findMany({ orderBy: [{ order: 'asc' }, { id: 'asc' }] });
        res.json({ success: true, banners });
    } catch (e) { res.status(500).json({ success: false, error: 'load failed' }); }
});

router.post('/admin/banners', async (req, res) => {
    const a = await authAdmin(req);
    if (!a.ok) return res.status(a.status).json({ success: false, error: a.error });
    try {
        const b = req.body || {};
        if (!b.imageUrl) return res.status(400).json({ success: false, error: 'imageUrl ห้ามว่าง' });
        const created = await prisma.banner.create({ data: {
            imageUrl: b.imageUrl, linkUrl: b.linkUrl || null,
            isActive: b.isActive !== false, order: parseInt(b.order) || 0,
        }});
        res.json({ success: true, banner: { id: created.id } });
    } catch (e) { res.status(500).json({ success: false, error: e.message || 'create failed' }); }
});

router.patch('/admin/banners/:id', async (req, res) => {
    const a = await authAdmin(req);
    if (!a.ok) return res.status(a.status).json({ success: false, error: a.error });
    try {
        const id = parseInt(req.params.id);
        const exist = await prisma.banner.findUnique({ where: { id } });
        if (!exist) return res.status(404).json({ success: false, error: 'ไม่พบ banner' });
        const b = req.body || {};
        await prisma.banner.update({ where: { id }, data: {
            imageUrl: b.imageUrl ?? exist.imageUrl,
            linkUrl: b.linkUrl !== undefined ? (b.linkUrl || null) : exist.linkUrl,
            isActive: b.isActive !== undefined ? !!b.isActive : exist.isActive,
            order: b.order !== undefined ? parseInt(b.order) || 0 : exist.order,
        }});
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message || 'update failed' }); }
});

router.delete('/admin/banners/:id', async (req, res) => {
    const a = await authAdmin(req);
    if (!a.ok) return res.status(a.status).json({ success: false, error: a.error });
    try {
        await prisma.banner.delete({ where: { id: parseInt(req.params.id) } });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message || 'delete failed' }); }
});

// ---------- 📅 CAMPAIGNS ----------
router.get('/admin/campaigns', async (req, res) => {
    const a = await authAdmin(req);
    if (!a.ok) return res.status(a.status).json({ success: false, error: a.error });
    try {
        const camps = await prisma.campaign.findMany({ orderBy: [{ isActive: 'desc' }, { startDate: 'desc' }] });
        res.json({ success: true, campaigns: camps });
    } catch (e) { res.status(500).json({ success: false, error: 'load failed' }); }
});

router.post('/admin/campaigns', async (req, res) => {
    const a = await authAdmin(req);
    if (!a.ok) return res.status(a.status).json({ success: false, error: a.error });
    try {
        const b = req.body || {};
        if (!b.name || !b.startDate || !b.endDate) return res.status(400).json({ success: false, error: 'name/startDate/endDate ห้ามว่าง' });
        const created = await prisma.campaign.create({ data: sanitizeCampaignPayload(b, true) });
        res.json({ success: true, campaign: { id: created.id } });
    } catch (e) {
        if (e.code === 'P2002') return res.status(400).json({ success: false, error: 'ชื่อแคมเปญซ้ำ' });
        res.status(500).json({ success: false, error: e.message || 'create failed' });
    }
});

router.patch('/admin/campaigns/:id', async (req, res) => {
    const a = await authAdmin(req);
    if (!a.ok) return res.status(a.status).json({ success: false, error: a.error });
    try {
        const id = parseInt(req.params.id);
        const exist = await prisma.campaign.findUnique({ where: { id } });
        if (!exist) return res.status(404).json({ success: false, error: 'ไม่พบ campaign' });
        await prisma.campaign.update({ where: { id }, data: sanitizeCampaignPayload(req.body || {}, false) });
        res.json({ success: true });
    } catch (e) {
        if (e.code === 'P2002') return res.status(400).json({ success: false, error: 'ชื่อแคมเปญซ้ำ' });
        res.status(500).json({ success: false, error: e.message || 'update failed' });
    }
});

router.delete('/admin/campaigns/:id', async (req, res) => {
    const a = await authAdmin(req);
    if (!a.ok) return res.status(a.status).json({ success: false, error: a.error });
    try {
        await prisma.campaign.delete({ where: { id: parseInt(req.params.id) } });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message || 'delete failed' }); }
});

function sanitizeCampaignPayload(b, isCreate) {
    const intOrNull = (v, d) => (v === '' || v == null ? d : parseInt(v));
    const dt = (v) => v ? new Date(v) : null;
    const out = {
        name: b.name ?? undefined,
        startDate: dt(b.startDate) ?? undefined,
        endDate: dt(b.endDate) ?? undefined,
        baseReferral: intOrNull(b.baseReferral, isCreate ? 50 : undefined),
        milestoneTarget: intOrNull(b.milestoneTarget, isCreate ? 0 : undefined),
        milestoneBonus: intOrNull(b.milestoneBonus, isCreate ? 0 : undefined),
        linkBonus: intOrNull(b.linkBonus, isCreate ? 50 : undefined),
        isActive: b.isActive !== false,
    };
    // strip undefined for patch
    Object.keys(out).forEach(k => out[k] === undefined && delete out[k]);
    return out;
}

// ---------- 📂 CATEGORIES ----------
router.get('/admin/categories', async (req, res) => {
    const a = await authAdmin(req);
    if (!a.ok) return res.status(a.status).json({ success: false, error: a.error });
    try {
        const cats = await prisma.category.findMany({
            include: { _count: { select: { products: true } } },
            orderBy: [{ order: 'asc' }, { id: 'asc' }],
        });
        res.json({ success: true, categories: cats.map(c => ({
            id: c.id, name: c.name, type: c.type, imageUrl: c.imageUrl, productIcon: c.productIcon,
            order: c.order, price: Number(c.price), productCount: c._count.products,
        })) });
    } catch (e) {
        res.status(500).json({ success: false, error: 'load failed' });
    }
});

router.post('/admin/categories', async (req, res) => {
    const a = await authAdmin(req);
    if (!a.ok) return res.status(a.status).json({ success: false, error: a.error });
    try {
        const b = req.body || {};
        if (!b.name) return res.status(400).json({ success: false, error: 'ชื่อหมวดห้ามว่าง' });
        const data = sanitizeCategoryPayload(b);
        const created = await prisma.category.create({ data });
        res.json({ success: true, category: { id: created.id } });
    } catch (e) {
        if (e.code === 'P2002') return res.status(400).json({ success: false, error: 'ชื่อหมวดซ้ำ' });
        console.error('admin category create error:', e);
        res.status(500).json({ success: false, error: e.message || 'create failed' });
    }
});

router.patch('/admin/categories/:id', async (req, res) => {
    const a = await authAdmin(req);
    if (!a.ok) return res.status(a.status).json({ success: false, error: a.error });
    try {
        const id = parseInt(req.params.id);
        const exist = await prisma.category.findUnique({ where: { id } });
        if (!exist) return res.status(404).json({ success: false, error: 'ไม่พบหมวด' });
        const data = sanitizeCategoryPayload(req.body || {});
        await prisma.category.update({ where: { id }, data });
        res.json({ success: true });
    } catch (e) {
        if (e.code === 'P2002') return res.status(400).json({ success: false, error: 'ชื่อหมวดซ้ำ' });
        console.error('admin category update error:', e);
        res.status(500).json({ success: false, error: e.message || 'update failed' });
    }
});

router.delete('/admin/categories/:id', async (req, res) => {
    const a = await authAdmin(req);
    if (!a.ok) return res.status(a.status).json({ success: false, error: a.error });
    try {
        const id = parseInt(req.params.id);
        const cnt = await prisma.product.count({ where: { categoryId: id } });
        if (cnt > 0) return res.status(400).json({ success: false, error: `ลบไม่ได้ — มีสินค้า ${cnt} ชิ้นใช้หมวดนี้` });
        await prisma.category.delete({ where: { id } });
        res.json({ success: true });
    } catch (e) {
        console.error('admin category delete error:', e);
        res.status(500).json({ success: false, error: e.message || 'delete failed' });
    }
});

function sanitizeCategoryPayload(b) {
    const num = (v) => (v === '' || v == null ? 0 : Number(v));
    const intOrNull = (v) => (v === '' || v == null ? null : parseInt(v));
    const allowedTypes = ['POD', 'DEVICE', 'DISPOSABLE'];
    return {
        name: b.name ?? undefined,
        type: allowedTypes.includes(b.type) ? b.type : undefined,
        imageUrl: b.imageUrl ?? null,
        productIcon: b.productIcon ?? null,
        order: intOrNull(b.order) ?? 0,
        price: num(b.price),
    };
}

// GET /admin/category-options — สำหรับเลือกใน coupon form (giftCategoryId / targetCategoryId)
router.get('/admin/category-options', async (req, res) => {
    const a = await authAdmin(req);
    if (!a.ok) return res.status(a.status).json({ success: false, error: a.error });
    try {
        const cats = await prisma.category.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } });
        res.json({ success: true, categories: cats });
    } catch (e) {
        res.status(500).json({ success: false, error: 'load failed' });
    }
});

function sanitizeCouponPayload(b) {
    const num = (v) => (v === '' || v == null ? null : Number(v));
    const intOrNull = (v) => (v === '' || v == null ? null : parseInt(v));
    const dt = (v) => (v ? new Date(v) : null);
    const allowedTypes = ['DISCOUNT_PERCENT', 'DISCOUNT_FLAT', 'GIFT'];
    if (b.type && !allowedTypes.includes(b.type)) throw new Error('type ไม่ถูกต้อง');
    return {
        name: b.name ?? undefined,
        nameEn: b.nameEn || null,
        description: b.description || null,
        descriptionEn: b.descriptionEn || null,
        type: b.type ?? undefined,
        value: num(b.value),
        giftCategoryId: intOrNull(b.giftCategoryId),
        giftQty: intOrNull(b.giftQty),
        minPurchase: num(b.minPurchase),
        minQty: intOrNull(b.minQty),
        targetCategoryId: intOrNull(b.targetCategoryId),
        targetProductId: intOrNull(b.targetProductId),
        pointsCost: intOrNull(b.pointsCost),
        totalQuota: intOrNull(b.totalQuota),
        usageLimitPerUser: intOrNull(b.usageLimitPerUser) ?? 1,
        startDate: dt(b.startDate),
        endDate: dt(b.endDate),
        validFrom: dt(b.validFrom),
        validUntil: dt(b.validUntil),
        validityDays: intOrNull(b.validityDays),
        isAutoAssign: !!b.isAutoAssign,
        autoAssignQty: intOrNull(b.autoAssignQty) ?? 0,
        autoAssignTrigger: b.autoAssignTrigger || 'ALL',
        rewardTrigger: b.rewardTrigger || null,
        rewardRecipient: b.rewardRecipient || null,
        rewardMinAmount: num(b.rewardMinAmount),
        rewardMaxAmount: num(b.rewardMaxAmount),
        rewardOncePerReferral: b.rewardOncePerReferral !== false,
        isActive: b.isActive !== false,
    };
}

// PATCH /admin/coupons/:id/toggle — switch isActive
router.patch('/admin/coupons/:id/toggle', async (req, res) => {
    const a = await authAdmin(req);
    if (!a.ok) return res.status(a.status).json({ success: false, error: a.error });
    try {
        const c = await prisma.coupon.findUnique({ where: { id: req.params.id } });
        if (!c) return res.status(404).json({ success: false, error: 'ไม่พบคูปอง' });
        const updated = await prisma.coupon.update({
            where: { id: c.id },
            data: { isActive: !c.isActive },
            select: { id: true, isActive: true },
        });
        res.json({ success: true, coupon: updated });
    } catch (e) {
        console.error('admin coupon toggle error:', e);
        res.status(500).json({ success: false, error: 'toggle failed' });
    }
});

// ---------- 🎁 MYSTERY BOXES ----------
// GET /admin/mystery-boxes — list + nested prizes
router.get('/admin/mystery-boxes', async (req, res) => {
    const a = await authAdmin(req);
    if (!a.ok) return res.status(a.status).json({ success: false, error: a.error });
    try {
        const boxes = await prisma.mysteryBox.findMany({
            include: {
                prizes: { where: { isActive: true }, orderBy: { weight: 'desc' } },
                _count: { select: { tickets: true } },
            },
            orderBy: [{ isActive: 'desc' }, { createdAt: 'desc' }],
        });
        const out = boxes.map(b => ({
            id: b.id, name: b.name, nameEn: b.nameEn, description: b.description,
            imageUrl: b.imageUrl, trigger: b.trigger,
            minPurchaseAmount: b.minPurchaseAmount != null ? Number(b.minPurchaseAmount) : null,
            maxPurchaseAmount: b.maxPurchaseAmount != null ? Number(b.maxPurchaseAmount) : null,
            ticketsPerEvent: b.ticketsPerEvent, maxPerUser: b.maxPerUser,
            requiredTier: b.requiredTier,
            isActive: b.isActive, startDate: b.startDate, endDate: b.endDate,
            ticketCount: b._count.tickets,
            prizes: b.prizes.map(p => ({
                id: p.id, name: p.name, imageUrl: p.imageUrl, weight: p.weight,
                rewardCouponId: p.rewardCouponId, isPhysicalReward: p.isPhysicalReward,
            })),
        }));
        res.json({ success: true, boxes: out });
    } catch (e) {
        console.error('admin mystery boxes list error:', e);
        res.status(500).json({ success: false, error: 'load failed' });
    }
});

// POST /admin/mystery-boxes — create
router.post('/admin/mystery-boxes', async (req, res) => {
    const a = await authAdmin(req);
    if (!a.ok) return res.status(a.status).json({ success: false, error: a.error });
    try {
        const b = req.body || {};
        if (!b.id || !b.name || !b.trigger) {
            return res.status(400).json({ success: false, error: 'id, name, trigger จำเป็น' });
        }
        // กัน duplicate
        const exist = await prisma.mysteryBox.findUnique({ where: { id: String(b.id).trim() } });
        if (exist) return res.status(409).json({ success: false, error: 'รหัสกล่องซ้ำ' });

        const created = await prisma.mysteryBox.create({
            data: {
                id: String(b.id).trim(),
                name: String(b.name).trim(),
                nameEn: b.nameEn || null,
                description: b.description || null,
                descriptionEn: b.descriptionEn || null,
                imageUrl: b.imageUrl || null,
                trigger: b.trigger,
                minPurchaseAmount: b.minPurchaseAmount != null && b.minPurchaseAmount !== '' ? Number(b.minPurchaseAmount) : null,
                maxPurchaseAmount: b.maxPurchaseAmount != null && b.maxPurchaseAmount !== '' ? Number(b.maxPurchaseAmount) : null,
                ticketsPerEvent: parseInt(b.ticketsPerEvent) || 1,
                maxPerUser: b.maxPerUser != null && b.maxPerUser !== '' ? parseInt(b.maxPerUser) : null,
                requiredTier: b.requiredTier || 'NONE',
                isActive: b.isActive !== false,
                startDate: b.startDate ? new Date(b.startDate) : null,
                endDate: b.endDate ? new Date(b.endDate) : null,
            },
        });
        res.json({ success: true, box: created });
    } catch (e) {
        console.error('mbox create error:', e);
        res.status(500).json({ success: false, error: e.message || 'create failed' });
    }
});

// PATCH /admin/mystery-boxes/:id — update
router.patch('/admin/mystery-boxes/:id', async (req, res) => {
    const a = await authAdmin(req);
    if (!a.ok) return res.status(a.status).json({ success: false, error: a.error });
    try {
        const id = req.params.id;
        const exist = await prisma.mysteryBox.findUnique({ where: { id } });
        if (!exist) return res.status(404).json({ success: false, error: 'ไม่พบกล่อง' });
        const b = req.body || {};
        const data = {};
        if (b.name !== undefined) data.name = String(b.name).trim();
        if (b.nameEn !== undefined) data.nameEn = b.nameEn || null;
        if (b.description !== undefined) data.description = b.description || null;
        if (b.descriptionEn !== undefined) data.descriptionEn = b.descriptionEn || null;
        if (b.imageUrl !== undefined) data.imageUrl = b.imageUrl || null;
        if (b.trigger !== undefined) data.trigger = b.trigger;
        if (b.minPurchaseAmount !== undefined) data.minPurchaseAmount = (b.minPurchaseAmount === '' || b.minPurchaseAmount === null) ? null : Number(b.minPurchaseAmount);
        if (b.maxPurchaseAmount !== undefined) data.maxPurchaseAmount = (b.maxPurchaseAmount === '' || b.maxPurchaseAmount === null) ? null : Number(b.maxPurchaseAmount);
        if (b.ticketsPerEvent !== undefined) data.ticketsPerEvent = parseInt(b.ticketsPerEvent) || 1;
        if (b.maxPerUser !== undefined) data.maxPerUser = (b.maxPerUser === '' || b.maxPerUser === null) ? null : parseInt(b.maxPerUser);
        if (b.requiredTier !== undefined) data.requiredTier = b.requiredTier || 'NONE';
        if (b.isActive !== undefined) data.isActive = !!b.isActive;
        if (b.startDate !== undefined) data.startDate = b.startDate ? new Date(b.startDate) : null;
        if (b.endDate !== undefined) data.endDate = b.endDate ? new Date(b.endDate) : null;
        const updated = await prisma.mysteryBox.update({ where: { id }, data });
        res.json({ success: true, box: updated });
    } catch (e) {
        console.error('mbox update error:', e);
        res.status(500).json({ success: false, error: e.message || 'update failed' });
    }
});

// POST /admin/mystery-boxes/:id/prizes — add prize
router.post('/admin/mystery-boxes/:id/prizes', async (req, res) => {
    const a = await authAdmin(req);
    if (!a.ok) return res.status(a.status).json({ success: false, error: a.error });
    try {
        const boxId = req.params.id;
        const exist = await prisma.mysteryBox.findUnique({ where: { id: boxId } });
        if (!exist) return res.status(404).json({ success: false, error: 'ไม่พบกล่อง' });
        const b = req.body || {};
        if (!b.name) return res.status(400).json({ success: false, error: 'name จำเป็น' });

        const created = await prisma.mysteryBoxPrize.create({
            data: {
                mysteryBoxId: boxId,
                name: String(b.name).trim(),
                nameEn: b.nameEn || null,
                description: b.description || null,
                descriptionEn: b.descriptionEn || null,
                imageUrl: b.imageUrl || null,
                weight: parseInt(b.weight) || 1,
                rewardCouponId: b.rewardCouponId || null,
                isPhysicalReward: !!b.isPhysicalReward,
                isActive: b.isActive !== false,
            },
        });
        res.json({ success: true, prize: created });
    } catch (e) {
        console.error('prize create error:', e);
        res.status(500).json({ success: false, error: e.message || 'create failed' });
    }
});

// PATCH /admin/mystery-boxes/:boxId/prizes/:prizeId — update
router.patch('/admin/mystery-boxes/:boxId/prizes/:prizeId', async (req, res) => {
    const a = await authAdmin(req);
    if (!a.ok) return res.status(a.status).json({ success: false, error: a.error });
    try {
        const prizeId = parseInt(req.params.prizeId);
        const exist = await prisma.mysteryBoxPrize.findUnique({ where: { id: prizeId } });
        if (!exist || exist.mysteryBoxId !== req.params.boxId) {
            return res.status(404).json({ success: false, error: 'ไม่พบรางวัล' });
        }
        const b = req.body || {};
        const data = {};
        if (b.name !== undefined) data.name = String(b.name).trim();
        if (b.nameEn !== undefined) data.nameEn = b.nameEn || null;
        if (b.description !== undefined) data.description = b.description || null;
        if (b.descriptionEn !== undefined) data.descriptionEn = b.descriptionEn || null;
        if (b.imageUrl !== undefined) data.imageUrl = b.imageUrl || null;
        if (b.weight !== undefined) data.weight = parseInt(b.weight) || 1;
        if (b.rewardCouponId !== undefined) data.rewardCouponId = b.rewardCouponId || null;
        if (b.isPhysicalReward !== undefined) data.isPhysicalReward = !!b.isPhysicalReward;
        if (b.isActive !== undefined) data.isActive = !!b.isActive;
        const updated = await prisma.mysteryBoxPrize.update({ where: { id: prizeId }, data });
        res.json({ success: true, prize: updated });
    } catch (e) {
        console.error('prize update error:', e);
        res.status(500).json({ success: false, error: e.message || 'update failed' });
    }
});

// DELETE /admin/mystery-boxes/:boxId/prizes/:prizeId
router.delete('/admin/mystery-boxes/:boxId/prizes/:prizeId', async (req, res) => {
    const a = await authAdmin(req);
    if (!a.ok) return res.status(a.status).json({ success: false, error: a.error });
    try {
        const prizeId = parseInt(req.params.prizeId);
        const exist = await prisma.mysteryBoxPrize.findUnique({ where: { id: prizeId } });
        if (!exist || exist.mysteryBoxId !== req.params.boxId) {
            return res.status(404).json({ success: false, error: 'ไม่พบรางวัล' });
        }
        // ถ้ามี ticket ที่ awardedPrizeId ชี้มา → ใช้ soft delete (isActive=false)
        const usedCount = await prisma.mysteryBoxTicket.count({ where: { awardedPrizeId: prizeId } });
        if (usedCount > 0) {
            await prisma.mysteryBoxPrize.update({ where: { id: prizeId }, data: { isActive: false } });
            return res.json({ success: true, softDeleted: true, usedCount });
        }
        await prisma.mysteryBoxPrize.delete({ where: { id: prizeId } });
        res.json({ success: true });
    } catch (e) {
        console.error('prize delete error:', e);
        res.status(500).json({ success: false, error: e.message || 'delete failed' });
    }
});

// GET /admin/coupon-options — สำหรับใช้เลือกใน prize.rewardCouponId selector
router.get('/admin/coupon-options', async (req, res) => {
    const a = await authAdmin(req);
    if (!a.ok) return res.status(a.status).json({ success: false, error: a.error });
    try {
        const coupons = await prisma.coupon.findMany({
            where: { isActive: true },
            select: { id: true, name: true, type: true, value: true },
            orderBy: { name: 'asc' },
        });
        res.json({ success: true, coupons });
    } catch (e) {
        res.status(500).json({ success: false, error: 'load failed' });
    }
});

// PATCH /admin/mystery-boxes/:id/toggle — switch isActive
router.patch('/admin/mystery-boxes/:id/toggle', async (req, res) => {
    const a = await authAdmin(req);
    if (!a.ok) return res.status(a.status).json({ success: false, error: a.error });
    try {
        const b = await prisma.mysteryBox.findUnique({ where: { id: req.params.id } });
        if (!b) return res.status(404).json({ success: false, error: 'ไม่พบกล่อง' });
        const updated = await prisma.mysteryBox.update({
            where: { id: b.id },
            data: { isActive: !b.isActive },
            select: { id: true, isActive: true },
        });
        res.json({ success: true, box: updated });
    } catch (e) {
        console.error('admin mystery box toggle error:', e);
        res.status(500).json({ success: false, error: 'toggle failed' });
    }
});

// POST /api/admin/prize-shipments/:id/ship — mark as SHIPPED
router.post('/admin/prize-shipments/:id/ship', async (req, res) => {
    const a = await authAdmin(req);
    if (!a.ok) return res.status(a.status).json({ success: false, error: a.error });
    try {
        const shipmentId = parseInt(req.params.id);
        const trackingNumber = (req.body?.trackingNumber || '').trim() || null;
        const result = await mysteryBox.markShipmentShipped({
            shipmentId,
            trackingNumber,
            adminName: a.admin.name || a.telegramId,
        });
        if (!result.success) {
            const map = {
                NOT_FOUND: 'ไม่พบ shipment',
                INVALID_STATUS: 'ส่งไปแล้วหรือสถานะไม่ถูกต้อง',
                INVALID_INPUT: 'ข้อมูลไม่ครบ',
            };
            return res.status(400).json({ success: false, error: map[result.error] || result.error });
        }
        emitShipmentUpdate(req, shipmentId, 'SHIPPED');
        res.json({ success: true });
    } catch (e) {
        console.error('admin ship error:', e);
        res.status(500).json({ success: false, error: 'ship failed' });
    }
});

export default router;