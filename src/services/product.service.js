import { prisma } from '../db.js';

/**
 * Fetches all data required for the product page, including banners, categories, and products.
 * Uses a transaction to ensure all data is fetched in a single database operation.
 * @returns {Promise<object>} A promise that resolves to an object containing banners, categories, and products.
 */
export const getProductPageData = async () => {
  console.log('[SERVICE TRACE] getProductPageData: Starting...');
  try {
    // Step 1: Fetch primary data in a transaction
    const [banners, categories, products] = await prisma.$transaction([
      prisma.banner.findMany({
        where: { isActive: true },
        orderBy: { order: 'asc' },
      }),
      prisma.category.findMany({
        orderBy: { order: 'asc' },
      }),
      prisma.product.findMany({
        include: {
          category: true,
        },
        orderBy: {
          nameTh: 'asc',
        },
      }),
    ]);

    // Step 2: Fetch review aggregations in a separate query
    const reviewAggregates = await prisma.productReview.groupBy({
      by: ['productId'],
      _avg: {
        rating: true,
      },
      _count: {
        id: true,
      },
    });

    // Step 3: Create a map for easy lookup
    const ratingMap = new Map();
    reviewAggregates.forEach(agg => {
      ratingMap.set(agg.productId, {
        averageRating: agg._avg.rating,
        reviewCount: agg._count.id,
      });
    });

    // Step 4: Merge the ratings into the product data
    const productsWithRatings = products.map(product => ({
      ...product,
      averageRating: ratingMap.get(product.id)?.averageRating || 0,
      reviewCount: ratingMap.get(product.id)?.reviewCount || 0,
    }));

    console.log('[SERVICE TRACE] getProductPageData: Database transaction and aggregation successful.');
    return { banners, categories, products: productsWithRatings };

  } catch (error) {
    console.error('[SERVICE ERROR] Error in getProductPageData:', error);
    throw new Error('Could not fetch product page data.');
  }
};
