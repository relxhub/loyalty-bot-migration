// src/utils/date.utils.js

import { getConfig } from '../config/config.js';

/**
 * 🇹🇭 สร้างวันที่ปัจจุบันโดยแปลงเป็นเวลาไทย (Fake UTC)
 * ใช้เพื่อให้การคำนวณวันตัดรอบ (00:00) ตรงกับเที่ยงคืนประเทศไทย
 * และเพื่อให้ตรงกับข้อมูลที่คุณกรอกใน DB (ซึ่งคุณกรอกเป็นเวลาไทย)
 */
export function getThaiNow() {
    const now = new Date();
    // บวก 7 ชั่วโมง (7 * 60 * 60 * 1000)
    const thaiOffset = 7 * 60 * 60 * 1000; 
    return new Date(now.getTime() + thaiOffset);
}

export function addDays(date, days) {
    const result = new Date(date);
    result.setDate(result.getDate() + days);
    // ปรับเวลาให้เป็น 00:00:00 
    result.setHours(0, 0, 0, 0); 
    return result;
}

// ฟังก์ชันคำนวณวันหมดอายุ (ใช้ getThaiNow แทน new Date)
export function calculateExpiryDate(pointType) {
    const startDate = getThaiNow(); // ใช้วันที่ไทย
    const DAYS_GENERAL_TOPUP = 365; 
    const DAYS_REFERRAL_BONUS = 90; 
    const DAYS_NEW_CUSTOMER = 30;

    let daysToAdd = 0;

    switch (pointType) {
        case 'GENERAL_TOPUP':
            daysToAdd = DAYS_GENERAL_TOPUP;
            break;
        case 'REFERRAL_NEW_CUSTOMER':
            daysToAdd = DAYS_NEW_CUSTOMER;
            break;
        case 'REFERRAL_REFERRER':
            daysToAdd = DAYS_REFERRAL_BONUS;
            break;
        default:
            daysToAdd = DAYS_GENERAL_TOPUP;
            break;
    }

    return addDays(startDate, daysToAdd);
}