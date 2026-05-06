-- CreateEnum
CREATE TYPE "MysteryBoxTrigger" AS ENUM ('REFEREE_FIRST_PURCHASE', 'JOIN_CHANNEL', 'ADMIN_GRANT', 'PURCHASE_MILESTONE', 'REVIEW_PRODUCT');

-- AlterTable
ALTER TABLE "Coupon" DROP COLUMN "isMysteryBox";

-- AlterTable
ALTER TABLE "CustomerCoupon" DROP COLUMN "isMysteryBoxLocked";

-- CreateTable
CREATE TABLE "MysteryBox" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameEn" TEXT,
    "description" TEXT,
    "descriptionEn" TEXT,
    "imageUrl" TEXT,
    "trigger" "MysteryBoxTrigger" NOT NULL,
    "minPurchaseAmount" DECIMAL(10,2),
    "maxPurchaseAmount" DECIMAL(10,2),
    "ticketsPerEvent" INTEGER NOT NULL DEFAULT 1,
    "maxPerUser" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "startDate" TIMESTAMP(3),
    "endDate" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MysteryBox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MysteryBoxPrize" (
    "id" SERIAL NOT NULL,
    "mysteryBoxId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameEn" TEXT,
    "description" TEXT,
    "descriptionEn" TEXT,
    "imageUrl" TEXT,
    "weight" INTEGER NOT NULL DEFAULT 1,
    "rewardCouponId" TEXT,
    "isPhysicalReward" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MysteryBoxPrize_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MysteryBoxTicket" (
    "id" SERIAL NOT NULL,
    "customerId" TEXT NOT NULL,
    "mysteryBoxId" TEXT NOT NULL,
    "sourceEvent" TEXT,
    "sourceReferralId" INTEGER,
    "sourceMetadata" TEXT,
    "status" TEXT NOT NULL DEFAULT 'UNOPENED',
    "openedAt" TIMESTAMP(3),
    "awardedPrizeId" INTEGER,
    "awardedCustomerCouponId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MysteryBoxTicket_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MysteryBox_trigger_isActive_idx" ON "MysteryBox"("trigger", "isActive");

-- CreateIndex
CREATE INDEX "MysteryBoxPrize_mysteryBoxId_idx" ON "MysteryBoxPrize"("mysteryBoxId");

-- CreateIndex
CREATE INDEX "MysteryBoxTicket_customerId_status_idx" ON "MysteryBoxTicket"("customerId", "status");

-- CreateIndex
CREATE INDEX "MysteryBoxTicket_customerId_mysteryBoxId_idx" ON "MysteryBoxTicket"("customerId", "mysteryBoxId");

-- CreateIndex
CREATE INDEX "MysteryBoxTicket_mysteryBoxId_sourceReferralId_idx" ON "MysteryBoxTicket"("mysteryBoxId", "sourceReferralId");

-- AddForeignKey
ALTER TABLE "MysteryBoxPrize" ADD CONSTRAINT "MysteryBoxPrize_mysteryBoxId_fkey" FOREIGN KEY ("mysteryBoxId") REFERENCES "MysteryBox"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MysteryBoxTicket" ADD CONSTRAINT "MysteryBoxTicket_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("customerId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MysteryBoxTicket" ADD CONSTRAINT "MysteryBoxTicket_mysteryBoxId_fkey" FOREIGN KEY ("mysteryBoxId") REFERENCES "MysteryBox"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MysteryBoxTicket" ADD CONSTRAINT "MysteryBoxTicket_awardedPrizeId_fkey" FOREIGN KEY ("awardedPrizeId") REFERENCES "MysteryBoxPrize"("id") ON DELETE SET NULL ON UPDATE CASCADE;
