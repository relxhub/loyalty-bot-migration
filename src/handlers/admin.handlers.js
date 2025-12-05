import { prisma } from '../db.js';
import { getAdminRole, loadAdminCache } from '../services/admin.service.js';
import { sendAdminReply, sendAlertToSuperAdmin, sendNotificationToCustomer } from '../services/notification.service.js'; 
import { listRewards, formatRewardsForAdmin } from '../services/reward.service.js';
import { isValidIdFormat } from '../utils/validation.utils.js'; 
import { generateUniqueCode } from '../utils/crypto.utils.js';
import { addDays } from '../utils/date.utils.js';
import { getActiveCampaign } from '../services/campaign.service.js';
import { getConfig } from '../config/config.js';
import { giveReferralBonus } from '../services/customer.service.js';
import * as referralService from '../services/referral.service'; // Import the new referral service
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

        if (!role) return sendAdminReply(chatId, "⛔️ คุณไม่มีสิทธิ์ใช้งานคำสั่งนี้");
        
        if (["/add", "/addadmin", "/fixreferrals"].includes(command) && role !== "SuperAdmin") {
            return sendAdminReply(chatId, `⛔️ คุณไม่มีสิทธิ์ใช้งานคำสั่ง ${command}`);
        }

        switch (command) {
            case "/undo":
                await handleUndoLastAction(ctx, adminUser, chatId);
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
            
            case "/refer": // New case for /refer command
                await handleReferCommand(ctx, commandParts, adminUser, chatId);
                break;

            case "/check":
                if (commandParts.length !== 2) {
                    sendAdminReply(chatId, "❗️รูปแบบคำสั่งผิด\nต้องเป็น: /check [รหัสลูกค้า]");
                } else {
                    const result = await checkCustomerInfo(commandParts[1], adminUser);
                    sendAdminReply(chatId, result);
                }
                break;

            case "/add":
                await handleAddPoints(ctx, commandParts, adminUser, chatId);
                break;

            case "/redeem":
                await handleRedeemReward(ctx, commandParts, adminUser, chatId);
                break;

            case "/reward":
                const rewards = await listRewards();
                const result = formatRewardsForAdmin(rewards);
                sendAdminReply(chatId, result);
                break;
                
            case "/start":
                const welcomeMsg = `👋 สวัสดี ${adminUser}!\nบอทสำหรับแอดมินพร้อมใช้งาน\n\n` +
                "<b>คำสั่งทั้งหมด:</b>\n" +
                `ℹ️ /check [รหัสลูกค้า]\n` +
                `↩️ /undo (ยกเลิกคำสั่งล่าสุด)\n` +
                (role === "SuperAdmin" ? "🪙 /add [รหัสลูกค้า] [แต้ม]\n" : "") +
                (role === "SuperAdmin" ? "👮‍♂️ /addadmin [ID] [Role] [Name]\n" : "") +
                "👤 /new [ลูกค้าใหม่] [ผู้แนะนำ]\n" +
                "✨ /refer [รหัสลูกค้าที่ถูกแนะนำ] [ยอดซื้อ]\n" + // Add new command to start message
                "🎁 /reward\n" +
                "✨ /redeem [รหัสลูกค้า] [รหัสรางวัล]";
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
        const customer = await customerService.createCustomer(newCustomerData); // customer.service.js creates the customerId and verificationCode

        // Log Creation
        await createAdminLog(adminUser, "CREATE_CUSTOMER", customer.customerId, 0, `Auto-generated customer via /new`);

        // 3. Generate Magic Link 🔗
        const botUsername = 'ONEHUB_Customer_Backup_Bot'; // Or from config
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
    const limitDays = getConfig('expiryDaysLimitMax') || 60;
    const extendDays = getConfig('expiryDaysAddPoints') || 30;

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

async function handleRedeemReward(ctx, commandParts, adminUser, chatId) {
    const customerId = commandParts[1]?.toUpperCase();
    const rewardId = commandParts[2]?.toUpperCase();

    if (!customerId || !rewardId) return sendAdminReply(chatId, "❗️รูปแบบคำสั่งผิด\nต้องเป็น: /redeem [รหัสลูกค้า] [รหัสรางวัล]");

    const customer = await prisma.customer.findUnique({ where: { customerId: customerId } });
    if (!customer || customer.isDeleted) return sendAdminReply(chatId, `🔍 ไม่พบข้อมูลลูกค้า ${customerId}`);

    const reward = await prisma.reward.findUnique({ where: { rewardId: rewardId } });
    if (!reward) return sendAdminReply(chatId, `🎁 ไม่พบของรางวัลรหัส '${rewardId}'`);

    if (customer.points < reward.pointsCost) return sendAdminReply(chatId, `⚠️ แต้มไม่เพียงพอ (มี ${customer.points}, ใช้ ${reward.pointsCost})`);

    await prisma.customer.update({
        where: { customerId: customerId },
        data: { points: { decrement: reward.pointsCost } }
    });

    const newPoints = customer.points - reward.pointsCost;
    await createAdminLog(adminUser, "REDEEM_POINTS", customerId, -reward.points, `Redeemed: ${reward.name}`);

    if (customer.telegramUserId) {
        await prisma.PointTransaction.create({
            data: {
                customerId: customerId,
                type: "REDEEM_REWARD",
                amount: -reward.pointsCost,
                detail: `Redeemed: ${reward.name}`
            }
        });
        await sendNotificationToCustomer(customer.telegramUserId, `🎁 คุณใช้ ${reward.points} แต้ม แลก '${reward.name}' สำเร็จ\n💰 แต้มคงเหลือ: ${newPoints}`);
    }
    sendAdminReply(chatId, `✅ แลก '${reward.name}' ให้ ${customerId} สำเร็จ\n💰 แต้มคงเหลือ: ${newPoints}`);
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