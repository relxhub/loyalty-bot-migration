// src/jobs/scheduler.js

import cron from 'node-cron';
import { getConfig } from '../config/config.js';
import { runPointExpiryJob, runReminderJob, runCouponExpiryJob, runOrderExpiryJob, runCouponExpiringWarningJob } from './expiry.job.js';
import { runDailyDigestJob, runBirthdayCouponJob, runWinBackJob } from './engagement.job.js';

export function runScheduler(timezone) {
    // ดึงค่าจาก Config
    let cutoffTime = getConfig('expiryCutoffTime');
    let reminderTime = getConfig('reminderNotificationTime');

    console.log(`[Scheduler] Raw values from DB -> Cutoff: "${cutoffTime}", Reminder: "${reminderTime}"`);

    // ⭐️ FIX: ตรวจสอบความยาวของ String (Cron ต้องยาวกว่า 5 ตัวอักษรแน่นอน)
    // ถ้าใน DB เป็น "5" หรือ "0 9" หรือค่าว่าง -> บังคับใช้ค่า Default ทันที
    if (!cutoffTime || typeof cutoffTime !== 'string' || cutoffTime.length < 9) {
        console.warn(`⚠️ Invalid Cutoff Time in DB ("${cutoffTime}"). Using default "5 0 * * *"`);
        cutoffTime = '5 0 * * *'; // 00:05 น.
    }

    if (!reminderTime || typeof reminderTime !== 'string' || reminderTime.length < 9) {
        console.warn(`⚠️ Invalid Reminder Time in DB ("${reminderTime}"). Using default "0 9 * * *"`);
        reminderTime = '0 9 * * *'; // 09:00 น.
    }

    console.log(`[Scheduler] Final values -> Cutoff: "${cutoffTime}", Reminder: "${reminderTime}"`);

    try {
        cron.schedule(cutoffTime, runPointExpiryJob, {
            scheduled: true,
            timezone: timezone
        });

        cron.schedule(reminderTime, runReminderJob, {
            scheduled: true,
            timezone: timezone
        });

        // ตรวจสอบคูปองหมดอายุทุกวัน เวลา 00:10
        cron.schedule('10 0 * * *', runCouponExpiryJob, {
            scheduled: true,
            timezone: timezone
        });

        // แจ้งเตือนคูปองใกล้หมดอายุล่วงหน้า 3 วัน — ทุกวัน 09:00
        cron.schedule('0 9 * * *', runCouponExpiringWarningJob, {
            scheduled: true,
            timezone: timezone
        });

        // E-commerce: ตรวจสอบออเดอร์หมดอายุทุก 10 วินาที
        // (ลูกค้า countdown ถึง 0 → server ยกเลิกภายใน 10s + emit socket → UI realtime)
        // ใช้ setInterval แทน cron เพราะ node-cron 5-field ไม่รองรับ sub-minute granularity
        setInterval(() => { runOrderExpiryJob().catch(e => console.error('[OrderExpiryJob] tick err:', e?.message)); }, 10000);

        // 📰 Daily digest — 09:00 ทุกวัน → ส่งสรุปไป admin group
        cron.schedule('0 9 * * *', runDailyDigestJob, { scheduled: true, timezone });

        // 🎂 Birthday coupon — 08:00 ทุกวัน
        cron.schedule('0 8 * * *', runBirthdayCouponJob, { scheduled: true, timezone });

        // 🔄 Win-back inactive customers — 10:00 ทุกวัน
        cron.schedule('0 10 * * *', runWinBackJob, { scheduled: true, timezone });

        console.log(`✅ Cron Jobs scheduled successfully.`);
    } catch (error) {
        console.error("⚠️ Failed to schedule cron jobs:", error.message);
    }
}