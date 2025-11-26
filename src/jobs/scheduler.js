// src/jobs/scheduler.js

import cron from 'node-cron'; 
import { getConfig } from '../config/config.js';
import { runPointExpiryJob, runReminderJob } from './expiry.job.js';

export function runScheduler(timezone) {
    // ⭐️ แก้ไข: เพิ่ม || 'ค่ามาตรฐาน' เพื่อป้องกัน Crash 100%
    // ถ้าใน DB หาไม่เจอ ให้ใช้ '5 0 * * *' (เที่ยงคืน 5 นาที) แทนทันที
    const cutoffTime = getConfig('expiryCutoffTime') || '5 0 * * *'; 
    const reminderTime = getConfig('reminderNotificationTime') || '0 9 * * *';

    console.log(`[Scheduler] Starting jobs with times: Cutoff="${cutoffTime}", Reminder="${reminderTime}"`);

    cron.schedule(cutoffTime, runPointExpiryJob, {
        scheduled: true,
        timezone: timezone 
    });

    cron.schedule(reminderTime, runReminderJob, {
        scheduled: true,
        timezone: timezone 
    });
} //