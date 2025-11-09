// prisma/seed.js

import { PrismaClient } from '@prisma/client';
// ต้องเพิ่ม dotenv เพื่อให้ seed file เข้าถึง .env ได้
import 'dotenv/config'; 

const prisma = new PrismaClient();

const SUPER_ADMIN_TG_ID = process.env.SUPER_ADMIN_CHAT_ID;
const ADMIN_ROLE_NAME = "SuperAdmin"; // ตาม enum Role ที่เรากำหนดไว้

async function main() {
  console.log('Start seeding...');

  // 1. ⭐️ เพิ่ม Super Admin คนแรก (ถ้ายังไม่มี)
  // รหัสผู้ดูแลจะถูกดึงมาจาก SUPER_ADMIN_CHAT_ID ในไฟล์ .env
  const admin = await prisma.admin.upsert({
    where: { telegramId: SUPER_ADMIN_TG_ID },
    update: { role: ADMIN_ROLE_NAME }, // อัปเดตสิทธิ์เสมอหากมีอยู่แล้ว
    create: {
      telegramId: SUPER_ADMIN_TG_ID,
      name: 'System Initial Admin',
      role: ADMIN_ROLE_NAME,
    },
  });
  console.log(`- Created/Updated Super Admin: ${admin.telegramId}`);

  // 2. ⭐️ ใส่ค่าตั้งค่า Dynamic หลัก (SystemConfig)
  const configData = [
    // [Days]
    { key: 'expiryDaysLimitMax', value: '60' },          // เพดานสะสมสูงสุด (วัน)
    { key: 'expiryDaysReferralBonus', value: '7' },       // ต่ออายุสำหรับผู้แนะนำ (วัน)
    { key: 'expiryDaysLinkAccount', value: '7' },         // ต่ออายุสำหรับการเชื่อมบัญชี (วัน)
    { key: 'expiryDaysAddPoints', value: '30' },          // ต่ออายุเมื่อ Admin /add (วัน)
    { key: 'expiryDaysNewCustomer', value: '30' },        // วันหมดอายุเริ่มต้นลูกค้าใหม่ (วัน)
    { key: 'expiryReminderDaysList', value: '3,2,1,0' }, // วันแจ้งเตือนล่วงหน้า

    // [Standard Points]
    { key: 'standardReferralPoints', value: '50' },
    { key: 'standardLinkBonus', value: '50' },

    // [Links]
    { key: 'customerBotLink', value: 'https://t.me/ONEHUBCustomer_Bot' }, 
  ];

  for (const data of configData) {
    await prisma.systemConfig.upsert({
      where: { key: data.key },
      update: { value: data.value },
      create: { key: data.key, value: data.value },
    });
  }
  console.log(`- Inserted/Updated ${configData.length} System Configurations.`);

  console.log('Seeding finished.');
}

main()
  .catch((e) => {
    console.error('Seeding failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });