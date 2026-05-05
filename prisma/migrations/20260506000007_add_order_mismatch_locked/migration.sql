-- Add Order.mismatchLocked flag for under-paid slip flow
-- Additive only. No existing column or constraint touched.

ALTER TABLE "Order"
    ADD COLUMN "mismatchLocked" BOOLEAN NOT NULL DEFAULT false;
