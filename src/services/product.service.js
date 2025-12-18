import { prisma } from '../db.js';

/**
 * Fetches all products with their associated category.
 * @returns {Promise<Array>} A promise that resolves to an array of products.
 */
export const getAllProducts = async () => {
  try {
    const products = await prisma.product.findMany({
      include: {
        category: true, // Include the related category data
      },
      orderBy: {
        name: 'asc', // Sort products by name
      },
    });
    return products;
  } catch (error) {
    console.error('Error fetching all products:', error);
    throw new Error('Could not fetch products.');
  }
};
