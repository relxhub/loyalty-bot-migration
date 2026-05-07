# Stock Reservation — Plan

ออกแบบและ implement stock reservation ตอน checkout เพื่อกัน oversold ระหว่างที่
ลูกค้ากำลังจ่ายเงิน + กัน abuse จาก malicious lock

---

## Phase 1 — Analysis ของระบบปัจจุบัน

### 1. จุดที่ stock ถูก mutate (decrement / increment)

| # | Path:Line | ที่เกิด | direction | trigger |
|---|---|---|---|---|
| A | `api.routes.js:432` (POST `/orders/checkout`) | สร้าง Order | **(ไม่แตะ stock)** | ลูกค้ากด checkout |
| B | `api.routes.js:1071-1075` (POST `/orders/:orderId/verify-slip` mismatch path) | mismatch under-paid → mismatchLocked=true | `decrement` | สลิปยอดน้อยกว่า total |
| C | `api.routes.js:1229-1231` (POST `/orders/:orderId/verify-slip` success path) | order PAID | `decrement` | สลิปยอดตรง / over-paid |
| D | `api.routes.js:3597` (POST `/admin/orders/:id/reject`) | admin ปฏิเสธ mismatch order | `increment` (ถ้า wasLocked) | revert stock + revert coupon |
| E | `api.routes.js:3838` (DELETE `/admin/orders/:id/items/:itemId`) | admin ลด/ลบ item | `increment` (เฉพาะส่วนที่ลด) | admin แก้ออเดอร์ |
| F | `api.routes.js:3981` (POST `/admin/orders/:id/cancel`) | admin ยกเลิกออเดอร์ PAID/PROCESSING | `increment` | admin cancel |
| G | `expiry.job.js:204-207` (`runOrderExpiryJob`) | ออเดอร์หมดเวลาชำระ | **(ไม่แตะ stock)** | cron ทุกๆ N นาที |
| H | `api.routes.js:724-727` (POST `/orders/:orderId/cancel` ลูกค้ากด) | ลูกค้ากดยกเลิกเอง | **(ไม่แตะ stock)** | ลูกค้ากด ใน mini app |

**สรุป:** stock ถูก decrement เฉพาะตอน paid (C) หรือ mismatchLocked (B) → ก่อน
หน้านั้นใครก็ซื้อตัดหน้าได้

### 2. Order status state machine (จริง)

```
                                  ┌─→ PAID ──→ PROCESSING ──→ SHIPPED
                                  │     │            │
                                  │     │            └─→ CANCELLED (admin cancel: stock++)
              ┌─→ PAID            │     └────────────────→ CANCELLED (admin cancel: stock++)
              │
PENDING_PAYMENT
              │   ↓ verify-slip (under-paid)
              │   mismatchLocked=true (status ยัง PENDING_PAYMENT)
              │   stock-- + coupon USE  ← (B)
              │   ─→ admin /reject → CANCELLED (stock++ revert)  ← (D)
              │   ─→ admin top-up → /approve → PAID
              │
              ├─→ CANCELLED (customer cancel: ไม่แตะ stock)  ← (H)
              ├─→ CANCELLED (expiry-job: ไม่แตะ stock)  ← (G)
              └─→ CANCELLED (admin remove all items: stock++ revert)  ← (E)
```

### 3. `mismatchLocked` ส่งผลต่อ stock อย่างไร

- ตั้ง `true` เมื่อสลิปยอดน้อยกว่า order.totalAmount → **stock decrement ทันที** + coupon ถูก mark USED + Payment row PENDING
- Order status ยังคงเป็น `PENDING_PAYMENT` แต่หลุด normal flow:
  - `expiry.job.js:192` skip orders ที่ `mismatchLocked: true` → ไม่ auto-cancel
  - `verify-slip:826-833` block re-upload → admin ต้องดำเนินการแทน
- ออกจาก lock ได้ 2 ทาง:
  - admin `/approve` (top-up) → status = PAID
  - admin `/reject` → status = CANCELLED + revert stock + revert coupon (D)

### 4. ถ้าจะเพิ่ม "reserved" state — กระทบโค้ดที่ไหน

**Schema:**
- `Product.reservedQuantity Int @default(0)` — เพิ่ม column ใหม่

**Code paths ที่ต้องแก้ (เรียงตาม flow):**

| # | Path:Line | เปลี่ยน | เหตุผล |
|---|---|---|---|
| 1 | `api.routes.js:432` (checkout tx) | `+= reserve qty` | ตั้ง reservation ตอนสร้าง Order |
| 2 | `api.routes.js:1071-1075` (mismatch path) | `stock--, reserved--` (atomic) | reservation กลายเป็น hard decrement |
| 3 | `api.routes.js:1229-1231` (paid path) | `stock--, reserved--` (atomic) | reservation กลายเป็น hard decrement |
| 4 | `api.routes.js:3597` (admin reject) | `stock++, reserved++? no` | wasLocked แล้ว reserved=0 อยู่แล้ว — แค่ increment stock เหมือนเดิม |
| 5 | `api.routes.js:3838` (admin remove item) | ต้องเช็ค status: ถ้ายัง PENDING → `reserved--` ถ้า PAID → `stock++` | depend on order.status |
| 6 | `api.routes.js:3981` (admin cancel) | เหมือนเดิม + ถ้า status='PENDING_PAYMENT' && !mismatchLocked → `reserved--` แทน `stock++` | |
| 7 | `api.routes.js:724-727` (customer cancel) | เพิ่ม `reserved--` | reservation ถูก release |
| 8 | `expiry.job.js:204-207` (auto-cancel) | เพิ่ม `reserved--` ใน loop | reservation ถูก release |
| 9 | `api.routes.js` product list endpoints (เช่น `/products/:id`, `/store-config`, GET admin product) | คืน `available = stockQuantity - reservedQuantity` | UI ลูกค้าเห็น available จริง |
| 10 | `api.routes.js` "low stock" admin pages | เพิ่ม column `reservedQuantity` | admin ติดตาม |

**Atomicity requirement:** ทุก mutation ของ `reservedQuantity` ต้องอยู่ใน Prisma `$transaction` คู่กับการแตะ Order — กัน race ที่ orders 2 ใบขอ reserve item เดียวกันชนกัน

### 5. ของที่มีอยู่แล้วและไม่ต้องสร้างใหม่

- `StoreSetting.orderExpiryMinutes` (default 30) — ใช้คุม expiry window อยู่แล้ว
- `SystemConfig` table — ใช้เก็บ tunable values ตามแบบที่ทำกับ tier multipliers
- `runOrderExpiryJob` cron — มีอยู่แล้ว แค่เพิ่ม reservation release ในนั้น
- `mismatchLocked` flag — ต้องระวังแต่ไม่ต้องสร้างใหม่ (ตรรกะ revert มีอยู่แล้ว)

---

## Phase 2 — Design Anti-Abuse

### Defense 1: จำกัดจำนวนต่อ checkout

| ค่า | เสนอ default | SystemConfig key | เหตุผล |
|---|---|---|---|
| `maxQuantityPerItem` | **10** | `checkout_max_qty_per_item` | ลูกค้าจริงซื้อหัว pod 10 ชิ้นต่อรสก็พอ |
| `maxTotalItemsInCart` | **50** | `checkout_max_total_items` | ขายส่งจริงน่าจะคุยกับ admin โดยตรง |
| `maxDistinctSkusPerOrder` | **15** | `checkout_max_distinct_skus` | กันลูกค้าใส่ทุก SKU ในร้าน |

**Trade-off:** ลูกค้าซื้อขายส่งจริงจะ hit limit — แก้โดยให้ admin ปรับ config ขึ้นได้
หรือลูกค้าทักแอดมิน

**Validation point:** server-side ที่ /orders/checkout (ก่อน tx) — return 400 +
explicit error message ที่บอกว่า limit ไหนเกิน

**ผลลัพธ์ที่คาดหวัง:** กัน case ที่ malicious user ใส่ 9999 ชิ้นใน cart เพื่อ
lock stock ทั้งร้าน

### Defense 2: จำกัด active reservation per user

**Policy:** 1 user มี active reservation ได้ **1 order** พร้อมกัน

**ถ้าลูกค้าสร้าง order ใหม่ขณะมี order เดิม PENDING_PAYMENT:**
- **Auto-cancel order เดิม** (better UX — ลูกค้าไม่งง ไม่ต้องไปกด cancel เอง)
- โน้ตใน admin notif ว่า "ออเดอร์เดิม #X ถูก auto-cancel เพราะลูกค้าสร้างใหม่"
- mismatchLocked order **ห้าม** auto-cancel — ต้อง block การสร้างใหม่ + แสดง error
  "คุณมีออเดอร์ที่รอแอดมินดำเนินการอยู่ กรุณาแชทแอดมิน"

**Trade-off:**
- Pro: ป้องกัน lock-multi attack (1 คนสร้าง 100 orders ค้างไว้)
- Con: ลูกค้าที่เปลี่ยนใจกลางทางจะหงุดหงิดถ้า auto-cancel เร็วเกินไป — แต่ trade
  ออเดอร์เดิมที่เพิ่งสร้างไม่ใช่ปัญหาใหญ่
- Con: ลูกค้าเปิด 2 อุปกรณ์พร้อมกันจะมี friction — รับได้เพราะ rare

### Defense 3: Velocity limit

**Policy:** สูงสุด **5 orders / hour / user**

**ถ้าเกิน:**
- 6th order: return 429 + log ไป `AdminAuditLog` (action=`CHECKOUT_VELOCITY_BLOCK`)
- ไม่ block permanent — แค่ rate-limit หน้าต่าง 1 ชม.
- หลังครบ 24 ชม. ที่ไม่มี order → ถือว่าโอเค

**SystemConfig keys:**
- `checkout_velocity_max_per_hour` (default 5)
- `checkout_velocity_window_seconds` (default 3600)

**Trade-off:**
- Pro: catch scripted abuse
- Con: ลูกค้าที่เคย abandon checkout 5 ครั้งใน 1 ชม. (เปลี่ยนของบ่อย) จะ hit
  limit — รับได้ เพราะ 5 attempts ใน 1 ชม. = ผิดปกติแน่
- Con: ระบบต้อง count orders ที่ status=ANY (รวม CANCELLED) ใน window —
  ใช้ index บน `(customerId, createdAt)` ที่มีอยู่แล้ว

### Defense 4: Reserve quantity vs Available stock ratio

**Per-user limit:**
- **1 user reserve ได้ ≤ 50% ของ stock ของ SKU นั้น**
- ถ้าเกิน → reject + error "จำนวนเกินกว่าที่มีให้เก็บไว้ได้"
- เช่น stock 10 ชิ้น → 1 user reserve ได้ ≤ 5 ชิ้น

**Global alert (ดีเฟอร์ได้):**
- ถ้า total reserved > 80% ของ stock → log ไป SystemLog level=WARN
- ไม่ block — แค่เตือน admin ดู
- ดีเฟอร์ทำใน Phase 6 ถ้าต้องการ

**Trade-off:**
- Pro: ป้องกันคนเดียวกวาดสต็อก
- Con: launch / flash sale (สินค้าหายาก) ลูกค้าจริงอาจ hit limit — ต้องใช้
  config override per-product (defer)
- Con: stock 1 ชิ้น → ratio 50% = 0.5 ปัดเป็น 0 → ใครก็ซื้อไม่ได้! ต้อง floor
  อย่างน้อย 1: `Math.max(1, Math.floor(stock × 0.5))`

**SystemConfig keys:**
- `checkout_reserve_max_per_user_pct` (default 0.5)
- `checkout_reserve_global_alert_pct` (default 0.8)

### Defense 5: Adaptive expiry window

**Tiers:** เลี่ยงผูกกับ Loyalty Tier ของ referral (config-driven, ซับซ้อน) → 
ใช้ "lifetime PAID order count" เป็นตัวชี้

| ประเภทลูกค้า | criteria | expiry minutes | SystemConfig key |
|---|---|---|---|
| **New** | PAID orders < 1 | **10** | `expiry_minutes_new` |
| **Regular** | 1 ≤ PAID orders < 5 | **15** (ลด default จาก 30) | `expiry_minutes_regular` |
| **VIP** | PAID orders ≥ 5 | **30** (เหมือน default เดิม) | `expiry_minutes_vip` |
| **Abuser** | cancelled orders ≥ 3 ใน 24 ชม. | **5** | `expiry_minutes_abuser` |

**Implementation:**
- `expiry.job.js` query orders ทุกๆ X นาที
- ตอน query ต้อง compute `effectiveExpiryMinutes` per-order (ลูก-up customer
  metrics ตอน checkout แล้วเก็บใน Order — หรือคำนวณตอน expiry job รัน)
- **Recommended:** เก็บใน Order (เช่น `Order.expiryMinutes Int?`) ตอน checkout
  → expiry job แค่เช็ค `createdAt + expiryMinutes` — ง่าย, deterministic

**ตัวเลข abuse counting:**
- Cancelled orders 24h: query `where customerId=X AND status='CANCELLED' AND
  createdAt > now-24h` → cache 5 นาที (ใน-memory) เพื่อกัน DB load

**Trade-off:**
- Pro: ลด window 30→15 นาทีได้สำหรับ regular (ลด abuse exposure 50%)
- Pro: ลูกค้าที่เคยซื้อเยอะยังได้ 30 นาที (UX ไม่กระทบ)
- Con: ตรรกะซับซ้อนขึ้น — ต้องเทสหลาย scenario
- Con: คุณภาพ "tier" ขึ้นกับ definition — ต้อง revisit หลังใช้จริง 1-2 เดือน

### Defense 6: Soft reservation (foundation field)

ตามที่ user เสนอใน prompt — **REQUIRED, ไม่ optional**:

```sql
ALTER TABLE "Product" ADD COLUMN "reservedQuantity" INTEGER NOT NULL DEFAULT 0;
```

**Invariants:**
- `0 ≤ reservedQuantity ≤ stockQuantity` (เสมอ)
- "Available" คำนวณ: `available = stockQuantity - reservedQuantity`
- ตอน checkout: `reservedQuantity++ × items.quantity`
- ตอน paid: `stockQuantity-- + reservedQuantity--` (atomic ใน tx เดียว)
- ตอน cancel/expire: `reservedQuantity--`

**Race condition guard:** ใช้ Prisma `update` กับ `where: { id: X, reservedQuantity: { lte: stockQuantity - reserveQty } }` — return 0 rows updated → reject; ใช้ raw SQL หรือ findUnique-then-update ถ้า Prisma ไม่ support เงื่อนไขนี้ตรงๆ (probably ใช้ `$queryRaw` สำหรับ atomic check-and-update)

**Trade-off:**
- Pro: **เป็น foundation** — defense อื่นๆ พึ่งพา field นี้
- Pro: separate concerns — `stockQuantity` = ของจริงในคลัง, `reservedQuantity` = ที่ถูกจองไว้
- Con: เพิ่ม state ที่ต้อง keep in sync — ทุก mutation point (10 ที่จากตาราง 4)
  ต้องอัพเดทถูกต้อง = บั๊กง่าย ถ้า miss สักจุด
- Con: ต้องเขียนเทสครอบคลุม — concurrency tests สำคัญที่สุด

---

## Recommendation: เปิด defense ตามลำดับ

1. **D6 (reservedQuantity field)** — REQUIRED, foundation
2. **D1 (qty limits)** — quick win, low risk, เปิดได้ทันที
3. **D5 simplified (2-tier: new=10min, regular=15min)** — biggest UX/abuse impact;
   skip VIP + abuser ทีหลังก็ได้
4. **D2 (1 active reservation/user, auto-cancel old)** — strong abuse prevention
5. **D3 (velocity 5/hour)** — defense in depth
6. **D4 (per-user 50% ratio)** — fine-grained, ปรับยากกว่า
7. **D4 global alert + D5 abuser/VIP tiers** — nice-to-have, ดีเฟอร์ Phase 6+

**Quick-launch combo (ครอบคลุม 80% ของ abuse pattern):** D6 + D1 + D5-simplified

**Full defense (เปิดทุกอันที่เสนอ):** D6 + D1-D5 ทั้งหมด

---

## ผลกระทบต่อ feature เดิม (ต้องระวัง)

| feature เดิม | กระทบ? | วิธีจัดการ |
|---|---|---|
| `mismatchLocked` flow | กระทบ — reserved ต้องถูก convert เป็น hard decrement พร้อมกับ stock-- | ใน mismatch path: `stock--, reserved--` atomic |
| `expiry.job.js` skip mismatchLocked | ไม่กระทบ logic แต่ต้องเพิ่ม `reserved--` ใน loop | เฉพาะ orders ที่ไม่ mismatchLocked เท่านั้น |
| Customer cancel flow | กระทบ — ต้อง release reservation | เพิ่ม `reserved--` |
| Admin reject flow (mismatch) | ไม่กระทบ — ตอนนี้ stock++ เพราะ wasLocked, reserved=0 อยู่แล้ว | คงเดิม |
| Admin cancel PAID/PROCESSING | ไม่กระทบ — reserved=0 ตอนถึงสถานะนั้น | คงเดิม |
| Admin remove/decrement item | ขึ้นกับ status: PENDING_PAYMENT → reserved--; PAID/PROCESSING → stock++ | branch on status |
| Coupon claim/redeem | ไม่กระทบ | — |
| Referral / Mystery box | ไม่กระทบ | — |
| Product list (UI) | กระทบ — ต้องคืน available แทน stock | เพิ่ม field `available` ใน response |

---

## คำถามที่ขออนุมัติก่อนเริ่ม Phase 3 (migration)

1. **Defense set:** เลือก quick-launch (D6+D1+D5simple) หรือ full (ทั้ง 5)?
2. **Limits:** เห็นด้วยกับตัวเลข default ที่เสนอไหม
   (max qty 10, total 50, velocity 5/hr, expiry 10/15/30 min)?
3. **D5 abuser tier:** เปิดเลย (เพิ่มซับซ้อน) หรือ defer?
4. **D4 global alert:** เปิดใน Phase 4 เลย หรือ defer Phase 6?
5. **Order.expiryMinutes field:** เพิ่มใน schema เลย (เก็บ snapshot ตอน checkout)
   หรือคำนวณ on-the-fly ใน expiry job (ประหยัด schema)?
