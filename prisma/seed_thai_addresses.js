import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

const sampleAddresses = [
    { subdistrict: 'บางค้อ', district: 'จอมทอง', province: 'กรุงเทพมหานคร', zipcode: '10150' },
    { subdistrict: 'จอมทอง', district: 'จอมทอง', province: 'กรุงเทพมหานคร', zipcode: '10150' },
    { subdistrict: 'บางมด', district: 'จอมทอง', province: 'กรุงเทพมหานคร', zipcode: '10150' },
    { subdistrict: 'บางขุนเทียน', district: 'จอมทอง', province: 'กรุงเทพมหานคร', zipcode: '10150' },
    { subdistrict: 'คลองเตย', district: 'คลองเตย', province: 'กรุงเทพมหานคร', zipcode: '10110' },
    { subdistrict: 'คลองตัน', district: 'คลองเตย', province: 'กรุงเทพมหานคร', zipcode: '10110' },
    { subdistrict: 'พระโขนง', district: 'คลองเตย', province: 'กรุงเทพมหานคร', zipcode: '10110' },
    { subdistrict: 'ลุมพินี', district: 'ปทุมวัน', province: 'กรุงเทพมหานคร', zipcode: '10330' },
    { subdistrict: 'ปทุมวัน', district: 'ปทุมวัน', province: 'กรุงเทพมหานคร', zipcode: '10330' },
    { subdistrict: 'รองเมือง', district: 'ปทุมวัน', province: 'กรุงเทพมหานคร', zipcode: '10330' },
    { subdistrict: 'วังใหม่', district: 'ปทุมวัน', province: 'กรุงเทพมหานคร', zipcode: '10330' },
    { subdistrict: 'ดินแดง', district: 'ดินแดง', province: 'กรุงเทพมหานคร', zipcode: '10400' },
    { subdistrict: 'ห้วยขวาง', district: 'ห้วยขวาง', province: 'กรุงเทพมหานคร', zipcode: '10310' },
    { subdistrict: 'สามเสนนอก', district: 'ห้วยขวาง', province: 'กรุงเทพมหานคร', zipcode: '10310' },
    { subdistrict: 'บางกะปิ', district: 'ห้วยขวาง', province: 'กรุงเทพมหานคร', zipcode: '10310' },
    { subdistrict: 'ลาดพร้าว', district: 'ลาดพร้าว', province: 'กรุงเทพมหานคร', zipcode: '10230' },
    { subdistrict: 'จรเข้บัว', district: 'ลาดพร้าว', province: 'กรุงเทพมหานคร', zipcode: '10230' },
];

async function main() {
    console.log('Seeding Thai Addresses...');
    
    // Using upsert or just createMany
    // For simplicity, we clear and re-seed this specific table if needed, 
    // or just check if it's empty.
    
    const count = await prisma.thaiAddress.count();
    if (count > 0) {
        console.log('ThaiAddress table is not empty. Skipping seed to prevent duplicates.');
        return;
    }

    await prisma.thaiAddress.createMany({
        data: sampleAddresses
    });

    console.log(`Successfully seeded ${sampleAddresses.length} Thai addresses.`);
}

main()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
