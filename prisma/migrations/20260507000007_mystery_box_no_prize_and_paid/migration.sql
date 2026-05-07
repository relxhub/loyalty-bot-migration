-- MysteryBoxPrize: เพิ่ม flag สำหรับ "ช่องโชคไม่ดี" (ไม่ได้รับรางวัล)
ALTER TABLE "MysteryBoxPrize" ADD COLUMN "isNoPrize" BOOLEAN NOT NULL DEFAULT false;

-- MysteryBox: เพิ่มราคาเป็นแต้มสำหรับเปิดกล่องด้วยแต้ม (null = ไม่เปิดให้ซื้อด้วยแต้ม)
ALTER TABLE "MysteryBox" ADD COLUMN "pointCost" INTEGER;
