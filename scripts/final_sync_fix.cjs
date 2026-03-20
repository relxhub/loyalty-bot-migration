const fs = require('fs');
const path = 'public/products.html';
let html = fs.readFileSync(path, 'utf8');

// 1. Move CORE state and functions to the VERY TOP of the script tag for guaranteed availability
const scriptStartIdx = html.indexOf('<script>') + 8;
const coreLogic = `
        // --- CORE GLOBAL STATE ---
        if (typeof window.cart === 'undefined') window.cart = [];
        if (typeof window.appliedCoupon === 'undefined') window.appliedCoupon = null;
        if (typeof window.allProducts === 'undefined') window.allProducts = [];
        if (typeof window.allCategories === 'undefined') window.allCategories = [];
        if (typeof window.shippingConfig === 'undefined') window.shippingConfig = { fee: 60, freeMin: 500 };

        // --- CORE GLOBAL FUNCTIONS ---
        window.updateQuantity = (productId, change) => {
            console.log('Global updateQuantity called:', productId, change);
            const item = window.cart.find(i => i.id === productId);
            if (!item) return;
            item.quantity += change;
            if (item.quantity <= 0) window.cart = window.cart.filter(i => i.id !== productId);
            
            localStorage.setItem('shoppingCart', JSON.stringify(window.cart));
            if (typeof updateCartIcon === 'function') updateCartIcon();
            if (typeof calculateCartTotals === 'function') calculateCartTotals();
            if (typeof updateProductCardCartControl === 'function') updateProductCardCartControl(productId);
            if (typeof updateCartModalDisplay === 'function') updateCartModalDisplay();
            
            try { window.Telegram.WebApp.hapticFeedback.selectionChanged(); } catch(e) {}
        };

        window.addToCart = (productId) => {
            console.log('Global addToCart called:', productId);
            const product = window.allProducts.find(p => p.id === productId);
            if (!product) return;
            const cartItem = window.cart.find(item => item.id === productId);
            if (cartItem) cartItem.quantity++;
            else {
                const category = window.allCategories.find(c => c.id === product.categoryId);
                window.cart.push({ id: product.id, nameEn: product.nameEn, nameTh: product.nameTh, nicotine: product.nicotine, imageUrl: product.imageUrl, price: category ? parseFloat(category.price) : 0, categoryName: category ? category.name : '', categoryId: product.categoryId, quantity: 1 });
            }
            window.updateQuantity(productId, 0); // Trigger UI update
            if (typeof showToast === 'function') showToast('เพิ่มเข้าตะกร้าแล้ว', 'success');
        };
`;

html = html.substring(0, scriptStartIdx) + coreLogic + html.substring(scriptStartIdx);

// 2. Clean up local variable conflicts (ensure they don't overwrite window variables)
html = html.replace(/let cart = \[\];/g, '// Use window.cart');
html = html.replace(/let appliedCoupon = null;/g, '// Use window.appliedCoupon');
html = html.replace(/cart = /g, 'window.cart = ');
html = html.replace(/appliedCoupon = /g, 'window.appliedCoupon = ');
html = html.replace(/!appliedCoupon/g, '!window.appliedCoupon');
html = html.replace(/appliedCoupon\./g, 'window.appliedCoupon.');

// 3. Ensure all quantity buttons in the HTML use window.updateQuantity
html = html.replace(/onclick=\"updateQuantity/g, 'onclick=\"window.updateQuantity');

// 4. Force Coupon area to be visible if there are items
html = html.replace(/couponArea\.classList\.add\('hidden'\);/g, "if(window.cart.length > 0) { couponArea.classList.remove('hidden'); } else { couponArea.classList.add('hidden'); }");

fs.writeFileSync(path, html, 'utf8');
console.log('✅ Advanced Sync and Exposure Complete.');
