-- insert_cron_data.sql

-- ⭐️ ใส่ค่า Cron Jobs ที่ทำให้ระบบ Crash
INSERT INTO "SystemConfig" ("key", "value")
VALUES 
    ('expiryCutoffTime', '5 0 * * *'),
    ('reminderNotificationTime', '0 9 * * *')
ON CONFLICT ("key") DO UPDATE 
SET value = excluded.value;