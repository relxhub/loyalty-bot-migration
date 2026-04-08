const fs = require('fs');
const path = 'public/products.html';
let html = fs.readFileSync(path, 'utf8');

// 1. Completely rewrite window.updateCartModalDisplay to be 100% Real-time
const robustCartDisplay = `
        window.updateCartModalDisplay = () => {
            const wrapper = document.getElementById('cart-list-wrapper');
            const subtotalEl = document.getElementById('summary-subtotal');
            const shippingEl = document.getElementById('summary-shipping');
            const discountEl = document.getElementById('summary-discount');
            const discountRow = document.getElementById('summary-discount-row');
            const totalEl = document.getElementById('cart-total-price');
            const couponArea = document.getElementById('cart-coupon-area');
            const couponNameEl = document.getElementById('cart-coupon-name');
            const shippingLabel = document.getElementById('shipping-label');
            
            if (!wrapper) return;

            // USE window.cart to ensure we have the latest global state
            const currentCart = window.cart || [];

            if (currentCart.length === 0) {
                wrapper.innerHTML = '<p class=\"text-zinc-400 text-center py-4\">ตะกร้าของคุณว่างเปล่า</p>';
                if (subtotalEl) subtotalEl.textContent = '฿0';
                if (shippingEl) shippingEl.textContent = '฿0';
                if (totalEl) totalEl.textContent = '฿0';
                if (couponArea) couponArea.classList.add('hidden');
                if (discountRow) discountRow.classList.add('hidden');
                return;
            }

            // Render Items
            const groups = currentCart.reduce((acc, item) => {
                const key = item.categoryName || 'Other';
                if (!acc[key]) acc[key] = [];
                acc[key].push(item);
                return acc;
            }, {});

            wrapper.innerHTML = Object.entries(groups).map(([cat, items]) => \`
                <div class=\"mb-4\">
                    <div class=\"text-[0.8rem] font-bold text-zinc-500 uppercase tracking-wider mb-2 pl-1\">\${cat}</div>
                    <div class=\"space-y-2\">
                        \${items.map(item => \`
                            <div class=\"cart-item-row flex items-center gap-3 text-white p-2.5 bg-zinc-800/50 rounded-xl border border-zinc-700/30\">
                                <div class=\"flex-grow min-w-0\">
                                    <p class=\"font-bold text-[1rem] leading-tight truncate\">\${item.nameEn}</p>
                                    <p class=\"text-[0.7rem] text-zinc-400 truncate mt-0.5\">\${item.nameTh || ''}</p>
                                </div>
                                <div class=\"cart-item-subtotal text-brand-red font-bold text-[0.9rem]\">\${(parseFloat(item.price || 0) * item.quantity).toLocaleString('th-TH')} ฿</div>
                                <div class=\"flex items-center bg-zinc-900/50 rounded-full p-1 gap-1 border border-zinc-700/50\">
                                    <button class=\"cart-qty-btn btn-minus !w-7 !h-7 !text-xs\" onclick=\"window.updateQuantity(\${item.id}, -1)\">
                                        <i class=\"\${item.quantity === 1 ? 'ri-delete-bin-line' : 'ri-subtract-line'}\"></i>
                                    </button>
                                    <div class=\"cart-qty-display !min-w-[20px] !text-sm\">\${item.quantity}</div>
                                    <button class=\"cart-qty-btn btn-plus !w-7 !h-7 !text-xs\" onclick=\"window.updateQuantity(\${item.id}, 1)\">
                                        <i class=\"ri-add-line\"></i>
                                    </button>
                                </div>
                            </div>
                        \`).join('')}
                    </div>
                </div>\`).join('');

            // --- REAL-TIME CALCULATIONS ---
            const subtotal = currentCart.reduce((sum, item) => sum + (parseFloat(item.price || 0) * item.quantity), 0);
            const isFree = subtotal >= (window.shippingConfig?.freeMin || 500);
            const shipFee = !isFree ? (window.shippingConfig?.fee || 60) : 0;
            
            let discount = 0;
            if (window.appliedCoupon && subtotal > 0) {
                const c = window.appliedCoupon.coupon;
                if (subtotal >= parseFloat(c.minPurchase || 0)) {
                    if (c.type === \"DISCOUNT_PERCENT\") discount = subtotal * (parseFloat(c.value) / 100);
                    else if (c.type === \"DISCOUNT_FLAT\") discount = parseFloat(c.value);
                    
                    if (couponArea) {
                        couponArea.classList.remove('hidden');
                        couponNameEl.textContent = 'คูปอง: ' + c.name;
                    }
                    if (discountRow) discountRow.classList.remove('hidden');
                    if (discountEl) discountEl.textContent = (c.type === \"GIFT\") ? \"FREE GIFT\" : '-฿' + discount.toLocaleString('th-TH');
                } else {
                    if (discountRow) discountRow.classList.add('hidden');
                    discount = 0;
                }
            } else {
                if (couponArea) {
                    if(currentCart.length > 0) couponArea.classList.remove('hidden');
                    if(!window.appliedCoupon) couponNameEl.textContent = 'ยังไม่ได้เลือกคูปอง';
                }
                if (discountRow) discountRow.classList.add('hidden');
            }

            if (subtotalEl) subtotalEl.textContent = '฿' + subtotal.toLocaleString('th-TH');
            if (shippingEl) {
                shippingEl.textContent = isFree ? 'FREE' : '฿' + shipFee;
                shippingEl.className = isFree ? 'text-green-500 font-bold' : 'text-zinc-400';
            }
            if (totalEl) totalEl.textContent = '฿' + Math.max(0, subtotal + shipFee - discount).toLocaleString('th-TH');
        };`;

html = html.replace(/window\.updateCartModalDisplay = \(\) => \{[\s\S]*?if \(totalEl\) totalEl\.textContent = `฿\$\{Math\.max\(0, finalTotal\)\.toLocaleString\('th-TH'\)\}`;\s*\};/, robustCartDisplay);

// 2. Fix applyManualCoupon to ALWAYS close the modal
const newApplyCoupon = `
        const applyManualCoupon = (couponId) => {
            try {
                const target = availableCoupons.find(cc => cc.coupon.id === couponId);
                if (target) {
                    window.appliedCoupon = target;
                    selectedGift = null;
                    showToast('ใช้คูปอง ' + target.coupon.name + ' แล้ว', 'success');
                    
                    // Close modal immediately to ensure UX
                    closeCouponSelection();
                    
                    // Then update UI
                    window.updateCartModalDisplay();
                }
            } catch (err) {
                console.error("Apply Coupon Error:", err);
                closeCouponSelection();
            }
        };`;

html = html.replace(/const applyManualCoupon = \(couponId\) => \{[\s\S]*?closeCouponSelection\(\);\s*\}\s*\};/, newApplyCoupon);

fs.writeFileSync(path, html, 'utf8');
console.log('✅ Final Polish: Multi-row Real-time Summary and Coupon UX Fix Complete.');
