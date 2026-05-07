# Stock Reservation — Manual Test Plan

Checklist สำหรับทดสอบบน staging (หรือ production ในช่วงเงียบ) — verify ระบบ
Stock Reservation + Anti-Abuse defenses ทำงานถูกต้อง

## ก่อนเริ่ม

1. ตรวจว่า Railway deploy commit `c41b27b` (Phase 4) ขึ้นแล้ว
2. เตรียม:
   - **3 บัญชี Telegram** สำหรับเทส (A=ลูกค้าใหม่, B=ลูกค้าเดิม, C=admin)
   - **1 SKU stock น้อยๆ** สำหรับเทส race (เซ็ต stock = 5 ใน admin)
   - เปิด admin → System Config — ตรวจว่ามี 15 keys ใหม่
3. ค่า config ที่แนะนำสำหรับเทส:
   - `expiry_minutes_new` = 3 (ลดลงให้เทสเร็ว)
   - `expiry_minutes_regular` = 5
   - `expiry_minutes_abuser` = 2
   - ค่าอื่นๆ ใช้ default

---

## ✅ Section A — Legitimate flow (ลูกค้าจริง)

### A1. ออเดอร์ปกติของลูกค้าทั่วไป

**Steps:**
1. บัญชี B (ลูกค้าเดิมที่เคยซื้อ ≥ 1 ครั้ง) → เปิด mini app
2. เพิ่มสินค้า 2 SKU × 2 ชิ้น
3. กด checkout → ตรวจที่ admin order list

**Expected:**
- Order ถูกสร้าง status=PENDING_PAYMENT
- ไปที่ admin → เปิดออเดอร์ → ดู `Order.expiryMinutes` (จะเห็นใน DB หรือ admin page)
  - ลูกค้า regular: ควรเป็น 15 หรือค่าที่ตั้ง
- เปิด admin → Stock Alert / Products — สต็อกของ SKU นั้น `available` ควรลดไป 4 ชิ้น
  (ในขณะที่ `stockQuantity` คงเดิม) — `📦 reserved: 4` แสดงใน UI

### A2. ลูกค้าใหม่ได้ window สั้น

**Steps:**
1. บัญชี A (ลูกค้าใหม่ ยังไม่เคยซื้อสำเร็จ) → checkout

**Expected:**
- `Order.expiryMinutes` ในออเดอร์ที่สร้าง = ค่า `expiry_minutes_new` (default 10, แต่
  ตั้งไว้ 3 ในเทส)
- รออีก 3+ นาที ไม่จ่าย → expiry job ยกเลิกออเดอร์อัตโนมัติ + คืน reservation
- กลับไปดู Stock Alert — `reserved` กลับลดลง 0

### A3. Customer cancel

**Steps:**
1. ลูกค้าสร้างออเดอร์ใหม่ที่ยังไม่จ่าย
2. ลูกค้ากด "ยกเลิกออเดอร์" ใน mini app

**Expected:**
- Order status = CANCELLED
- Stock `available` กลับเป็นค่าเดิม (เลิก reserve)
- ลูกค้าสามารถสร้างออเดอร์ใหม่ได้ทันที (ไม่ติด D2)

### A4. ออเดอร์จ่ายสำเร็จ

**Steps:**
1. ลูกค้าสร้างออเดอร์ + อัปสลิปยอดตรง

**Expected:**
- Order status = PAID
- ดู Product ใน admin: `stockQuantity` ลดลงจริง, `reservedQuantity` กลับเป็นค่าเดิม
  (reservation ถูก convert เป็น hard decrement)

---

## 🔒 Section B — Anti-abuse scenarios

### B1. D1 — qty per item cap

**Steps:**
1. ลูกค้าใส่ของลงตะกร้าจำนวน > `checkout_max_qty_per_item` (default 10)
2. กด checkout

**Expected:**
- Server reject 400: "สินค้าตัวเดียวกันสั่งได้ไม่เกิน 10 ชิ้นต่อออเดอร์"
- (ถ้า frontend จำกัดที่ +/- ปุ่มไว้แล้ว อาจไม่สามารถใส่เกินได้ — ทดสอบโดยใช้ DevTools
   แก้ค่าใน localStorage หรือ POST ตรงไป /api/orders/checkout ด้วย Postman)

### B2. D2 — block when has mismatch reservation

**Steps:**
1. ลูกค้า A สร้างออเดอร์ → อัปสลิปยอดน้อยกว่ายอดจริง → mismatchLocked
2. ลูกค้า A พยายามสร้างออเดอร์ใหม่

**Expected:**
- Server reject 409: "คุณมีออเดอร์ที่รอแอดมินดำเนินการอยู่ (#ORD-...) กรุณาแชทแอดมิน"

### B3. D2 — auto-cancel when has non-mismatch active

**Steps:**
1. ลูกค้า A สร้างออเดอร์ #1 (PENDING_PAYMENT, ยังไม่อัปสลิป)
2. ลูกค้า A สร้างออเดอร์ #2 ทันที

**Expected:**
- ออเดอร์ #1 ถูก auto-cancel (status=CANCELLED, reservation released)
- Audit log ของ #1 มีบันทึก "ยกเลิกอัตโนมัติเพราะลูกค้าสร้างออเดอร์ใหม่"
- ออเดอร์ #2 ถูกสร้างปกติ
- Stock balance ถูกต้อง (ไม่ double-reserve)

### B4. D3 — velocity rate-limit

**Steps:**
1. ลูกค้า A สร้างออเดอร์ × 5 ครั้งติดกัน (จะ trigger D2 auto-cancel ทุกครั้ง)
2. ครั้งที่ 6 ภายใน 1 ชม.

**Expected:**
- Server reject 429: "สร้างออเดอร์เกิน 5 ครั้งในช่วง 60 นาที กรุณารอสักครู่"
- AdminAuditLog มี action `CHECKOUT_VELOCITY_BLOCK`

### B5. D4 — per-user ratio cap

**Steps:**
1. ตั้ง stock ของ SKU = 10
2. ลูกค้า A พยายาม checkout 6 ชิ้นของ SKU นั้น (50% × 10 = 5 → 6 > 5)

**Expected:**
- Server reject 409: 'สินค้า "..." คุณจองได้ไม่เกิน 5 ชิ้นจากสต็อกที่มี'
- Stock ไม่ถูกแตะ

### B6. D5 — abuser tier shorter window

**Steps:**
1. ลูกค้า A สร้าง+ยกเลิกออเดอร์ติดกัน 3 ครั้งในช่วง 24 ชม. (จงใจ abuse)
2. สร้างออเดอร์ครั้งที่ 4

**Expected:**
- Order ที่ 4 มี `expiryMinutes` = ค่า `expiry_minutes_abuser` (default 5, ตั้งเทส 2)
- รอ 2+ นาที ไม่จ่าย → auto-cancel เร็วกว่าปกติ

---

## ⚠️ Section C — Edge cases

### C1. mismatchLocked — admin reject path

**Steps:**
1. ลูกค้า A สร้างออเดอร์ + อัปสลิปยอดน้อย → mismatchLocked
2. ดู Stock Alert: `available` ลดลง (เพราะ stock ถูก decrement) แต่ `reserved` = 0
3. Admin กด "ปฏิเสธ + ยกเลิก" ใน admin app

**Expected:**
- Order status=CANCELLED
- Stock `stockQuantity` กลับเพิ่มขึ้น (revert)
- `reservedQuantity` ยังเป็น 0 (ไม่กระทบ)
- ถ้าลูกค้าใช้ coupon → status กลับเป็น AVAILABLE

### C2. mismatchLocked — admin approve (top-up)

**Steps:**
1. mismatchLocked order
2. Admin รับ top-up จากลูกค้า → กด "อนุมัติสลิป (รับยอดเต็ม)"

**Expected:**
- Order → PAID
- Stock + reserved คงเดิม (ของถูก decrement ตั้งแต่ตอน mismatch แล้ว)
- ไม่มี double-decrement

### C3. Admin remove item ระหว่าง PENDING_PAYMENT non-mismatch

**Steps:**
1. ลูกค้าสร้างออเดอร์ qty=3 ของ SKU X (status PENDING_PAYMENT, !mismatchLocked)
2. Admin กด ➖ (ลด 1) ใน admin order detail

**Expected:**
- OrderItem.quantity = 2
- Product `reservedQuantity` ลดลง 1 (เพราะ status=PENDING+!mismatch → release)
- `stockQuantity` ไม่เปลี่ยน

### C4. Admin remove item ระหว่าง PAID

**Steps:**
1. ลูกค้าจ่ายแล้ว → status=PAID, reserved=0, stock decremented
2. Admin กด × ลบรายการ

**Expected:**
- OrderItem ถูกลบ
- Product `stockQuantity` กลับเพิ่มขึ้น (revert)
- `reservedQuantity` ไม่กระทบ

### C5. Expiry job — old order ก่อน Phase 4 (expiryMinutes=null)

**Steps:**
1. หา order เก่าที่สร้างก่อน Phase 4 (expiryMinutes=null) ที่ยัง PENDING_PAYMENT — หรือ
   manual SET expiryMinutes=NULL ใน DB ของ order ใหม่
2. รอ expiry job รัน (default ทุก N นาที)

**Expected:**
- Order ถูกยกเลิกเมื่อ createdAt + StoreSetting.orderExpiryMinutes (default 30) < now
- Reservation released

### C6. Stock concurrent purchase race

**Steps:** (ใช้ Postman + 2 บัญชีพร้อมกัน)
1. SKU stock = 5
2. ลูกค้า A และ B ทั้งคู่กด checkout 5 ชิ้นของ SKU นี้พร้อมกัน

**Expected:**
- ลูกค้าที่ DB UPDATE สำเร็จก่อน → ได้ order
- อีกคน → 409 INSUFFICIENT_STOCK
- ไม่มี oversold (รวม reserved ≤ 5)

### C7. Admin grants stock เพิ่มระหว่างมี reservation อยู่

**Steps:**
1. SKU stock=5, มี order pending reserve 5 ชิ้น (`available=0`)
2. Admin ใช้ bulk-stock add +10 → stock=15
3. ลูกค้าใหม่ checkout 5 ชิ้น

**Expected:**
- ลูกค้าใหม่ได้ตามจริง (available = 15-5 = 10 → reserve 5 ผ่าน)

---

## 🛠 Section D — System Config sanity

### D1. ปรับ config แล้วมีผลทันที

**Steps:**
1. ใน admin → System Config → ปรับ `checkout_max_qty_per_item` = 3
2. กดบันทึก
3. ลูกค้า checkout qty=5

**Expected:**
- alert "✅ บันทึก ... รายการ — มีผลทันที (hot-reload)"
- ลูกค้าโดน reject 400: "สินค้าตัวเดียวกันสั่งได้ไม่เกิน 3 ชิ้น"

(หมายเหตุ: hot-reload ทำงานเฉพาะถ้า `loadConfig()` ถูกเรียกใหม่หลังบันทึก — ถ้าไม่ได้ผลทันที
 ต้อง restart Railway service)

### D2. ค่า threshold edge

**Steps:**
1. ตั้ง `checkout_new_threshold_orders` = 3, `checkout_vip_threshold_orders` = 3
2. ลูกค้าที่ paidCount = 3 → tier = ?

**Expected:**
- คาดหวัง VIP (เพราะ paidCount ≥ vipThreshold มาก่อน — ใน code path สำคัญสุด)
- ตรวจ `Order.expiryMinutes` ใน order ที่สร้าง

---

## รายงานหลังเทส

| Section | ทดสอบ | Expected | Actual | สถานะ |
|---|---|---|---|---|
| A1 | Regular order | 15 min expiry | | ⬜️ |
| A2 | New customer | 3 min expiry | | ⬜️ |
| A3 | Customer cancel | release reservation | | ⬜️ |
| A4 | Paid order | stock-- + reserved-- | | ⬜️ |
| B1 | qty cap | 400 reject | | ⬜️ |
| B2 | mismatch block | 409 reject | | ⬜️ |
| B3 | auto-cancel old | #1 cancelled | | ⬜️ |
| B4 | velocity | 429 + audit log | | ⬜️ |
| B5 | ratio cap | 409 reject | | ⬜️ |
| B6 | abuser tier | 2 min expiry | | ⬜️ |
| C1 | reject mismatch | stock revert | | ⬜️ |
| C2 | approve mismatch | no double-dec | | ⬜️ |
| C3 | admin remove pending | reserved-- | | ⬜️ |
| C4 | admin remove paid | stock++ | | ⬜️ |
| C5 | old order expiry | fallback 30 min | | ⬜️ |
| C6 | concurrent race | no oversold | | ⬜️ |
| C7 | admin grants mid-reserve | new order ผ่าน | | ⬜️ |
| D1 | config hot-reload | reject ใหม่ | | ⬜️ |
| D2 | threshold edge | VIP win | | ⬜️ |

ถ้า case ไหน fail → ส่ง Railway log + screenshot ให้ Claude เพื่อ debug ต่อ
