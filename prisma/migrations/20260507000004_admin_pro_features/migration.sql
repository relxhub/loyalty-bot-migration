-- Order: time-to-bill metrics
ALTER TABLE "Order" ADD COLUMN "assignedAt" TIMESTAMP(3);
ALTER TABLE "Order" ADD COLUMN "firstBillAt" TIMESTAMP(3);
ALTER TABLE "Order" ADD COLUMN "billAttempts" INTEGER NOT NULL DEFAULT 0;

-- Customer: admin profile + birthday
ALTER TABLE "Customer" ADD COLUMN "adminNote" TEXT;
ALTER TABLE "Customer" ADD COLUMN "birthDate" TIMESTAMP(3);

-- BillAttempt: audit ทุกครั้งที่ใส่บิล
CREATE TABLE "BillAttempt" (
    "id" SERIAL NOT NULL,
    "orderId" TEXT NOT NULL,
    "adminId" TEXT NOT NULL,
    "billNumber" TEXT NOT NULL,
    "billLength" INTEGER NOT NULL,
    "attemptNo" INTEGER NOT NULL,
    "suspicious" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BillAttempt_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "BillAttempt_orderId_idx" ON "BillAttempt"("orderId");
CREATE INDEX "BillAttempt_adminId_createdAt_idx" ON "BillAttempt"("adminId", "createdAt");

-- Wishlist
CREATE TABLE "Wishlist" (
    "id" SERIAL NOT NULL,
    "customerId" TEXT NOT NULL,
    "productId" INTEGER NOT NULL,
    "notifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Wishlist_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Wishlist_customerId_productId_key" ON "Wishlist"("customerId", "productId");
CREATE INDEX "Wishlist_productId_idx" ON "Wishlist"("productId");
