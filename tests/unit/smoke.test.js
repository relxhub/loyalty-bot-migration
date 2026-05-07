// tests/unit/smoke.test.js
//
// Step 1 sanity check — ยืนยันว่า test runner ทำงานและไม่ import โค้ด production
// ลบทิ้งได้หลัง Step 2 ขึ้นไป

import { describe, it, expect } from 'vitest';

describe('test infrastructure', () => {
    it('runs vitest', () => {
        expect(1 + 1).toBe(2);
    });

    it('loads .env.test', () => {
        // setup.js โหลด .env.test แล้ว — ตรวจว่า DATABASE_URL ไม่ได้ชี้ prod
        expect(process.env.DATABASE_URL).toBeDefined();
        expect(process.env.DATABASE_URL).not.toMatch(/rlwy\.net|railway\.app/);
    });
});
