// src/utils/date.utils.js

import { getConfig } from '../config/config.js';

/**
 * Formats a Date object into a readable string for the Asia/Bangkok timezone.
 * @param {Date | string} date The date object or string to format.
 * @returns {string} The formatted date string (e.g., "5 ธ.ค. 2568, 11:03").
 */
export function formatToBangkok(date) {
    if (!date) return 'N/A';
    return new Date(date).toLocaleString('th-TH', {
        timeZone: 'Asia/Bangkok',
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
    });
}

export function addDays(date, days) {
    const result = new Date(date);
    result.setDate(result.getDate() + days);
    // Set time to midnight UTC for consistency
    result.setUTCHours(0, 0, 0, 0); 
    return result;
}

// This function now correctly calculates a future expiry date in UTC
export function calculateExpiryDate(pointType) {
    const startDate = new Date(); // Current time in UTC
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