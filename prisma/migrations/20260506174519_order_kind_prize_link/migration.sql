-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'PRODUCT';

-- AlterTable
ALTER TABLE "PrizeShipment" ADD COLUMN     "orderId" TEXT;

-- CreateIndex
CREATE INDEX "Order_kind_idx" ON "Order"("kind");

-- CreateIndex
CREATE UNIQUE INDEX "PrizeShipment_orderId_key" ON "PrizeShipment"("orderId");

-- AddForeignKey
ALTER TABLE "PrizeShipment" ADD CONSTRAINT "PrizeShipment_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;
