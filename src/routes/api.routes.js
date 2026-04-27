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

        res.json({ success: true, order, bankAccount });
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
                }
            }
        });

        // Manually fetch shipping address for each order if needed
        orders = await Promise.all(orders.map(async (order) => {
            let shippingAddress = null;
            if (order.shippingAddressId) {
                shippingAddress = await prisma.shippingAddress.findUnique({
                    where: { id: order.shippingAddressId }
                });
            }
            return { ...order, shippingAddress };
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

        // 2. Call SlipOK API
        const BYPASS_SLIPOK = true; // ⚠️ ตั้งค่าเป็น true เพื่อปิดการตรวจสอบสลิปชั่วคราวตามคำขอ

        let slipData = {};
        let slipAmount = order.totalAmount;
        let slipTransRef = 'BYPASS-' + Date.now();

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

            const slipOkRes = await fetch(`https://api.slipok.com/api/line/apikey/${slipOkBranchId}`, {
                method: 'POST',
                headers: {
                    'x-authorization': slipOkApiKey
                },
                body: formData
            });

            slipData = await slipOkRes.json();

            if (!slipData.success) {
                console.error("SlipOK Verification Failed:", slipData);
                return res.status(400).json({ 
                    success: false, 
                    error: slipData.message || 'สลิปไม่ถูกต้อง หรือไม่สามารถตรวจสอบได้' 
                });
            }

            slipAmount = slipData.data.amount;
            slipTransRef = slipData.data.transRef;

            // 3. Validate Amount
            if (parseFloat(slipAmount) !== parseFloat(order.totalAmount)) {
                return res.status(400).json({ 
                    success: false, 
                    error: `ยอดเงินไม่ตรงกัน (ยอดที่ต้องชำระ: ${order.totalAmount} ฿, ยอดในสลิป: ${slipAmount} ฿)` 
                });
            }
            
            // 4. Check for duplicate slip usage
            const existingPayment = await prisma.payment.findFirst({
                where: { slipOkTransactionId: slipTransRef }
            });

            if (existingPayment) {
                 return res.status(400).json({ success: false, error: 'สลิปนี้ถูกใช้งานไปแล้ว' });
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

        // 6. Send Notification to Admin (Round-Robin & Detailed Summary)
        try {
            const token = getVerificationToken();
            if (token) {
                // Prepare highly detailed message
                const bkkOpts = { timeZone: 'Asia/Bangkok', year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' };
                const orderTimeStr = new Date(order.createdAt).toLocaleDateString('th-TH', bkkOpts);
                
                let shippingInfo = 'ไม่ระบุที่อยู่จัดส่ง';
                if (order.shippingAddressId) {
                    const addr = await prisma.shippingAddress.findUnique({ where: { id: order.shippingAddressId } });
                    if (addr) {
                        shippingInfo = `ชื่อ: ${addr.receiverName}\nโทร: ${addr.phone}\nที่อยู่: ${addr.address} ${addr.subdistrict} ${addr.district} ${addr.province} ${addr.zipcode}`;
                    }
                }

                let itemsDetails = '';
                const itemsByCategory = {};
                for (const item of order.items) {
                    const categoryName = item.product.category?.name || 'ไม่ระบุหมวดหมู่';
                    const categoryPrice = item.product.category?.price ? ` (฿${parseFloat(item.product.category.price).toLocaleString('th-TH')})` : '';
                    const catKey = `${categoryName}${categoryPrice}`;
                    if (!itemsByCategory[catKey]) itemsByCategory[catKey] = [];
                    itemsByCategory[catKey].push(item);
                }
                
                for (const [catName, catItems] of Object.entries(itemsByCategory)) {
                    itemsDetails += `<b>${catName}</b>\n`;
                    for (const item of catItems) {
                        const nicStr = item.product.nicotine !== null ? ` (${item.product.nicotine}%)` : '';
                        itemsDetails += `${item.product.nameEn}${nicStr} x${item.quantity}\n`;
                    }
                    itemsDetails += '\n';
                }

                // Retrieve shipping fee context from config
                const shipConfigRaw = await prisma.systemConfig.findUnique({ where: { key: 'shippingFee' } });
                const freeMinRaw = await prisma.systemConfig.findUnique({ where: { key: 'freeShippingMin' } });
                const shipFeeBase = shipConfigRaw ? parseFloat(shipConfigRaw.value) : 60;
                const freeMin = freeMinRaw ? parseFloat(freeMinRaw.value) : 500;
                
                const itemsSubtotal = order.items.reduce((sum, item) => sum + (item.quantity * parseFloat(item.priceAtPurchase)), 0);
                const actualShipFee = itemsSubtotal >= freeMin ? 0 : shipFeeBase;

                let message = `✅ <b>ได้รับการชำระเงินใหม่</b>\n\n` +
                              `<b>วันที่:</b> ${orderTimeStr}\n` +
                              `<b>ออเดอร์:</b> #${order.id}\n` +
                              `<b>รหัสลูกค้า:</b> ${order.customerId}\n\n` +
                              `📦 <b>[ข้อมูลจัดส่ง]</b>\n${shippingInfo}\n\n` +
                              `🛍️ <b>[รายการสินค้า]</b>\n${itemsDetails}\n` +
                              `<b>รวมค่าสินค้า:</b> ฿${itemsSubtotal.toLocaleString('th-TH')}\n` +
                              `<b>ค่าจัดส่ง:</b> ${actualShipFee === 0 ? 'ฟรี' : '฿' + actualShipFee.toLocaleString('th-TH')}\n`;

                if (parseFloat(order.discountAmount) > 0) {
                    message += `<b>ส่วนลดคูปอง:</b> -฿${parseFloat(order.discountAmount).toLocaleString('th-TH')} (${order.appliedCouponId || ''})\n`;
                }
                
                message += `\n💰 <b>ยอดสุทธิ:</b> ฿${parseFloat(slipAmount).toLocaleString('th-TH')}\n` +
                           `<i>(ตรวจสอบสลิปผ่าน SlipOK สำเร็จ) ${BYPASS_SLIPOK ? '[โหมดทดสอบ: Bypass สลิป]' : ''}</i>`;

                // Admin Round-Robin Selection
                const dayOfWeek = new Date().toLocaleString('en-US', { timeZone: 'Asia/Bangkok', weekday: 'short' });
                // 0 = Every day, 1 = Mon, 2 = Tue, ..., 7 = Sun
                const daysMap = { 'Mon': 1, 'Tue': 2, 'Wed': 3, 'Thu': 4, 'Fri': 5, 'Sat': 6, 'Sun': 7 };
                const currentDayInt = daysMap[dayOfWeek];
                
                const currentBkkTime = new Date().toLocaleTimeString('en-US', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit', hour12: false });

                // Find all shifts for today (including 0 which means 'Every day')
                const todaysShifts = await prisma.adminShift.findMany({
                    where: { dayOfWeek: { in: [0, currentDayInt] } },
                    include: { admin: true }
                });

                // Filter active admins
                const activeAdminsMap = new Map(); // using Map to ensure unique admins
                for (const shift of todaysShifts) {
                    const checkTime = (start, end) => {
                        if (!start || !end) return false;
                        if (start <= end) return currentBkkTime >= start && currentBkkTime <= end;
                        return currentBkkTime >= start || currentBkkTime <= end; // crosses midnight
                    };

                    if (checkTime(shift.shift1Start, shift.shift1End) || 
                        checkTime(shift.shift2Start, shift.shift2End) || 
                        checkTime(shift.shift3Start, shift.shift3End)) {
                        activeAdminsMap.set(shift.adminTelegramId, shift.adminTelegramId);
                    }
                }

                let activeAdminId = null;
                let activeAdminName = 'ไม่ระบุ';
                const activeAdminIds = Array.from(activeAdminsMap.values()).sort(); // deterministic order

                if (activeAdminIds.length > 0) {
                    const storeSetting = await prisma.storeSetting.findUnique({ where: { id: 1 } });
                    const lastId = storeSetting?.lastAssignedAdminId;
                    
                    let nextIndex = 0;
                    if (lastId && activeAdminIds.includes(lastId)) {
                        const lastIndex = activeAdminIds.indexOf(lastId);
                        nextIndex = (lastIndex + 1) % activeAdminIds.length;
                    }
                    
                    activeAdminId = activeAdminIds[nextIndex];
                    
                    // Fetch the assigned admin's name
                    const assignedAdmin = await prisma.admin.findUnique({
                        where: { telegramId: activeAdminId },
                        select: { name: true }
                    });
                    if (assignedAdmin && assignedAdmin.name) {
                        activeAdminName = assignedAdmin.name;
                    }
                    
                    // Update state
                    await prisma.storeSetting.update({
                        where: { id: 1 },
                        data: { lastAssignedAdminId: activeAdminId }
                    });
                }

                // Append the assigned admin info to the message
                message += `\n👨‍💼 <b>แอดมินผู้รับผิดชอบ:</b> ${activeAdminName}`;

                const notifyTelegram = async (chatId, isPersonalAdmin) => {
                    if (!chatId) return;
                    try {
                        const adminToken = process.env.ADMIN_BOT_TOKEN;
                        if (!adminToken) {
                            console.error('FATAL: ADMIN_BOT_TOKEN is missing for admin notifications.');
                            return;
                        }

                        const photoUrl = slipData.data.url;
                        let telegramUrl = `https://api.telegram.org/bot${adminToken}/sendPhoto`;
                        let res;
                        
                        const replyMarkup = isPersonalAdmin ? {
                            inline_keyboard: [[
                                { text: "📝 แนบเลขบิล", callback_data: `addbill_${order.id}` }
                            ]]
                        } : {
                            inline_keyboard: [[
                                { text: "⚙️ แก้ไข/ยกเลิกออเดอร์", callback_data: `manage_order_${order.id}` }
                            ]]
                        };
                        
                        if (photoUrl) {
                            res = await fetch(telegramUrl, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({
                                    chat_id: chatId,
                                    photo: photoUrl,
                                    caption: message,
                                    parse_mode: 'HTML',
                                    reply_markup: replyMarkup
                                })
                            });
                        } else {
                            telegramUrl = `https://api.telegram.org/bot${adminToken}/sendMessage`;
                            res = await fetch(telegramUrl, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({
                                    chat_id: chatId,
                                    text: message,
                                    parse_mode: 'HTML',
                                    reply_markup: replyMarkup
                                })
                            });
                        }
                        if (!res.ok) {
                            const errData = await res.json();
                            console.error(`Telegram API Error for chat ${chatId}:`, errData);
                            return null;
                        }
                        return await res.json();
                    } catch (e) {
                        console.error(`Fetch error sending to ${chatId}:`, e);
                        return null;
                    }
                };

                // 1. Send to Active Admin (if any)
                if (activeAdminId) {
                    await notifyTelegram(activeAdminId, true);
                }

                // 2. ALWAYS send to Group Admin (or Super Admin fallback)
                const groupId = process.env.ADMIN_GROUP_ID || process.env.SUPER_ADMIN_TELEGRAM_ID;
                if (groupId && groupId !== activeAdminId) {
                    const groupRes = await notifyTelegram(groupId, false);
                    if (groupRes && groupRes.result && groupRes.result.message_id) {
                        try {
                            await prisma.order.update({
                                where: { id: order.id },
                                data: { groupMsgId: groupRes.result.message_id }
                            });
                        } catch (dbErr) {
                            console.error('Failed to save groupMsgId:', dbErr);
                        }
                    }
                }
            }
        } catch (notifErr) {
             console.error("Failed to send admin notification:", notifErr);
             // Non-fatal error, proceed
        }

        res.json({ success: true, message: 'ตรวจสอบสลิปและยืนยันการสั่งซื้อสำเร็จ', slipUrl: slipData.data.url });

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
        
        // Pipe the image stream directly to the response
        imgRes.body.pipe(res);

    } catch (e) {
        console.error('Error proxying telegram image:', e);
        res.status(500).send('Error loading image');
    }
});

export default router;