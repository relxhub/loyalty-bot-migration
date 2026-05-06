-- AlterTable
ALTER TABLE "Coupon" ADD COLUMN     "isMysteryBox" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "CustomerCoupon" ADD COLUMN     "isMysteryBoxLocked" BOOLEAN NOT NULL DEFAULT false;
