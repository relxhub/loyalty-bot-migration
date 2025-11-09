// src/jobs/scheduler.js
import cron from 'node-cron'; 
import { getConfig } from '../config/config.js';
import { runPointExpiryJob, runReminderJob } from './expiry.job.js';

export function runScheduler(timezone) {
    // ดึงค่า Dynamic จาก Config
    const cutoffTime = getConfig('expiryCutoffTime') || '5 0';      // Default: 00:05
    const reminderTime = getConfig('reminderNotificationTime') || '0 9'; // Default: 09:00

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