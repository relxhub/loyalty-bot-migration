// src/jobs/scheduler.js (ฉบับปรับปรุงความปลอดภัย)

import cron from 'node-cron'; 
import { getConfig } from '../config/config.js';
import { runPointExpiryJob, runReminderJob } from './expiry.job.js';

export function runScheduler(timezone) {
    // ⭐️ แก้ไข: เปลี่ยน Default ให้เป็นรูปแบบ 5 Fields ที่ถูกต้อง ⭐️
    // '5 0 * * *' หมายถึง: นาทีที่ 5 ของทุกชั่วโมงที่ 0 (ตี 00:05 น.) ของทุกวัน
    const cutoffTime = getConfig('expiryCutoffTime') || '5 0 * * *'; 
    const reminderTime = getConfig('reminderNotificationTime') || '0 9 * * *'; // Default: 09:00 น.

    // ⚠️ Note: ถ้าโค้ดมาถึงตรงนี้ แสดงว่าค่าจาก DB ถูกต้องแล้ว

    cron.schedule(cutoffTime, runPointExpiryJob, {
        scheduled: true,
        timezone: timezone 
    });

    cron.schedule(reminderTime, runReminderJob, {
        scheduled: true,
        timezone: timezone 
    });

    console.log(`[Scheduler] Jobs scheduled with times: Cutoff=${cutoffTime}, Reminder=${reminderTime}`);
}