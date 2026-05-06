-- CreateEnum
CREATE TYPE "RewardTrigger" AS ENUM ('REFEREE_FIRST_PURCHASE');

-- CreateEnum
CREATE TYPE "RewardRecipient" AS ENUM ('REFERRER', 'REFEREE', 'BOTH');

-- DropForeignKey
ALTER TABLE "CustomerCoupon" DROP CONSTRAINT "CustomerCoupon_couponId_fkey";

-- AlterTable
ALTER TABLE "Coupon" ADD COLUMN     "rewardMaxAmount" DECIMAL(10,2),
ADD COLUMN     "rewardMinAmount" DECIMAL(10,2),
ADD COLUMN     "rewardOncePerReferral" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "rewardRecipient" "RewardRecipient",
ADD COLUMN     "rewardTrigger" "RewardTrigger";

-- AlterTable
ALTER TABLE "CustomerCoupon" ADD COLUMN     "sourceEvent" TEXT,
ADD COLUMN     "sourceReferralId" INTEGER;

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "shippingFee" DECIMAL(10,2),
ADD COLUMN     "subtotal" DECIMAL(10,2);

-- CreateTable
CREATE TABLE "AdminMessage" (
    "id" SERIAL NOT NULL,
    "orderId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "messageId" INTEGER NOT NULL,
    "hasPhoto" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AdminMessage_orderId_kind_idx" ON "AdminMessage"("orderId", "kind");

-- CreateIndex
CREATE INDEX "AdminMessage_orderId_idx" ON "AdminMessage"("orderId");

-- CreateIndex
CREATE INDEX "CustomerCoupon_sourceReferralId_idx" ON "CustomerCoupon"("sourceReferralId");

-- AddForeignKey
ALTER TABLE "CustomerCoupon" ADD CONSTRAINT "CustomerCoupon_couponId_fkey" FOREIGN KEY ("couponId") REFERENCES "Coupon"("id") ON DELETE CASCADE ON UPDATE CASCADE;
