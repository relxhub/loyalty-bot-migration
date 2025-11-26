// src/handlers/admin.handlers.js (Final Version)

import { prisma } from '../db.js';
import { getAdminRole, loadAdminCache } from '../services/admin.service.js';
import { sendAdminReply, sendAlertToSuperAdmin, sendNotificationToCustomer } from '../services/notification.service.js'; 
import { listRewards, formatRewardsForAdmin } from '../services/reward.service.js';
import { isValidIdFormat } from '../utils/validation.utils.js'; 
import { generateUniqueCode } from '../utils/crypto.utils.js';
import { addDays, getThaiNow } from '../utils/date.utils.js';
import { getActiveCampaign } from '../services/campaign.service.js';
import { getConfig } from '../config/config.js';
import { giveReferralBonus } from '../services/customer.service.js';

// ==================================================
// ⭐️ MAIN ROUTER: จัดการคำสั่งทั้งหมดของ Admin
// ==================================================
export async function handleAdminCommand(ctx) {
    const userTgId = String(ctx.from.id);
    const text = ctx.message.text || "";
    const role = await getAdminRole(userTgId);
    
    // แยกคำสั่งและ Argument
    const commandParts = text.trim().split(/\s+/);
    const command = commandParts[0].toLowerCase();
    
    const adminUser = ctx.from.username || ctx.from.first_name || "Admin";
    const chatId = ctx.chat.id;

    // 1. ตรวจสอบสิทธิ์ (Gating)
    if (!role) {
        return sendAdminReply(chatId, "⛔️ คุณไม่มีสิทธิ์ใช้งานคำสั่งนี้");
    }

    // 2. ตรวจสอบสิทธิ์เฉพาะคำสั่ง (Super Admin Only)
    if (["/add", "/addadmin"].includes(command) && role !== "SuperAdmin") {
        return sendAdminReply(chatId, `⛔️ คุณไม่มีสิทธิ์ใช้งานคำสั่ง ${command}`);
    }

    // 3. Route คำสั่ง
    switch (command) {
        // ⭐️ เพิ่มคำสั่ง UNDO
        case "/undo":
            await handleUndoLastAction(ctx, adminUser, chatId);
            break;

        case "/addadmin":
            await handleAddAdmin(ctx, commandParts, chatId);
            break;

        case "/new":
            await handleNewCustomer(ctx, commandParts, adminUser, chatId);
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
            // ไม่ต้อง Log การดู reward เพื่อไม่ให้รก
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
            "🎁 /reward\n" +
            "✨ /redeem [รหัสลูกค้า] [รหัสรางวัล]";
            sendAdminReply(chatId, welcomeMsg);
            break;

        default:
            sendAdminReply(chatId, "⚠️ คำสั่งไม่ถูกต้อง หรือรูปแบบไม่สมบูรณ์");
            break;
    }
}

// ==================================================
// 🛠️ HELPER FUNCTIONS
// ==================================================

// ⭐️ ฟังก์ชันยกเลิกคำสั่งล่าสุด (/undo)
async function handleUndoLastAction(ctx, adminUser, chatId) {
    // 1. ค้นหา Log ล่าสุดของ Admin คนนี้ (ยกเว้นคำสั่งที่ไม่ได้เปลี่ยนค่า)
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

    try {
        // 2. ตรวจสอบประเภทและทำการย้อนกลับ (Revert)
        if (actionType === 'ADD_POINTS' || actionType === 'REDEEM_POINTS') {
            // ย้อนกลับแต้ม (กลับเครื่องหมาย +/-)
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
            // ⭐️ Logic ใหม่: เช็คผู้แนะนำและหักแต้มคืน
            const targetCustomer = await prisma.customer.findUnique({
                where: { customerId: customerId }
            });

            let refundMsg = "";

            // ถ้ามีผู้แนะนำ -> ไปหักแต้มคืนจากผู้แนะนำ
            if (targetCustomer && targetCustomer.referrerId) {
                const referrerId = targetCustomer.referrerId;
                // คำนวณแต้มที่ต้องหักคืน (ใช้ตรรกะเดียวกับตอนให้)
                const campaign = await getActiveCampaign();
                const bonusPoints = campaign?.baseReferral || campaign?.base || getConfig('standardReferralPoints') || 50;
                
                await prisma.customer.update({
                    where: { customerId: referrerId },
                    data: { 
                        points: { decrement: bonusPoints },
                        referralCount: { decrement: 1 } 
                    }
                });
                refundMsg = `\n(และหัก ${bonusPoints} แต้มคืนจากผู้แนะนำ ${referrerId})`;
            }

            // ย้อนกลับการสร้างลูกค้า (Soft Delete และล้างความสัมพันธ์)
            await prisma.customer.update({
                where: { customerId: customerId },
                data: { 
                    isDeleted: true,
                    telegramUserId: null,
                    verificationCode: null,
                    referrerId: null // ล้างผู้แนะนำออก
                }
            });
            resultMessage = `✅ ยกเลิกการสร้างลูกค้า ${customerId} สำเร็จ${refundMsg}`;
        }
        else {
            return sendAdminReply(chatId, `⚠️ ไม่รองรับการ Undo คำสั่งประเภท: ${actionType}`);
        }

        // 3. บันทึก Log การ Undo
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
        sendAdminReply(chatId, `✅ บันทึกข้อมูล Admin เรียบร้อย\nID: ${targetTgId}\nRole: ${targetRole}\nName: ${targetName}`);
    } catch (e) {
        console.error("Add Admin Error:", e);
        sendAdminReply(chatId, "❌ เกิดข้อผิดพลาดในการบันทึกข้อมูล");
    }
}

async function handleNewCustomer(ctx, commandParts, adminUser, chatId) {
    const newCustomerId = commandParts[1]?.toUpperCase();
    const referrerId = commandParts[2]?.toUpperCase() || null;
    const isReferrerSpecified = referrerId && referrerId !== 'N/A';

    // 1. Validation
    if (!newCustomerId) return sendAdminReply(chatId, "❗️รูปแบบคำสั่งผิด\nต้องเป็น: /new [รหัสลูกค้าใหม่] [รหัสผู้แนะนำ (ถ้ามี)]");
    if (!isValidIdFormat(newCustomerId)) return sendAdminReply(chatId, `❌ รูปแบบรหัสลูกค้า '${newCustomerId}' ไม่ถูกต้อง (A-Z, 0-9)`);
    
    const existing = await prisma.customer.findUnique({ where: { customerId: newCustomerId, isDeleted: false } });
    if (existing) return sendAdminReply(chatId, `❌ รหัสลูกค้า '${newCustomerId}' นี้มีอยู่ในระบบแล้ว`);

    if (isReferrerSpecified) {
        const refUser = await prisma.customer.findUnique({ where: { customerId: referrerId, isDeleted: false } });
        if (!refUser) return sendAdminReply(chatId, `❌ ไม่พบข้อมูลรหัสผู้แนะนำ '${referrerId}'`);
        if (newCustomerId === referrerId) return sendAdminReply(chatId, "❌ รหัสลูกค้าและผู้แนะนำต้องไม่เหมือนกัน");
    }

    // 2. Create Data
    const verificationCode = generateUniqueCode(4);
    const initialPoints = 0;
    
    // ⭐️ ใช้ getThaiNow() เพื่อเริ่มนับจากเวลาไทย
    const newExpiryDate = addDays(getThaiNow(), getConfig('expiryDaysNewCustomer') || 30);

    await prisma.customer.create({
        data: {
            customerId: newCustomerId,
            referrerId: isReferrerSpecified ? referrerId : null,
            points: initialPoints,
            expiryDate: newExpiryDate,
            verificationCode: verificationCode,
            adminCreatedBy: adminUser,
        }
    });

    // Log Creation
    await createAdminLog(adminUser, "CREATE_CUSTOMER", newCustomerId, 0, `Referred by: ${referrerId || 'N/A'}`);

    // 3. Give Referral Bonus
    if (isReferrerSpecified) {
        await giveReferralBonus(referrerId, newCustomerId, adminUser);
    }

    // 4. Prepare Messages
    const campaign = await getActiveCampaign();
    const linkBonus = campaign?.linkBonus || 50;
    const referralBonus = campaign?.baseReferral || campaign?.base || 50;
    const botLink = getConfig('customerBotLink') || "https://t.me/ONEHUBCustomer_Bot";

    // กล่อง 1: แจ้งแอดมิน
    const adminMsg = `✅ สร้างลูกค้าใหม่ '${newCustomerId}' เรียบร้อยแล้ว\n\n` +
                     `👇 <b>กรุณาคัดลอกข้อความด้านล่างนี้ทั้งหมด\nแล้วส่งให้ลูกค้าได้เลยครับ</b> 👇`;

    // กล่อง 2: ข้อความลูกค้า
    let promoText = "";
    if (campaign?.name && campaign?.name !== 'Standard') {
         if (campaign.endAt) {
             const endDate = new Date(campaign.endAt);
             const dateStr = endDate.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
             promoText = `\n💌 <i>(แคมเปญพิเศษถึง ${dateStr} | ปกติ 50 แต้ม)</i>`;
         } else {
             promoText = `\n💌 <i>(แคมเปญพิเศษ ${campaign.name} | ปกติ 50 แต้ม)</i>`;
         }
    }

    const customerMsg = `🎉 ยินดีต้อนรับสู่การเป็นสมาชิกค่ะ!\n\n` +
        `นี่คือข้อมูลสำหรับใช้สะสมแต้มของคุณ:\n` +
        `----------------------------------\n` +
        `👤 <b>รหัสสมาชิก:</b> ${newCustomerId}\n` +
        `🔑 <b>รหัสยืนยัน (ใช้ครั้งเดียว):</b> ${verificationCode}\n` +
        `----------------------------------\n\n` +
        `✨ <b>รับสิทธิพิเศษทันที!</b> ✨\n` +
        `เพียงนำรหัสข้างต้นไปเชื่อมต่อกับบัญชี Telegram รับฟรี <b>${linkBonus} แต้ม</b>ไปเลย!\n\n` +
        `<b><u>ขั้นตอนการเชื่อมบัญชี:</u></b>\n` +
        `1️⃣ กดที่ลิงก์นี้เพื่อไปที่บอท: ${botLink}\n` +
        `2️⃣ พิมพ์คำสั่งตามนี้แล้วกดส่ง:\n` +
        `<code>/link ${newCustomerId} ${verificationCode}</code>\n\n` +
        `💌 <b>บอกต่อเพื่อนรับแต้มเพิ่ม!</b>\n` +
        `คุณสามารถใช้รหัสสมาชิก (<b>${newCustomerId}</b>) ของคุณเป็น "รหัสผู้แนะนำ" ให้เพื่อนได้ทันที เมื่อเพื่อนของคุณมียอดสั่งซื้อครั้งแรกเกิน 500 บาท ` +
        `คุณจะได้รับแต้มสะสมเพิ่มอีก <b>${referralBonus} แต้ม</b>ค่ะ!${promoText}`;

    await sendAdminReply(chatId, adminMsg);
    await sendAdminReply(chatId, customerMsg);
}

async function checkCustomerInfo(customerId, adminUser) {
    const customer = await prisma.customer.findUnique({
        where: { customerId: customerId.toUpperCase(), isDeleted: false }
    });
    
    await createAdminLog(adminUser, "CHECK_CUSTOMER", customerId.toUpperCase(), 0, "Checked info");

    if (!customer) return `🔍 ไม่พบข้อมูลลูกค้า ${customerId}`;
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

    const customer = await prisma.customer.findUnique({ where: { customerId: customerId, isDeleted: false } });
    if (!customer) return sendAdminReply(chatId, `🔍 ไม่พบข้อมูลลูกค้า ${customerId}`);

    // ⭐️ FIX: Cutoff Logic ที่ถูกต้อง (ใช้ getThaiNow เพื่อความแม่นยำเรื่อง Timezone)
    const today = getThaiNow(); 
    today.setHours(0,0,0,0); 
    
    const currentExpiry = customer.expiryDate;
    const limitDays = getConfig('expiryDaysLimitMax') || 60;
    const extendDays = getConfig('expiryDaysAddPoints') || 30;

    // 1. คำนวณวันที่ฐาน (เลือกวันที่ไกลกว่าระหว่าง วันหมดอายุเดิม กับ วันนี้)
    const baseDate = currentExpiry > today ? currentExpiry : today;
    
    // 2. วันหมดอายุใหม่ = วันที่ฐาน + 30 วัน
    const proposedExpiry = addDays(baseDate, extendDays);
    
    // 3. วันเพดานสูงสุด = วันนี้ + 60 วัน (นับจากวันนี้เสมอ)
    const limitDate = addDays(today, limitDays);
    
    // 4. เลือกวันที่ไม่เกินเพดาน
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
        await sendNotificationToCustomer(customer.telegramUserId, `🎉 คุณได้รับ ${points} แต้ม!\n💰 แต้มสะสมปัจจุบัน: ${newPoints} แต้ม`);
    }
    await sendAlertToSuperAdmin(`🔔 <b>Admin Alert: /add</b>\nUser: ${adminUser}\nCustomer: ${customerId}\nPoints: +${points}`);
    sendAdminReply(chatId, `✅ เพิ่ม ${points} แต้มให้ ${customerId} เรียบร้อย\n💰 ยอดรวม: ${newPoints}`);
}

async function handleRedeemReward(ctx, commandParts, adminUser, chatId) {
    const customerId = commandParts[1]?.toUpperCase();
    const rewardId = commandParts[2]?.toUpperCase();

    if (!customerId || !rewardId) return sendAdminReply(chatId, "❗️รูปแบบคำสั่งผิด\nต้องเป็น: /redeem [รหัสลูกค้า] [รหัสรางวัล]");

    const customer = await prisma.customer.findUnique({ where: { customerId: customerId, isDeleted: false } });
    if (!customer) return sendAdminReply(chatId, `🔍 ไม่พบข้อมูลลูกค้า ${customerId}`);

    const reward = await prisma.reward.findUnique({ where: { rewardId: rewardId } });
    if (!reward) return sendAdminReply(chatId, `🎁 ไม่พบของรางวัลรหัส '${rewardId}'`);

    if (customer.points < reward.points) return sendAdminReply(chatId, `⚠️ แต้มไม่เพียงพอ (มี ${customer.points}, ใช้ ${reward.points})`);

    await prisma.customer.update({
        where: { customerId: customerId },
        data: { points: { decrement: reward.points } }
    });

    const newPoints = customer.points - reward.points;
    await createAdminLog(adminUser, "REDEEM_POINTS", customerId, -reward.points, `Redeemed: ${reward.name}`);

    if (customer.telegramUserId) {
        await sendNotificationToCustomer(customer.telegramUserId, `🎁 คุณใช้ ${reward.points} แต้ม แลก '${reward.name}' สำเร็จ\n💰 แต้มคงเหลือ: ${newPoints}`);
    }
    sendAdminReply(chatId, `✅ แลก '${reward.name}' ให้ ${customerId} สำเร็จ\n💰 แต้มคงเหลือ: ${newPoints}`);
}

async function createAdminLog(admin, action, customerId, pointsChange, details) {
    try {
        await prisma.adminLog.create({
            data: {
                admin: admin,
                action: action,
                customerId: customerId || null,
                pointsChange: pointsChange || 0,
                details: details || ""
            }
        });
    } catch (e) { console.error("Failed to create Admin Log:", e); }
}