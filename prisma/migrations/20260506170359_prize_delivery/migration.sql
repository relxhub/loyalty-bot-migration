-- AlterTable
ALTER TABLE "MysteryBoxTicket" ADD COLUMN     "adminNote" TEXT,
ADD COLUMN     "deliveredAt" TIMESTAMP(3),
ADD COLUMN     "deliveryRequestedAt" TIMESTAMP(3),
ADD COLUMN     "deliveryShipmentId" INTEGER,
ADD COLUMN     "deliveryStatus" TEXT DEFAULT 'OWNED',
ADD COLUMN     "shippedAt" TIMESTAMP(3),
ADD COLUMN     "shippingAddressId" INTEGER,
ADD COLUMN     "shippingFeeSnapshot" DECIMAL(10,2),
ADD COLUMN     "trackingNumber" TEXT;

-- CreateTable
CREATE TABLE "PrizeShipment" (
    "id" SERIAL NOT NULL,
    "customerId" TEXT NOT NULL,
    "shippingAddressId" INTEGER NOT NULL,
    "shippingFeeSnapshot" DECIMAL(10,2) NOT NULL,
    "customerNote" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "trackingNumber" TEXT,
    "shippedAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "adminNote" TEXT,
    "adminGroupMsgId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PrizeShipment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PrizeShipment_customerId_status_idx" ON "PrizeShipment"("customerId", "status");

-- CreateIndex
CREATE INDEX "PrizeShipment_status_createdAt_idx" ON "PrizeShipment"("status", "createdAt");

-- CreateIndex
CREATE INDEX "MysteryBoxTicket_customerId_deliveryStatus_idx" ON "MysteryBoxTicket"("customerId", "deliveryStatus");

-- CreateIndex
CREATE INDEX "MysteryBoxTicket_deliveryShipmentId_idx" ON "MysteryBoxTicket"("deliveryShipmentId");

-- AddForeignKey
ALTER TABLE "MysteryBoxTicket" ADD CONSTRAINT "MysteryBoxTicket_deliveryShipmentId_fkey" FOREIGN KEY ("deliveryShipmentId") REFERENCES "PrizeShipment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
