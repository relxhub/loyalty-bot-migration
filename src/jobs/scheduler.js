// src/jobs/scheduler.js

import cron from 'node-cron'; 
import { getConfig } from '../config/config.js';
import { runPointExpiryJob, runReminderJob } from './expiry.job.js';

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
        console.log(`✅ Cron Jobs scheduled successfully.`);
    } catch (error) {
        console.error("⚠️ Failed to schedule cron jobs:", error.message);
    }
}