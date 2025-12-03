// src/handlers/admin.handlers.js (Final Version - Fix Undo & Duplicate Check)

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
// ⭐️ MAIN ROUTER
// ==================================================
async function handleNewCustomer(ctx, commandParts, adminUser, chatId) {
    const newCustomerId = commandParts[1]?.toUpperCase();
    const referrerId = commandParts[2]?.toUpperCase() || null;
    const isReferrerSpecified = referrerId && referrerId !== 'N/A';

    // 1. Validation (เหมือนเดิม)
    if (!newCustomerId) return sendAdminReply(chatId, "❗️รูปแบบคำสั่งผิด\nต้องเป็น: /new [รหัสลูกค้าใหม่] [รหัสผู้แนะนำ (ถ้ามี)]");
    if (!isValidIdFormat(newCustomerId)) return sendAdminReply(chatId, `❌ รูปแบบรหัสลูกค้า '${newCustomerId}' ไม่ถูกต้อง (A-Z, 0-9)`);
    
    // ... (ส่วนเช็คซ้ำ existing customer เหมือนเดิม) ...

    // 2. Create Data (เหมือนเดิม)
    // ✅ เพิ่มการสร้าง Verification Code ตรงนี้ให้ชัวร์
    const verificationCode = generateUniqueCode(4); 
    const initialPoints = 0;
    const newExpiryDate = addDays(getThaiNow(), getConfig('expiryDaysNewCustomer') || 30);

    // สร้างลูกค้า (ส่ง telegramId: null เพราะลูกค้ายังไม่เข้าบอท)
    await prisma.customer.create({
        data: {
            customerId: newCustomerId,
            referrerId: isReferrerSpecified ? referrerId : null,
            points: initialPoints,
            expiryDate: newExpiryDate,
            verificationCode: verificationCode,
            adminCreatedBy: adminUser,
            telegramUserId: null // ✅ สำคัญ: ระบุเป็น null
        }
    });

    // Log Creation
    await createAdminLog(adminUser, "CREATE_CUSTOMER", newCustomerId, 0, `Referred by: ${referrerId || 'N/A'}`);

    // 3. Give Referral Bonus (เหมือนเดิม)
    if (isReferrerSpecified) {
        await giveReferralBonus(referrerId, newCustomerId, adminUser);
    }

    // 4. Prepare Messages & Magic Link 🆕
    const campaign = await getActiveCampaign();
    const linkBonus = campaign?.linkBonus || 50;
    const referralBonus = campaign?.baseReferral || campaign?.base || 50;
    
    // ✅ ดึง Username ของบอทเพื่อสร้างลิงก์ (ดึงจาก ctx โดยตรงแม่นยำกว่า config)
    const botUsername = ctx.botInfo.username; 
    
    // ✅ สร้าง Magic Link
    // รูปแบบ: link_รหัสลูกค้า_รหัสยืนยัน
    const magicLink = `https://t.me/${botUsername}/app?startapp=link_${newCustomerId}_${verificationCode}`;

    const adminMsg = `✅ <b>สร้างลูกค้าใหม่สำเร็จ!</b>\n` +
                     `👤 ชื่อ: ${newCustomerId}\n` + // (หรือใช้ชื่อจริงถ้ามี)
                     `🔑 รหัสยืนยัน: <code>${verificationCode}</code>\n\n` +
                     `👇 <b>แตะที่ลิงก์นี้เพื่อส่งให้ลูกค้าเชื่อมต่อทันที:</b>\n` +
                     `${magicLink}`; // ส่งลิงก์เพียวๆ ให้กดง่ายๆ

    // ข้อความสำหรับลูกค้า (Optional: ส่งแยกไปเผื่อแอดมินอยากก๊อปปี้ข้อความยาวๆ)
    const customerMsg = `🎉 ยินดีต้อนรับสมาชิกใหม่!\n\n` +
        `รหัสสมาชิกของคุณคือ: <b>${newCustomerId}</b>\n` +
        `กดที่ลิงก์ด้านล่างเพื่อสะสมแต้มและรับโบนัสฟรี ${linkBonus} แต้มทันที!\n` +
        `👉 ${magicLink}`;

    await sendAdminReply(chatId, adminMsg);
    await sendAdminReply(chatId, customerMsg);
}

// ==================================================
// 🛠️ HELPER FUNCTIONS
// ==================================================

// ⭐️ ฟังก์ชันยกเลิกคำสั่งล่าสุด (/undo)
async function handleUndoLastAction(ctx, adminUser, chatId) {
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
            // ⭐️ Logic 1: เช็คผู้แนะนำและหักแต้มคืน
            const targetCustomer = await prisma.customer.findUnique({
                where: { customerId: customerId }
            });

            let refundMsg = "";

            if (targetCustomer && targetCustomer.referrerId) {
                const referrerId = targetCustomer.referrerId;
                // ดึง Log การให้โบนัสล่าสุดที่เกี่ยวข้องกับลูกค้าคนนี้
                // เพื่อดูว่าให้ไปเท่าไหร่ (จะได้หักคืนถูก)
                const bonusLog = await prisma.adminLog.findFirst({
                     where: {
                         action: 'REFERRAL_BONUS',
                         customerId: referrerId,
                         createdAt: { gte: lastLog.createdAt } // ต้องเกิดพร้อมกันหรือหลังจากการสร้าง
                     }
                });
                
                // ถ้าหา Log ไม่เจอ ให้ใช้ค่า Config ปัจจุบันแทน
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

            // ⭐️ Logic 2: เปลี่ยนชื่อ ID (Rename) เพื่อให้ชื่อเดิมว่าง
            const deletedId = `${customerId}_DEL_${Date.now().toString().slice(-4)}`; // เช่น TEST12_DEL_5678

            await prisma.customer.update({
                where: { customerId: customerId },
                data: { 
                    customerId: deletedId, // เปลี่ยนชื่อ ID
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

async function handleNewCustomer(ctx, commandParts, adminUser, chatId) {
    const newCustomerId = commandParts[1]?.toUpperCase();
    const referrerId = commandParts[2]?.toUpperCase() || null;
    const isReferrerSpecified = referrerId && referrerId !== 'N/A';

    // 1. Validation
    if (!newCustomerId) return sendAdminReply(chatId, "❗️รูปแบบคำสั่งผิด\nต้องเป็น: /new [รหัสลูกค้าใหม่] [รหัสผู้แนะนำ (ถ้ามี)]");
    if (!isValidIdFormat(newCustomerId)) return sendAdminReply(chatId, `❌ รูปแบบรหัสลูกค้า '${newCustomerId}' ไม่ถูกต้อง (A-Z, 0-9)`);
    
    // ⭐️ FIX: การเช็คซ้ำ (ต้องค้นหาด้วย ID ตรงๆ แล้วค่อยเช็ค isDeleted)
    const existing = await prisma.customer.findUnique({ 
        where: { customerId: newCustomerId } 
    });

    // ถ้ามีข้อมูล และยังไม่ถูกลบ -> แจ้งเตือนซ้ำ
    if (existing && !existing.isDeleted) {
        return sendAdminReply(chatId, `❌ รหัสลูกค้า '${newCustomerId}' นี้มีอยู่ในระบบแล้ว`);
    }
    // ถ้ามีข้อมูล แต่ถูกลบไปแล้ว (กรณีหายากเพราะเรา Rename แล้ว) -> แจ้งเตือนเช่นกันเพื่อความชัวร์
    if (existing && existing.isDeleted) {
        return sendAdminReply(chatId, `⚠️ รหัส '${newCustomerId}' เคยถูกใช้แล้ว (แต่ถูกลบ) กรุณาใช้รหัสอื่น`);
    }

    if (isReferrerSpecified) {
        const refUser = await prisma.customer.findUnique({ where: { customerId: referrerId } });
        if (!refUser || refUser.isDeleted) return sendAdminReply(chatId, `❌ ไม่พบข้อมูลรหัสผู้แนะนำ '${referrerId}'`);
        if (newCustomerId === referrerId) return sendAdminReply(chatId, "❌ รหัสลูกค้าและผู้แนะนำต้องไม่เหมือนกัน");
    }

    // 2. Create Data
    const verificationCode = generateUniqueCode(4);
    const initialPoints = 0;
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

    const adminMsg = `✅ สร้างลูกค้าใหม่ '${newCustomerId}' เรียบร้อยแล้ว\n\n` +
                     `👇 <b>กรุณาคัดลอกข้อความด้านล่างนี้ทั้งหมด\nแล้วส่งให้ลูกค้าได้เลยครับ</b> 👇`;

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

    const today = getThaiNow(); 
    today.setHours(0,0,0,0); 
    
    const currentExpiry = customer.expiryDate;
    const limitDays = getConfig('expiryDaysLimitMax') || 60;
    const extendDays = getConfig('expiryDaysAddPoints') || 30;

    const baseDate = currentExpiry > today ? currentExpiry : today;
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