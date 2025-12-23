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
    const [banners, categories, products, tickerConfig] = await prisma.$transaction([
      prisma.banner.findMany({
        where: { isActive: true },
        orderBy: { order: 'asc' },
      }),
      prisma.category.findMany({
        orderBy: { order: 'asc' },
        select: {
          id: true,
          name: true,
          type: true,
          imageUrl: true,
          productIcon: true,
          order: true,
          price: true,
        },
      }),
      prisma.product.findMany({
        select: {
          id: true,
          nameTh: true,
          nameEn: true,
          tagline: true,
          description: true,
          imageUrl: true,
          flavorIconUrl: true,
          status: true,
          isNew: true,
          isHot: true,
          nicotine: true,
          coolnessLevel: true,
          sweetnessLevel: true,
          flavorIntensityLevel: true,
          color: true,
          battery: true,
          wattage: true,
          createdAt: true,
          updatedAt: true,
          categoryId: true,
          category: true,
        },
        orderBy: {
          nameTh: 'asc',
        },
      }),
      prisma.systemConfig.findUnique({
        where: { key: 'ticker_default_message' }
      })
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
    const tickerMessage = tickerConfig ? tickerConfig.value : "🎉 ยินดีต้อนรับสู่ร้าน Loyalty Shop! สินค้าคุณภาพพร้อมส่ง";
    return { banners, categories, products: productsWithRatings, tickerDefaultMessage: tickerMessage };

  } catch (error) {
    console.error('[SERVICE ERROR] Error in getProductPageData:', error);
    throw new Error('Could not fetch product page data.');
  }
};