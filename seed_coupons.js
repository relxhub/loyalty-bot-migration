import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function seed() {
    console.log("🎟️ กำลังสร้างคูปองตัวอย่าง...");

    const coupons = [
        {
            id: 'FIRST_ENTRY',
            name: 'คูปองยินดีต้อนรับ',
            description: 'ลด 10% สำหรับสมาชิกใหม่ (100 ท่านแรก)',
            type: 'DISCOUNT_PERCENT',
            value: 10,
            totalQuota: 100,
            isActive: true
        },
        {
            id: 'PRO_50_BAHT',
            name: 'ส่วนลด 50 บาท',
            description: 'ลดทันที 50 บาท เมื่อยอดซื้อครบ 500 บาท',
            type: 'DISCOUNT_FLAT',
            value: 50,
            minPurchase: 500,
            totalQuota: 50,
            isActive: true
        },
        {
            id: 'B3G1_SEPT',
            name: 'โปรซื้อ 3 แถม 1',
            description: 'ซื้อสินค้าอะไรก็ได้ครบ 3 ชิ้น รับของแถมฟรี!',
            type: 'GIFT',
            minQty: 3,
            giftProductId: 1, // สมมติว่าเป็นสินค้า ID 1 (คุณสามารถเปลี่ยนภายหลังได้)
            giftQty: 1,
            totalQuota: 30,
            isActive: true
        },
        {
            id: 'VIP_BIG_DEAL',
            name: 'VIP ส่วนลด 20%',
            description: 'ลดจุใจ 20% เมื่อยอดซื้อครบ 1,000 บาท',
            type: 'DISCOUNT_PERCENT',
            value: 20,
            minPurchase: 1000,
            isActive: true
        },
        {
            id: 'GIFT_SAMPLE',
            name: 'รับของแถมฟรี!',
            description: 'เพียงกดเก็บคูปอง รับของแถมฟรีไม่มีขั้นต่ำ',
            type: 'GIFT',
            giftProductId: 1,
            giftQty: 1,
            totalQuota: 200,
            isActive: true
        }
    ];

    for (const c of coupons) {
        await prisma.coupon.upsert({
            where: { id: c.id },
            update: c,
            create: c
        });
        console.log(`✅ สร้างคูปอง: ${c.id} สำเร็จ`);
    }

    console.log("✨ เสร็จสิ้นการสร้างข้อมูลตัวอย่าง");
    process.exit(0);
}

seed();
