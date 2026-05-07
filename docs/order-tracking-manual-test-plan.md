# Order Tracking — Manual Test Plan (Phase 5)

Checklist สำหรับเทสบน staging/production หลัง Railway deploy commit ที่ ship feature นี้

## เตรียม
1. Deploy commit แล้ว — เปิด Telegram Mini App (ทั้งบัญชีลูกค้าใหม่และเก่า)
2. เตรียม:
   - 1 ลูกค้าที่มีหลาย order หลาย status (pending / paid / processing / shipped / cancelled / mismatchLocked)
   - 1 ลูกค้าใหม่ที่ยังไม่มี order
   - Admin app เปิดอีกหน้าต่างพร้อม update order

---

## ✅ Section A — ฟังก์ชันหลัก (V1 must-pass)

### A1. เปิดหน้า orders.html
- [ ] เห็น header "ออเดอร์ของฉัน" + icon truck
- [ ] เห็น lang switcher มุมซ้ายบน
- [ ] Loading skeleton 3 cards แสดงก่อน data โหลด (ไม่ใช่ spinner)
- [ ] Bottom nav 5 ปุ่ม — "ออเดอร์" active (text-white + truck-fill icon)

### A2. Filter tabs
- [ ] เห็น 4 tabs: ทั้งหมด / รอชำระ / กำลังจัดส่ง / ยกเลิก
- [ ] Tab "ทั้งหมด" active by default (gradient orange)
- [ ] Count badges ตรงกับจำนวนจริง
- [ ] กด tab → list filter ทันที + haptic feedback selection
- [ ] Tab counts > 99 แสดง "99+"

### A3. Card รายการ
- [ ] แต่ละ card แสดง: order id, date relative, status pill (สีตาม status), preview รูป 3 ชิ้นแรก, +N ชิ้น, ยอดรวม gradient
- [ ] PRZ orders มี badge "PRZ" สีม่วง
- [ ] mismatchLocked แสดง pill สีม่วง "รอตรวจสลิป"
- [ ] PENDING_PAYMENT non-mismatch → ปุ่ม "ชำระเงิน" gradient orange
- [ ] mismatchLocked → ปุ่ม "ทักแอดมิน" สีม่วง
- [ ] SHIPPED + มี trackingNumber → ปุ่ม "ติดตามพัสดุ" gradient orange
- [ ] PAID/PROCESSING → ไม่มีปุ่ม primary (มีแค่ "ดูรายละเอียด")
- [ ] กด card body → เปิด modal detail
- [ ] Card entrance animation (fade-in delayed)

### A4. Modal Detail
- [ ] กด "ดูรายละเอียด" → slide-up animation จากล่าง
- [ ] ปุ่ม X มุมขวาบน + คลิก backdrop → close
- [ ] Header แสดง order id + status icon + วันที่เต็ม
- [ ] **Timeline 4-step** แสดง:
  - PENDING_PAYMENT → step 0 current (pulse), 1-3 pending
  - PAID → step 0 done, step 1 current, 2-3 pending
  - PROCESSING → step 0-1 done, step 2 current, step 3 pending
  - SHIPPED → step 0-2 done, step 3 current
  - CANCELLED → banner แดงด้านบน + step 0 done, 1-3 cancelled (เทาแดง)
- [ ] Step ที่ done มี checkmark + line สี gradient
- [ ] Step ที่ current มี pulse ring
- [ ] Timestamps แสดงใต้ step (ใช้ relative time)
- [ ] รายการสินค้าครบ (รูป + ชื่อ + qty + ราคาต่อหน่วย + รวม)
- [ ] ที่อยู่จัดส่ง (ถ้ามี)
- [ ] เลขบิล (ถ้ามี)
- [ ] Tracking block (ถ้ามี trackingNumber)
- [ ] Summary ครบ (ค่าสินค้า / คูปอง / ค่าส่ง / รวม)
- [ ] Admin note (ถ้ามี)

### A5. Empty states
- [ ] ลูกค้าใหม่ไม่มี order → "ยังไม่มีออเดอร์" + ปุ่ม "เริ่มช้อปปิ้ง" → ไป products.html
- [ ] Filter ไม่เจอ → "ไม่มีออเดอร์ในหมวดนี้" + ปุ่ม "ดูออเดอร์ทั้งหมด" → set tab=ALL
- [ ] Network error → "ลองใหม่" button → re-fetch

---

## 📦 Section B — Smart Courier Detection

### B1. ไปรษณีย์ไทย
- [ ] tracking `EH123456789TH` → detect "ไปรษณีย์ไทย" → กดปุ่มเปิด `https://track.thailandpost.co.th/?trackNumber=...`
- [ ] tracking ที่ขึ้นต้น `ER`, `RC`, `PC` → detect ถูก

### B2. Kerry
- [ ] tracking `KEX123456789` → detect "Kerry Express" → URL `th.kerryexpress.com`

### B3. Flash
- [ ] tracking `TH123456789012` → detect "Flash Express" → URL `flashexpress.com`

### B4. J&T
- [ ] tracking `JT12345` หรือ `60xxxxxxxxxx` → detect "J&T Express"

### B5. SCG
- [ ] tracking `SCG12345` → detect "SCG Express"

### B6. Unknown courier
- [ ] tracking ที่ไม่ match pattern ใดๆ → ปุ่ม "เลือกขนส่ง"
- [ ] กด → tg.showPopup ขึ้น list 5 ขนส่ง
- [ ] เลือกอันใดอันหนึ่ง → เปิด URL + จำใน localStorage
- [ ] Reload หน้า → กลับมาแสดงชื่อ courier ที่จำไว้ทันที

### B7. Multiple tracking numbers
- [ ] order ที่ trackingNumber = `EH123TH,KEX456,...` (คั่นด้วย comma) → แสดงเป็น chip-list ใน modal
- [ ] กด "ติดตามพัสดุ" บน card หลัก (ไม่ใช่ modal) เมื่อมีหลายเลข → เปิด modal detail (ไม่ navigate)

---

## ⚡ Section C — Realtime Updates

### C1. Admin set bill → customer ดู realtime
**Steps**:
1. ลูกค้าเปิด orders.html อยู่
2. Admin เปิด admin app → ใส่บิลให้ order PAID ของลูกค้า
3. ฝั่งลูกค้าโดยไม่กดอะไร

**Expected**:
- [ ] Card นั้น flash highlight สีส้ม 1.5s
- [ ] Status pill เปลี่ยนเป็น "กำลังแพ็คสินค้า"
- [ ] Tab counts อัปเดต
- [ ] Haptic notificationOccurred (success)

### C2. Admin set tracking → SHIPPED
**Steps**:
1. ลูกค้าเปิด modal detail ของ order PROCESSING อยู่
2. Admin set tracking number

**Expected**:
- [ ] Modal refresh เอง (timeline เลื่อนถึง step 3)
- [ ] Tracking block ขึ้นใหม่
- [ ] Card ใน list flash highlight

### C3. Auto-cancel (expiry)
**Steps**:
1. ลูกค้าสร้าง order รอจน countdown หมด
2. เปิด orders.html

**Expected**:
- [ ] Card เปลี่ยน status เป็น "ยกเลิก" ภายใน 10s หลังหมดเวลา (ตาม Phase A+B realtime)
- [ ] Modal ที่เปิดอยู่ refresh + แสดง cancelled banner

### C4. Socket reconnect
**Steps**:
1. เปิดหน้า orders.html
2. ปิด/เปิด wifi (force socket disconnect/reconnect)

**Expected**:
- [ ] เมื่อ reconnect → fetchOrders() ทำงาน → state สด

---

## 🌐 Section D — i18n + UI

### D1. EN translation
- [ ] กด lang switcher → ทุกข้อความเปลี่ยนเป็น EN
- [ ] Tabs: All / Pending / Shipping / Cancelled
- [ ] Empty states, status labels, timeline steps, button labels ทุกอันแปลครบ
- [ ] Bottom nav: Home / Shop / Orders / Refer / Member

### D2. Bottom nav consistency (5 ไฟล์)
- [ ] เปิด `home.html` → nav มี 5 ปุ่ม, "หน้าหลัก" active (text-white + ri-home-4-fill)
- [ ] เปิด `products.html` → "เมนูสินค้า" active (ri-shopping-cart-fill)
- [ ] เปิด `orders.html` → "ออเดอร์" active (ri-truck-fill)
- [ ] เปิด `referral.html` → "แนะนำเพื่อน" active (ri-team-fill)
- [ ] เปิด `dashboard.html` → "บัตรสมาชิก" active (ri-wallet-3-fill)
- [ ] เปิด `mystery-box.html` → ไม่มี active button (ทุกอัน gray) — ปุ่มทั้ง 5 ใช้ได้
- [ ] กดทุกปุ่มไปหน้าถูกต้อง
- [ ] ทุกหน้าใช้ w-1/5 ครบ (ไม่มี w-1/4 หลงเหลือ)

### D3. Mobile rendering (Telegram จริง)
- [ ] เปิดบนมือถือผ่าน Telegram bot menu
- [ ] Bottom nav ไม่ทับ content (padding-bottom 100px)
- [ ] Modal แสดงเต็มจอเหมาะสม, scroll ภายใน modal ได้
- [ ] Sticky filter tabs ไม่ทับ header
- [ ] Card layout ไม่ overflow

---

## 🔒 Section E — mismatchLocked CTA

### E1. Order mismatchLocked
**Steps**:
1. ลูกค้าโอนสลิปยอดน้อยกว่ายอดจริง → server lock
2. เปิด orders.html → tab "รอชำระ"

**Expected**:
- [ ] Card แสดง pill ม่วง "รอตรวจสลิป"
- [ ] ปุ่ม primary = "ทักแอดมิน" (ม่วง)
- [ ] ไม่มีปุ่ม "ยกเลิก" (เพราะลูกค้ายกเลิกเองไม่ได้ตาม policy)

### E2. mismatchLocked modal
- [ ] เปิด modal → ไม่มี timeline ปกติ → แสดง mismatch warning box แทน
- [ ] Box แสดง: ต้องโอน / โอนแล้ว / ขาดอีก
- [ ] ปุ่ม "คัดลอกข้อความ" → copy formatted message + toast "คัดลอกแล้ว"
- [ ] ปุ่ม "ปิดและทักแอดมิน" → copy + ปิด mini app (กลับไปแชทบอท)

---

## 🎁 Section F — PRZ Orders

### F1. Mystery Box prize delivery
- [ ] order ที่ kind=PRIZE_DELIVERY → badge "PRZ" สีม่วงข้าง order id
- [ ] Filter tabs ทำงานปกติ
- [ ] Modal เปิดได้ (อาจไม่มี items แบบสินค้า — แสดงตาม data ที่มี)

---

## 🎯 Section G — Polish (manual eyeball check)

- [ ] Card hover/active scale ทำงาน (active:scale-[0.99])
- [ ] Modal slide-up smooth (ไม่กระตุก)
- [ ] Step pulse animation นุ่มนวล
- [ ] Skeleton shimmer ดู natural
- [ ] Flash highlight ตอน realtime update เห็นชัด
- [ ] Toast slide-down + fade-out ลื่น
- [ ] ไม่มี layout shift ตอน fetch แล้วโหลดเสร็จ
- [ ] Haptic feedback ตอน:
  - [ ] tab switch (selectionChanged)
  - [ ] open detail (impact light)
  - [ ] go to payment (impact medium)
  - [ ] open tracking URL (impact medium)
  - [ ] realtime update arrived (notification success)

---

## รายงานหลังเทส

| Section | สถานะ | หมายเหตุ |
|---|---|---|
| A. ฟังก์ชันหลัก | ⬜️ |  |
| B. Courier detection | ⬜️ |  |
| C. Realtime | ⬜️ |  |
| D. i18n + nav | ⬜️ |  |
| E. mismatchLocked CTA | ⬜️ |  |
| F. PRZ orders | ⬜️ |  |
| G. Polish | ⬜️ |  |

ถ้า case ไหน fail → ส่ง screenshot + Railway log ให้ Claude เพื่อ debug
