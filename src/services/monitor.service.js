import { prisma } from '../db.js';

// Cache previous states to detect changes
let productCache = new Map(); // id -> { status, isHot, isNew, updatedAt }
let latestReviewId = 0; // Track the last processed review

/**
 * Initializes the monitor service.
 * Loads initial state from DB to avoid false alarms on startup.
 */
export const initMonitor = async () => {
    console.log("🕵️ Monitor Service: Initializing state...");
    
    // 1. Snapshot Products
    const products = await prisma.product.findMany({
        select: { id: true, status: true, isHot: true, isNew: true, updatedAt: true, nameEn: true }
    });
    products.forEach(p => {
        productCache.set(p.id, { 
            status: p.status, 
            isHot: p.isHot, 
            isNew: p.isNew, 
            updatedAt: p.updatedAt.getTime(),
            name: p.nameEn
        });
    });

    // 2. Snapshot Reviews (Get max ID)
    const lastReview = await prisma.productReview.findFirst({
        orderBy: { id: 'desc' },
        select: { id: true }
    });
    latestReviewId = lastReview ? lastReview.id : 0;

    console.log(`🕵️ Monitor Service: Ready. Tracking ${products.length} products, Latest Review ID: ${latestReviewId}`);
};

/**
 * Polls the database for changes and returns significant events.
 * @returns {Promise<Array>} Array of event objects { type, message, data }
 */
export const checkDatabaseChanges = async () => {
    const events = [];

    try {
        // --- 1. Check Products (Optimized: Filter by updatedAt if possible, but full scan is safer for status toggle via Studio) ---
        // Since Prisma Studio might not update 'updatedAt' if we just toggle enum? 
        // Actually Prisma usually updates 'updatedAt' automatically. Let's assume it does.
        // We fetch ALL products (lightweight select) to be sure we catch manual toggles.
        const products = await prisma.product.findMany({
            select: { id: true, status: true, isHot: true, isNew: true, updatedAt: true, nameEn: true }
        });

        for (const p of products) {
            const cached = productCache.get(p.id);
            const currentUpdate = p.updatedAt.getTime();

            // New Product detected
            if (!cached) {
                productCache.set(p.id, { 
                    status: p.status, isHot: p.isHot, isNew: p.isNew, updatedAt: currentUpdate, name: p.nameEn 
                });
                events.push({
                    type: 'NEW_PRODUCT',
                    message: `✨ สินค้าใหม่มาแล้ว! ${p.nameEn}`,
                    data: p
                });
                continue;
            }

            // Existing Product Change
            // We check values directly because sometimes updatedAt might be tricky with manual DB edits
            
            // Check Restock (OUT -> IN)
            if (cached.status === 'OUT_OF_STOCK' && p.status === 'IN_STOCK') {
                events.push({
                    type: 'RESTOCK',
                    message: `📦 เติมของแล้ว! ${p.nameEn} พร้อมส่ง`,
                    data: p
                });
            }
            // Check Out of Stock (Real-time update request from user)
            else if (cached.status === 'IN_STOCK' && p.status === 'OUT_OF_STOCK') {
                 events.push({
                    type: 'OUT_OF_STOCK', // Technical event for UI update
                    message: null, // No ticker message needed for running out? Or maybe "Sold Out!"
                    data: p
                });
            }

            // Check HOT status change
            if (!cached.isHot && p.isHot) {
                events.push({
                    type: 'HOT_ITEM',
                    message: `🔥 กำลังฮิต! ${p.nameEn} เป็นสินค้าขายดี`,
                    data: p
                });
            }

            // Update Cache if anything changed
            if (cached.status !== p.status || cached.isHot !== p.isHot || cached.isNew !== p.isNew) {
                productCache.set(p.id, { 
                    status: p.status, isHot: p.isHot, isNew: p.isNew, updatedAt: currentUpdate, name: p.nameEn 
                });
            }
        }

        // --- 2. Check New Reviews (4+ Stars) ---
        const newReviews = await prisma.productReview.findMany({
            where: {
                id: { gt: latestReviewId },
                rating: { gte: 4 }
            },
            include: {
                customer: { select: { firstName: true } },
                product: { select: { nameEn: true } }
            }
        });

        for (const r of newReviews) {
            if (r.id > latestReviewId) latestReviewId = r.id;
            events.push({
                type: 'GOOD_REVIEW',
                message: `⭐ ขอบคุณคุณ ${r.customer.firstName} รีวิว 5 ดาวให้ ${r.product.nameEn}`,
                data: r
            });
        }

    } catch (error) {
        console.error("🕵️ Monitor Service Error:", error);
    }

    return events;
};
