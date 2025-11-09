// src/handlers/admin.handlers.js

import { getAdminRole } from '../services/admin.service.js';
// ... (imports อื่นๆ เช่น transaction.service, reward.service)

// ⚠️ Note: Logic สำหรับคำสั่งต่างๆ ต้องถูก implement ในไฟล์ services หรือใน handler นี้

/**
 * 🔐 Gating: ตรวจสอบสิทธิ์และ Route คำสั่ง Admin
 */
export async function handleAdminCommand(ctx) {
    const userTgId = String(ctx.from.id);
    const text = ctx.message.text || "";
    const role = await getAdminRole(userTgId);

    if (!role) {
        return ctx.reply("⛔️ คุณไม่มีสิทธิ์ใช้งานคำสั่งนี้");
    }

    const commandParts = text.split(" ");
    const command = commandParts[0].toLowerCase();

    // ⭐️ ตรรกะ: /add ถูกจำกัดไว้สำหรับ Super Admin
    if (command === "/add" && role !== "SuperAdmin") {
        return ctx.reply("⛔️ คุณไม่มีสิทธิ์ใช้งานคำสั่ง /add");
    }

    switch (command) {
        case "/add":
            // ⚠️ ต้องเรียกใช้ตรรกะ handleAddPoints(ctx, commandParts);
            return ctx.reply("✅ ตรรกะ /add จะถูกเรียกใช้"); 
        case "/redeem":
            // ⚠️ ต้องเรียกใช้ตรรกะ handleRedeemReward(ctx, commandParts);
            return ctx.reply("✅ ตรรกะ /redeem จะถูกเรียกใช้");
        case "/new":
            // ⚠️ ต้องเรียกใช้ตรรกะ handleNewCustomer(ctx, commandParts);
            return ctx.reply("✅ ตรรกะ /new จะถูกเรียกใช้");
        case "/reversesignup": 
            // ⚠️ คำสั่งย้อนกลับที่เราออกแบบไว้
            return ctx.reply("✅ ตรรกะ /reversesignup จะถูกเรียกใช้");
        case "/check":
            // ⚠️ ต้องเรียกใช้ตรรกะ checkCustomerInfo(customerId);
            return ctx.reply("✅ ตรรกะ /check จะถูกเรียกใช้");
        // ... (คำสั่งอื่นๆ)
        default:
             return ctx.reply(`👋 สวัสดี ${ctx.from.first_name}!\nบอทแอดมินพร้อมใช้งาน`);
    }
}