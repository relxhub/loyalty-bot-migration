// src/jobs/expiry.job.js
import { prisma } from '../db.js';
import { getConfig } from '../config/config.js';

// ⭐️ ตรรกะตัดแต้มหมดอายุ (Logic จาก Step 26)
export async function runPointExpiryJob() {
    // ต้อง implement logic ที่ใช้ prisma.customer.findMany และ prisma.customer.update
    console.log("[Job] Running Point Expiry Logic...");
    // ⚠️ ต้องเพิ่มตรรกะ Log และ Notification ที่นี่
}

// ⭐️ ตรรกะแจ้งเตือนวันหมดอายุ (Logic จาก Step 27)
export async function runReminderJob() {
    // ต้อง implement logic ที่ใช้ getConfig('expiryReminderDaysList')
    console.log("[Job] Running Expiry Reminder Logic...");
    // ⚠️ ต้องเพิ่มตรรกะ Log และ Notification ที่นี่
}