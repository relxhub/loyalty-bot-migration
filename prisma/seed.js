// prisma/seed.js

import { PrismaClient } from '@prisma/client';
// ต้องเพิ่ม dotenv เพื่อให้ seed file เข้าถึง .env ได้
import 'dotenv/config'; 

const prisma = new PrismaClient();

// ⭐️ ดึง Super Admin ID จาก Environment Variable (.env)
const SUPER_ADMIN_TG_ID = process.env.SUPER_ADMIN_CHAT_ID;
const ADMIN_ROLE_NAME = "SuperAdmin"; 

async function main() {
  console.log('Start seeding...');

  // 1. ⭐️ ข้อมูลตั้งค่า Dynamic หลัก (SystemConfig)
  const configData = [
    // [CRON JOB TIMES] - CRITICAL FOR SCHEDULER STARTUP
    { key: 'expiryCutoffTime', value: '5 0 * * *' },          // เวลาตัดแต้ม (00:05 AM)
    { key: 'reminderNotificationTime', value: '0 9 * * *' },   // เวลาแจ้งเตือน (09:00 AM)
    
    // [DAYS AND LIMITS]
    { key: 'expiryDaysLimitMax', value: '60' },             // เพดานสะสมสูงสุด (วัน)
    { key: 'expiryDaysReferralBonus', value: '7' },          // ต่ออายุสำหรับผู้แนะนำ (วัน)
    { key: 'expiryDaysLinkAccount', value: '7' },            // ต่ออายุสำหรับการเชื่อมบัญชี (วัน)
    { key: 'expiryDaysAddPoints', value: '30' },             // ต่ออายุเมื่อ Admin /add (วัน)
    { key: 'expiryDaysNewCustomer', value: '30' },           // วันหมดอายุเริ่มต้นลูกค้าใหม่ (วัน)
    { key: 'expiryReminderDaysList', value: '4,3,2,1,0' },   // วันแจ้งเตือนล่วงหน้า

    // [STANDARD POINTS]
    { key: 'standardReferralPoints', value: '50' },
    { key: 'standardLinkBonus', value: '50' },

    // [LINKS]
    { key: 'customerBotLink', value: 'https://t.me/ONEHUBCustomer_Bot' }, 
  ];

    // 2. ⭐️ Upsert ข้อมูลทั้งหมดลงใน SystemConfig (เพิ่มหรืออัปเดต)
  for (const data of configData) {
    await prisma.systemConfig.upsert({
      where: { key: data.key },
      update: { value: data.value },
      create: { key: data.key, value: data.value },
    });
  }
  console.log(`- Inserted/Updated ${configData.length} System Configurations.`);

  // 3. ⭐️ Upsert Super Admin คนแรก (ถ้ายังไม่มี)
  // ใช้ Chat ID จาก ENV เพื่อให้แน่ใจว่า Admin คนแรกถูกสร้างขึ้น
  if (!SUPER_ADMIN_TG_ID) {
    console.error('FATAL: SUPER_ADMIN_CHAT_ID is missing in the .env file. Cannot create first admin.');
    process.exit(1);
  }

  const admin = await prisma.admin.upsert({
    where: { telegramId: SUPER_ADMIN_TG_ID },
    update: { role: ADMIN_ROLE_NAME }, 
    create: {
      telegramId: SUPER_ADMIN_TG_ID,
      name: 'System Initial Admin',
      role: ADMIN_ROLE_NAME,
    },
  });
  console.log(`- Created/Updated Super Admin: ${admin.telegramId}`);


  console.log('Seeding finished. Database is configured.');
}

main()
  .catch((e) => {
    console.error('Seeding failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });