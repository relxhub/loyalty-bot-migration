# Order Tracking Page — Phase 1 Analysis

วิเคราะห์ก่อนเริ่ม implement หน้า "ออเดอร์ของฉัน" สำหรับลูกค้า

---

## 1. `/api/orders/history/:telegramId` — return field พอใช้ไหม?

**Endpoint**: `src/routes/api.routes.js:794` (GET, ไม่ verify initData — auth กึ่ง weak,
อ้างอิง telegramId ใน URL)

**Response shape**:
```js
{
  success: true,
  orders: [Order, ...],
  orderExpiryMinutes: number,    // global fallback (StoreSetting)
  trackingUrlTemplate: string,    // e.g. "https://track.thailandpost.co.th/?trackNumber={{TRACK}}"
}
```

**แต่ละ Order** (Prisma `findMany` + include payment + items.product):
```
id, customerId, kind ('PRODUCT'|'PRIZE_DELIVERY'),
status, totalAmount, subtotal, shippingFee, discountAmount, appliedCouponId,
shippingAddressId → shippingAddress (manual fetch),
trackingNumber, billNumber, refundSlipUrl,
mismatchLocked, expiryMinutes, overPaidRefundedAt,
adminNote, assignedAdminId, assignedAt, firstBillAt, billAttempts,
createdAt, updatedAt,
items: [{ id, productId, quantity, priceAtPurchase, product: {full Product} }],
payment: { id, slipUrl, slipImage, amount, status, verifiedAt, createdAt, ... },
overPaidInfo: { expected, actual, diff, copyMessage } | null,
```

**Verdict**: **มีพอ** สำหรับ V1 ของ tracking page ทั้งหมด ไม่ต้องสร้าง endpoint ใหม่

**ข้อสังเกต / สิ่งที่ขาด**:
- **ไม่มี `statusHistory[]`** (เช่น `[{status: 'PAID', at: ...}, {status: 'PROCESSING', at: ...}]`)
  → timeline แสดง "วันที่เปลี่ยน status แต่ละขั้น" ไม่ได้ — ทำได้เฉพาะ "ปัจจุบันถึงขั้นไหน"
  → ทางออก V1: ใช้ `createdAt` (= สั่งซื้อ), `firstBillAt` (= เริ่ม PROCESSING),
    `payment.verifiedAt` (= PAID), `updatedAt` (= ขั้นล่าสุด) — ประมาณการได้
- **Payload ค่อนข้างหนัก** (full product object ทุก item) — สำหรับ V1 รับได้
- **endpoint นี้ไม่ verify initData** — security gap ที่มีอยู่แล้ว ไม่ใช่งาน scope นี้

---

## 2. PRODUCT vs PRIZE_DELIVERY — ทั้ง 2 ต้องแสดงในหน้านี้ไหม?

**ใช่ — ต้องแสดงทั้งคู่** เหตุผล:
- ลูกค้าจะถามทั้ง "ของที่ซื้อ" และ "ของรางวัล Mystery Box" ว่าถึงไหน → จุดประสงค์เดียวกัน
- ID prefix ต่างกัน (`ORD-...` vs `PRZ-...`) — แสดงปกติได้
- ต้องมี **visual differentiator** (badge "PRZ" สีม่วง / icon `ri-gift-2-fill`)
  ตามที่ admin app ใช้อยู่แล้ว (line 2075 ใน admin-app.html)
- PRZ orders ไม่มี items แบบสินค้า → ต้องโหลด `prizeShipment` data (ปัจจุบัน
  `/orders/history` ไม่ load — แต่ `/orders/:orderId` (single) ทำให้)
  → V1: PRZ ใน list แสดงแบบย่อ, modal detail fetch single order endpoint

**ทางเลือกเสนอ**: เพิ่ม filter tab พิเศษ "ของรางวัล" หรือมีอยู่ใน "ทั้งหมด" และ filter ที่
status tab ปกติ — ผมแนะนำ option หลัง (ไม่เพิ่ม tab) เพื่อ UI สะอาด

---

## 3. OrderStatus mapping → 5-step timeline

**Schema enum** (`prisma/schema.prisma:545`):
```
PENDING_PAYMENT, PAID, PROCESSING, SHIPPED, CANCELLED
```

**ปัญหา**: schema มี **4 ขั้น forward** (+ CANCELLED) ไม่มี `DELIVERED`
→ ถ้า admin ใส่ tracking แล้ว status = SHIPPED → จบ flow ที่ตรงนั้น
→ Spec ในโจทย์ระบุ 5 ขั้น: รอชำระ → ชำระแล้ว → กำลังเตรียม → จัดส่ง → **จัดส่งสำเร็จ**
→ ขั้นที่ 5 "จัดส่งสำเร็จ" ปัจจุบัน **ไม่มีในระบบ**

**Decision (ผู้ใช้เลือก)**: **Option A — 4-step ตามจริง**
- ตรง schema 100%, ไม่หลอกตา (ระบบไม่ track delivery → step "ได้รับแล้ว" จะไม่ tick → สับสน)
- ถ้าวันหลังอยากเพิ่ม DELIVERED แยกเป็น project ภายหลัง

**Mapping ที่ใช้**:
```
step 0: PENDING_PAYMENT  →  📦 สั่งซื้อ      (createdAt)
step 1: PAID/PROCESSING+ →  ✓ ชำระแล้ว     (payment.verifiedAt)
step 2: PROCESSING+      →  🛍 กำลังเตรียม   (firstBillAt)
step 3: SHIPPED          →  🚚 จัดส่งแล้ว    (updatedAt เมื่อเปลี่ยน → SHIPPED)
       CANCELLED         →  ❌ ยกเลิก       (terminate, override visual)
```

---

## 4. mismatchLocked — มีผลต่อการแสดงผลยังไง?

`mismatchLocked = true` หมายถึง: ลูกค้าโอนสลิปยอดน้อยกว่ายอดจริง → server lock ออเดอร์ +
ตัดสต็อก/คูปองทันที + ห้าม re-upload + รอ admin ตัดสินใจ (อนุมัติ top-up หรือยกเลิก)

**ใน tracking page**:
- ใน list: card แสดง badge สีม่วง "⚠️ รอตรวจสลิป" + sub-text "แอดมินกำลังตรวจสอบ"
- Status pill: ยังคงเป็น "รอชำระ" (เพราะ status enum ยังไม่เปลี่ยน) แต่ override
  visual ด้วย warning style
- ใน modal timeline: ค้างที่ขั้น "ชำระแล้ว" (step 1) + แสดง warning box
  ระหว่าง step 1 และ 2: "ยอดสลิปไม่ตรง — รอแอดมินดำเนินการ กรุณาทักแชทบอท"
- Action buttons: **ซ่อนปุ่ม "ยกเลิก"** + แสดงปุ่ม "ทักแอดมิน" (open Telegram chat)
- ปุ่ม "ดูรายละเอียด" → modal มีลิงก์ไป payment.html (ที่จะถูก lock อยู่แล้ว
  ตามที่เพิ่มใน Phase A)

**Filter tab "รอชำระ"**: นับ mismatchLocked อยู่ในนี้ (ก็ยัง PENDING_PAYMENT)

---

## 5. Bottom nav — ไฟล์ไหนต้องแก้?

**5 ไฟล์** (จาก grep `bottom-nav` + `w-1/4`):

| ไฟล์ | line | bg | หมายเหตุ |
|---|---|---|---|
| `public/home.html` | 238 | `bg-[var(--secondary-bg)]` | ปกติ |
| `public/products.html` | 127 | `bg-[#1E1E1E]` (hardcoded) | ปกติ |
| `public/dashboard.html` | 1761 | `bg-[var(--secondary-bg)]` | ปกติ |
| `public/referral.html` | 1678 | `bg-[var(--secondary-bg)]` | ปกติ |
| `public/mystery-box.html` | 168 | `bg-[#1E1E1E]` (hardcoded) | ปกติ |

**ไฟล์ที่ไม่ต้องแก้**:
- `public/payment.html` — ไม่มี bottom nav (focused checkout flow) ✓
- `public/admin-app.html` — bottom nav ของ admin (คนละบริบท) ✓
- `public/index(backup).html` — backup เก่า ไม่ใช่งาน

**สังเกต**: `bg-[#1E1E1E]` ถูก hardcoded 2 ไฟล์ (products + mystery-box) — ค่าตรงกับ
`var(--secondary-bg)` แต่เขียนแบบไม่ใช้ token ผม **จะไม่ refactor ตอนนี้** (out of scope)

---

## 6. w-1/4 → w-1/5 — spacing OK ไหม?

**คำนวณ**:
- Container: `max-w-md` (448px), `p-2` (16px) → inner ≈ 432px / 5 = **86px ต่อปุ่ม**
- เนื้อหาต่อปุ่ม: icon `text-xl` (20×20) + label `text-xs` (12px font, ~60-72px กว้าง)
- Padding ปัจจุบัน: `py-1.5` (12px vertical) — ไม่มี horizontal padding
- Gap แนวนอน (จาก `justify-around`): ~8-12px ระหว่างปุ่ม

**Label ปัจจุบัน + ใหม่**:
- "หน้าหลัก" (4) — 48px
- "เมนูสินค้า" (5) — 60px
- "ออเดอร์" (4) ← ใหม่
- "แนะนำเพื่อน" (5) — 60px
- "บัตรสมาชิก" (5) — 60px

**Verdict**: w-1/5 (86px) ใส่ได้สบาย — เผื่อ buffer 14-26px ต่อปุ่ม

**Concern**: ที่ Telegram WebView บนจอแคบสุด (~320px) → container 280px / 5 = 56px →
"เมนูสินค้า" และ "แนะนำเพื่อน" อาจชิดขอบเล็กน้อย แต่ไม่ overflow (font-xs)

**เสนอ alternative ถ้าจะดูดีขึ้น**:
- **option A (default)**: เปลี่ยน w-1/4 → w-1/5 ตรงๆ — ง่าย ชัวร์
- **option B**: ใช้ `flex-1` แทน `w-1/5` (auto-distribute) — flexible กว่าแต่ผลลัพธ์
  ใกล้กัน
- **option C**: ลด `text-xs` (12px) เป็น `text-[10px]` — ใช้กรณีจอแคบจริงๆ
  (ไม่จำเป็นถ้าทดสอบบน 360px+ เห็นว่าโอเค)

ผมแนะนำ **option A** ตรงๆ — เทสจริงก่อน ถ้าแน่นค่อยปรับ

---

## ตัวเลือก Icon สำหรับปุ่มใหม่ (3 ตัว — Phase 2 จะเลือก 1)

| icon | filled variant | ความหมาย | ข้อดี | ข้อเสีย |
|---|---|---|---|---|
| `ri-truck-line` | `ri-truck-fill` | รถส่งของ | สื่อ "ติดตามพัสดุ" ตรง, ไม่ซ้ำ | อาจสื่อแค่ "shipping" ไม่ครอบคลุม PENDING_PAYMENT |
| `ri-file-list-3-line` | `ri-file-list-3-fill` | รายการ/บิล | กลางๆ ครอบคลุมทุก status | จืดไป ไม่บอกชัดว่าเป็น "ออเดอร์" |
| `ri-archive-line` | `ri-archive-fill` | กล่อง/พัสดุ | สื่อ "พัสดุ" ดี | คล้าย "ของที่เก็บไว้" — อาจสับสน |

ผมแนะนำ **`ri-truck-line` / `ri-truck-fill`** เพราะ:
- 80%+ ของออเดอร์ที่ลูกค้าจะเช็ค = ออเดอร์ที่ payment เสร็จแล้วและรอของ — primary use case
- Icon นี้ชัด ไม่ชนกับ icon อื่นใน nav
- ตรงกับ jargon "ติดตามพัสดุ" ที่ลูกค้าคุ้นเคย

**ทางเลือก backup**: ถ้าคุณรู้สึกว่าครอบคลุมไม่ได้ ใช้ `ri-list-check-2` หรือ `ri-list-ordered`

---

## Decisions ที่ confirmed (ก่อนเข้า Phase 2)

| # | คำตอบ |
|---|---|
| 1. Timeline | **A — 4-step ตามจริง** (สั่งซื้อ → ชำระแล้ว → กำลังเตรียม → จัดส่งแล้ว) |
| 2. Icon nav | `ri-truck-line` / `ri-truck-fill` (active) |
| 3. PRZ orders | รวมในหน้านี้ + visual differentiator badge "PRZ" |
| 4. mismatchLocked CTA | มี — copy message + close mini app (pattern เดียวกับ over-paid ใน payment.html) |
| 5. Layout | w-1/5 ตรงๆ |

---

# Phase 2 — Design Spec

## A. Bottom Navigation (5 buttons)

### Order ใหม่
| pos | icon (line/fill) | label TH | label EN | href |
|---|---|---|---|---|
| 1 | `ri-home-4-line/fill` | หน้าหลัก | Home | `home.html` |
| 2 | `ri-shopping-cart-line/fill` | เมนูสินค้า | Shop | `products.html?v=2` |
| 3 | `ri-truck-line/fill` | **ออเดอร์** | **Orders** | `orders.html` |
| 4 | `ri-team-line/fill` | แนะนำเพื่อน | Refer | `referral.html` |
| 5 | `ri-wallet-3-line/fill` | บัตรสมาชิก | Card | `dashboard.html?v=2` |

### Active state convention
- Inactive: `text-gray-400` + line variant icon
- Active (current page): `text-white` + **fill** variant icon
- `transition active:scale-95` ทุกปุ่ม (เหมือนเดิม)

### HTML diff pattern (apply ทุก 5 ไฟล์)
```diff
- <a href="..." class="... w-1/4 ...">
-   <i class="ri-home-4-fill text-xl"></i>
-   <span data-i18n="nav.home">หน้าหลัก</span>
- </a>
+ <a href="..." class="... w-1/5 ...">
+   <i class="ri-home-4-fill text-xl"></i>
+   <span data-i18n="nav.home">หน้าหลัก</span>
+ </a>
+ <!-- NEW button between products and referral -->
+ <a href="orders.html" class="... w-1/5 ...">
+   <i class="ri-truck-line text-xl"></i>
+   <span data-i18n="nav.orders">ออเดอร์</span>
+   <span id="nav-orders-dot" class="hidden absolute ..."></span>
+ </a>
```

### Active dot (badge)
- จุดสีส้ม (`bg-orange-500`) มุมขวา-บนของไอคอน เมื่อมี order PENDING_PAYMENT หรือ
  PAID/PROCESSING (= "ยังไม่จบ")
- Count อยู่ในจุด ถ้า > 0 (max "9+")
- Update ผ่าน socket `order_update` (ที่มีอยู่แล้ว) — ไม่ต้อง endpoint เพิ่ม

---

## B. orders.html — Layout

### 1. Header (sticky, padding-top safe-area)
```
┌──────────────────────────────────┐
│ ออเดอร์ของฉัน         🌐 TH ▾ │
└──────────────────────────────────┘
```
- Title: `text-2xl font-bold` พร้อม icon `ri-truck-fill` สีส้ม
- Lang switcher (มุมขวาบน) — ใช้ component เดียวกับหน้าอื่น

### 2. Filter Tabs (sticky ใต้ header, scroll-x)
```
┌──────────────────────────────────────────────┐
│ [ทั้งหมด 12] [รอชำระ ⏱2] [กำลังจัดส่ง 3]   │
│ [สำเร็จ 6] [ยกเลิก 1]                       │
└──────────────────────────────────────────────┘
```
- Pill style: `rounded-full px-4 py-1.5 text-xs font-bold whitespace-nowrap`
- Active tab: `bg-gradient-to-br from-yellow-400 to-orange-500 text-white shadow-[0_0_15px_rgba(245,158,11,0.3)]`
- Inactive: `bg-zinc-800 text-zinc-400 border border-zinc-700`
- Badge count: small number ในวงกลมข้างๆ label (สีพื้นหลังต่างจาก pill)
- Tabs:
  - ทั้งหมด (count = total)
  - รอชำระ (PENDING_PAYMENT — รวม mismatchLocked)
  - กำลังจัดส่ง (PAID + PROCESSING + SHIPPED — orders ที่ยังไม่จบ delivery)
  - สำเร็จ (SHIPPED ที่ลูกค้าเห็นว่าได้รับแล้ว — ก็คือ SHIPPED ทั้งหมดในเวอร์ชัน A)
  - ยกเลิก (CANCELLED)

  > **หมายเหตุ**: option A 4-step → ไม่มี DELIVERED → "กำลังจัดส่ง" และ "สำเร็จ" จะ
  > overlap (SHIPPED อยู่ทั้ง 2 tab). ผมเสนอ:
  > - **กำลังจัดส่ง** = PAID + PROCESSING (ยังไม่ส่ง) + SHIPPED ที่ < 7 วัน
  > - **สำเร็จ** = SHIPPED ที่ ≥ 7 วัน (สมมุติว่าได้รับแล้ว)
  >
  > หรือ — ลด tab เหลือ 4: ทั้งหมด / รอชำระ / กำลังจัดส่ง / ยกเลิก (clean กว่า)
  > **ขอ confirm ตรงนี้ก่อน Phase 4** — แนะนำ 4 tabs

### 3. Order Card

```
┌────────────────────────────────────────────┐
│ #ORD-123456                  [กำลังเตรียม] │ ← header bar
│ 4 ม.ค. 2569 · 14:23                        │
│ ─────────────────────────────────────────  │
│ 🍇🍓🥭 +2 ชิ้น                              │ ← items preview
│                                             │
│ 💰 ฿850.00                                  │ ← total (gradient)
│                                             │
│ [🚚 ติดตามพัสดุ]  [📋 ดูรายละเอียด]        │ ← actions
└────────────────────────────────────────────┘
```

**Spec**:
- Container: `bg-[var(--secondary-bg)] rounded-2xl p-4 mb-3 border border-zinc-800`
- Header bar:
  - Order ID: `font-mono text-xs text-zinc-400` (PRZ มี prefix สีม่วง)
  - Status pill: ขนาดเล็ก ตามสีในตาราง status palette ด้านล่าง
  - PRZ kind: badge เพิ่ม "PRZ" สีม่วง (`bg-purple-500/20 text-purple-300`)
  - mismatchLocked: badge เพิ่ม "⚠️ รอตรวจสลิป" สีเหลือง override
- Date: `text-[11px] text-zinc-500`
- Items preview:
  - 3 รูปกลม overlap (`-ml-2` from 2nd) ขนาด 32×32, border-zinc-800
  - "+N ชิ้น" ถ้ามี items > 3
  - Fallback: ถ้าไม่มีรูป → emoji `🛍`
- Total: gradient text (`bg-gradient-to-r from-yellow-400 to-orange-500 bg-clip-text text-transparent`) + `text-xl font-bold`
- Action row (flex gap-2):
  - **ติดตามพัสดุ** (primary): แสดงเฉพาะถ้ามี trackingNumber + status SHIPPED.
    `bg-gradient-to-br from-yellow-400 to-orange-500 text-white py-2 rounded-xl flex-1`
  - **ดูรายละเอียด** (secondary): เสมอ
    `bg-zinc-800 text-zinc-200 py-2 rounded-xl flex-1 border border-zinc-700`
  - **ยกเลิก** (PENDING_PAYMENT non-mismatch เท่านั้น): แทน "ติดตามพัสดุ"
    `bg-zinc-800 text-red-400 py-2 rounded-xl flex-1`
  - **ทักแอดมิน** (mismatchLocked): แทน "ติดตามพัสดุ"
    `bg-purple-500/20 text-purple-300 py-2 rounded-xl flex-1`
- คลิกที่ card body (ส่วนที่ไม่ใช่ปุ่ม) → เปิด modal detail

### Status palette (ตาราง)
| status | pill bg / text | icon |
|---|---|---|
| PENDING_PAYMENT | `bg-yellow-500/15 text-yellow-300 border-yellow-500/30` | `ri-time-line` |
| PENDING_PAYMENT + mismatchLocked | `bg-purple-500/15 text-purple-300 border-purple-500/30` | `ri-error-warning-line` |
| PAID | `bg-blue-500/15 text-blue-300 border-blue-500/30` | `ri-checkbox-circle-line` |
| PROCESSING | `bg-cyan-500/15 text-cyan-300 border-cyan-500/30` | `ri-archive-line` |
| SHIPPED | `bg-green-500/15 text-green-400 border-green-500/30` | `ri-truck-line` |
| CANCELLED | `bg-red-500/15 text-red-400 border-red-500/30` | `ri-close-circle-line` |

---

## C. Modal Detail (เปิดเมื่อกด "ดูรายละเอียด")

### Layout
```
┌──────────────────────────────────────┐
│ ← #ORD-123456              [×]      │ ← header
│                                      │
│ ┌─ Hero ─────────────────────────┐  │
│ │  [Status badge ใหญ่]            │  │
│ │  สั่งซื้อ 4 ม.ค. 2569 · 14:23   │  │
│ │                                 │  │
│ │  ●━━●━━●━━○                    │  │ ← 4-step timeline
│ │  สั่ง  จ่าย เตรียม จัดส่ง         │  │
│ └────────────────────────────────┘  │
│                                      │
│ 📍 ที่อยู่จัดส่ง                       │
│ ┌────────────────────────────────┐  │
│ │ คุณกาญจนา · 081-234-5678        │  │
│ │ 123/45 ถ.สุขุมวิท ...            │  │
│ └────────────────────────────────┘  │
│                                      │
│ 📦 เลขพัสดุ                          │
│ ┌────────────────────────────────┐  │
│ │ EH123456789TH (Thailand Post)   │  │
│ │ [🚚 เปิดเว็บขนส่ง →]            │  │
│ └────────────────────────────────┘  │
│                                      │
│ 🛍 รายการสินค้า · 5 ชิ้น              │
│ ┌────────────────────────────────┐  │
│ │ [img] สับปะรด 5%      ×2  ฿200 │  │
│ │ [img] องุ่น 3%        ×1  ฿100 │  │
│ │ ...                              │  │
│ └────────────────────────────────┘  │
│                                      │
│ 💰 สรุปยอด                            │
│ ┌────────────────────────────────┐  │
│ │ ค่าสินค้า         ฿800           │  │
│ │ ส่วนลด          -฿50            │  │
│ │ ค่าจัดส่ง         ฟรี             │  │
│ │ ────────────────                 │  │
│ │ ยอดรวม          ฿750            │  │
│ └────────────────────────────────┘  │
│                                      │
│ 📝 หมายเหตุจากแอดมิน (ถ้ามี)         │
└──────────────────────────────────────┘
```

### Animation
- **Slide up จากล่าง** (300ms `cubic-bezier(0.4,0,0.2,1)`) — ใช้ pattern เดียวกับ
  order-details-modal ใน products.html
- Backdrop `bg-black/80 backdrop-blur-sm`, click ที่ backdrop → close

### Timeline 4-step (ส่วนสำคัญ)
```
●━━━━━━●━━━━━━●━━━━━○
สั่ง   จ่าย   เตรียม  จัดส่ง
✓     ✓      now     wait
```
- **Done step**: dot สี orange gradient + checkmark + line ก่อน-หลัง สี gradient
- **Current step**: dot pulse animation (ring radial gradient) + label สีขาว bold
- **Pending step**: dot zinc-700 + label zinc-500 + line เทา
- **Cancelled override**: ทั้ง timeline แทนด้วย banner สีแดง "❌ ยกเลิก {reason ถ้ามี}"
- **mismatchLocked override**: ค้างที่ step 1 (ชำระแล้ว) แต่ใส่ warning box ระหว่าง
  step 1-2: "⚠️ ยอดสลิปไม่ตรง — รอแอดมินตัดสินใจ" + ปุ่ม "📋 คัดลอกข้อความ" และ
  "💬 ปิดและทักแอดมิน"
- Timestamp ใต้ step (ถ้ามี): font-mono text-[10px] text-zinc-500
  - sub มาจาก: createdAt (step 0), payment.verifiedAt (step 1), firstBillAt (step 2),
    updatedAt (step 3 — เพราะไม่มี shippedAt field)

---

## D. Smart Courier Detection

ใส่ใน `public/orders.js` (ไม่ใช้ inline เพื่อ test แยกได้):

```js
const COURIERS = [
  {
    id: 'thp',
    name: 'ไปรษณีย์ไทย',
    test: (n) => /^[A-Z]{2}\d{9}TH$/i.test(n) || /^(EH|ER|RC|PC|RA|RD|RH|RR)/i.test(n),
    url: (n) => `https://track.thailandpost.co.th/?trackNumber=${n}`,
    icon: 'ri-mail-send-line',
  },
  {
    id: 'kerry',
    name: 'Kerry Express',
    test: (n) => /^(KEX|PSP|SMR|KER)/i.test(n),
    url: (n) => `https://th.kerryexpress.com/th/track/?track=${n}`,
    icon: 'ri-truck-line',
  },
  {
    id: 'flash',
    name: 'Flash Express',
    test: (n) => /^TH\d{12}$/i.test(n),
    url: (n) => `https://www.flashexpress.com/fle/tracking?se=${n}`,
    icon: 'ri-flashlight-line',
  },
  {
    id: 'jt',
    name: 'J&T Express',
    test: (n) => /^JT\d+/i.test(n) || /^60\d{10}/.test(n),
    url: (n) => `https://www.jtexpress.co.th/index/query/gzquery.html?bills=${n}`,
    icon: 'ri-truck-line',
  },
  {
    id: 'scg',
    name: 'SCG Express',
    test: (n) => /^SCG/i.test(n),
    url: (n) => `https://www.scgexpress.co.th/tracking?tracking_no=${n}`,
    icon: 'ri-truck-line',
  },
];

function detectCourier(trackingNumber) {
  for (const c of COURIERS) if (c.test(trackingNumber)) return c;
  return null;
}
```

### Multiple tracking numbers
ออเดอร์ใหญ่อาจมี trackingNumber หลายเลขคั่นด้วย `,` (พบ pattern นี้ใน history.js ที่มีอยู่)
→ split + render เป็น chip-list, แต่ละ chip คลิกแล้ว detect courier แล้วเปิด URL

### Unknown courier fallback
ถ้า detect ไม่ได้:
- แสดง "❓ ตรวจไม่พบขนส่ง" + dropdown "เลือกขนส่ง" → ลูกค้าเลือกจาก 5 ตัวข้างต้น
- จำ choice ไว้ใน `localStorage` (key = `courier:<orderId>`) เพื่อครั้งถัดไปไม่ต้องเลือกซ้ำ
- ถ้ามี `tracking_url_template` ใน config (มีอยู่แล้ว) → ใช้เป็น fallback ก่อน
  (`replace('{{TRACK}}', n)`)

---

## E. Real-time Updates

ใช้ infrastructure ที่มีอยู่ (Phase A+B เดิม):
- `socket.io` + `socket-register.js` (มีโหลดแล้ว)
- Server emit `order_update` ที่ทุก mutation (set-bill, set-tracking, cancel, ฯลฯ — มีอยู่แล้ว)
- ไม่ต้องเพิ่ม emit ใหม่ฝั่ง backend ✓

ฝั่ง client (`orders.js`):
```js
socket.on('order_update', (payload) => {
  if (!payload?.id) return;
  // 1. หา card นั้นใน DOM, เพิ่ม flash highlight 1.5s
  // 2. re-fetch /api/orders/history (debounced 500ms กัน burst)
  // 3. ถ้า modal เปิดของ order นี้ → re-render modal
  // 4. update tab counts + nav badge
});
socket.on('connect', () => fetchOrders()); // catch missed events
```

**Flash highlight**: เพิ่ม class `flash-update` (1.5s) → keyframe ring สีส้ม fade-out

---

## F. Empty States

### F1. ลูกค้าใหม่ ยังไม่มี order ใดๆ
```
┌────────────────────────┐
│        🛍               │ ← icon ใหญ่ zinc-700
│                         │
│  ยังไม่มีออเดอร์          │
│  ไปดูสินค้ากันเลย!         │
│                         │
│  [🍃 เริ่มช้อปปิ้ง]       │ ← gradient orange CTA
└────────────────────────┘
```
- Container: full viewport center, padding 24px
- Icon: `ri-shopping-bag-3-line text-6xl text-zinc-700`
- CTA → `products.html?v=2`

### F2. Filter ไม่เจอ (มี order รวม แต่ tab นี้ว่าง)
```
ไม่มีออเดอร์ในหมวด "รอชำระ"
[ดูออเดอร์ทั้งหมด]
```
- ปุ่ม clear filter → set tab = "ทั้งหมด"

### F3. Loading skeleton (NOT spinner)
- 3 card-skeleton: `bg-zinc-800/50 rounded-2xl h-32 animate-pulse mb-3`
- ใช้ shimmer effect ถ้าทำง่าย ไม่งั้น `animate-pulse` ของ Tailwind พอ

### F4. Error state
- Network/API error: `text-red-400 text-center py-8` + ปุ่ม "ลองใหม่"

---

## G. Animation + Haptic + Polish

| event | effect |
|---|---|
| Tab switch | `tg.HapticFeedback.selectionChanged()` |
| ดูรายละเอียด | `tg.HapticFeedback.impactOccurred('light')` + slide-up modal |
| ติดตามพัสดุ | `tg.HapticFeedback.impactOccurred('medium')` + open URL |
| ยกเลิก order | `tg.showPopup` confirm → `notificationOccurred('warning')` |
| Realtime update arrived | `notificationOccurred('success')` + flash highlight |
| Pull-to-refresh | (optional V2 — ข้ามไปก่อน) |

---

## H. i18n keys ใหม่ (เพิ่มใน th.json + en.json)

```json
{
  "nav.orders": "ออเดอร์",                    // EN: "Orders"
  "orders.title": "ออเดอร์ของฉัน",             // EN: "My Orders"
  "orders.tabs.all": "ทั้งหมด",                // EN: "All"
  "orders.tabs.pending": "รอชำระ",             // EN: "Pending"
  "orders.tabs.shipping": "กำลังจัดส่ง",        // EN: "Shipping"
  "orders.tabs.cancelled": "ยกเลิก",           // EN: "Cancelled"
  "orders.empty.title": "ยังไม่มีออเดอร์",       // EN: "No orders yet"
  "orders.empty.subtitle": "ไปดูสินค้ากันเลย!",  // EN: "Let's go shopping!"
  "orders.empty.cta": "เริ่มช้อปปิ้ง",          // EN: "Start shopping"
  "orders.empty_filter.title": "ไม่มีออเดอร์ในหมวดนี้", // EN: "No orders in this category"
  "orders.empty_filter.clear": "ดูออเดอร์ทั้งหมด", // EN: "View all orders"
  "orders.card.items_more": "และอีก {n} ชิ้น", // EN: "+{n} more"
  "orders.card.track": "ติดตามพัสดุ",          // EN: "Track package"
  "orders.card.detail": "ดูรายละเอียด",        // EN: "Details"
  "orders.card.cancel": "ยกเลิก",             // EN: "Cancel"
  "orders.card.contact_admin": "ทักแอดมิน",   // EN: "Contact admin"
  "orders.timeline.step.order": "สั่งซื้อ",      // EN: "Ordered"
  "orders.timeline.step.paid": "ชำระแล้ว",     // EN: "Paid"
  "orders.timeline.step.preparing": "กำลังเตรียม", // EN: "Preparing"
  "orders.timeline.step.shipped": "จัดส่งแล้ว",  // EN: "Shipped"
  "orders.timeline.cancelled_banner": "ออเดอร์นี้ถูกยกเลิก", // EN: "Order cancelled"
  "orders.timeline.mismatch_warning": "ยอดสลิปไม่ตรง — รอแอดมินตัดสินใจ", // EN: "Slip amount mismatch — awaiting admin"
  "orders.detail.shipping_address": "ที่อยู่จัดส่ง", // EN: "Shipping address"
  "orders.detail.tracking": "เลขพัสดุ",        // EN: "Tracking number"
  "orders.detail.items": "รายการสินค้า",        // EN: "Items"
  "orders.detail.summary": "สรุปยอด",          // EN: "Summary"
  "orders.detail.coupon": "คูปองที่ใช้",         // EN: "Coupon used"
  "orders.detail.note": "หมายเหตุจากแอดมิน",   // EN: "Note from admin"
  "orders.courier.open": "เปิดเว็บขนส่ง",       // EN: "Open courier site"
  "orders.courier.unknown": "ตรวจไม่พบขนส่ง",  // EN: "Courier unknown"
  "orders.courier.select": "เลือกขนส่ง",        // EN: "Select courier"
  "orders.courier.kerry": "Kerry Express",
  "orders.courier.thp": "ไปรษณีย์ไทย",         // EN: "Thailand Post"
  "orders.courier.flash": "Flash Express",
  "orders.courier.jt": "J&T Express",
  "orders.courier.scg": "SCG Express",
  "orders.refresh.flash": "อัปเดตแล้ว"          // EN: "Updated"
}
```

---

## I. File scope (Phase 4)

**ไฟล์ใหม่ (2)**:
- `public/orders.html` — markup + ใช้ design tokens
- `public/orders.js` — fetchOrders, renderOrders, openDetailModal, detectCourier,
  COURIERS array, filter logic, socket subscription

**ไฟล์ที่แก้ (5 — bottom nav update)**:
- `public/home.html`
- `public/products.html`
- `public/dashboard.html`
- `public/referral.html`
- `public/mystery-box.html`

**ไฟล์ที่แก้ (2 — i18n)**:
- `public/i18n/th.json`
- `public/i18n/en.json`

**ไม่แตะ**:
- `payment.html` (ไม่มี nav)
- `admin-app.html` (admin context)
- backend (`api.routes.js`) — endpoint + emit มีพร้อมแล้ว ✓

---

## Decisions Phase 2 (confirmed)

| # | คำตอบ |
|---|---|
| Filter tabs | **4 tabs**: ทั้งหมด / รอชำระ / กำลังจัดส่ง / ยกเลิก. "กำลังจัดส่ง" = PAID + PROCESSING + SHIPPED รวม |
| Pull-to-refresh | **ไม่ใส่ V1** — มี realtime + tab click refresh อยู่แล้ว |

