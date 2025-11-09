// src/utils/crypto.utils.js

/**
 * ฟังก์ชันสร้างรหัสยืนยันตัวเลขแบบสุ่ม
 * @param {number} length ความยาวของรหัส (เช่น 4 หลัก)
 * @returns {string} รหัสยืนยัน
 */
export function generateUniqueCode(length) {
    let result = '';
    // ใช้เฉพาะตัวเลข 0-9 เท่านั้น ตามที่โค้ดเดิมกำหนด
    const characters = '0123456789'; 
    for (let i = 0; i < length; i++) {
        result += characters.charAt(Math.floor(Math.random() * characters.length));
    }
    return result;
}