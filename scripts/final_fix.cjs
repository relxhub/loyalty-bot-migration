const fs = require('fs');
const path = 'public/products.html';
let html = fs.readFileSync(path, 'utf8');

// 1. Separate HTML from Script
const scriptStartMarker = '<script src=\"/socket.io/socket.io.js\"></script>';
const scriptEndMarker = '</script>';
const firstScriptIdx = html.indexOf(scriptStartMarker);
const lastScriptIdx = html.lastIndexOf(scriptEndMarker) + scriptEndMarker.length;

if (firstScriptIdx === -1) {
    console.log('❌ Could not find script block.');
    process.exit(1);
}

const htmlHead = html.substring(0, firstScriptIdx);
const htmlFoot = html.substring(lastScriptIdx);

// 2. Define the ONE AND ONLY Clean Script
const cleanScript = `
    <script src="/socket.io/socket.io.js"></script>
    <script src="https://telegram.org/js/telegram-web-app.js"></script>
    <script>
        // --- GLOBAL STATE ---
        const tg = window.Telegram.WebApp;
        let allProducts = [], allCategories = [], cart = [], favorites = [];
        let currentUser = null, appliedCoupon = null, selectedGift = null;
        let shippingConfig = { fee: 60, freeMin: 500 };
        let availableCoupons = [];
        let currentFilter = { categoryId: null, searchTerm: '', nicotine: null, specials: new Set() };

        // --- CORE FUNCTIONS ---
        const getTelegramId = () => tg.initDataUnsafe?.user?.id?.toString() || currentUser?.telegramUserId || '';

        const saveCart = () => localStorage.setItem('shoppingCart', JSON.stringify(cart));

        const loadCart = () => {
            const saved = localStorage.getItem('shoppingCart');
            let parsed = saved ? JSON.parse(saved) : [];
            cart = parsed.map(item => {
                const prod = allProducts.find(p => p.id === item.id);
                if (prod) {
                    const cat = allCategories.find(c => c.id === prod.categoryId);
                    item.price = cat ? parseFloat(cat.price) : (item.price || 0);
                    item.categoryName = cat ? cat.name : (item.categoryName || '');
                }
                return item;
            });
            updateCartUI();
        };

        const calculateCartTotals = () => {
            const subtotal = cart.reduce((sum, i) => sum + (parseFloat(i.price || 0) * i.quantity), 0);
            const isFree = subtotal >= shippingConfig.freeMin;
            const shipFee = (subtotal > 0 && !isFree) ? shippingConfig.fee : 0;
            
            let discount = 0;
            if (appliedCoupon && subtotal >= parseFloat(appliedCoupon.coupon.minPurchase || 0)) {
                const c = appliedCoupon.coupon;
                if (c.type === "DISCOUNT_PERCENT") discount = subtotal * (parseFloat(c.value) / 100);
                else if (c.type === "DISCOUNT_FLAT") discount = parseFloat(c.value);
            }

            const net = subtotal + shipFee - discount;

            // Update UI
            const setEl = (id, val) => { const el = document.getElementById(id); if(el) el.textContent = val; };
            setEl('summary-subtotal', '฿' + subtotal.toLocaleString());
            setEl('summary-shipping', isFree ? 'FREE' : '฿' + shipFee);
            setEl('summary-discount', '-฿' + discount.toLocaleString());
            setEl('cart-total-price', '฿' + Math.max(0, net).toLocaleString());
            
            const discRow = document.getElementById('summary-discount-row');
            if(discRow) discRow.classList.toggle('hidden', discount === 0);
            
            const coupArea = document.getElementById('cart-coupon-area');
            if(coupArea) {
                coupArea.classList.toggle('hidden', !appliedCoupon);
                const nameEl = document.getElementById('cart-coupon-name');
                if(nameEl && appliedCoupon) nameEl.textContent = 'คูปอง: ' + appliedCoupon.coupon.name;
            }
        };

        const updateCartUI = async (productId = null) => {
            saveCart();
            const totalItems = cart.reduce((s, i) => s + i.quantity, 0);
            const badge = document.getElementById('cart-item-count');
            if(badge) { badge.textContent = totalItems; badge.classList.toggle('hidden', totalItems === 0); }
            
            calculateCartTotals();
            if (productId) updateProductCardCartControl(productId);
            else renderProducts();

            if (!appliedCoupon) await autoApplyBestCoupon();
            calculateCartTotals(); // Re-calc after coupon
        };

        const updateCartModalDisplay = () => {
            const wrapper = document.getElementById('cart-list-wrapper');
            if (!wrapper) return;
            if (cart.length === 0) {
                wrapper.innerHTML = '<p class=\"text-zinc-400 text-center py-4\">ตะกร้าของคุณว่างเปล่า</p>';
                calculateCartTotals();
                return;
            }
            const groups = cart.reduce((acc, i) => { const k = i.categoryName || 'Other'; if(!acc[k]) acc[k]=[]; acc[k].push(i); return acc; }, {});
            wrapper.innerHTML = Object.entries(groups).map(([cat, items]) => \`
                <div class=\"mb-4\">
                    <div class=\"text-[0.8rem] font-bold text-zinc-500 uppercase tracking-wider mb-2 pl-1\">\${cat}</div>
                    <div class=\"space-y-2\">
                        \${items.map(item => \`
                            <div class=\"cart-item-row flex items-center gap-3 text-white p-2.5 bg-zinc-800/50 rounded-xl border border-zinc-700/30\">
                                <div class=\"flex-grow min-w-0\">
                                    <p class=\"font-bold text-[1rem] leading-tight truncate\">\${item.nameEn}</p>
                                    <p class=\"text-[0.7rem] text-zinc-400 truncate\">\${item.nameTh || ''}</p>
                                </div>
                                <div class=\"cart-item-subtotal text-brand-red font-bold\">\${(item.price * item.quantity).toLocaleString()} ฿</div>
                                <div class=\"flex items-center bg-zinc-900/50 rounded-full p-1 gap-1 border border-zinc-700/50\">
                                    <button class=\"w-7 h-7 flex items-center justify-center\" onclick=\"window.updateQuantity(\${item.id}, -1)\">
                                        <i class=\"\${item.quantity === 1 ? 'ri-delete-bin-line' : 'ri-subtract-line'}\"></i>
                                    </button>
                                    <div class=\"text-sm font-bold min-w-[20px] text-center\">\${item.quantity}</div>
                                    <button class=\"w-7 h-7 flex items-center justify-center\" onclick=\"window.updateQuantity(\${item.id}, 1)\">
                                        <i class=\"ri-add-line\"></i>
                                    </button>
                                </div>
                            </div>\`).join('')}
                    </div>
                </div>\`).join('');
            calculateCartTotals();
        };

        const autoApplyBestCoupon = async () => {
            if (cart.length === 0) { appliedCoupon = null; return; }
            try {
                const tid = getTelegramId();
                const total = cart.reduce((s, i) => s + (i.price * i.quantity), 0);
                const res = await fetch('/api/coupons/best', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ telegramId: tid, cartItems: cart, totalAmount: total })
                });
                const data = await res.json();
                if (data.success) appliedCoupon = data.bestCoupon;
            } catch (e) {}
        };

        const openCartModal = () => {
            updateCartModalDisplay();
            const m = document.getElementById('cart-modal');
            if(m) { m.classList.remove('hidden'); document.body.classList.add('modal-open'); setTimeout(() => m.classList.add('show'), 10); }
        };

        const openCouponSelection = async () => {
            const list = document.getElementById('available-coupons-list');
            list.innerHTML = '<div class=\"text-center py-8 animate-spin\">...</div>';
            document.getElementById('coupon-select-modal').classList.remove('hidden');
            setTimeout(() => document.getElementById('coupon-select-content').classList.remove('translate-y-full'), 10);
            try {
                const tid = getTelegramId();
                const res = await fetch('/api/coupons/my/' + tid);
                const data = await res.json();
                if (data.success) {
                    availableCoupons = data.coupons.filter(c => c.status === 'AVAILABLE');
                    list.innerHTML = availableCoupons.map(cc => \`
                        <div onclick=\"window.applyManualCoupon('\${cc.coupon.id}')\" class=\"p-4 rounded-2xl border-2 \${appliedCoupon?.coupon?.id === cc.coupon.id ? 'border-yellow-500 bg-yellow-500/10' : 'border-zinc-700'}\">
                            <div class=\"font-bold\">\${cc.coupon.name}</div>
                            <div class=\"text-xs text-zinc-400\">\${cc.coupon.description || ''}</div>
                        </div>\`).join('');
                }
            } catch (e) { list.innerHTML = 'Error'; }
        };

        window.updateQuantity = (id, chg) => {
            const i = cart.find(x => x.id === id);
            if(i) { i.quantity += chg; if(i.quantity <= 0) cart = cart.filter(x => x.id !== id); updateCartUI(id); }
        };
        window.addToCart = (id) => {
            const p = allProducts.find(x => x.id === id);
            if(!p) return;
            const i = cart.find(x => x.id === id);
            if(i) i.quantity++;
            else {
                const c = allCategories.find(cat => cat.id === p.categoryId);
                cart.push({...p, price: c ? parseFloat(c.price) : 0, categoryName: c ? c.name : '', quantity: 1});
            }
            updateCartUI(id);
        };
        window.applyManualCoupon = (id) => {
            appliedCoupon = availableCoupons.find(c => c.coupon.id === id);
            updateCartUI();
            document.getElementById('coupon-select-content').classList.add('translate-y-full');
            setTimeout(() => document.getElementById('coupon-select-modal').classList.add('hidden'), 300);
        };
        window.openCartModal = openCartModal;
        window.openCouponSelection = openCouponSelection;

        document.addEventListener('DOMContentLoaded', async () => {
            tg.ready(); tg.expand();
            try {
                const res = await fetch('/api/products');
                const data = await res.json();
                allProducts = data.products;
                allCategories = data.categories;
                
                const sRes = await fetch('/api/config/shipping');
                const sData = await sRes.json();
                if(sData.success) shippingConfig = { fee: sData.shippingFee, freeMin: sData.freeShippingMin };

                loadCart();
                renderBanners(data.banners);
                renderCategories(data.categories);
                document.getElementById('loader').remove();
                document.getElementById('app-container').classList.remove('hidden');
            } catch (e) { console.error(e); }
        });
    </script>
`;

fs.writeFileSync(path, htmlHead + cleanScript + htmlFoot, 'utf8');
console.log('✅ Final System Cleanup Complete.');
