// src/utils/date.utils.js

export function addDays(date, days) {
    const result = new Date(date);
    result.setDate(result.getDate() + days);
    // ปรับเวลาให้เป็น 00:00:00 เพื่อให้การเปรียบเทียบวันหมดอายุคงที่
    result.setHours(0, 0, 0, 0); 
    return result;
}

// ⭐️ ฟังก์ชันคำนวณวันหมดอายุหลัก (ใช้ค่าจาก SystemConfig)
export function calculateExpiryDate(pointType, startDate = new Date()) {
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