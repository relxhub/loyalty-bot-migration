import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Starting seeding...');

  // ===============================================
  // ⚙️ SYSTEM CONFIG (ตั้งค่าระบบทีเดียวจบ)
  // ===============================================
  const configs = [
    // 1. หมวดคะแนนพื้นฐาน
    { key: 'standardReferralPoints', value: '50' },
    { key: 'standardLinkBonus', value: '50' },

    // 2. หมวดวันหมดอายุ (Expiry Rules)
    { key: 'expiryDaysNewMember', value: '30' },
    { key: 'expiryDaysReferralBonus', value: '7' },
    { key: 'expiryDaysLinkAccount', value: '7' },
    { key: 'expiryDaysLimitMax', value: '60' },

    // 3. หมวดเวลาและการแจ้งเตือน (Scheduler)
    { key: 'expiryCutoffTime', value: '5 0 * * *' },      // ตัดแต้ม 00:05 น.
    { key: 'reminderNotificationTime', value: '0 9 * * *' }, // แจ้งเตือน 09:00 น.
    { key: 'systemTimezone', value: 'Asia/Bangkok' }
  ];

  console.log('⚙️ Upserting System Configs...');
  
  for (const config of configs) {
    // ใช้ upsert: ถ้ามีอยู่แล้วให้ update (หรือข้ามก็ได้), ถ้ายังไม่มีให้ create
    await prisma.systemConfig.upsert({
      where: { key: config.key },
      update: { value: config.value }, // ถ้าอยากให้ทับค่าเดิม ให้ใส่บรรทัดนี้
      // update: {}, // ถ้าไม่อยากให้ทับค่าเดิมที่เคยแก้ไว้ ให้ใช้บรรทัดนี้แทน
      create: config,
    });
  }

  console.log('✅ Seeding completed!');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });