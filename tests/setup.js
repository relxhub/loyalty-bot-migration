// tests/setup.js
//
// Global setup สำหรับเทสทุกไฟล์
// - โหลด .env.test เพื่อกัน prisma client crash ตอน import
// - ห้าม import โค้ด production จากที่นี่ (เก็บไว้ให้แต่ละไฟล์เทสจัดการเอง)

import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(here, '..', '.env.test') });

// Safety: ถ้า DATABASE_URL ชี้ไป production (rlwy.net) ให้หยุดทันที
// — กันเทสยิงไป DB จริงโดยไม่ตั้งใจ
const url = process.env.DATABASE_URL || '';
if (/rlwy\.net|railway\.app/.test(url)) {
    throw new Error(
        '[tests/setup] DATABASE_URL points to a Railway host. ' +
            'Refusing to run tests against production. ' +
            'Set DATABASE_URL in .env.test to a stub or local DB.',
    );
}
