# Tests

โครงสร้างเทสของโปรเจกต์ — เปิดใช้งาน 2026-05-07

## รันเทส

```bash
npm test                 # รันทั้งหมดครั้งเดียว
npm run test:watch       # watch mode (re-run เมื่อมีไฟล์เปลี่ยน)
npm run test:coverage    # รัน + สร้างรายงาน coverage (HTML ใน coverage/)
```

จะรันเฉพาะ unit หรือ integration ก็ส่ง path เพิ่มได้:

```bash
npm test -- tests/unit
npm test -- tests/integration
```

## โครงสร้าง

```
tests/
├── README.md           ← ไฟล์นี้
├── setup.js            ← global setup (โหลด .env.test, กันยิง prod DB)
├── unit/               ← unit tests — mock dependencies (prisma ฯลฯ)
├── integration/        ← (ยังว่าง) — เทสที่แตะ DB / HTTP จริง ใช้ test DB เท่านั้น
├── fixtures/           ← (ยังว่าง) — sample data / factory helpers
└── mocks/              ← (ยังว่าง) — shared mock factories (Prisma, Telegram, ฯลฯ)
```

## หลักการ

1. **ห้าม import โค้ด production แล้วยิง DB จริง** — `tests/setup.js` จะตรวจ
   ถ้า `DATABASE_URL` ชี้ไป Railway (`rlwy.net` / `railway.app`) จะ throw ทันที
2. **Mock Prisma เป็น default** — ใช้ `vitest-mock-extended` (`mockDeep`)
   สร้าง mock ของ `PrismaClient` แล้ว stub method ที่ใช้ในเทสแต่ละเคส
3. **Deterministic** — ห้ามเทสที่ผลลัพธ์ผันแปรตาม clock/random
   ใช้ `vi.useFakeTimers()` หรือ seeded RNG
4. **เทสแต่ละไฟล์ < 300 บรรทัด** — ถ้ายาวกว่าให้แตกตาม subject
5. **ตั้งชื่อเทสเป็น behavior** — `it('rejects when minPurchase not met')`
   ไม่ใช่ `it('test1')`

## การเขียนเทสใหม่

ตัวอย่าง pattern:

```js
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockDeep, mockReset } from 'vitest-mock-extended';

vi.mock('../../src/db.js', () => ({
    prisma: mockDeep(), // จะ swap ตอน beforeEach
}));

import { prisma } from '../../src/db.js';
import { someService } from '../../src/services/some.service.js';

beforeEach(() => mockReset(prisma));

describe('someService.doThing', () => {
    it('does the thing', async () => {
        prisma.coupon.findUnique.mockResolvedValue({ id: 'C1', isActive: true });
        const r = await someService.doThing('C1');
        expect(r).toEqual({ ok: true });
    });
});
```

## Coverage targets

ตั้งไว้ 0% ทุกหมวดในตอนนี้ (gating ปิด) — จะค่อยเพิ่มทีละก้าว
เมื่อเทสคลุม services เพิ่มขึ้น เป้าหมายระยะกลาง 80%+ ของ services ที่มีเทส
