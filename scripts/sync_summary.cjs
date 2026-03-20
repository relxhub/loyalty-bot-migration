const fs = require('fs');
const path = 'public/products.html';
let html = fs.readFileSync(path, 'utf8');

// 1. Improve calculateCartTotals to ensure ALL summary rows are updated every time
const improvedCalcTotals = `
        window.calculateCartTotals = () => {
            console.log('Calculating Totals...');
            const subtotalEl = document.getElementById('summary-subtotal');
            const shippingEl = document.getElementById('summary-shipping');
            const discountEl = document.getElementById('summary-discount');
            const discountRow = document.getElementById('summary-discount-row');
            const totalEl = document.getElementById('cart-total-price');
            const couponArea = document.getElementById('cart-coupon-area');
            const couponNameEl = document.getElementById('cart-coupon-name');

            if (!window.cart) return;

            // 1. Calculate Real-time Subtotal
            const subtotal = window.cart.reduce((sum, item) => sum + (parseFloat(item.price || 0) * item.quantity), 0);
            if (subtotalEl) subtotalEl.textContent = '฿' + subtotal.toLocaleString('th-TH');

            // 2. Calculate Shipping
            const isFree = subtotal >= (window.shippingConfig?.freeMin || 500);
            const shipFee = (subtotal > 0 && !isFree) ? (window.shippingConfig?.fee || 60) : 0;
            if (shippingEl) {
                shippingEl.textContent = (subtotal > 0 && isFree) ? 'FREE' : '฿' + shipFee;
                shippingEl.className = (subtotal > 0 && isFree) ? 'text-green-500 font-bold' : 'text-zinc-400';
            }

            // 3. Calculate Discount
            let discount = 0;
            if (window.appliedCoupon && subtotal > 0) {
                const c = window.appliedCoupon.coupon;
                if (subtotal >= parseFloat(c.minPurchase || 0)) {
                    if (c.type === "DISCOUNT_PERCENT") discount = subtotal * (parseFloat(c.value) / 100);
                    else if (c.type === "DISCOUNT_FLAT") discount = parseFloat(c.value);
                    
                    if (couponArea) couponArea.classList.remove('hidden');
                    if (couponNameEl) couponNameEl.textContent = 'คูปอง: ' + c.name;
                    if (discountRow) discountRow.classList.remove('hidden');
                    if (discountEl) discountEl.textContent = '-฿' + discount.toLocaleString('th-TH');
                } else {
                    // Min purchase not met
                    if (discountRow) discountRow.classList.add('hidden');
                    discount = 0;
                }
            } else {
                if (discountRow) discountRow.classList.add('hidden');
            }

            // 4. Update Final Net Total
            const net = subtotal + shipFee - discount;
            if (totalEl) totalEl.textContent = '฿' + Math.max(0, net).toLocaleString('th-TH');
        };`;

// Replace the existing calculateCartTotals with the improved one
html = html.replace(/window\.calculateCartTotals = \(\) => \{[\s\S]*?totalEl\.textContent = '฿' \+ Math\.max\(0, net\)\.toLocaleString\('th-TH'\);\s*\};/, improvedCalcTotals);

// 2. Ensure updateQuantity calls the global calculateCartTotals
if (!html.includes('window.calculateCartTotals(); // Real-time update')) {
    html = html.replace('localStorage.setItem(\'shoppingCart\', JSON.stringify(window.cart));', 'localStorage.setItem(\'shoppingCart\', JSON.stringify(window.cart));\n            if (typeof window.calculateCartTotals === \"function\") window.calculateCartTotals(); // Real-time update');
}

fs.writeFileSync(path, html, 'utf8');
console.log('✅ Real-time Summary Sync Complete.');
