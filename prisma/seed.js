// prisma/seed.js
import { PrismaClient } from '@prisma/client';
import seedSystemConfig from './seed_system_config.js';

const prisma = new PrismaClient();

async function main() {
  console.log('🚀 Starting database seeding...');
  
  // This is the main entry point for all seeding operations.
  // It calls other specific seed functions.
  await seedSystemConfig();
  
  // In the future, if you have other data to seed (e.g., Rewards),
  // you can create another file like `seed_rewards.js` and call it here:
  // await seedRewards();

  console.log('✅ Database seeding completed successfully.');
}

main()
  .catch((e) => {
    console.error("💀 An error occurred during seeding:");
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
