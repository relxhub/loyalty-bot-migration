-- AlterTable
ALTER TABLE "Order" ADD COLUMN "assignedAdminId" TEXT;
CREATE INDEX "Order_assignedAdminId_idx" ON "Order"("assignedAdminId");
