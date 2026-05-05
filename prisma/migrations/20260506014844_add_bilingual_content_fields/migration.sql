-- Bilingual content fields for Coupon + Product. Additive only (all nullable).
-- Display layer falls back to TH (existing fields) when EN is null.

ALTER TABLE "Coupon"
    ADD COLUMN "nameEn" TEXT,
    ADD COLUMN "descriptionEn" TEXT;

ALTER TABLE "Product"
    ADD COLUMN "taglineEn" TEXT,
    ADD COLUMN "descriptionEn" TEXT;
