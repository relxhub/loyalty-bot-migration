import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const existingSetting = await prisma.storeSetting.findUnique({
    where: { id: 1 }
  });

  if (!existingSetting) {
    await prisma.storeSetting.create({
      data: {
        id: 1,
        lowStockThreshold: 50,
        outOfStockThreshold: 20
      }
    });
    console.log("StoreSetting seeded with ID 1.");
  } else {
    console.log("StoreSetting already exists.");
  }
}

main()
  .catch(e => console.error(e))
  .finally(async () => await prisma.$disconnect());