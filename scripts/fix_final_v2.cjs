const fs = require('fs');
const path = 'public/products.html';
let html = fs.readFileSync(path, 'utf8');

// 1. Ensure autoApplyBestCoupon is called during initialization
if (!html.includes('await autoApplyBestCoupon();')) {
    html = html.replace('updateCartUI();', 'updateCartUI();\n                await autoApplyBestCoupon();\n                updateCartModalDisplay();');
}

// 2. Fix the updateQuantity function to be globally accessible and functional
const newGlobalFunctions = `
        // --- CONSOLIDATED GLOBAL FUNCTIONS ---
        window.updateQuantity = (productId, change) => {
            const item = cart.find(i => i.id === productId);
            if (!item) return;
            item.quantity += change;
            if (item.quantity <= 0) cart = cart.filter(i => i.id !== productId);
            
            saveCart();
            updateCartIcon();
            calculateCartTotals();
            updateProductCardCartControl(productId);
            updateCartModalDisplay();
            
            try { tg.hapticFeedback.selectionChanged(); } catch(e) {}
        };

        window.addToCart = (productId) => {
            const product = allProducts.find(p => p.id === productId);
            if (!product) return;
            const cartItem = cart.find(item => item.id === productId);
            if (cartItem) cartItem.quantity++;
            else {
                const category = allCategories.find(c => c.id === product.categoryId);
                cart.push({ id: product.id, nameEn: product.nameEn, nameTh: product.nameTh, nicotine: product.nicotine, imageUrl: product.imageUrl, price: category ? parseFloat(category.price) : 0, categoryName: category ? category.name : '', categoryId: product.categoryId, quantity: 1 });
            }
            window.updateQuantity(productId, 0); // Trigger UI update
            showToast('เพิ่มเข้าตะกร้าแล้ว', 'success');
        };
`;

// Insert global functions at the beginning of the script tag
html = html.replace('<script>', '<script>\n' + newGlobalFunctions);

// 3. Fix Coupon Area to show the best coupon details
const autoApplyFix = `
                    if (data.success && data.bestCoupon) {
                        appliedCoupon = data.bestCoupon;
                        calculateCartTotals(); // Update UI with new coupon
                    }
`;
html = html.replace(/if \(data\.success && data\.bestCoupon\) \{[\s\S]*?\}/, autoApplyFix);

fs.writeFileSync(path, html, 'utf8');
console.log('✅ Final System Fixes: Automatic Coupon and Working Buttons.');
