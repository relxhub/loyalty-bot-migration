import cron from 'node-cron'; 
import { getConfig } from '../config/config.js';
import { runPointExpiryJob, runReminderJob } from './expiry.job.js';

export function runScheduler(timezone) {
    // ⭐️ แก้ไขตรงนี้: เปลี่ยนค่า Default ให้มีครบ 5 ส่วน (* * * * *)
    // '5 0 * * *' = เวลา 00:05 น. ของทุกวัน
    const cutoffTime = getConfig('expiryCutoffTime') || '5 0 * * *'; 
    
    // '0 9 * * *' = เวลา 09:00 น. ของทุกวัน
    const reminderTime = getConfig('reminderNotificationTime') || '0 9 * * *';

    console.log(`[Scheduler] Starting jobs with times: Cutoff="${cutoffTime}", Reminder="${reminderTime}"`);

    // เพิ่ม Try-Catch เพื่อป้องกันไม่ให้ระบบล่มถ้าค่า Config ผิดพลาด
    try {
        cron.schedule(cutoffTime, runPointExpiryJob, {
            scheduled: true,
            timezone: timezone 
        });

        cron.schedule(reminderTime, runReminderJob, {
            scheduled: true,
            timezone: timezone 
        });
    } catch (error) {
        console.error("⚠️ Failed to schedule cron jobs:", error.message);
    }
}