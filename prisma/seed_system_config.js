// prisma/seed_system_config.js
import { PrismaClient } from '@prisma/client';
import 'dotenv/config'; // To load environment variables like DATABASE_URL

const prisma = new PrismaClient();

async function seedSystemConfig() {
  console.log('🌱 Seeding default SystemConfig values...');

  const defaultConfigs = [
    { key: 'expiryDaysNewMember', value: '30' },
    { key: 'expiryDaysReferralBonus', value: '7' },
    { key: 'expiryDaysLimitMax', value: '60' },
    { key: 'standardReferralPoints', value: '50' },
    { key: 'standardLinkBonus', value: '50' },
    { key: 'minPurchaseForReferral', value: '500' },
    { key: 'expiryDaysLinkAccount', value: '7' },
  ];

  for (const config of defaultConfigs) {
    await prisma.systemConfig.upsert({
      where: { key: config.key },
      update: { value: config.value },
      create: { key: config.key, value: config.value },
    });
    console.log(`  Upserted SystemConfig: ${config.key} = ${config.value}`);
  }

  console.log('✅ SystemConfig seeding complete.');
}

seedSystemConfig()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });