import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  console.log('🗑️ กำลังล้างประวัติข้อมูลทั้งหมด...');
  await prisma.pointTransaction.deleteMany({}); // ลบประวัติ
  // await prisma.customer.deleteMany({}); // (อย่าเพิ่งลบลูกค้า ถ้าไม่อยากเริ่มใหม่หมด)
  console.log('✅ ล้างข้อมูลเรียบร้อย พร้อมรับข้อมูลจริง!');
}

main()
  .catch(e => console.error(e))
  .finally(async () => await prisma.$disconnect());