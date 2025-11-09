// src/utils/validation.utils.js

/**
 * ตรวจสอบรูปแบบ ID ว่าเป็นตัวอักษรใหญ่ A-Z และตัวเลข 0-9 เท่านั้น
 * (อ้างอิงตาม Regex ในโค้ด Apps Script เดิม)
 * @param {string} id รหัสลูกค้าหรือรหัสผู้แนะนำ
 * @returns {boolean}
 */
export function isValidIdFormat(id) {
    if (!id) return false;
    // Regex จากโค้ด Apps Script เดิม: /^[A-Z0-9]+$/
    const regex = /^[A-Z0-9]+$/; 
    // แปลงเป็นตัวพิมพ์ใหญ่ก่อนตรวจสอบ
    return regex.test(id.toUpperCase()); 
}