import { prisma } from '../db.js';

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
