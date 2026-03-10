const fs = require('fs');
const path = 'public/products.html';
let html = fs.readFileSync(path, 'utf8');

// 1. Fix addToCart to include price from category
const oldAddToCartRegex = /const addToCart = \(productId\) => \{[\s\S]*?updateCartUI\(productId\); \/\/ Pass productId for surgical update\s*\};/;
const newAddToCart = `const addToCart = (productId) => {
                const product = allProducts.find(p => p.id === productId);
                if (!product) return;

                const cartItem = cart.find(item => item.id === productId);
                if (cartItem) {
                    cartItem.quantity++;
                } else {
                    const category = allCategories.find(c => c.id === product.categoryId);
                    cart.push({
                        id: product.id, 
                        nameEn: product.nameEn,
                        nameTh: product.nameTh,
                        nicotine: product.nicotine,
                        imageUrl: product.imageUrl,
                        price: category ? parseFloat(category.price) : 0,
                        categoryName: category ? category.name : '',
                        categoryId: product.categoryId,
                        quantity: 1 
                    });
                }
                updateCartUI(productId);
                showToast('เพิ่มเข้าตะกร้าแล้ว', 'success');
            };`;

if (html.match(oldAddToCartRegex)) {
    html = html.replace(oldAddToCartRegex, newAddToCart);
    console.log('✅ Fixed addToCart logic.');
} else {
    console.log('⚠️ Could not find old addToCart logic (might be already fixed or different format).');
}

// 2. Fix Coupon URL
const oldCouponUrl = /\/api\/coupons\/customer\/\$\{telegramId\}/g;
if (html.match(oldCouponUrl)) {
    html = html.replace(oldCouponUrl, '/api/coupons/my/${telegramId}');
    console.log('✅ Fixed Coupon API URL.');
}

// 3. Remove duplicated functions that cause "stuck loading" (if any)
// We'll search for redundant declarations of addToCart, updateQuantity, etc.
// In the current state, we suspect there's a scope conflict.

fs.writeFileSync(path, html, 'utf8');
console.log('🚀 products.html repair complete.');
