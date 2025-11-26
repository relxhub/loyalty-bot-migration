// src/jobs/scheduler.js

import cron from 'node-cron'; 
import { getConfig } from '../config/config.js';
import { runPointExpiryJob, runReminderJob } from './expiry.job.js';

export function runScheduler(timezone) {
    // ดึงค่าจาก Config
    let cutoffTime = getConfig('expiryCutoffTime');
    let reminderTime = getConfig('reminderNotificationTime');

    // ⭐️ การตรวจสอบความถูกต้อง (Validation) ⭐️
    // ถ้าค่าที่ได้มาสั้นเกินไป (เช่น "5") หรือไม่มีค่า ให้ใช้ค่ามาตรฐานทันที
    if (!cutoffTime || cutoffTime.length < 5) {
        cutoffTime = '5 0 * * *'; // ตี 00:05 น.
    }
    if (!reminderTime || reminderTime.length < 5) {
        reminderTime = '0 9 * * *'; // 09:00 น.
    }

    console.log(`[Scheduler] Starting jobs with times: Cutoff="${cutoffTime}", Reminder="${reminderTime}"`);

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