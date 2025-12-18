import { prisma } from '../db.js';

/**
 * Fetches all data required for the product page, including banners, categories, and products.
 * Uses a transaction to ensure all data is fetched in a single database operation.
 * @returns {Promise<object>} A promise that resolves to an object containing banners, categories, and products.
 */
export const getProductPageData = async () => {
  console.log('[SERVICE TRACE] getProductPageData: Starting...');
  try {
    const [banners, categories, products] = await prisma.$transaction([
      prisma.banner.findMany({
        where: { isActive: true },
        orderBy: { order: 'asc' },
      }),
      prisma.category.findMany({
        orderBy: { name: 'asc' },
      }),
      prisma.product.findMany({
        include: {
          category: true,
        },
        orderBy: {
          name: 'asc',
        },
      }),
    ]);

    console.log('[SERVICE TRACE] getProductPageData: Database transaction successful.');
    return { banners, categories, products };
  } catch (error) {
    console.error('[SERVICE ERROR] Error in getProductPageData:', error);
    throw new Error('Could not fetch product page data.');
  }
};
