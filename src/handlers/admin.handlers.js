// src/handlers/admin.handlers.js

import { prisma } from '../db.js';
import { getAdminRole } from '../services/admin.service.js';
import { sendAdminReply, sendAlertToSuperAdmin } from '../services/notification.service.js'; 
import { giveReferralBonus } from '../services/customer.service.js'; // Logic ให้แต้มผู้แนะนำ
import { listRewards, formatRewardsForAdmin } from '../services/reward.service.js';
import { isValidIdFormat } from '../utils/validation.utils.js'; 
// Note: ต้องมี logic handlers เช่น handleRedeemReward, handleAddPoints, ฯลฯ

// ⭐️ ฟังก์ชันหลัก: Router คำสั่ง Admin
export async function handleAdminCommand(ctx) {
    const userTgId = String(ctx.from.id);
    const text = ctx.message.text || "";
    const role = await getAdminRole(userTgId);
    const commandParts = text.trim().split(/\s+/);
    const command = commandParts[0].toLowerCase();
    const adminUser = ctx.from.username || ctx.from.first_name;
    const chatId = ctx.chat.id;

    // 1. ตรวจสอบ Gating (ไม่มีสิทธิ์)
    if (!role) {
        return sendAdminReply(chatId, "⛔️ คุณไม่มีสิทธิ์ใช้งานคำสั่งนี้");
    }

    // 2. ตรวจสอบสิทธิ์ /add (Super Admin Only)
    if (command === "/add" && role !== "SuperAdmin") {
        return sendAdminReply(chatId, "⛔️ คุณไม่มีสิทธิ์ใช้งานคำสั่ง /add");
    }

    let result = "⚠️ คำสั่งไม่ถูกต้อง หรือรูปแบบไม่สมบูรณ์";

    switch (command) {
        case "/add":
            // ⚠️ TODO: Call handleAddPoints Logic
            result = `✅ Logic /add สำหรับลูกค้า ${commandParts[1]} กำลังถูกดำเนินการ...`;
            break;

        case "/redeem":
            // ⚠️ TODO: Call handleRedeemReward Logic
            result = `✅ Logic /redeem สำหรับลูกค้า ${commandParts[1]} กำลังถูกดำเนินการ...`;
            break;

        case "/new":
            // ⚠️ TODO: Call handleNewCustomer Logic (ต้องมีตรรกะสร้าง Verification Code, DB Create, และ giveReferralBonus)
            result = `✅ Logic /new สำหรับลูกค้า ${commandParts[1]} กำลังถูกดำเนินการ...`;
            break;
            
        case "/check":
            if (commandParts.length !== 2) {
                result = "❗️รูปแบบคำสั่งผิด\nต้องเป็น: /check [รหัสลูกค้า]";
            } else {
                result = await checkCustomerInfo(commandParts[1]);
                // TODO: Log the action
            }
            break;

        case "/reward":
            const rewards = await listRewards();
            result = formatRewardsForAdmin(rewards);
            // TODO: Log the action
            break;
            
        case "/start":
            result = `👋 สวัสดี ${adminUser}!\nบอทสำหรับแอดมินพร้อมใช้งาน\n\n` +
            "<b>คำสั่งทั้งหมด:</b>\n" +
            `ℹ️ /check [รหัสลูกค้า]\n` +
            (role === "SuperAdmin" ? "🪙 /add [รหัสลูกค้า] [แต้ม]\n" : "") +
            "👤 /new [ลูกค้าใหม่] [ผู้แนะนำ]\n" +
            "🎁 /reward\n" +
            "✨ /redeem [รหัสลูกค้า] [รหัสรางวัล]";
            break;
    }

    sendAdminReply(chatId, result);
}

// ⭐️ ตรรกะค้นหาลูกค้า (แทนที่ checkCustomerInfo เดิม)
async function checkCustomerInfo(customerId) {
    const customer = await prisma.customer.findUnique({
        where: { 
            customerId: customerId.toUpperCase(),
            isDeleted: false // ต้องไม่เป็นบัญชีที่ถูกยกเลิก
        }
    });

    if (!customer) {
        return `🔍 ไม่พบข้อมูลลูกค้า ${customerId}`;
    }

    const formattedDate = customer.expiryDate.toLocaleDateString('th-TH');

    return `👤 <b>ข้อมูลลูกค้า: ${customer.customerId}</b>\n` +
        `🤝 ผู้แนะนำ: ${customer.referrerId || 'N/A'}\n` +
        `💰 แต้มคงเหลือ: ${customer.points}\n` +
        `🗓️ วันหมดอายุ: ${formattedDate}`;
}