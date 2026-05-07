-- =============================================================
-- Stock Reservation feature (Phase 3 — schema + config defaults)
-- =============================================================

-- Product: column ใหม่สำหรับจำนวนที่ถูก "จองไว้" (Order PENDING_PAYMENT)
-- Available = stockQuantity - reservedQuantity
ALTER TABLE "Product" ADD COLUMN "reservedQuantity" INTEGER NOT NULL DEFAULT 0;

-- Order: snapshot ของ expiry window (นาที) ตอน checkout
-- null สำหรับออเดอร์เก่าก่อน migration → expiry job fallback ใช้ StoreSetting.orderExpiryMinutes
ALTER TABLE "Order" ADD COLUMN "expiryMinutes" INTEGER;

-- =============================================================
-- Default values สำหรับ SystemConfig (idempotent — ON CONFLICT DO NOTHING)
-- ค่าทั้งหมดสามารถปรับได้ใน admin console → System Config
-- =============================================================

-- D1: Cart limits
INSERT INTO "SystemConfig" (key, value) VALUES
    ('checkout_max_qty_per_item', '10'),
    ('checkout_max_total_items', '50'),
    ('checkout_max_distinct_skus', '15')
ON CONFLICT (key) DO NOTHING;

-- D2: Active reservation per user (1 = single active order at a time)
INSERT INTO "SystemConfig" (key, value) VALUES
    ('checkout_max_active_reservations', '1')
ON CONFLICT (key) DO NOTHING;

-- D3: Velocity limit (orders per hour per user)
INSERT INTO "SystemConfig" (key, value) VALUES
    ('checkout_velocity_max_per_hour', '5'),
    ('checkout_velocity_window_seconds', '3600')
ON CONFLICT (key) DO NOTHING;

-- D4: Reserve ratio (per-user max + global alert threshold)
INSERT INTO "SystemConfig" (key, value) VALUES
    ('checkout_reserve_max_per_user_pct', '0.5'),
    ('checkout_reserve_global_alert_pct', '0.8')
ON CONFLICT (key) DO NOTHING;

-- D5: Adaptive expiry window (นาที) ตาม customer tier
INSERT INTO "SystemConfig" (key, value) VALUES
    ('expiry_minutes_new', '10'),
    ('expiry_minutes_regular', '15'),
    ('expiry_minutes_vip', '30'),
    ('expiry_minutes_abuser', '5'),
    ('checkout_new_threshold_orders', '1'),
    ('checkout_vip_threshold_orders', '5'),
    ('checkout_abuser_threshold_cancellations', '3')
ON CONFLICT (key) DO NOTHING;

-- =============================================================
-- ROLLBACK (run manually ถ้าต้อง revert)
-- =============================================================
-- ALTER TABLE "Product" DROP COLUMN "reservedQuantity";
-- ALTER TABLE "Order" DROP COLUMN "expiryMinutes";
-- DELETE FROM "SystemConfig" WHERE key IN (
--     'checkout_max_qty_per_item',
--     'checkout_max_total_items',
--     'checkout_max_distinct_skus',
--     'checkout_max_active_reservations',
--     'checkout_velocity_max_per_hour',
--     'checkout_velocity_window_seconds',
--     'checkout_reserve_max_per_user_pct',
--     'checkout_reserve_global_alert_pct',
--     'expiry_minutes_new',
--     'expiry_minutes_regular',
--     'expiry_minutes_vip',
--     'expiry_minutes_abuser',
--     'checkout_new_threshold_orders',
--     'checkout_vip_threshold_orders',
--     'checkout_abuser_threshold_cancellations'
-- );
