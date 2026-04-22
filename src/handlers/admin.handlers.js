import { prisma } from '../db.js';
import { getAdminRole, loadAdminCache } from '../services/admin.service.js';
import { sendAdminReply, sendAlertToSuperAdmin, sendNotificationToCustomer } from '../services/notification.service.js'; 
import { listRewards, formatRewardsForAdmin } from '../services/reward.service.js';
import { isValidIdFormat } from '../utils/validation.utils.js'; 
import { generateUniqueCode } from '../utils/crypto.utils.js';
import { addDays } from '../utils/date.utils.js';
import { getActiveCampaign } from '../services/campaign.service.js';
import { getConfig } from '../config/config.js';
import { createCustomer, giveReferralBonus } from '../services/customer.service.js';
import * as referralService from '../services/referral.service.js'; // Import the new referral service
import * as couponService from '../services/coupon.service.js';
import fs from 'fs';
import path from 'path';

// ==================================================
// ⭐️ MAIN ROUTER
// ==================================================
export async function handleAdminCommand(ctx) {
    try {
        const userTgId = String(ctx.from.id);
        const text = ctx.message.text || "";
        const role = await getAdminRole(userTgId);
        
        const commandParts = text.trim().split(/\s+/);
        const command = commandParts[0].toLowerCase();
        
        const adminUser = ctx.from.username || ctx.from.first_name || "Admin";
        const chatId = ctx.chat.id;

        // Debug logging
        console.log(`[AdminCommand] ID: ${userTgId}, User: ${adminUser}, Command: ${command}, Role: ${role}`);

        if (!role) return sendAdminReply(chatId, "⛔️ คุณไม่มีสิทธิ์ใช้งานคำสั่งนี้");
        
        if (["/add", "/addadmin", "/fixreferrals"].includes(command) && role !== "SuperAdmin") {
            return sendAdminReply(chatId, `⛔️ คุณไม่มีสิทธิ์ใช้งานคำสั่ง ${command}`);
        }

        switch (command) {
            case "/undo":
                await handleUndoLastAction(ctx, adminUser, chatId);
                break;

            case "/coupon":
                await handleCouponUse(ctx, commandParts, adminUser, chatId);
                break;

            case "/uncoupon":
                await handleCouponRestore(ctx, commandParts, adminUser, chatId);
                break;

            case "/fixreferrals":
                await handleFixReferrals(ctx, adminUser, chatId);
                break;

            case "/addadmin":
                await handleAddAdmin(ctx, commandParts, chatId);
                break;

            case "/new":
                await handleNewCustomer(ctx, commandParts, adminUser, chatId);
                break;
            
            case "/refer":
                await handleReferCommand(ctx, commandParts, adminUser, chatId);
                break;

            case "/gencode":
                await handleGencodeCommand(ctx, commandParts, adminUser, chatId);
                break;

            case "/check":
                if (commandParts.length !== 2) {
                    sendAdminReply(chatId, "●รูปแบบคำสั่งผิด\nต้องเป็น: /check [รหัสลูกค้า]");
                } else {
                    const result = await checkCustomerInfo(commandParts[1], adminUser);
                    sendAdminReply(chatId, result);
                }
                break;

            case "/checkcoupon":
                await handleCheckCoupon(ctx, commandParts, adminUser, chatId);
                break;

            case "/add":
                await handleAddPoints(ctx, commandParts, adminUser, chatId);
                break;

            case "/start":
                const welcomeMsg = `👋 สวัสดี ${adminUser}!\nบอทสำหรับแอดมินพร้อมใช้งาน\n\n` +
                "<b>คำสั่งทั้งหมด:</b>\n" +
                `ℹ️ /check [รหัสลูกค้า]\n` +
                `🎫 /checkcoupon [รหัสลูกค้า]\n` +
                `↩️ /undo (ยกเลิกคำสั่งล่าสุด)\n` +
                (role === "SuperAdmin" ? "🪙 /add [รหัสลูกค้า] [แต้ม]\n" : "") +
                (role === "SuperAdmin" ? "👮‍♂️ /addadmin [ID] [Role] [Name]\n" : "") +
                "👤 /new [ลูกค้าใหม่]\n" +
                "✨ /refer [รหัสลูกค้าที่ถูกแนะนำ] [ยอดซื้อ]\n" + 
                "🎫 /coupon [รหัสลูกค้า] [รหัสคูปอง]\n" +
                "↩️ /uncoupon [รหัสลูกค้า] [รหัสคูปอง]";
                sendAdminReply(chatId, welcomeMsg);
                break;

            default:
                // ไม่ต้องตอบกลับถ้าพิมพ์ผิดเล็กน้อย เพื่อลด Spam
                break;
        }
    } catch (err) {
        console.error("Critical Error in handleAdminCommand:", err);
        ctx.reply(`❌ เกิดข้อผิดพลาดร้ายแรง: ${err.message}`);
    }
}

// ==================================================
// 🛠️ HELPER FUNCTIONS
// ==================================================

/**
 * ตรวจสอบคูปองที่ลูกค้ามีทั้งหมด (เฉพาะที่ยังใช้ได้)
 */
async function handleCheckCoupon(ctx, commandParts, adminUser, chatId) {
    const customerId = commandParts[1]?.toUpperCase();

    if (!customerId) {
        return sendAdminReply(chatId, "❗️รูปแบบคำสั่งผิด\nต้องเป็น: /checkcoupon [รหัสลูกค้า]");
    }

    try {
        const coupons = await couponService.getCustomerCoupons(customerId);

        if (!coupons || coupons.length === 0) {
            return sendAdminReply(chatId, `🔍 ไม่พบคูปองที่ใช้งานได้สำหรับลูกค้า ${customerId}`);
        }

        // จัดกลุ่มคูปองตาม ID เพื่อหาจำนวนที่ซ้ำกัน (ถ้ามี)
        const grouped = coupons.reduce((acc, item) => {
            const cid = item.couponId;
            if (!acc[cid]) {
                acc[cid] = {
                    id: cid,
                    name: item.coupon.name,
                    description: item.coupon.description,
                    count: 0
                };
            }
            acc[cid].count++;
            return acc;
        }, {});

        let msg = `🎫 <b>รายการคูปองของ: ${customerId}</b>\n\n`;

        Object.values(grouped).forEach((c, index) => {
            msg += `${index + 1}. <b>${c.name}</b>\n`;
            msg += `ID: <code>${c.id}</code>\n`;
            msg += `รายละเอียด: ${c.description || '-'}\n`;
            msg += `จำนวนที่มี: <b>${c.count} ใบ</b>\n\n`;
        });

        await createAdminLog(adminUser, "CHECK_COUPONS", customerId, 0, `Checked coupons for ${customerId}`);
        sendAdminReply(chatId, msg);

    } catch (error) {
        console.error("Check Coupon Error:", error);
        sendAdminReply(chatId, `❌ เกิดข้อผิดพลาดในการดึงข้อมูล: ${error.message}`);
    }
}

async function handleGencodeCommand(ctx, commandParts, adminUser, chatId) {
    try {
        const customerIdToCreate = commandParts[1]?.toUpperCase();

        // 1. Validate input format
        if (!customerIdToCreate) {
            return sendAdminReply(chatId, "●รูปแบบคำสั่งผิด\nต้องเป็น: /gencode [รหัสลูกค้าที่ต้องการสร้าง]");
        }
        if (!isValidIdFormat(customerIdToCreate)) {
            return sendAdminReply(chatId, `❌ รูปแบบรหัสลูกค้า '${customerIdToCreate}' ไม่ถูกต้อง (ต้องเป็น A-Z, 0-9)`);
        }

        // 2. Check if the Customer ID already exists
        const existingCustomer = await prisma.customer.findUnique({
            where: { customerId: customerIdToCreate }
        });
        if (existingCustomer) {
            return sendAdminReply(chatId, `❌ผิดพลาด: รหัสลูกค้า ${customerIdToCreate} มีอยู่ในระบบแล้ว`);
        }

        // 3. Prevent creating an ID higher than the current max
        const allCustomers = await prisma.customer.findMany({
            select: { customerId: true }
        });

        // Extract numbers from IDs like 'OT1234', 'T5', etc.
        const customerNumbers = allCustomers
            .map(c => parseInt(c.customerId.replace(/[^0-9]/g, ''), 10))
            .filter(n => !isNaN(n));

        if (customerNumbers.length > 0) {
            const maxIdNumber = Math.max(...customerNumbers);
            const inputIdNumber = parseInt(customerIdToCreate.replace(/[^0-9]/g, ''), 10);

            if (isNaN(inputIdNumber)) {
                 return sendAdminReply(chatId, `❌ รหัสลูกค้า '${customerIdToCreate}' ต้องมีตัวเลข`);
            }
            
            if (inputIdNumber > maxIdNumber) {
                return sendAdminReply(chatId, `❌ผิดพลาด: รหัส ${customerIdToCreate} สูงกว่ารหัสสูงสุดในระบบ (สูงสุดคือ ~${maxIdNumber}).\nคำสั่งนี้ใช้สำหรับสร้างรหัสย้อนหลังเท่านั้น`);
            }
        }

        // 4. All checks passed, create the new customer
        const verificationCode = Math.floor(1000 + Math.random() * 9000).toString();
        const newCustomer = await prisma.customer.create({
            data: {
                customerId: customerIdToCreate,
                verificationCode: verificationCode,
                adminCreatedBy: adminUser
            }
        });

        await createAdminLog(adminUser, "GENCODE_CUSTOMER", newCustomer.customerId, 0, `Generated specific customer ID`);

        const msg = `✅ <b>สร้างรหัสสำเร็จ!</b>\n` +
                    `\n👤 รหัสลูกค้า: <code>${newCustomer.customerId}</code>` +
                    `\n🔑 รหัสยืนยัน: <code>${newCustomer.verificationCode}</code>\n` +
                    `\nกรุณาส่งรหัสยืนยันนี้ให้ลูกค้าเพื่อใช้เชื่อมต่อบัญชีผ่าน Mini App`;

        await sendAdminReply(chatId, msg);

    } catch (error) {
        console.error("Gencode Command Error:", error);
        sendAdminReply(chatId, `❌ เกิดข้อผิดพลาดร้ายแรงในการสร้างรหัส: ${error.message}`);
    }
}

// Function for /refer command
async function handleReferCommand(ctx, commandParts, adminUser, chatId) {
    try {
        const refereeId = commandParts[1]?.toUpperCase();
        const purchaseAmount = parseFloat(commandParts[2]);



        // 1. Validation
        if (!refereeId || isNaN(purchaseAmount)) {
            return sendAdminReply(chatId, "❗️รูปแบบคำสั่งผิด\nต้องเป็น: /refer [รหัสลูกค้าที่ถูกแนะนำ] [ยอดซื้อ]");
        }
        if (!isValidIdFormat(refereeId)) {
            return sendAdminReply(chatId, `❌ รูปแบบรหัสลูกค้า '${refereeId}' ไม่ถูกต้อง (A-Z, 0-9)`);
        }

        // 2. Call referralService.completeReferral
        const result = await referralService.completeReferral(refereeId, purchaseAmount);

        // 3. Provide feedback to admin
        if (result.success) {
            await createAdminLog(adminUser, "COMPLETE_REFERRAL", refereeId, result.bonus, `Purchase: ${purchaseAmount}`);
            sendAdminReply(chatId, result.message);
        } else {
            sendAdminReply(chatId, `❌ ${result.message}`);
        }

    } catch (error) {
        console.error("Refer Command Error:", error);
        sendAdminReply(chatId, `❌ เกิดข้อผิดพลาดในการทำรายการ: ${error.message}`);
    }
}

// ฟังก์ชันสร้างลูกค้าใหม่ (พร้อม Magic Link)
async function handleNewCustomer(ctx, commandParts, adminUser, chatId) {
    try {
        // No longer takes customer ID from commandParts. It's auto-generated.
        // No longer takes referrerId.

        // 1. Validation (only check if any extra params are passed, which shouldn't be)
        if (commandParts.length > 1) { // If anything other than just "/new" is present
            return sendAdminReply(chatId, "❗️รูปแบบคำสั่งผิด\nต้องเป็น: /new (สร้างรหัสลูกค้าใหม่)");
        }

        // 2. Create Data - delegate to customerService.createCustomer for ID generation
        // customerService.createCustomer generates customerId and verificationCode
        const newCustomerData = {
            telegramUserId: null, // Admin command doesn't provide telegramId initially
            firstName: null,
            lastName: null,
            username: null,
            adminCreatedBy: adminUser
        };
        const customer = await createCustomer(newCustomerData);

        // Log Creation
        await createAdminLog(adminUser, "CREATE_CUSTOMER", customer.customerId, 0, `Auto-generated customer via /new`);

        // 3. Generate Magic Link 🔗
        const botUsername = getConfig('orderBotUsername', 'YOUR_ORDER_BOT_USERNAME_HERE'); // Fallback in case it's not in DB
        const magicLink = `https://t.me/${botUsername}/app?startapp=link_${customer.customerId}_${customer.verificationCode}`;

        const msg = `✅ <b>รหัสสมาชิกของคุณลูกค้า!</b>\n` +
                    `👤 รหัส: <code>${customer.customerId}</code>\n` +
                    `🔑 รหัสยืนยัน: <code>${customer.verificationCode}</code>\n\n` +
                    `👇 <b>คุณลูกค้าสามารถแตะที่ลิงค์นี่้ระบบจะเชื่อมต่อสมาชิกให้ทันที:</b>\n` +
                    `${magicLink}`;

        await sendAdminReply(chatId, msg);

    } catch (error) {
        console.error("New Customer Error:", error);
        sendAdminReply(chatId, `❌ สร้างลูกค้าไม่สำเร็จ: ${error.message}`);
    }
}

// ฟังก์ชันยกเลิกคำสั่งล่าสุด (/undo)
async function handleUndoLastAction(ctx, adminUser, chatId) {
    try {
        const lastLog = await prisma.adminLog.findFirst({
            where: { 
                admin: adminUser,
                NOT: {
                    action: { in: ['CHECK_CUSTOMER', 'LIST_REWARDS', 'UNDO_ACTION', 'ADD_ADMIN'] }
                }
            },
            orderBy: { createdAt: 'desc' }
        });

        if (!lastLog) {
            return sendAdminReply(chatId, "⚠️ ไม่พบประวัติการทำรายการล่าสุดที่สามารถยกเลิกได้");
        }

        const customerId = lastLog.customerId;
        const actionType = lastLog.action;
        const pointsDiff = lastLog.pointsChange; 

        let resultMessage = "";

        if (actionType === 'ADD_POINTS' || actionType === 'REDEEM_POINTS') {
            const revertPoints = pointsDiff * -1; 
            await prisma.customer.update({
                where: { customerId: customerId },
                data: { points: { increment: revertPoints } }
            });
            resultMessage = `✅ ยกเลิกรายการ ${actionType} สำเร็จ\n` +
                            `ลูกค้า: ${customerId}\n` +
                            `แต้มที่คืนค่า: ${revertPoints > 0 ? '+' + revertPoints : revertPoints}`;
        } 
        else if (actionType === 'CREATE_CUSTOMER') {
            const targetCustomer = await prisma.customer.findUnique({
                where: { customerId: customerId }
            });

            let refundMsg = "";

            if (targetCustomer && targetCustomer.referrerId) {
                const referrerId = targetCustomer.referrerId;
                const bonusLog = await prisma.adminLog.findFirst({
                     where: {
                         action: 'REFERRAL_BONUS',
                         customerId: referrerId,
                         createdAt: { gte: lastLog.createdAt }
                     }
                });
                
                const campaign = await getActiveCampaign();
                const bonusPoints = bonusLog ? bonusLog.pointsChange : (campaign?.baseReferral || 50);
                
                await prisma.customer.update({
                    where: { customerId: referrerId },
                    data: { 
                        points: { decrement: bonusPoints },
                        referralCount: { decrement: 1 } 
                    }
                });
                refundMsg = `\n(และหัก ${bonusPoints} แต้มคืนจากผู้แนะนำ ${referrerId})`;
            }

            const deletedId = `${customerId}_DEL_${Date.now().toString().slice(-4)}`;

            await prisma.customer.update({
                where: { customerId: customerId },
                data: { 
                    customerId: deletedId,
                    isDeleted: true,
                    telegramUserId: null,
                    verificationCode: null,
                    referrerId: null 
                }
            });
            resultMessage = `✅ ยกเลิกการสร้างลูกค้า ${customerId} สำเร็จ (ลบข้อมูลแล้ว)${refundMsg}`;
        }
        else {
            return sendAdminReply(chatId, `⚠️ ไม่รองรับการ Undo คำสั่งประเภท: ${actionType}`);
        }

        await createAdminLog(adminUser, "UNDO_ACTION", customerId, 0, `Reverted action ID: ${lastLog.id} (${actionType})`);
        sendAdminReply(chatId, resultMessage);

    } catch (e) {
        console.error("Undo Error:", e);
        sendAdminReply(chatId, "❌ เกิดข้อผิดพลาดในการยกเลิกคำสั่ง");
    }
}

async function handleAddAdmin(ctx, commandParts, chatId) {
    if (commandParts.length < 3) return sendAdminReply(chatId, "❗️รูปแบบผิด: /addadmin [ID] [Role] [Name]");
    const targetTgId = commandParts[1];
    const targetRole = commandParts[2]; 
    const targetName = commandParts.slice(3).join(" ") || "Unknown Staff"; 

    if (!['Admin', 'SuperAdmin'].includes(targetRole)) return sendAdminReply(chatId, "⚠️ Role ต้องเป็น 'Admin' หรือ 'SuperAdmin'");

    try {
        await prisma.admin.upsert({
            where: { telegramId: targetTgId },
            update: { role: targetRole, name: targetName },
            create: { telegramId: targetTgId, role: targetRole, name: targetName }
        });
        await loadAdminCache();
        sendAdminReply(chatId, `✅ บันทึก Admin เรียบร้อย\nID: ${targetTgId}\nRole: ${targetRole}\nName: ${targetName}`);
    } catch (e) {
        console.error("Add Admin Error:", e);
        sendAdminReply(chatId, "❌ เกิดข้อผิดพลาดในการบันทึกข้อมูล");
    }
}

async function checkCustomerInfo(customerId, adminUser) {
    const customer = await prisma.customer.findUnique({
        where: { customerId: customerId.toUpperCase() }
    });
    
    await createAdminLog(adminUser, "CHECK_CUSTOMER", customerId.toUpperCase(), 0, "Checked info");

    if (!customer || customer.isDeleted) return `🔍 ไม่พบข้อมูลลูกค้า ${customerId}`;
    
    const formattedDate = customer.expiryDate.toLocaleDateString('th-TH');
    return `👤 <b>ข้อมูลลูกค้า: ${customer.customerId}</b>\n` +
           `🤝 ผู้แนะนำ: ${customer.referrerId || 'N/A'}\n` +
           `💰 แต้มคงเหลือ: ${customer.points}\n` +
           `🗓️ วันหมดอายุ: ${formattedDate}`;
}

async function handleAddPoints(ctx, commandParts, adminUser, chatId) {
    const customerId = commandParts[1]?.toUpperCase();
    const points = parseInt(commandParts[2]);

    if (!customerId || isNaN(points)) return sendAdminReply(chatId, "❗️รูปแบบคำสั่งผิด\nต้องเป็น: /add [รหัสลูกค้า] [แต้ม]");

    const customer = await prisma.customer.findUnique({ where: { customerId: customerId } });
    if (!customer || customer.isDeleted) return sendAdminReply(chatId, `🔍 ไม่พบข้อมูลลูกค้า ${customerId}`);

    // Get the start of today in Bangkok, represented as a UTC timestamp for accurate comparison
    const now = new Date();
    const year = Number(now.toLocaleString('en-US', { timeZone: 'Asia/Bangkok', year: 'numeric' }));
    const month = Number(now.toLocaleString('en-US', { timeZone: 'Asia/Bangkok', month: 'numeric' }));
    const day = Number(now.toLocaleString('en-US', { timeZone: 'Asia/Bangkok', day: 'numeric' }));
    const today = new Date(Date.UTC(year, month - 1, day));
    
    const currentExpiry = customer.expiryDate;
    const limitDays = parseInt(getConfig('expiryDaysLimitMax')) || 60;
    const extendDays = parseInt(getConfig('expiryDaysAddPoints')) || 30;

    const baseDate = (currentExpiry && currentExpiry > today) ? currentExpiry : today;
    const proposedExpiry = addDays(baseDate, extendDays);
    const limitDate = addDays(today, limitDays);
    let finalExpiryDate = proposedExpiry > limitDate ? limitDate : proposedExpiry;

    await prisma.customer.update({
        where: { customerId: customerId },
        data: { 
            points: { increment: points }, 
            expiryDate: finalExpiryDate 
        }
    });

    const newPoints = customer.points + points;
    await createAdminLog(adminUser, "ADD_POINTS", customerId, points, "Manual Add");

    if (customer.telegramUserId) {
        await prisma.PointTransaction.create({
            data: {
                customerId: customerId,
                type: "ADMIN_ADJUST",
                amount: points
            }
        });
        await sendNotificationToCustomer(customer.telegramUserId, `🎉 คุณได้รับ ${points} แต้ม!\n💰 แต้มสะสมปัจจุบัน: ${newPoints} แต้ม`);
    }
    await sendAlertToSuperAdmin(`🔔 <b>Admin Alert: /add</b>\nUser: ${adminUser}\nCustomer: ${customerId}\nPoints: +${points}`);
    sendAdminReply(chatId, `✅ เพิ่ม ${points} แต้มให้ ${customerId} เรียบร้อย\n💰 ยอดรวม: ${newPoints}`);
}

async function createAdminLog(admin, action, customerId, pointsChange, details) {
    try {
        let combinedDetails = details || "";
        if (pointsChange && pointsChange !== 0) {
            const sign = pointsChange > 0 ? '+' : '';
            combinedDetails += ` (Points: ${sign}${pointsChange})`;
        }
        await prisma.AdminAuditLog.create({
            data: {
                adminName: admin,
                action: action,
                targetId: customerId || null,
                details: combinedDetails
            }
        });
    } catch (e) { console.error("Failed to create Admin Log:", e); }
}

async function handleFixReferrals(ctx, adminUser, chatId) {
    await sendAdminReply(chatId, "⏳ กำลังเริ่มกระบวนการซ่อมแซมข้อมูล... (อาจใช้เวลาสักครู่)");

    try {
        // 1. Parse Admin Logs to find lost links
        const logPath = path.join(process.cwd(), 'admin_logs.csv');
        let restoredLinks = 0;
        const referralMap = new Map();

        if (fs.existsSync(logPath)) {
            const fileContent = fs.readFileSync(logPath, 'utf-8');
            const lines = fileContent.split('\n');

            for (const line of lines) {
                // "Timestamp",Admin,Action,CustomerID,PointsChange,Details
                // Look for CREATE_CUSTOMER and "Referred by:"
                if (line.includes('CREATE_CUSTOMER') && line.includes('Referred by:')) {
                    // Extract CustomerID (OTxxxx)
                    // The line format is loosely CSV.
                    // Example: "...",Telegran,CREATE_CUSTOMER,OT1117,0,Referred by: OT411

                    const parts = line.split(',');
                    // Note: Date/Time often contains comma inside quotes, so split might be unreliable if just by ','.
                    // However, 'CREATE_CUSTOMER' is unique keyword.

                    // Simple regex extraction is safer
                    const createMatch = line.match(/CREATE_CUSTOMER,([A-Z0-9]+)/); // Matches OTxxxx
                    const refMatch = line.match(/Referred by: ([A-Z0-9]+)/);

                    if (createMatch && refMatch) {
                        const childId = createMatch[1].trim().toUpperCase();
                        const referrerId = refMatch[1].trim().toUpperCase();

                        if (childId && referrerId && referrerId !== 'N/A') {
                            referralMap.set(childId, referrerId);
                        }
                    }
                }
            }

            // 2. Update DB with missing links
            for (const [childId, referrerId] of referralMap) {
                const child = await prisma.customer.findUnique({ where: { customerId: childId } });

                // Only update if child exists AND referrerId is missing/null
                if (child && !child.referrerId) {
                    // Check if referrer exists
                    const referrer = await prisma.customer.findUnique({ where: { customerId: referrerId } });
                    if (referrer) {
                        await prisma.customer.update({
                            where: { customerId: childId },
                            data: { referrerId: referrerId }
                        });
                        restoredLinks++;
                    }
                }
            }
        }

        await sendAdminReply(chatId, `✅ ซ่อมแซมข้อมูลเสร็จสิ้น\n🔗 กู้คืนความสัมพันธ์: ${restoredLinks} รายการ`);

    } catch (error) {
        console.error("Fix Referrals Error:", error);
        sendAdminReply(chatId, `❌ เกิดข้อผิดพลาด: ${error.message}`);
    }
}
async function handleCouponUse(ctx, commandParts, adminUser, chatId) {
    const customerId = commandParts[1]?.toUpperCase();
    const couponId = commandParts[2]?.toUpperCase();

    if (!customerId || !couponId) {
        return sendAdminReply(chatId, "⚠️ ข้อมูลไม่ครบถ้วน\nรูปแบบ: /coupon [รหัสลูกค้า] [รหัสคูปอง]");
    }

    try {
        const result = await couponService.useCoupon(customerId, couponId, adminUser);
        let msg = `✅ <b>ใช้คูปองสำเร็จ!</b>\n` +
                  `👤 ลูกค้า: ${customerId}\n` +
                  `🎫 คูปอง: ${result.coupon.name}\n`;

        if (result.coupon.type === "GIFT") {
            msg += `\n🎁 <b>ของแถม:</b> กรุณามอบของแถมตามรายการที่กำหนดให้ลูกค้า`;
        } else {
            const discountDisplay = result.coupon.type === "DISCOUNT_PERCENT" ? `${result.coupon.value}%` : `${result.coupon.value} บาท`;
            msg += `💰 <b>ส่วนลด:</b> ${discountDisplay}`;
        }

        await createAdminLog(adminUser, "USE_COUPON", customerId, 0, `Used Coupon: ${couponId}`);
        sendAdminReply(chatId, msg);

        // Notify Customer
        const customer = await prisma.customer.findUnique({ where: { customerId } });
        if (customer?.telegramUserId) {
            await sendNotificationToCustomer(customer.telegramUserId, `🎫 คูปองของคุณ "${result.coupon.name}" ถูกใช้งานแล้ว!`);
        }

    } catch (error) {
        sendAdminReply(chatId, `❌ ${error.message}`);
    }
}

async function handleCouponRestore(ctx, commandParts, adminUser, chatId) {
    const customerId = commandParts[1]?.toUpperCase();
    const couponId = commandParts[2]?.toUpperCase();

    if (!customerId || !couponId) {
        return sendAdminReply(chatId, "⚠️ ข้อมูลไม่ครบถ้วน\nรูปแบบ: /uncoupon [รหัสลูกค้า] [รหัสคูปอง]");
    }

    try {
        const result = await couponService.restoreCoupon(customerId, couponId, adminUser);
        const msg = `✅ <b>คืนสิทธิ์คูปองสำเร็จ!</b>\n` +
                    `👤 ลูกค้า: ${customerId}\n` +
                    `🎫 คูปอง: ${result.coupon.name}\n` +
                    `\nคืนสิทธิ์ให้ลูกค้าสามารถนำกลับมาใช้ได้อีกครั้ง`;

        await createAdminLog(adminUser, "RESTORE_COUPON", customerId, 0, `Restored Coupon: ${couponId}`);
        sendAdminReply(chatId, msg);

    } catch (error) {
        sendAdminReply(chatId, `❌ ${error.message}`);
    }
}
