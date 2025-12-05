// seed_my_history.js
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// 🔴 แก้ตรงนี้: ใส่ Telegram ID ของคุณที่ใช้ทดสอบ (ดูในหน้าแอปตรงมุมซ้ายบน หรือ console log)
const MY_TELEGRAM_ID = "7040651281"; 

async function main() {
  console.log(`🔍 กำลังค้นหา User ที่มี Telegram ID: ${MY_TELEGRAM_ID}`);

  const user = await prisma.customer.findUnique({
    where: { telegramUserId: MY_TELEGRAM_ID }
  });

  if (!user) {
    console.error(`❌ ไม่พบ User นี้ในระบบ! (คุณอาจจะล็อกอินด้วย Demo หรือยังไม่ได้ Link Account)`);
    console.log(`💡 ลองเปลี่ยน MY_TELEGRAM_ID เป็น 'Customer ID' ที่คุณเห็นในหน้าจอมือถือดูครับ`);
    return;
  }

  console.log(`✅ พบ User: ${user.firstName} (CustID: ${user.customerId})`);
  console.log('🔄 กำลังสร้างประวัติ 3 รายการ...');

  await prisma.pointTransaction.createMany({
    data: [
      {
        customerId: user.customerId,
        amount: 500,
        type: 'ADMIN_ADJUST', // แอดมินเติมให้
        detail: 'Test Add by Script',
        createdAt: new Date()
      },
      {
        customerId: user.customerId,
        amount: -50,
        type: 'REDEEM_REWARD', // แลกของ
        detail: 'Test Redeem',
        createdAt: new Date(Date.now() - 3600000) // 1 ชม.ที่แล้ว
      },
      {
        customerId: user.customerId,
        amount: 100,
        type: 'REFERRAL_BONUS', // แนะนำเพื่อน
        detail: 'Friend Referral',
        createdAt: new Date(Date.now() - 86400000) // 1 วันที่แล้ว
      }
    ]
  });

  console.log('🎉 สร้างข้อมูลเสร็จแล้ว! ลองกดรีเฟรชหน้าประวัติใหม่ครับ');
}

main()
  .catch((e) => console.error(e))
  .finally(async () => await prisma.$disconnect());