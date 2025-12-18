-- AlterTable
ALTER TABLE "Category" ADD COLUMN     "imageUrl" TEXT;

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "coolnessLevel" INTEGER DEFAULT 0,
ADD COLUMN     "flavorIconUrl" TEXT,
ADD COLUMN     "flavorIntensityLevel" INTEGER DEFAULT 0,
ADD COLUMN     "sweetnessLevel" INTEGER DEFAULT 0;

-- CreateTable
CREATE TABLE "Banner" (
    "id" SERIAL NOT NULL,
    "imageUrl" TEXT NOT NULL,
    "linkUrl" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Banner_pkey" PRIMARY KEY ("id")
);
