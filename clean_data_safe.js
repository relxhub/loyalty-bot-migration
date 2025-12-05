import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
    console.log("🧹 กำลังเริ่มล้างข้อมูล (โหมดปลอดภัย)...");
    console.log("   (จะเก็บข้อมูล Admin, SystemConfig, Reward, Campaign ไว้)");

    // 1. ลบข้อมูล Transaction และ Audit Logs (ต้องลบก่อน เพราะผูกกับ Customer)
    console.log("   - กำลังลบ PointTransaction...");
    await prisma.pointTransaction.deleteMany({});

    console.log("   - กำลังลบ AdminAuditLog...");
    await prisma.adminAuditLog.deleteMany({});

    // ลบ Legacy Logs (ถ้ามีใน Database)
    try { await prisma.customerLog.deleteMany({}); } catch (e) {}
    try { await prisma.adminLog.deleteMany({}); } catch (e) {}
    try { await prisma.systemLog.deleteMany({}); } catch (e) {}

    // 2. ลบข้อมูลลูกค้า (Customer)
    console.log("   - กำลังลบ Customer...");
    await prisma.customer.deleteMany({});

    console.log("\n✅ ล้างข้อมูลเสร็จสิ้น!");
    console.log("   ข้อมูลในตาราง Admin, SystemConfig, Reward, Campaign ยังอยู่ครบถ้วนครับ");
}

main()
    .catch(e => console.error(e))
    .finally(async () => await prisma.$disconnect());