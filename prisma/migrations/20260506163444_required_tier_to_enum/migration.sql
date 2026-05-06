-- CreateEnum
CREATE TYPE "MysteryBoxRequiredTier" AS ENUM ('NONE', 'SILVER', 'GOLD');

-- AlterTable
ALTER TABLE "MysteryBox" DROP COLUMN "requiredTierMin",
ADD COLUMN     "requiredTier" "MysteryBoxRequiredTier" NOT NULL DEFAULT 'NONE';
