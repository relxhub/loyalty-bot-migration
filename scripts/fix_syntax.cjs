const fs = require('fs');
const path = 'public/products.html';
let html = fs.readFileSync(path, 'utf8');

// 1. Re-define the correct autoApplyBestCoupon function (Global)
const correctAutoApply = `
        const autoApplyBestCoupon = async () => {
            if (cart.length === 0) {
                appliedCoupon = null;
                selectedGift = null;
                return;
            }

            try {
                const telegramId = tg.initDataUnsafe?.user?.id.toString() || currentUser?.telegramUserId;
                if (!telegramId) return;

                const totalAmount = cart.reduce((sum, item) => sum + (parseFloat(item.price || 0) * item.quantity), 0);
                
                const res = await fetch('/api/coupons/best', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        telegramId,
                        cartItems: cart.map(i => ({ productId: i.id, categoryId: i.categoryId, qty: i.quantity, price: i.price })),
                        totalAmount
                    })
                });
                const data = await res.json();
                
                if (data.success && data.bestCoupon) {
                    appliedCoupon = data.bestCoupon;
                    calculateCartTotals();
                } else {
                    appliedCoupon = null;
                }
            } catch (err) {
                console.error(\"Auto Apply Coupon Error:\", err);
            }
        };
`;

// 2. Remove the messy OLD functions block entirely to fix syntax errors
const messyBlockStart = html.indexOf('const OLD_updateCartUI');
const messyBlockEnd = html.indexOf('const openCartModal = () =>');

if (messyBlockStart !== -1 && messyBlockEnd !== -1) {
    const head = html.substring(0, messyBlockStart);
    const tail = html.substring(messyBlockEnd);
    html = head + tail;
}

// 3. Insert the correct autoApplyBestCoupon at the top
if (!html.includes('const autoApplyBestCoupon =')) {
    html = html.replace('// --- GLOBAL FUNCTIONS ---', '// --- GLOBAL FUNCTIONS ---\n' + correctAutoApply);
}

// 4. Ensure calculateCartTotals exists and is functional
if (!html.includes('const calculateCartTotals =')) {
    const calcTotals = `
        const calculateCartTotals = () => {
            const subtotalEl = document.getElementById('summary-subtotal');
            const shippingEl = document.getElementById('summary-shipping');
            const discountEl = document.getElementById('summary-discount');
            const discountRow = document.getElementById('summary-discount-row');
            const totalEl = document.getElementById('cart-total-price');
            const couponArea = document.getElementById('cart-coupon-area');
            const couponNameEl = document.getElementById('cart-coupon-name');

            if (!subtotalEl || !totalEl) return;

            const subtotal = cart.reduce((sum, item) => sum + (parseFloat(item.price || 0) * item.quantity), 0);
            subtotalEl.textContent = '฿' + subtotal.toLocaleString('th-TH');

            const isFree = subtotal >= (shippingConfig.freeMin || 500);
            const shipFee = (subtotal > 0 && !isFree) ? (shippingConfig.fee || 60) : 0;
            
            if (shippingEl) {
                shippingEl.textContent = (subtotal > 0 && isFree) ? 'FREE' : '฿' + shipFee;
                shippingEl.className = (subtotal > 0 && isFree) ? 'text-green-500 font-bold' : 'text-zinc-400';
            }

            let discount = 0;
            if (appliedCoupon && subtotal > 0) {
                const c = appliedCoupon.coupon;
                if (subtotal >= parseFloat(c.minPurchase || 0)) {
                    if (c.type === \"DISCOUNT_PERCENT\") discount = subtotal * (parseFloat(c.value) / 100);
                    else if (c.type === \"DISCOUNT_FLAT\") discount = parseFloat(c.value);
                    
                    if (couponArea) {
                        couponArea.classList.remove('hidden');
                        couponNameEl.textContent = 'คูปอง: ' + c.name;
                    }
                    if (discountRow) discountRow.classList.remove('hidden');
                    if (discountEl) discountEl.textContent = '-฿' + discount.toLocaleString('th-TH');
                }
            } else {
                if (couponArea) if(cart.length > 0) couponArea.classList.remove('hidden');
            }

            const net = subtotal + shipFee - discount;
            totalEl.textContent = '฿' + Math.max(0, net).toLocaleString('th-TH');
        };
    `;
    html = html.replace('// --- GLOBAL FUNCTIONS ---', '// --- GLOBAL FUNCTIONS ---\n' + calcTotals);
}

fs.writeFileSync(path, html, 'utf8');
console.log('✅ Syntax Error Fixed and Cart System Cleaned.');
