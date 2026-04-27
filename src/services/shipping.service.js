import { prisma } from '../db.js';
import fetch from 'node-fetch';
import csvParser from 'csv-parser';
import { Readable } from 'stream';
import { sendNotificationToCustomer } from './notification.service.js';

/**
 * Parses a Google Sheets URL to download and sync shipping tracking numbers.
 * @param {string} sheetUrl 
 * @returns {Promise<{totalProcessed: number, totalUpdated: number, errors: string[]}>}
 */
export async function syncShippingFromGoogleSheet(sheetUrl) {
    const stats = { totalProcessed: 0, totalUpdated: 0, errors: [] };

    try {
        // Extract Doc ID and GID
        const docIdMatch = sheetUrl.match(/\/d\/([a-zA-Z0-9-_]+)/);
        if (!docIdMatch) throw new Error("ไม่พบ Document ID ในลิงก์");
        const docId = docIdMatch[1];
        
        let gid = "0";
        const gidMatch = sheetUrl.match(/[#&]gid=([0-9]+)/);
        if (gidMatch) gid = gidMatch[1];

        const csvUrl = `https://docs.google.com/spreadsheets/d/${docId}/export?format=csv&gid=${gid}`;
        
        const response = await fetch(csvUrl);
        if (!response.ok) throw new Error(`ไม่สามารถดาวน์โหลดข้อมูลจาก Google Sheet ได้ (${response.status})`);
        
        const csvText = await response.text();
        const results = [];
        
        await new Promise((resolve, reject) => {
            Readable.from(csvText)
                .pipe(csvParser())
                .on('data', (data) => results.push(data))
                .on('error', reject)
                .on('end', resolve);
        });

        if (results.length === 0) throw new Error("ไม่พบข้อมูลใดๆ ในตาราง");

        // Assuming Column 1 is Tracking, Column 3 is Phone (0-indexed) or relying on object keys
        // The user's pattern: Column B (เลขพัสดุ), Column D (เบอร์โทรผู้รับ)
        const keys = Object.keys(results[0]);
        // Find keys that contain 'เลขพัสดุ' or are at index 1, and 'เบอร์' or index 3
        const trackingKey = keys.find(k => k.includes('เลขพัสดุ') || k.includes('Tracking')) || keys[1];
        const phoneKey = keys.find(k => k.includes('เบอร์') || k.includes('Phone')) || keys[3];
        const zipcodeKey = keys.find(k => k.includes('รหัสไปรษณีย์') || k.includes('Zip') || k.includes('Postcode'));

        if (!trackingKey || !phoneKey) {
            throw new Error(`ไม่พบคอลัมน์ 'เลขพัสดุ' หรือ 'เบอร์โทร' ในตาราง (พบ: ${keys.join(', ')})`);
        }

        // Group tracking numbers by sanitized phone + zipcode
        const identifierToTracking = new Map();
        for (const row of results) {
            let phone = row[phoneKey]?.toString().replace(/\D/g, ''); // Keep only digits
            let tracking = row[trackingKey]?.toString().trim();
            let zipcode = '';

            // Try to extract zipcode
            if (zipcodeKey && row[zipcodeKey]) {
                zipcode = row[zipcodeKey].toString().replace(/\D/g, '');
            } else {
                // Fallback: search for 5-digit number across all values in the row
                for (const key of keys) {
                    const val = row[key]?.toString() || '';
                    const match = val.match(/\b\d{5}\b/);
                    if (match) {
                        zipcode = match[0];
                        break;
                    }
                }
            }

            if (phone && tracking) {
                // If phone starts with 66, convert to 0 for internal matching
                if (phone.startsWith('66') && phone.length > 10) {
                    phone = '0' + phone.substring(2);
                }
                
                const identifier = zipcode ? `${phone}_${zipcode}` : phone;
                
                if (!identifierToTracking.has(identifier)) {
                    identifierToTracking.set(identifier, { phone, zipcode, trackings: new Set() });
                }
                identifierToTracking.get(identifier).trackings.add(tracking);
                stats.totalProcessed++;
            }
        }

        // Fetch tracking template config
        const trackingConfig = await prisma.systemConfig.findUnique({ where: { key: 'tracking_url_template' } });
        const trackingUrlTemplate = trackingConfig ? trackingConfig.value : 'https://track.thailandpost.co.th/?trackNumber={{TRACK}}';

        // Process each phone number group
        for (const [identifier, groupData] of identifierToTracking.entries()) {
            const { phone, zipcode, trackings } = groupData;
            const trackingNumbersStr = Array.from(trackings).join(', ');

            // First find matching ShippingAddress IDs for this phone number (and zipcode if available)
            const addressWhere = { phone: { contains: phone } };
            if (zipcode) {
                addressWhere.zipcode = zipcode;
            }

            const matchingAddresses = await prisma.shippingAddress.findMany({
                where: addressWhere,
                select: { id: true }
            });

            if (matchingAddresses.length === 0) {
                stats.errors.push(`ไม่พบที่อยู่จัดส่งสำหรับเบอร์: ${phone} ${zipcode ? '(รหัสไปรษณีย์: ' + zipcode + ')' : ''}`);
                continue;
            }

            const addressIds = matchingAddresses.map(a => a.id);

            // Find PROCESSING orders linked to these addresses
            const matchingOrders = await prisma.order.findMany({
                where: {
                    status: 'PROCESSING',
                    shippingAddressId: { in: addressIds }
                },
                include: { customer: true }
            });

            if (matchingOrders.length > 0) {
                for (const order of matchingOrders) {
                    // Update Order
                    await prisma.order.update({
                        where: { id: order.id },
                        data: {
                            status: 'SHIPPED',
                            trackingNumber: trackingNumbersStr
                        }
                    });
                    
                    // Construct tracking links for notification
                    const trackers = Array.from(trackings);
                    let trackingLinksStr = trackers.map(t => {
                        const url = trackingUrlTemplate.replace('{{TRACK}}', t);
                        return `<a href="${url}">${t}</a>`;
                    }).join('\n');

                    // Send Notification to Customer safely
                    if (order.customer && order.customer.telegramUserId) {
                        const msg = `📦 <b>สินค้าของคุณจัดส่งแล้ว!</b>\n\n` +
                                    `ออเดอร์: #${order.id}\n` +
                                    `เลขพัสดุ:\n${trackingLinksStr}\n\n` +
                                    `ขอบคุณที่อุดหนุนครับ 🙏`;
                        
                        try {
                            await sendNotificationToCustomer(order.customer.telegramUserId, msg);
                            // Rate limit pause (100ms) to avoid Telegram 429
                            await new Promise(r => setTimeout(r, 100));
                        } catch (err) {
                            console.error(`Failed to notify ${order.customer.telegramUserId}:`, err.message);
                            stats.errors.push(`แจ้งเตือนลูกค้า ${phone} ไม่สำเร็จ`);
                        }
                    }
                    stats.totalUpdated++;
                }
            } else {
                stats.errors.push(`ไม่พบออเดอร์สถานะเตรียมจัดส่ง (PROCESSING) สำหรับเบอร์: ${phone}`);
            }
        }

        return stats;

    } catch (error) {
        console.error("Sync Shipping Error:", error);
        throw new Error(error.message || "เกิดข้อผิดพลาดในการประมวลผล Google Sheet");
    }
}

/**
 * Get all shipping addresses for a customer
 * @param {string} customerId 
 */
export async function getShippingAddresses(customerId) {
    return await prisma.shippingAddress.findMany({
        where: { customerId },
        orderBy: { isDefault: 'desc' }
    });
}

/**
 * Save or Update a shipping address
 * @param {string} customerId 
 * @param {object} data 
 */
export async function saveShippingAddress(customerId, data) {
    const { id, name, receiverName, phone, address, subdistrict, district, province, zipcode, isDefault } = data;

    // If setting as default, unset others
    if (isDefault) {
        await prisma.shippingAddress.updateMany({
            where: { customerId },
            data: { isDefault: false }
        });
    }

    if (id) {
        // Update
        return await prisma.shippingAddress.update({
            where: { id: parseInt(id) },
            data: {
                name,
                receiverName,
                phone,
                address,
                subdistrict,
                district,
                province,
                zipcode,
                isDefault: !!isDefault
            }
        });
    } else {
        // Create
        return await prisma.shippingAddress.create({
            data: {
                customerId,
                name,
                receiverName,
                phone,
                address,
                subdistrict,
                district,
                province,
                zipcode,
                isDefault: !!isDefault
            }
        });
    }
}

/**
 * Delete a shipping address
 * @param {string} customerId 
 * @param {number} addressId 
 */
export async function deleteShippingAddress(customerId, addressId) {
    return await prisma.shippingAddress.delete({
        where: { 
            id: parseInt(addressId),
            customerId // Ensure it belongs to the customer
        }
    });
}

/**
 * Search Thai addresses for auto-complete
 * @param {string} query Zipcode or Subdistrict/District/Province name
 */
export async function searchThaiAddress(query) {
    if (!query || query.length < 2) return [];

    // Search by zipcode or subdistrict/district/province
    return await prisma.thaiAddress.findMany({
        where: {
            OR: [
                { zipcode: { startsWith: query } },
                { subdistrict: { contains: query } },
                { district: { contains: query } },
                { province: { contains: query } }
            ]
        },
        take: 20 // Limit for performance
    });
}
