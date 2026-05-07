// tests/mocks/prisma.mock.js
//
// Helpers สำหรับ mock Prisma client ในเทส
//
// ใช้ pattern ต่อไปนี้ในไฟล์เทสที่ต้องการ mock prisma:
//
//   import { vi, beforeEach } from 'vitest';
//   import { mockReset } from '../mocks/prisma.mock.js';
//
//   // vi.mock จะถูก hoist ก่อน import จริง
//   // — factory ห้ามอ้าง closure ตัวนอก ใช้ dynamic import แทน
//   vi.mock('../../src/db.js', async () => {
//       const { mockDeep } = await import('vitest-mock-extended');
//       return { prisma: mockDeep() };
//   });
//
//   // import จากไฟล์ที่ mocked → ได้ instance เดียวกับใน factory
//   import { prisma } from '../../src/db.js';
//   import { someService } from '../../src/services/some.service.js';
//
//   beforeEach(() => mockReset(prisma));
//
//   it('does the thing', async () => {
//       prisma.coupon.findUnique.mockResolvedValue({ id: 'C1', isActive: true });
//       const r = await someService.doThing('C1');
//       expect(r).toEqual({ ok: true });
//   });
//
// การ mock $transaction (callback-style):
//   prisma.$transaction.mockImplementation(async (cb) => cb(prisma));
//   // → tx ใน callback กลายเป็น prisma mock เดียวกับด้านนอก
//
// (ถ้าต้องการ tx แยก mock ให้ใช้ mockDeep() ใหม่ในนั้น)

export { mockDeep, mockReset } from 'vitest-mock-extended';
