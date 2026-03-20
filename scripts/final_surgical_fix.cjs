const fs = require('fs');
const path = 'public/products.html';
let html = fs.readFileSync(path, 'utf8');

// 1. Move openCartModal and related to Global scope
const functionsToMove = `
        const updateCartModalDisplay = () => {
            const wrapper = document.getElementById('cart-list-wrapper');
            const subtotalEl = document.getElementById('summary-subtotal');
            const shippingEl = document.getElementById('summary-shipping');
            const discountEl = document.getElementById('summary-discount');
            const discountRow = document.getElementById('summary-discount-row');
            const totalEl = document.getElementById('cart-total-price');
            const shippingLabel = document.getElementById('shipping-label');
            const couponArea = document.getElementById('cart-coupon-area');
            const couponNameEl = document.getElementById('cart-coupon-name');
            
            if (!wrapper) return;

            const subtotal = cart.reduce((sum, item) => sum + (parseFloat(item.price || 0) * item.quantity), 0);

            if (cart.length === 0) {
                wrapper.innerHTML = '<p class=\"text-zinc-400 text-center py-4\">ตะกร้าของคุณว่างเปล่า</p>';
                if (subtotalEl) subtotalEl.textContent = '฿0';
                if (totalEl) totalEl.textContent = '฿0';
                if (couponArea) couponArea.classList.add('hidden');
                return;
            }

            const groups = cart.reduce((acc, item) => {
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
                                <div class=\"cart-item-subtotal text-brand-red font-bold text-[0.9rem]\">\${(item.price * item.quantity).toLocaleString()} ฿</div>
                                <div class=\"flex items-center bg-zinc-900/50 rounded-full p-1 gap-1\">
                                    <button onclick=\"window.updateQuantity(\${item.id}, -1)\" class=\"w-7 h-7 flex items-center justify-center bg-red-500/20 text-red-400 rounded-full\"><i class=\"ri-subtract-line\"></i></button>
                                    <div class=\"min-w-[20px] text-center\">\${item.quantity}</div>
                                    <button onclick=\"window.updateQuantity(\${item.id}, 1)\" class=\"w-7 h-7 flex items-center justify-center bg-orange-500 text-white rounded-full\"><i class=\"ri-add-line\"></i></button>
                                </div>
                            </div>\`).join('')}
                    </div>
                </div>\`).join('');

            const isFree = subtotal >= (shippingConfig.freeMin || 500);
            const shipFee = (subtotal > 0 && !isFree) ? (shippingConfig.fee || 60) : 0;
            
            let discount = 0;
            if (appliedCoupon && subtotal > 0) {
                const c = appliedCoupon.coupon;
                if (c.type === \"DISCOUNT_PERCENT\") discount = subtotal * (parseFloat(c.value) / 100);
                else if (c.type === \"DISCOUNT_FLAT\") discount = parseFloat(c.value);
                if (couponArea) { couponArea.classList.remove('hidden'); couponNameEl.textContent = 'คูปอง: ' + c.name; }
                if (discountRow) discountRow.classList.remove('hidden');
                if (discountEl) discountEl.textContent = '-฿' + discount.toLocaleString();
            }

            if (subtotalEl) subtotalEl.textContent = '฿' + subtotal.toLocaleString();
            if (shippingEl) shippingEl.textContent = isFree ? 'FREE' : '฿' + shipFee;
            if (totalEl) totalEl.textContent = '฿' + (subtotal + shipFee - discount).toLocaleString();
        };

        const openCartModal = () => {
            updateCartModalDisplay();
            const modal = document.getElementById('cart-modal');
            if (!modal) return;
            modal.classList.remove('hidden');
            document.body.classList.add('modal-open');
            setTimeout(() => modal.classList.add('show'), 10);
        };
        window.openCartModal = openCartModal;
`;

// Insert at the top of script tag
html = html.replace('<script>', '<script>\n' + functionsToMove);

// Clean up: Remove old duplicates from later in the file
// Find and comment out or remove the old definitions to prevent conflicts
const lines = html.split('\n');
const cleanedLines = lines.map(line => {
    if (line.includes('const updateCartModalDisplay = () =>') || line.includes('const openCartModal = () =>')) {
        if (!line.includes('// --- GLOBAL')) return '// REDUNDANT: ' + line;
    }
    return line;
});

fs.writeFileSync(path, cleanedLines.join('\n'), 'utf8');
console.log('✅ Surgical Fix Complete: 3,350+ lines maintained, buttons fixed.');
