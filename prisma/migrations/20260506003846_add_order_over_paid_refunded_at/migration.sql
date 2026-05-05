-- Track admin-confirmed over-paid refund timestamp.
-- Additive only.

ALTER TABLE "Order"
    ADD COLUMN "overPaidRefundedAt" TIMESTAMP(3);
