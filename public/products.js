
        // --- CORE GLOBAL STATE ---
        if (typeof window.cart === 'undefined') window.cart = [];
        if (typeof window.appliedCoupon === 'undefined') window.appliedCoupon = null;
        if (typeof window.allProducts === 'undefined') window.allProducts = [];
        if (typeof window.allCategories === 'undefined') window.allCategories = [];
        if (typeof window.shippingConfig === 'undefined') window.shippingConfig = { fee: 60, freeMin: 500 };

        // --- CORE GLOBAL FUNCTIONS ---
        window.checkAuth = (actionName) => {
            const tg = window.Telegram.WebApp;
            const isTelegram = tg.initDataUnsafe && tg.initDataUnsafe.user && tg.initDataUnsafe.user.id;
            const user = window.currentUser || (typeof currentUser !== 'undefined' ? currentUser : null);

            if (!isTelegram) {
                const botUsername = (user && user.orderBotUsername) ? user.orderBotUsername : 'ONEHUB_Order_Backup_Bot';
                const confirmOpen = window.confirm(`คุณกำลังใช้งานในโหมดเยี่ยมชม (Guest Mode)\nกรุณาใช้งานผ่านแอป Telegram เพื่อ${actionName} หรือรับสิทธิพิเศษ\n\nต้องการเปิดแอป Telegram ทันทีหรือไม่?`);
                if (confirmOpen) {
                    window.location.href = `https://t.me/${botUsername}/app`;
                }
                return false;
            }

            if (!user || !user.customerId) {
                showToast('กำลังโหลดข้อมูลสมาชิก กรุณารอสักครู่...', 'warning');
                return false;
            }
            return true;
        };

        window.updateQuantity = (productId, change) => {
            if (!window.checkAuth('จัดการตะกร้าสินค้า')) return;
            const item = window.cart.find(i => i.id == productId);
            if (!item) return;

            if (change > 0) {
                const product = window.allProducts.find(p => p.id == productId);
                if (product && (item.quantity + change) > product.stockQuantity) {
                    showToast(`สั่งซื้อได้สูงสุด ${product.stockQuantity} ชิ้น`, 'error');
                    return; // Prevent adding more than stock
                }
            }

            item.quantity += change;
            if (item.quantity <= 0) window.cart = window.cart.filter(i => i.id != productId);

            // Track in PostHog
            if (window.posthog && change !== 0) {
                posthog.capture(change > 0 ? 'Increase Quantity' : 'Decrease Quantity', { 
                    productId: productId,
                    newQuantity: item.quantity
                });
            }

            if (typeof window.updateCartUI === 'function') {
                window.updateCartUI(productId);
            } else {
                localStorage.setItem('shoppingCart', JSON.stringify(window.cart));
            }

            try { window.Telegram.WebApp.hapticFeedback.selectionChanged(); } catch(e) {}
        };
        window.addToCart = (productId) => {
            const product = window.allProducts.find(p => p.id == productId);
            if (!product) return;
            const cartItem = window.cart.find(item => item.id == productId);

            if (cartItem) {
                if (cartItem.quantity + 1 > product.stockQuantity) {
                    showToast(`สั่งซื้อได้สูงสุด ${product.stockQuantity} ชิ้น`, 'error');
                    return;
                }
                cartItem.quantity++;
            } else {
                if (1 > product.stockQuantity) {
                    showToast(`สินค้าหมด`, 'error');
                    return;
                }
                const category = window.allCategories.find(c => c.id === product.categoryId);
                window.cart.push({ id: product.id, nameEn: product.nameEn, nameTh: product.nameTh, nicotine: product.nicotine, imageUrl: product.imageUrl, price: category ? parseFloat(category.price) : 0, categoryName: category ? category.name : '', categoryId: product.categoryId, quantity: 1 });
            }
            
            if (window.posthog) {
                posthog.capture('Add to Cart', { 
                    productId: product.id, 
                    productName: product.nameEn,
                    categoryId: product.categoryId 
                });
            }

            window.updateQuantity(productId, 0); // Trigger UI update
        };

// --- GLOBAL STATE ---
        const tg = window.Telegram.WebApp;
        let allProducts = [];
        let allCategories = [];
        let storeSetting = { lowStockThreshold: 50, outOfStockThreshold: 20 };
        // Use window.cart
        let favorites = []; 
        let currentUser = null;
        let activeProduct = null;
        // Use window.appliedCoupon 
        let selectedGift = null; 
        let shippingConfig = { fee: 60, freeMin: 500 }; // Default values
        let availableCoupons = [];
        let currentFilter = {
            categoryId: null,
            searchTerm: '',
            nicotine: null,
            specials: new Set(), 
        };

        // --- GLOBAL FUNCTIONS ---
        window.updateCartUI = (productId = null) => {
            saveCart();
            window.updateCartIcon();
            
            // 1. Optimistic UI Update: Instantly update the product card buttons or the full list
            if (productId && typeof window.updateProductCardCartControl === 'function') {
                window.updateProductCardCartControl(productId);
            } else {
                if (typeof renderProducts === 'function') renderProducts();
            }

            // ALWAYS update the cart modal display if it exists, to ensure cart items reflect instantly
            if (typeof window.updateCartModalDisplay === 'function') {
                window.updateCartModalDisplay();
            }

            // 2. Background Task: Check coupons and refresh modal totals asynchronously
            const checkCouponsInBackground = async () => {
                if (!window.appliedCoupon) {
                    await window.autoApplyBestCoupon();
                } else {
                    await reVerifyManualCoupon();
                }
                // Refresh modal display again to show updated discount/shipping if changed
                if (typeof window.updateCartModalDisplay === 'function') {
                    window.updateCartModalDisplay();
                }
            };

            checkCouponsInBackground();
        };

        const reVerifyManualCoupon = async () => {
            if (cart.length === 0) {
                window.appliedCoupon = null;
                selectedGift = null;
                return;
            }
            
            try {
                const telegramId = tg.initDataUnsafe?.user?.id?.toString() || window.currentUser?.telegramUserId || currentUser?.telegramUserId;
                const cartItems = cart.map(i => ({ productId: i.id, categoryId: i.categoryId, qty: i.quantity, price: i.price }));
                const totalAmount = cart.reduce((sum, i) => sum + (i.price * i.quantity), 0);

                const res = await fetch('/api/coupons/validate', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ telegramId, couponId: window.appliedCoupon.coupon.id, cartItems, totalAmount, initData: tg.initData })
                });
                
                const data = await res.json();
                if (!res.ok || !data.success) {
                    showToast('เงื่อนไขไม่ครบ คูปองถูกยกเลิกอัตโนมัติ', 'info');
                    window.appliedCoupon = null;
                    selectedGift = null;
                    await window.autoApplyBestCoupon();
                }
            } catch (err) {
                window.appliedCoupon = null;
                selectedGift = null;
            }
        };

        window.updateCartIcon = () => {
            const totalItems = cart.reduce((sum, item) => sum + item.quantity, 0);
            const badge = document.getElementById('cart-item-count');
            if (badge) {
                badge.textContent = totalItems;
                badge.classList.toggle('hidden', totalItems === 0);
            }
            const favBadge = document.getElementById('fav-cart-badge');
            if (favBadge) {
                favBadge.textContent = totalItems;
                favBadge.classList.toggle('hidden', totalItems === 0);
            }
        };

        let cartSyncTimer = null;
        const saveCart = () => {
            localStorage.setItem('shoppingCart', JSON.stringify(window.cart));

            // Debounced background sync to DB (1.5s) so rapid +/- presses don't flood the server
            const telegramId = tg.initDataUnsafe?.user?.id?.toString() || window.currentUser?.telegramUserId || (typeof currentUser !== 'undefined' ? currentUser?.telegramUserId : null);
            if (!telegramId) return;

            if (cartSyncTimer) clearTimeout(cartSyncTimer);
            cartSyncTimer = setTimeout(() => {
                cartSyncTimer = null;
                const cartItems = window.cart.map(i => ({ id: i.id, quantity: i.quantity }));
                fetch('/api/cart/sync', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ telegramId, cartItems, initData: tg.initData })
                }).catch(err => console.error("Failed to sync cart:", err));
            }, 1500);
        };
        const openCartModal = () => {
            window.updateCartModalDisplay();
            const modal = document.getElementById('cart-modal');
            if (!modal) return;
            modal.classList.remove('hidden');
            document.body.classList.add('modal-open');
            setTimeout(() => modal.classList.add('show'), 10);
        };
        window.openCartModal = openCartModal;

        const closeCartModal = () => {
            const modal = document.getElementById('cart-modal');
            if (!modal) return;
            modal.classList.remove('show');
            setTimeout(() => {
                modal.classList.add('hidden');
                document.body.classList.remove('modal-open');
            }, 300);
        };
        window.closeCartModal = closeCartModal;

        
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
                wrapper.innerHTML = '<p class="text-zinc-400 text-center py-4">ตะกร้าของคุณว่างเปล่า</p>';
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

            wrapper.innerHTML = Object.entries(groups).map(([cat, items]) => `
                <div class="mb-4">
                    <div class="text-[0.8rem] font-bold text-zinc-500 uppercase tracking-wider mb-2 pl-1">${cat}</div>
                    <div class="space-y-2">
                        ${items.map(item => {
                            const product = window.allProducts.find(p => p.id == item.id);
                            const maxStock = product ? product.stockQuantity : 0;
                            const isAtMaxStock = item.quantity >= maxStock;
                            return `
                            <div class="cart-item-row flex items-center gap-3 text-white p-2.5 bg-zinc-800/50 rounded-xl border border-zinc-700/30" data-product-id="${item.id}">
                                <div class="flex-grow min-w-0">
                                    <p class="font-bold text-[1rem] leading-tight truncate">${item.nameEn}</p>
                                    <p class="text-[0.7rem] text-zinc-400 truncate mt-0.5">${item.nameTh || ''}</p>
                                </div>
                                <div class="cart-item-subtotal text-brand-red font-bold text-[0.9rem]">${(parseFloat(item.price || 0) * item.quantity).toLocaleString('th-TH')} ฿</div>
                                <div class="flex items-center bg-zinc-900/50 rounded-full p-1 gap-1 border border-zinc-700/50">
                                    <button class="cart-qty-btn btn-minus !w-7 !h-7 !text-xs" onclick="window.updateQuantity(${item.id}, -1)">
                                        <i class="${item.quantity === 1 ? 'ri-delete-bin-line' : 'ri-subtract-line'}"></i>
                                    </button>
                                    <div class="cart-qty-display !min-w-[20px] !text-sm">${item.quantity}</div>
                                    <button class="cart-qty-btn btn-plus !w-7 !h-7 !text-xs ${isAtMaxStock ? 'opacity-50 cursor-not-allowed' : ''}" onclick="window.updateQuantity(${item.id}, 1)" ${isAtMaxStock ? 'disabled' : ''}>
                                        <i class="ri-add-line"></i>
                                    </button>
                                </div>
                            </div>
                            `;
                        }).join('')}
                    </div>
                </div>`).join('');

            // --- REAL-TIME CALCULATIONS ---
            const subtotal = currentCart.reduce((sum, item) => sum + (parseFloat(item.price || 0) * item.quantity), 0);
            const isFree = subtotal >= (window.shippingConfig?.freeMin ?? 500);
            const shipFee = !isFree ? (window.shippingConfig?.fee ?? 60) : 0;
            
            let discount = 0;
            if (window.appliedCoupon && subtotal > 0) {
                const c = window.appliedCoupon.coupon;
                if (subtotal >= parseFloat(c.minPurchase || 0)) {
                    if (c.type === "DISCOUNT_PERCENT") discount = subtotal * (parseFloat(c.value) / 100);
                    else if (c.type === "DISCOUNT_FLAT") discount = parseFloat(c.value);
                    
                    if (couponArea) {
                        couponArea.classList.remove('hidden');
                        couponNameEl.textContent = 'คูปอง: ' + c.name;
                        const couponDescEl = document.getElementById('cart-coupon-desc');
                        if (couponDescEl) {
                            if (window.appliedCoupon.isAuto !== false) {
                                couponDescEl.textContent = 'คูปองนี้ถูกเลือกอัตโนมัติ';
                                couponDescEl.classList.remove('hidden');
                            } else {
                                couponDescEl.classList.add('hidden');
                            }
                        }
                    }
                    if (discountRow) discountRow.classList.remove('hidden');
                    if (discountEl) discountEl.textContent = (c.type === "GIFT") ? "FREE GIFT" : '-฿' + discount.toLocaleString('th-TH');
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

            // --- Free Shipping Progress Bar ---
            const shipArea = document.getElementById('ship-progress-area');
            if (shipArea) {
                const freeMin = window.shippingConfig?.freeMin ?? 500;
                if (subtotal === 0 || freeMin <= 0) {
                    shipArea.classList.add('hidden');
                } else {
                    shipArea.classList.remove('hidden');
                    const fillEl = document.getElementById('ship-progress-fill');
                    const textEl = document.getElementById('ship-progress-text');
                    const pctEl = document.getElementById('ship-progress-percent');
                    const pct = Math.min(100, Math.round((subtotal / freeMin) * 100));
                    if (fillEl) {
                        fillEl.style.width = pct + '%';
                        fillEl.classList.toggle('complete', isFree);
                    }
                    if (pctEl) pctEl.textContent = pct + '%';
                    if (textEl) {
                        if (isFree) {
                            textEl.textContent = '🎉 ได้รับฟรีค่าส่งแล้ว';
                        } else {
                            const remaining = Math.max(0, freeMin - subtotal);
                            textEl.textContent = `ซื้อเพิ่ม ฿${remaining.toLocaleString('th-TH')} รับฟรีค่าส่ง`;
                        }
                    }
                }
            }
        };

        // ==================================================
        // 🏠 SHIPPING ADDRESS SYSTEM
        // ==================================================
        let savedAddresses = [];
        let selectedAddressId = null;

        window.openAddressSelection = async () => {
            document.getElementById('address-modal').classList.remove('hidden');
            setTimeout(() => document.getElementById('address-modal-content').classList.remove('translate-y-full'), 10);
            await fetchAddresses();
        };

        window.closeAddressModal = () => {
            document.getElementById('address-modal-content').classList.add('translate-y-full');
            setTimeout(() => document.getElementById('address-modal').classList.add('hidden'), 300);
            window.hideAddressForm();
        };

        async function fetchAddresses() {
            const container = document.getElementById('address-list-container');
            container.innerHTML = '<div class="text-center py-4"><div class="animate-spin h-6 w-6 border-2 border-brand-red border-t-transparent rounded-full mx-auto"></div></div>';
            
            try {
                const telegramId = tg.initDataUnsafe?.user?.id?.toString() || currentUser?.telegramUserId;
                const res = await fetch(`/api/shipping-addresses/${telegramId}`);
                const data = await res.json();
                
                if (data.success) {
                    savedAddresses = data.addresses;
                    
                    const lastSelected = localStorage.getItem('lastSelectedAddressId');
                    if (lastSelected && savedAddresses.some(a => a.id === parseInt(lastSelected))) {
                        window.selectAddress(parseInt(lastSelected), true);
                    } else {
                        const defaultAddr = savedAddresses.find(a => a.isDefault);
                        if (defaultAddr) window.selectAddress(defaultAddr.id, true);
                    }
                    
                    renderAddresses();
                }
            } catch (err) {
                container.innerHTML = '<p class="text-center text-red-400">โหลดข้อมูลไม่สำเร็จ</p>';
            }
        }

        function renderAddresses() {
            const container = document.getElementById('address-list-container');
            if (savedAddresses.length === 0) {
                container.innerHTML = '<p class="text-center text-zinc-500 py-4 text-sm">คุณยังไม่มีที่อยู่จัดส่งที่บันทึกไว้</p>';
                return;
            }

            container.innerHTML = savedAddresses.map(addr => `
                <div class="p-4 rounded-2xl border-2 transition-all cursor-pointer ${selectedAddressId === addr.id ? 'border-brand-red bg-brand-red/5' : 'border-zinc-700 bg-zinc-900/50'}"
                     onclick="window.selectAddress(${addr.id})">
                    <div class="flex justify-between items-start">
                        <div class="flex-grow min-w-0">
                            <div class="flex items-center gap-2 mb-1">
                                <span class="font-bold text-white">${addr.name}</span>
                                ${addr.isDefault ? '<span class="text-[10px] bg-zinc-700 text-zinc-300 px-1.5 py-0.5 rounded">หลัก</span>' : ''}
                            </div>
                            <div class="text-xs text-zinc-300 font-medium">${addr.receiverName} | ${addr.phone}</div>
                            <div class="text-xs text-zinc-400 mt-1 line-clamp-2">${addr.address} ${addr.subdistrict} ${addr.district} ${addr.province} ${addr.zipcode}</div>
                        </div>
                        <div class="flex flex-col gap-2 ml-3">
                            <button onclick="event.stopPropagation(); window.showAddressForm(${addr.id})" class="text-zinc-500 hover:text-white transition"><i class="ri-edit-line"></i></button>
                            <button onclick="event.stopPropagation(); window.deleteAddress(${addr.id})" class="text-zinc-600 hover:text-red-500 transition"><i class="ri-delete-bin-line"></i></button>
                        </div>
                    </div>
                </div>
            `).join('');
        }

        window.showAddressForm = (id = null) => {
            document.getElementById('address-form-container').classList.remove('hidden');
            document.getElementById('add-new-addr-btn').classList.add('hidden');
            document.getElementById('address-list-container').classList.add('hidden');
            
            const form = {
                id: document.getElementById('addr-id'),
                name: document.getElementById('addr-name'),
                receiver: document.getElementById('addr-receiver'),
                phone: document.getElementById('addr-phone'),
                detail: document.getElementById('addr-detail'),
                subdistrict: document.getElementById('addr-subdistrict'),
                district: document.getElementById('addr-district'),
                province: document.getElementById('addr-province'),
                zipcode: document.getElementById('addr-zipcode'),
                default: document.getElementById('addr-default')
            };

            if (id) {
                const addr = savedAddresses.find(a => a.id === id);
                form.id.value = addr.id;
                form.name.value = addr.name;
                form.receiver.value = addr.receiverName;
                form.phone.value = addr.phone;
                form.detail.value = addr.address;
                form.subdistrict.value = addr.subdistrict;
                form.district.value = addr.district;
                form.province.value = addr.province;
                form.zipcode.value = addr.zipcode;
                form.default.checked = addr.isDefault;
            } else {
                Object.values(form).forEach(el => {
                    if (el.type === 'checkbox') el.checked = false;
                    else el.value = '';
                });
            }
        };

        window.hideAddressForm = () => {
            document.getElementById('address-form-container').classList.add('hidden');
            document.getElementById('add-new-addr-btn').classList.remove('hidden');
            document.getElementById('address-list-container').classList.remove('hidden');
        };

        window.saveAddress = async () => {
            const addressData = {
                id: document.getElementById('addr-id').value,
                name: document.getElementById('addr-name').value,
                receiverName: document.getElementById('addr-receiver').value,
                phone: document.getElementById('addr-phone').value,
                address: document.getElementById('addr-detail').value,
                subdistrict: document.getElementById('addr-subdistrict').value,
                district: document.getElementById('addr-district').value,
                province: document.getElementById('addr-province').value,
                zipcode: document.getElementById('addr-zipcode').value,
                isDefault: document.getElementById('addr-default').checked
            };

            if (!addressData.name || !addressData.receiverName || !addressData.phone || !addressData.zipcode) {
                showToast('กรุณากรอกข้อมูลที่จำเป็นให้ครบถ้วน', 'error');
                return;
            }

            try {
                const telegramId = tg.initDataUnsafe?.user?.id?.toString() || currentUser?.telegramUserId;
                const res = await fetch('/api/shipping-addresses', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ telegramId, initData: tg.initData, addressData })
                });
                const data = await res.json();
                if (data.success) {
                    showToast('บันทึกที่อยู่เรียบร้อย', 'success');
                    window.hideAddressForm();
                    await fetchAddresses();
                }
            } catch (err) {
                showToast('บันทึกไม่สำเร็จ', 'error');
            }
        };

        window.deleteAddress = async (id) => {
            if (!confirm('ยืนยันการลบที่อยู่นี้?')) return;
            try {
                const telegramId = tg.initDataUnsafe?.user?.id?.toString() || currentUser?.telegramUserId;
                const res = await fetch(`/api/shipping-addresses/${telegramId}/${id}`, { method: 'DELETE' });
                const data = await res.json();
                if (data.success) {
                    showToast('ลบที่อยู่เรียบร้อย', 'info');
                    await fetchAddresses();
                }
            } catch (err) {
                showToast('ลบไม่สำเร็จ', 'error');
            }
        };

        window.selectAddress = (id, skipModalClose = false) => {
            selectedAddressId = id;
            localStorage.setItem('lastSelectedAddressId', id);
            const addr = savedAddresses.find(a => a.id === id);
            const display = document.getElementById('selected-address-display');
            if (addr) {
                display.innerHTML = `
                    <div class="flex flex-col text-left">
                        <div class="truncate"><span class="font-bold text-white">${addr.name}</span>: ${addr.receiverName} (${addr.phone})</div>
                        <div class="text-zinc-400 text-[10px] truncate w-full">${addr.address} ${addr.subdistrict} ${addr.district} ${addr.province} ${addr.zipcode}</div>
                    </div>
                `;
                display.classList.remove('hidden');
            }
            if (!skipModalClose) {
                window.closeAddressModal();
            }
            renderAddresses();
        };

        // --- Thai Address Auto-complete ---
        setTimeout(() => {
            const zipcodeInp = document.getElementById('addr-zipcode');
            const suggestionsDiv = document.getElementById('zipcode-suggestions');
            let searchTimeout;

            if (zipcodeInp) {
                zipcodeInp.addEventListener('input', (e) => {
                    clearTimeout(searchTimeout);
                    const q = e.target.value;
                    if (q.length < 2) {
                        suggestionsDiv.classList.add('hidden');
                        return;
                    }

                    searchTimeout = setTimeout(async () => {
                        try {
                            const res = await fetch(`/api/thai-addresses/search?q=${encodeURIComponent(q)}`);
                            const data = await res.json();
                            if (data.success && data.suggestions.length > 0) {
                                suggestionsDiv.innerHTML = data.suggestions.map(s => `
                                    <div class="p-3 border-b border-zinc-700/50 hover:bg-zinc-700/50 cursor-pointer text-xs"
                                         onclick="window.fillAddress('${s.subdistrict}', '${s.district}', '${s.province}', '${s.zipcode}')">
                                        <span class="font-bold text-white">${s.subdistrict}</span> > ${s.district} > ${s.province} <span class="text-brand-red">${s.zipcode}</span>
                                    </div>
                                `).join('');
                                suggestionsDiv.classList.remove('hidden');
                            } else {
                                suggestionsDiv.classList.add('hidden');
                            }
                        } catch (err) {
                            console.error("Search Error:", err);
                        }
                    }, 300);
                });

                window.fillAddress = (sub, dist, prov, zip) => {
                    document.getElementById('addr-subdistrict').value = sub;
                    document.getElementById('addr-district').value = dist;
                    document.getElementById('addr-province').value = prov;
                    document.getElementById('addr-zipcode').value = zip;
                    suggestionsDiv.classList.add('hidden');
                };

                // Close suggestions when clicking outside
                document.addEventListener('click', (e) => {
                    if (!zipcodeInp.contains(e.target) && !suggestionsDiv.contains(e.target)) {
                        suggestionsDiv.classList.add('hidden');
                    }
                });
            }
        }, 1000);


        // --- Manual Coupon Selection Logic ---
        const openCouponSelection = async () => {
            const listContainer = document.getElementById('available-coupons-list');
            listContainer.innerHTML = '<div class="text-center py-8"><div class="animate-spin h-6 w-6 border-2 border-yellow-500 border-t-transparent rounded-full mx-auto"></div></div>';
            
            document.getElementById('coupon-select-modal').classList.remove('hidden');
            setTimeout(() => document.getElementById('coupon-select-content').classList.remove('translate-y-full'), 10);

            try {
                const telegramId = tg.initDataUnsafe?.user?.id.toString() || currentUser?.telegramUserId;
                const res = await fetch(`/api/coupons/my/${telegramId}`);
                const data = await res.json();
                
                if (data.success) {
                    availableCoupons = data.coupons.filter(c => c.status === 'AVAILABLE');
                    renderCouponList();
                }
            } catch (err) {
                listContainer.innerHTML = '<p class="text-center text-red-400">โหลดข้อมูลไม่สำเร็จ</p>';
            }
        };

        const renderCouponList = () => {
            const listContainer = document.getElementById('available-coupons-list');
            const subtotal = cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);

            if (availableCoupons.length === 0) {
                listContainer.innerHTML = '<p class="text-center text-zinc-500 py-8">คุณยังไม่มีคูปองที่ใช้งานได้</p>';
                return;
            }

            const groupedCoupons = availableCoupons.reduce((acc, item) => {
                const cid = item.coupon.id;
                if (!acc[cid]) {
                    acc[cid] = { ...item, count: 1 };
                } else {
                    acc[cid].count++;
                }
                return acc;
            }, {});

            listContainer.innerHTML = Object.values(groupedCoupons).map(cc => {
                const c = cc.coupon;
                const isSelected = window.appliedCoupon && window.appliedCoupon.coupon.id === c.id;
                const minPurchase = parseFloat(c.minPurchase || 0);
                
                const now = new Date();
                const isUpcoming = c.validFrom && new Date(c.validFrom) > now;
                const isLocked = subtotal < minPurchase || isUpcoming;

                const countBadge = cc.count > 1 ? `<span class="ml-2 px-2 py-0.5 bg-zinc-700 text-white text-xs rounded-full font-bold">x${cc.count}</span>` : '';
                
                let statusText = '';
                if (isUpcoming) {
                    statusText = `<div class="text-[10px] mt-2 text-yellow-500"><i class="ri-time-line"></i> เริ่มใช้ได้วันที่ ${new Date(c.validFrom).toLocaleDateString('th-TH')}</div>`;
                } else if (minPurchase > 0) {
                    statusText = `<div class="text-[10px] mt-2 ${isLocked ? 'text-red-400' : 'text-zinc-500'}">ขั้นต่ำ ฿${minPurchase.toLocaleString()} ${isLocked ? `(ขาดอีก ฿${Math.max(0, minPurchase - subtotal).toLocaleString()})` : ''}</div>`;
                }

                return `
                    <div onclick="${isLocked ? '' : `applyManualCoupon('${c.id}')`}"
                         class="p-4 rounded-2xl border-2 transition-all ${isSelected ? 'border-yellow-500 bg-yellow-500/10' : 'border-zinc-700 bg-zinc-900/50'} ${isLocked ? 'opacity-50 grayscale cursor-not-allowed' : 'active:scale-95 cursor-pointer'}">
                        <div class="flex justify-between items-start">
                            <div class="flex-grow">
                                <div class="font-bold text-lg ${isSelected ? 'text-yellow-500' : 'text-white'} flex items-center">${c.name} ${countBadge}</div>
                                <div class="text-xs text-zinc-400 mt-1">${c.description || ''}</div>
                                ${statusText}
                            </div>
                            <div class="flex-shrink-0 ml-3 flex items-center justify-center">
                                ${isSelected ? '<i class="ri-checkbox-circle-fill text-yellow-500 text-2xl"></i>' : '<i class="ri-checkbox-blank-circle-line text-zinc-600 text-2xl"></i>'}
                            </div>
                        </div>
                    </div>
                `;
            }).join('');
        };

        const applyManualCoupon = async (couponId) => {
            try {
                if (window.appliedCoupon && window.appliedCoupon.coupon.id === couponId && !window.appliedCoupon.isAuto) {
                    window.appliedCoupon = null;
                    selectedGift = null;
                    showToast('ยกเลิกการใช้คูปองแล้ว', 'info');
                    renderCouponList();
                    if (typeof window.updateCartModalDisplay === 'function') window.updateCartModalDisplay();
                    return;
                }

                // Collect Cart Info for validation (USING REAL CART)
                const telegramId = tg.initDataUnsafe?.user?.id?.toString() || window.currentUser?.telegramUserId || currentUser?.telegramUserId;
                const cartItems = cart.map(i => ({
                    productId: i.id,
                    categoryId: i.categoryId,
                    qty: i.quantity,
                    price: i.price
                }));
                const totalAmount = cart.reduce((sum, i) => sum + (i.price * i.quantity), 0);

                // Validation Step
                const res = await fetch('/api/coupons/validate', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        telegramId,
                        couponId,
                        cartItems,
                        totalAmount,
                        initData: tg.initData
                    })
                });

                const data = await res.json();

                if (!res.ok || !data.success) {
                    // Show detailed error in a popup
                    tg.showAlert(data.error || 'คูปองนี้ไม่สามารถใช้งานได้ในขณะนี้');
                    return;
                }

                // If success, apply it
                const target = availableCoupons.find(cc => cc.coupon.id === couponId);
                if (target) {
                    window.appliedCoupon = target;
                    window.appliedCoupon.isAuto = false;
                    selectedGift = null;
                    showToast('ใช้คูปอง ' + target.coupon.name + ' แล้ว', 'success');

                    renderCouponList();
                    if (typeof window.updateCartModalDisplay === 'function') window.updateCartModalDisplay();
                    closeCouponSelection();
                }
            } catch (err) {
                console.error("Apply Coupon Error:", err);
                closeCouponSelection();
                tg.showAlert('เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง');
            }
        };
        const closeCouponSelection = () => {
            document.getElementById('coupon-select-content').classList.add('translate-y-full');
            setTimeout(() => document.getElementById('coupon-select-modal').classList.add('hidden'), 300);
        };

        window.openCouponSelection = openCouponSelection;
        window.closeCouponSelection = closeCouponSelection;
        window.applyManualCoupon = applyManualCoupon;

        document.addEventListener('DOMContentLoaded', async function() {
            // --- UI Enhancements: Skeleton Loading ---
            const renderSkeletons = () => {
                const skeletonHTML = `
                    <div class="info-card p-0 overflow-hidden bg-zinc-800 border border-zinc-700/50" style="aspect-ratio: 9/12.5;">
                        <div class="w-full h-[30%] skeleton rounded-none"></div>
                        <div class="p-3 space-y-2 flex-grow flex flex-col justify-end">
                            <div class="h-4 w-3/4 skeleton"></div>
                            <div class="h-3 w-1/2 skeleton"></div>
                            <div class="flex justify-between items-center mt-3">
                                <div class="h-5 w-16 skeleton"></div>
                                <div class="h-8 w-20 skeleton rounded-full"></div>
                            </div>
                        </div>
                    </div>
                `.repeat(6);
                const grid = document.getElementById('product-grid');
                if(grid) {
                    grid.innerHTML = skeletonHTML;
                    grid.style.display = 'grid';
                }
            };

            // Show App & Skeletons immediately
            document.getElementById('loader').remove();
            document.getElementById('app-container').classList.remove('hidden');
            renderSkeletons();

            // --- Search Bar (toggle + debounced filter) ---
            const searchToggleBtn = document.getElementById('search-toggle-btn');
            const searchBarContainer = document.getElementById('search-bar-container');
            const searchInput = document.getElementById('product-search-input');
            const searchClearBtn = document.getElementById('search-clear-btn');
            let searchDebounce;

            if (searchToggleBtn && searchBarContainer) {
                searchToggleBtn.addEventListener('click', () => {
                    const willOpen = searchBarContainer.classList.contains('hidden');
                    searchBarContainer.classList.toggle('hidden');
                    if (willOpen && searchInput) {
                        setTimeout(() => searchInput.focus(), 50);
                    } else if (!willOpen && searchInput && searchInput.value) {
                        // closing while text exists -> clear filter
                        searchInput.value = '';
                        currentFilter.searchTerm = '';
                        if (searchClearBtn) searchClearBtn.classList.add('hidden');
                        if (typeof renderProducts === 'function') renderProducts();
                    }
                });
            }

            if (searchInput) {
                searchInput.addEventListener('input', (e) => {
                    const val = e.target.value;
                    if (searchClearBtn) searchClearBtn.classList.toggle('hidden', !val);
                    clearTimeout(searchDebounce);
                    searchDebounce = setTimeout(() => {
                        currentFilter.searchTerm = (val || '').toLowerCase().trim();
                        if (typeof renderProducts === 'function') renderProducts();
                    }, 300);
                });
            }

            if (searchClearBtn) {
                searchClearBtn.addEventListener('click', () => {
                    if (!searchInput) return;
                    searchInput.value = '';
                    currentFilter.searchTerm = '';
                    searchClearBtn.classList.add('hidden');
                    if (typeof renderProducts === 'function') renderProducts();
                    searchInput.focus();
                });
            }

            // --- Header & Ticker Logic ---
            const topBar = document.getElementById('top-bar');
            const mainHeader = document.getElementById('main-header');
            const tickerBar = document.getElementById('ticker-bar');
            const tickerContent = document.getElementById('ticker-content');
            let tickerTimeout;
            let defaultTickerMessage = ''; // Will be populated from API
            
            // Queue System
            let tickerQueue = []; 
            let isTickerActive = false; // True if showing a temporary event

            const adjustHeaderOffset = () => {
                // Headers are no longer dynamically sticky, they scroll naturally.
                // Main header is now sticky at top: -1px via CSS class.
            };

            const displayTickerMessage = (message, type) => {
                // Internal function to actually render text and animation
                let icon = '<i class="ri-notification-3-fill"></i>';
                if (type === 'RESTOCK') icon = '<i class="ri-box-3-fill text-green-400"></i>';
                if (type === 'NEW_PRODUCT') icon = '<i class="ri-sparkling-fill text-yellow-400"></i>';
                if (type === 'HOT_ITEM') icon = '<i class="ri-fire-fill text-red-500"></i>';
                if (type === 'GOOD_REVIEW') icon = '<i class="ri-star-smile-fill text-yellow-400"></i>';
                if (type === 'DEFAULT') icon = '<i class="ri-store-2-fill text-brand-red"></i>';

                // Reset Animation
                tickerContent.classList.remove('animate-scroll');

                const msgHtml = `<span class="ticker-item">${icon} ${message}</span>`;
                // Duplicate for smooth marquee with wider spacing
                tickerContent.innerHTML = msgHtml + '<span style="margin: 0 4rem;"></span>' + msgHtml + '<span style="margin: 0 4rem;"></span>' + msgHtml;
                
                // Trigger Reflow to restart animation
                void tickerContent.offsetWidth;
                tickerContent.classList.add('animate-scroll');

                tickerBar.classList.remove('hidden');
                adjustHeaderOffset();
            };

            const processQueue = () => {
                if (tickerQueue.length > 0) {
                    isTickerActive = true;
                    const nextEvent = tickerQueue.shift();
                    
                    displayTickerMessage(nextEvent.message, nextEvent.type);

                    if (tickerTimeout) clearTimeout(tickerTimeout);
                    tickerTimeout = setTimeout(() => {
                        processQueue(); // Recursive call for next item
                    }, 15000);
                } else {
                    // Queue empty, revert to default
                    isTickerActive = false;
                    if (defaultTickerMessage) {
                        displayTickerMessage(defaultTickerMessage, 'DEFAULT');
                    } else {
                        tickerBar.classList.add('hidden');
                        adjustHeaderOffset();
                    }
                }
            };

            const showTicker = (message, type = 'DEFAULT', temporary = false) => {
                if (temporary) {
                    // Add to queue
                    tickerQueue.push({ message, type });
                    
                    // If not currently running an event loop, start it
                    if (!isTickerActive) {
                        processQueue();
                    }
                } else {
                    // Setting Default Message (Permanent)
                    // Only display immediately if NOT currently showing an event loop
                    if (!isTickerActive) {
                        displayTickerMessage(message, type);
                    }
                }
            };

            if (topBar && mainHeader) {
                // Initial adjustment
                adjustHeaderOffset();

                // Watch for size changes (e.g. image loading, window resize)
                const resizeObserver = new ResizeObserver(adjustHeaderOffset);
                resizeObserver.observe(topBar);
                
                // Fallback for image load specifically
                const logoImg = topBar.querySelector('img');
                if (logoImg && !logoImg.complete) {
                    logoImg.onload = adjustHeaderOffset;
                }
            }

            const tg = window.Telegram.WebApp;
            tg.ready();
            tg.expand();
            tg.setHeaderColor('#121212');
            tg.setBackgroundColor('#121212');

            // --- Socket.io Real-time Updates ---
            const socket = io();
            socket.on('product_update', (data) => {
                // Update local data
                const productIndex = allProducts.findIndex(p => p.id === data.productId);
                if (productIndex !== -1) {
                    allProducts[productIndex].status = data.status;
                    if (data.stock !== undefined) allProducts[productIndex].stock = data.stock;
                }

                // Surgical UI Update: Only update the specific product card controls
                if (typeof window.updateProductCardCartControl === 'function') {
                    window.updateProductCardCartControl(data.productId);
                }
                
                // If the product is in the cart modal, update it too
                if (!cartModal.classList.contains('hidden')) {
                    window.updateCartModalDisplay();
                }
            });

                                    // --- Ticker Update Listener ---
                                    socket.on('ticker_update', (data) => {
                                        if (!data.message) return;
                                        showTicker(data.message, data.type, true); // True = Temporary (reverts to default)
                                    });
                        
                                    // --- Live User Count ---
                                    socket.on('online_users', (data) => {
                                        const badge = document.getElementById('live-user-badge');
                                        const countEl = document.getElementById('live-user-count');
                                        if (badge && countEl) {
                                            // Smooth number animation or just set
                                            countEl.textContent = `${data.count} ออนไลน์`;
                                            badge.classList.remove('hidden');
                                        }
                                    });            // --- Toast Notification Function (from dashboard.html) ---
            const showToast = (message, type = 'info') => {
                const container = document.getElementById('toast-container');
                if (!container) return;
                
                let icon = '';
                switch(type) {
                    case 'success': icon = '<i class="ri-checkbox-circle-fill"></i>'; break;
                    case 'error': icon = '<i class="ri-close-circle-fill"></i>'; break;
                    default: icon = '<i class="ri-information-fill"></i>';
                }

                const toast = document.createElement('div');
                toast.className = `toast ${type}`;
                toast.innerHTML = `<span class="toast-icon">${icon}</span><span>${message}</span>`;

                container.appendChild(toast);
                
                try { tg.hapticFeedback.notificationOccurred(type === 'error' ? 'error' : 'success'); } catch(e){}

                requestAnimationFrame(() => {
                    setTimeout(() => {
                        toast.classList.add('show');
                    }, 10);
                });

                setTimeout(() => {
                    toast.classList.remove('show');
                    setTimeout(() => toast.remove(), 400);
                }, 1000); // User requested 1 second
            };

            // --- State Management ---
            // REDUNDANT: // CLEANED: let allProducts = [];
            // REDUNDANT: // CLEANED: let allCategories = [];
            // REDUNDANT: // CLEANED: // Use window.cart
            // REDUNDANT: // CLEANED: let favorites = []; // Store favorite product IDs
            // CLEANED: let currentUser = null;
            // CLEANED: let activeProduct = null;
            // CLEANED: // Use window.appliedCoupon // คูปองที่เลือกใช้งานอยู่
            // CLEANED: let selectedGift = null; // ของแถมที่ลูกค้าเลือก
            let currentFilter = {
                categoryId: null,
                searchTerm: '',
                nicotine: null,
                specials: new Set(), 
            };

            // --- DOM Elements ---
            const loader = document.getElementById('loader');
            const appContainer = document.getElementById('app-container');
            const bannerContainer = document.getElementById('banner-container');
            const categorySelector = document.getElementById('category-selector');
            const productGrid = document.getElementById('product-grid');
            const sectionTitle = document.getElementById('product-section-title');
            const categoryNameDisplay = document.getElementById('category-name-display');
            const categoryPriceDisplay = document.getElementById('category-price-display');
            const nicotineFilterContainer = document.getElementById('nicotine-filter-container');
            const specialFilterContainer = document.getElementById('special-filter-container');
            
            // Product Modal Elements
            const productModal = document.getElementById('product-modal');
            const productModalContent = document.getElementById('product-modal-content');
            const closeProductModalBtn = document.getElementById('close-modal-btn');
            const reviewContentContainer = document.getElementById('review-content-container');

            // Cart Elements
            const cartButton = document.getElementById('cart-button');
            const cartItemCount = document.getElementById('cart-item-count');
            const cartModal = document.getElementById('cart-modal');
            const cartModalContent = document.getElementById('cart-modal-content');
            const closeCartModalBtn = document.getElementById('close-cart-modal-btn');
            // const cartItemsContainer = document.getElementById('cart-items-container'); // No longer direct render target
            const cartListWrapper = document.getElementById('cart-list-wrapper'); // New render target
            const cartTotalPrice = document.getElementById('cart-total-price');
            const copyCartBtn = document.getElementById('copy-cart-btn');
            const clearCartBtn = document.getElementById('clear-cart-btn');

            // --- Favorites Functions ---
            const favModal = document.getElementById('fav-modal');
            const favModalContent = document.getElementById('fav-modal-content');
            const favListWrapper = document.getElementById('fav-list-wrapper');
            const favButton = document.getElementById('fav-button');
            const closeFavModalBtn = document.getElementById('close-fav-modal-btn');

            const saveFavorites = () => {
                localStorage.setItem('favorites', JSON.stringify(favorites));

                // Sync to DB in background
                const telegramId = tg.initDataUnsafe?.user?.id?.toString() || window.currentUser?.telegramUserId || currentUser?.telegramUserId;
                if (telegramId) {
                    fetch('/api/favorites/sync', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ telegramId, favorites, initData: tg.initData })
                    }).catch(err => console.error("Failed to sync favorites:", err));
                }
            };

            const loadFavorites = async () => {
                try {
                    const telegramId = tg.initDataUnsafe?.user?.id?.toString() || currentUser?.telegramUserId;
                    if (telegramId) {
                        const res = await fetch(`/api/favorites/${telegramId}`);
                        const data = await res.json();
                        if (data.success) {
                            // Update localStorage from DB as source of truth
                            localStorage.setItem('favorites', JSON.stringify(data.favorites));
                        }
                    }
                } catch (error) {
                    console.error("Failed to load favorites from DB, using local cache:", error);
                }

                const saved = localStorage.getItem('favorites');
                if (saved) {
                    favorites = JSON.parse(saved);
                    updateFavUI();
                }
            };

                        const toggleFavorite = (productId, btnElement) => {
                            if (!window.checkAuth('เพิ่มรายการโปรด')) return;
                            const index = favorites.indexOf(productId);

                            

                            if (index === -1) {

                                favorites.push(productId);

                                if(btnElement) {

                                    btnElement.classList.add('active');

                                    btnElement.querySelector('i').className = 'ri-heart-3-fill';

                                    // Burst Animation

                                    btnElement.classList.remove('animate-burst');

                                    void btnElement.offsetWidth;

                                    btnElement.classList.add('animate-burst');

                                }

                            } else {

                                favorites.splice(index, 1);

                                if(btnElement) {

                                    btnElement.classList.remove('active');

                                    btnElement.classList.remove('animate-burst');

                                    btnElement.querySelector('i').className = 'ri-heart-3-line';

                                }

                            }

                            // Track user in PostHog
                            if (window.posthog) {
                                posthog.capture('Toggle Favorite', { 
                                    productId: productId,
                                    action: index === -1 ? 'add' : 'remove'
                                });
                            }

                            

                            saveFavorites();

                            updateFavUI();

                            

                            try { 

                                if (window.Telegram?.WebApp?.HapticFeedback) {

                                    window.Telegram.WebApp.HapticFeedback.impactOccurred('medium');

                                } else {

                                    tg.HapticFeedback.impactOccurred('medium'); 

                                }

                            } catch(e) {}

                        };

            const updateFavUI = () => {
                const favDot = document.getElementById('fav-dot');
                const favBtnIcon = favButton.querySelector('i');
                
                if (favorites.length > 0) {
                    favDot.classList.remove('hidden');
                    favBtnIcon.classList.add('text-red-500');
                    favBtnIcon.classList.remove('text-zinc-400');
                } else {
                    favDot.classList.add('hidden');
                    favBtnIcon.classList.remove('text-red-500');
                    favBtnIcon.classList.add('text-zinc-400');
                }

                favButton.classList.remove('fav-bump-anim');
                void favButton.offsetWidth; 
                favButton.classList.add('fav-bump-anim');

                // Sync Grid Buttons
                document.querySelectorAll('.fav-btn').forEach(btn => {
                    const id = parseInt(btn.dataset.productId);
                    if(favorites.includes(id)) {
                        btn.classList.add('active');
                        btn.querySelector('i').className = 'ri-heart-3-fill';
                    } else {
                        btn.classList.remove('active');
                        btn.querySelector('i').className = 'ri-heart-3-line';
                    }
                });

                if(!favModal.classList.contains('hidden')) renderFavModal();
            };

            const renderFavModal = () => {
                if (favorites.length === 0) {
                    favListWrapper.innerHTML = `<p class="text-zinc-500 text-center py-8">ยังไม่มีรายการที่ชอบ</p>`;
                    return;
                }

                const favProducts = allProducts.filter(p => favorites.includes(p.id));
                
                const groups = favProducts.reduce((acc, p) => {
                    const catName = allCategories.find(c => c.id === p.categoryId)?.name || 'Other';
                    if (!acc[catName]) acc[catName] = [];
                    acc[catName].push(p);
                    return acc;
                }, {});

                let html = '';
                for (const [catName, products] of Object.entries(groups)) {
                    html += `
                        <div class="bg-zinc-900/50 rounded-xl p-3 border border-zinc-700/30">
                            <h4 class="text-xs font-bold text-zinc-400 mb-2 uppercase tracking-wider">${catName}</h4>
                            <div class="space-y-2">
                                ${products.map(p => {
                                    const cartItem = window.cart.find(item => item.id === p.id);
                                    const isInCart = cartItem && cartItem.quantity > 0;
                                    const outThreshold = window.storeSetting?.outOfStockThreshold || 0;
                                    const isOutOfStock = p.status === 'OUT_OF_STOCK' || p.stockQuantity <= outThreshold;
                                    
                                    let cartControlHtml = '';
                                    if (isOutOfStock) {
                                        cartControlHtml = `<button class="w-8 h-8 rounded-full bg-zinc-700 text-zinc-500 flex items-center justify-center cursor-not-allowed opacity-50 grayscale" disabled><i class="ri-shopping-cart-2-line"></i></button>`;
                                    } else if (isInCart) {
                                        cartControlHtml = `
                                            <div class="flex items-center bg-zinc-900/80 rounded-full p-1 gap-1 border border-zinc-700/50">
                                                <button class="cart-qty-btn btn-minus !w-7 !h-7 !text-xs" data-product-id="${p.id}" data-action="minus">
                                                    <i class="${cartItem.quantity === 1 ? 'ri-delete-bin-line' : 'ri-subtract-line'}"></i>
                                                </button>
                                                <div class="cart-qty-display !min-w-[20px] !text-sm">${cartItem.quantity}</div>
                                                <button class="cart-qty-btn btn-plus !w-7 !h-7 !text-xs" data-product-id="${p.id}" data-action="plus">
                                                    <i class="ri-add-line"></i>
                                                </button>
                                            </div>
                                        `;
                                    } else {
                                        cartControlHtml = `
                                            <button class="add-to-cart-btn w-8 h-8 rounded-full bg-gradient-to-r from-yellow-400 to-orange-500 text-white flex items-center justify-center shadow-lg active:scale-90 transition" 
                                                data-product-id="${p.id}">
                                                <i class="ri-shopping-cart-2-line"></i>
                                            </button>
                                        `;
                                    }

                                    return `
                                        <div class="flex items-center gap-2 bg-zinc-800 rounded-lg p-2 relative overflow-hidden">
                                            <div class="flex-grow min-w-0">
                                                <div class="text-sm font-semibold truncate text-white">
                                                    ${p.nameEn}
                                                </div>
                                                <div class="text-xs text-zinc-400 truncate">
                                                    ${p.nameTh || ''} ${p.nicotine !== null ? `(${p.nicotine}%)` : ''}
                                                </div>
                                            </div>
                                            
                                            <!-- Cart Control Section -->
                                            <div class="flex-shrink-0 cart-control-container" data-product-id="${p.id}" data-mode="mini">
                                                ${cartControlHtml}
                                            </div>

                                            <!-- Remove from Favs Button -->
                                            <button class="w-8 h-8 rounded-full bg-zinc-700/50 text-zinc-400 flex items-center justify-center active:scale-90 transition ml-1" 
                                                onclick="toggleFavorite(${p.id}, null)" title="Remove from Favorites">
                                                <i class="ri-close-line text-lg"></i>
                                            </button>
                                        </div>
                                    `;
                                }).join('')}
                            </div>
                        </div>
                    `;
                }
                favListWrapper.innerHTML = html;
            };

            const openFavModal = () => {
                renderFavModal();
                favModal.classList.remove('hidden');
                document.body.classList.add('modal-open');
                setTimeout(() => favModal.classList.add('show'), 10);
            };

            const closeFavModal = () => {
                favModal.classList.remove('show');
                setTimeout(() => {
                    favModal.classList.add('hidden');
                    document.body.classList.remove('modal-open');
                }, 300);
            };

            // --- Cart Functions ---
            const loadCart = async () => {
                try {
                    const telegramId = tg.initDataUnsafe?.user?.id?.toString() || currentUser?.telegramUserId;
                    if (telegramId) {
                        const res = await fetch(`/api/cart/${telegramId}`);
                        const data = await res.json();
                        if (data.success) {
                            // Update localStorage from DB as source of truth
                            localStorage.setItem('shoppingCart', JSON.stringify(data.items));
                        }
                    }
                } catch (error) {
                    console.error("Failed to load cart from DB, using local cache:", error);
                }

                const savedCart = localStorage.getItem('shoppingCart');
                let parsedCart = savedCart ? JSON.parse(savedCart) : [];

                // --- FIX: Restore missing prices and names for old cart items ---
                window.cart = parsedCart.map(item => {
                    const product = allProducts.find(p => p.id === item.id);
                    if (product) {
                        const category = allCategories.find(c => c.id === product.categoryId);
                        item.nameEn = product.nameEn;
                        item.nameTh = product.nameTh;
                        item.nicotine = product.nicotine;
                        item.imageUrl = product.imageUrl;
                        item.price = category ? parseFloat(category.price) : (item.price || 0);
                        item.categoryName = category ? category.name : (item.categoryName || '');
                        item.categoryId = product.categoryId;
                    } else {
                        item.price = item.price || 0;
                    }
                    return item;
                });

                window.updateCartUI();
            };

            const clearCart = () => {
                if (confirm('ยืนยันล้างตะกร้าสินค้าทั้งหมด?')) {
                    window.cart = [];
                    saveCart();

                    // Refresh everything
                    if (typeof window.updateCartUI === 'function') window.updateCartUI();
                    if (typeof window.calculateCartTotals === 'function') window.calculateCartTotals();
                    if (typeof window.updateCartIcon === 'function') window.updateCartIcon();
                    if (typeof window.updateCartModalDisplay === 'function') window.updateCartModalDisplay();                    
                    // CRITICAL: Refresh the product listing to show "Add" buttons again
                    if (typeof renderProducts === 'function') renderProducts();
                    
                    showToast('ล้างตะกร้าเรียบร้อย', 'info');
                }
            };            
            const addToCart = (productId) => {
                if (!window.checkAuth('หยิบสินค้าลงตะกร้า')) return;
                const product = allProducts.find(p => p.id == productId);
                if (!product) return;

                const cartItem = window.cart.find(item => item.id == productId);
                if (cartItem) {
                    if (cartItem.quantity + 1 > product.stockQuantity) {
                        showToast(`สั่งซื้อได้สูงสุด ${product.stockQuantity} ชิ้น`, 'error');
                        return;
                    }
                    cartItem.quantity++;
                } else {
                    if (1 > product.stockQuantity) {
                        showToast(`สินค้าหมด`, 'error');
                        return;
                    }
                    const category = allCategories.find(c => c.id === product.categoryId);
                    window.cart.push({
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

                // Track in PostHog
                if (window.posthog) {
                    posthog.capture('Add to Cart', { 
                        productId: product.id, 
                        productName: product.nameEn,
                        categoryId: product.categoryId 
                    });
                }

                window.updateCartUI(productId);
            };            
            window.updateProductCardCartControl = (productId) => {
                const product = allProducts.find(p => p.id === productId);
                if (!product) return;

                const containers = document.querySelectorAll(`.cart-control-container[data-product-id="${productId}"]`);
                // Use raw stockQuantity to determine outOfStock state dynamically to fix button stuck bug
                const threshold = storeSetting.outOfStockThreshold || 0;
                const isOutOfStock = product.status === 'OUT_OF_STOCK' || product.stockQuantity <= threshold;

                containers.forEach(container => {
                    const mode = container.dataset.mode || 'standard';
                    container.innerHTML = createCartControlHtml(product, isOutOfStock, mode);
                });
            };

            window.updateCartModalItem = (productId) => {
                const item = window.cart.find(i => i.id == productId);
                const total = cart.reduce((sum, i) => sum + (i.price * i.quantity), 0);
                cartTotalPrice.textContent = `฿${total.toLocaleString('th-TH')}`;

                if (!item) {
                    // Item was removed, full render is safer to handle grouping/titles
                    window.updateCartModalDisplay();
                    return;
                }

                const product = window.allProducts.find(p => p.id == productId);
                const maxStock = product ? product.stockQuantity : 0;
                const isAtMaxStock = item.quantity >= maxStock;

                const row = document.querySelector(`.cart-item-row[data-product-id="${productId}"]`);
                if (row) {
                    const subtotalEl = row.querySelector('.cart-item-subtotal');
                    const qtyDisplayEl = row.querySelector('.cart-qty-display');
                    const minusIcon = row.querySelector('.btn-minus i');
                    const plusBtn = row.querySelector('.btn-plus');

                    if (subtotalEl) subtotalEl.textContent = `${(item.price * item.quantity).toLocaleString('th-TH')} ฿`;
                    if (qtyDisplayEl) qtyDisplayEl.textContent = item.quantity;
                    if (minusIcon) {
                        minusIcon.className = item.quantity === 1 ? 'ri-delete-bin-line' : 'ri-subtract-line';
                    }
                    if (plusBtn) {
                        if (isAtMaxStock) {
                            plusBtn.classList.add('opacity-50', 'cursor-not-allowed');
                            plusBtn.setAttribute('disabled', 'true');
                        } else {
                            plusBtn.classList.remove('opacity-50', 'cursor-not-allowed');
                            plusBtn.removeAttribute('disabled');
                        }
                    }
                }
            };

            window.autoApplyBestCoupon = async () => {
                if (cart.length === 0) {
                    window.appliedCoupon = null;
                    selectedGift = null;
                    return;
                }

                try {
                    const telegramId = tg.initDataUnsafe?.user?.id.toString() || currentUser?.telegramUserId;
                    const totalAmount = cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);
                    
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
                        // Reset gift if coupon changed
                        if (!window.appliedCoupon || window.appliedCoupon.coupon.id !== data.bestCoupon.coupon.id) {
                            selectedGift = null;
                        }
                        window.appliedCoupon = data.bestCoupon;
                        window.appliedCoupon.isAuto = true;
                    } else {
                        window.appliedCoupon = null;
                        selectedGift = null;
                    }
                } catch (err) {
                    console.error("Auto Apply Coupon Error:", err);
                }
            };
            
            const openCartModal = () => {
                window.updateCartModalDisplay();
                const modal = document.getElementById('cart-modal');
                if (!modal) return;
                modal.classList.remove('hidden');
                document.body.classList.add('modal-open');
                setTimeout(() => {
                    modal.classList.add('show');
                }, 10);
            };
            window.openCartModal = openCartModal;

            const closeCartModal = () => {
                const modal = document.getElementById('cart-modal');
                if (!modal) return;
                modal.classList.remove('show');
                setTimeout(() => {
                    modal.classList.add('hidden');
                    document.body.classList.remove('modal-open');
                }, 300);
            };
            window.closeCartModal = closeCartModal;

            // --- NEW: Order History Logic ---
            const openHistoryModal = () => {
                const modal = document.getElementById('history-modal');
                if (!modal) return;
                modal.classList.remove('hidden');
                document.body.classList.add('modal-open');
                setTimeout(() => modal.classList.add('show'), 10);
                fetchHistory();
            };
            window.openHistoryModal = openHistoryModal;

            const closeHistoryModal = () => {
                const modal = document.getElementById('history-modal');
                if (!modal) return;
                modal.classList.remove('show');
                setTimeout(() => {
                    modal.classList.add('hidden');
                    document.body.classList.remove('modal-open');
                }, 300);
            };
            window.closeHistoryModal = closeHistoryModal;

            // Click outside to close for History Modal
            document.getElementById('history-modal')?.addEventListener('click', (e) => {
                if (e.target.id === 'history-modal') closeHistoryModal();
            });

            // ============= Helpers for redesigned history/details =============
            const STATUS_META = {
                PENDING_PAYMENT: { key: 'pending', label: 'รอชำระเงิน', icon: 'ri-time-line', step: 0 },
                PAID:            { key: 'paid', label: 'ชำระเงินแล้ว', icon: 'ri-checkbox-circle-fill', step: 1 },
                PROCESSING:      { key: 'processing', label: 'กำลังแพ็คสินค้า', icon: 'ri-archive-2-line', step: 2 },
                SHIPPED:         { key: 'shipped', label: 'จัดส่งแล้ว', icon: 'ri-truck-fill', step: 3 },
                CANCELLED:       { key: 'cancelled', label: 'ยกเลิกแล้ว', icon: 'ri-close-circle-fill', step: -1 },
            };
            const formatRelativeDate = (iso) => {
                const d = new Date(iso);
                const now = new Date();
                const diffMs = now - d;
                const oneDay = 86400000;
                const sameDay = d.toDateString() === now.toDateString();
                const yesterdayDate = new Date(now.getTime() - oneDay);
                const isYesterday = d.toDateString() === yesterdayDate.toDateString();
                const time = d.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
                if (sameDay) return `วันนี้ ${time}`;
                if (isYesterday) return `เมื่อวาน ${time}`;
                if (diffMs < 7 * oneDay) {
                    const days = Math.floor(diffMs / oneDay);
                    return `${days} วันก่อน · ${time}`;
                }
                return d.toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: 'numeric' }) + ' · ' + time;
            };
            const escapeAttr = (s) => String(s == null ? '' : s).replace(/'/g, "\\'").replace(/"/g, '&quot;');

            window.showOrderDetails = (orderId) => {
                window.currentOpenOrderId = orderId;
                const order = window.currentOrders?.find(o => o.id === orderId);
                if (!order) return;

                const modal = document.getElementById('order-details-modal');
                const body = document.getElementById('order-details-body');
                const footer = document.getElementById('order-details-footer');
                if (!modal || !body) return;

                const meta = STATUS_META[order.status] || STATUS_META.CANCELLED;
                const dateFull = new Date(order.createdAt).toLocaleDateString('th-TH', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

                // ----- Hero with timeline -----
                const isCancelled = order.status === 'CANCELLED';
                const steps = [
                    { label: 'สั่งซื้อ', icon: 'ri-shopping-bag-line' },
                    { label: 'ชำระเงิน', icon: 'ri-bank-card-line' },
                    { label: 'แพ็คสินค้า', icon: 'ri-archive-2-line' },
                    { label: 'จัดส่ง', icon: 'ri-truck-line' },
                ];
                const currentStep = isCancelled ? -1 : (meta.step ?? 0);
                const stepHtml = steps.map((s, idx) => {
                    let cls = '';
                    if (isCancelled) cls = idx === 0 ? 'done' : 'cancelled';
                    else if (idx < currentStep) cls = 'done';
                    else if (idx === currentStep) cls = 'current';
                    const stepIcon = (idx < currentStep || (isCancelled && idx === 0)) ? '<i class="ri-check-line"></i>' : (idx === currentStep && !isCancelled) ? `<i class="${s.icon}"></i>` : (idx + 1);
                    return `
                        <div class="od-step ${cls}">
                            <div class="od-step-dot">${stepIcon}</div>
                            <div class="od-step-label">${s.label}</div>
                        </div>
                    `;
                }).join('');
                const fillPct = isCancelled ? 0 : Math.max(0, Math.min(100, (currentStep / (steps.length - 1)) * 100));

                // ----- Items grouped by category -----
                let subtotal = 0;
                const itemsByCategory = order.items.reduce((acc, item) => {
                    const category = window.allCategories?.find(c => c.id === item.product.categoryId);
                    const categoryName = category ? category.name : 'อื่นๆ';
                    if (!acc[categoryName]) acc[categoryName] = [];
                    acc[categoryName].push(item);
                    return acc;
                }, {});
                const totalUnits = order.items.reduce((s, i) => s + i.quantity, 0);

                let itemsHtml = '';
                Object.entries(itemsByCategory).forEach(([catName, items], idx) => {
                    if (idx > 0) itemsHtml += '<div class="border-t border-white/5 my-2"></div>';
                    itemsHtml += `<div class="text-[10px] font-bold text-zinc-500 uppercase tracking-wider mb-1.5">${catName}</div>`;
                    items.forEach(item => {
                        const price = parseFloat(item.priceAtPurchase);
                        const itemTotal = price * item.quantity;
                        subtotal += itemTotal;
                        const nic = item.product.nicotine !== null ? `<span class="text-[10px] text-zinc-500 ml-1">(${item.product.nicotine}%)</span>` : '';
                        itemsHtml += `
                            <div class="flex justify-between items-center py-1.5">
                                <div class="flex items-center gap-2 min-w-0">
                                    <span class="text-[11px] text-zinc-500 font-mono w-7 flex-shrink-0">×${item.quantity}</span>
                                    <span class="text-sm text-zinc-200 truncate">${item.product.nameEn}${nic}</span>
                                </div>
                                <span class="text-sm text-zinc-300 font-medium whitespace-nowrap ml-2">฿${itemTotal.toLocaleString('th-TH')}</span>
                            </div>
                        `;
                    });
                });

                const discount = parseFloat(order.discountAmount || 0);
                const total = parseFloat(order.totalAmount);
                let shipping = total - subtotal + discount;
                shipping = Math.max(0, Math.round(shipping));

                // ----- Shipping address -----
                let shippingAddressHtml = '';
                if (order.shippingAddress) {
                    const addr = order.shippingAddress;
                    shippingAddressHtml = `
                        <div class="od-section-title"><i class="ri-map-pin-2-fill text-blue-400"></i> ที่อยู่จัดส่ง</div>
                        <div class="od-card flex gap-3 mb-4">
                            <div class="w-10 h-10 rounded-xl bg-blue-500/15 text-blue-400 flex items-center justify-center flex-shrink-0">
                                <i class="ri-home-4-fill"></i>
                            </div>
                            <div class="min-w-0 flex-1">
                                <div class="font-semibold text-white text-sm">${addr.receiverName}</div>
                                <div class="text-xs text-zinc-400 mb-1">${addr.phone}</div>
                                <div class="text-xs text-zinc-300 leading-relaxed">${addr.address} ${addr.subdistrict} ${addr.district} ${addr.province} ${addr.zipcode}</div>
                            </div>
                        </div>
                    `;
                }

                // ----- Tracking -----
                let trackingHtml = '';
                if (order.trackingNumber) {
                    const trackers = order.trackingNumber.split(',').map(t => t.trim()).filter(Boolean);
                    const links = trackers.map(t => {
                        let url = (window.currentTrackingTemplate || '').replace('{{TRACK}}', t);
                        url = url.startsWith('http') ? url : 'https://' + url;
                        return `<a href="${url}" target="_blank" rel="noopener noreferrer" class="inline-flex items-center gap-1.5 px-3 py-2 bg-blue-500/10 hover:bg-blue-500/20 text-blue-300 border border-blue-500/25 rounded-lg text-xs font-mono font-bold active:scale-95 transition"><i class="ri-truck-line"></i> ${t}</a>`;
                    }).join('');
                    trackingHtml = `
                        <div class="od-section-title"><i class="ri-route-line text-blue-400"></i> ตามรอยพัสดุ</div>
                        <div class="od-card mb-4">
                            <div class="text-[11px] text-zinc-400 mb-2">แตะเลขพัสดุเพื่อติดตามสถานะ</div>
                            <div class="flex flex-wrap gap-2">${links}</div>
                        </div>
                    `;
                }

                // ----- Summary -----
                const summaryHtml = `
                    <div class="od-section-title"><i class="ri-bill-line text-yellow-400"></i> สรุปยอดเงิน</div>
                    <div class="od-card summary mb-4">
                        <div class="flex justify-between text-sm py-1 text-zinc-300">
                            <span>ค่าสินค้า (${totalUnits} ชิ้น)</span>
                            <span>฿${subtotal.toLocaleString('th-TH')}</span>
                        </div>
                        ${discount > 0 ? `
                        <div class="flex justify-between text-sm py-1 text-green-400">
                            <span class="flex items-center gap-1"><i class="ri-coupon-line"></i> ส่วนลดคูปอง</span>
                            <span>- ฿${discount.toLocaleString('th-TH')}</span>
                        </div>` : ''}
                        <div class="flex justify-between text-sm py-1 text-zinc-300">
                            <span>ค่าจัดส่ง</span>
                            <span class="${shipping === 0 ? 'text-green-400 font-bold' : ''}">${shipping === 0 ? 'ฟรี' : '฿' + shipping.toLocaleString('th-TH')}</span>
                        </div>
                        <div class="border-t border-white/10 mt-2 pt-2 flex justify-between items-baseline">
                            <span class="font-bold text-white text-sm">ยอดสุทธิ</span>
                            <span class="total-amount-gold text-2xl">฿${total.toLocaleString('th-TH')}</span>
                        </div>
                    </div>
                `;

                // ----- Refund slip (if any) -----
                const refundHtml = order.refundSlipUrl ? `
                    <button onclick="window.showRefundSlip('${escapeAttr(order.refundSlipUrl)}')" class="w-full py-3 bg-white/5 hover:bg-white/10 text-zinc-200 rounded-xl text-sm font-bold active:scale-95 transition border border-white/10 flex justify-center items-center gap-2 mb-4">
                        <i class="ri-file-list-3-line text-lg"></i> ดูสลิปคืนเงิน
                    </button>
                ` : '';

                // ----- Body assembly -----
                body.innerHTML = `
                    <div class="space-y-4 pt-2">
                        <!-- Hero -->
                        <div class="od-hero status-${meta.key}">
                            <div class="relative z-10 text-center">
                                <div class="od-status-icon"><i class="${meta.icon}"></i></div>
                                <div class="text-base font-bold text-white">${meta.label}</div>
                                <div class="font-mono text-[11px] text-zinc-400 mt-1">${order.id}</div>
                                <div class="text-[11px] text-zinc-500 mt-0.5">${dateFull}</div>

                                <!-- Timeline -->
                                <div class="od-timeline">
                                    <div class="od-timeline-line"></div>
                                    <div class="od-timeline-line-fill" style="width: calc(${fillPct}% * 0.84);"></div>
                                    ${stepHtml}
                                </div>
                            </div>
                        </div>

                        ${shippingAddressHtml}
                        ${trackingHtml}

                        <div class="od-section-title"><i class="ri-shopping-bag-3-fill text-orange-400"></i> รายการสินค้า · ${totalUnits} ชิ้น</div>
                        <div class="od-card mb-4">
                            ${itemsHtml}
                        </div>

                        ${summaryHtml}
                        ${refundHtml}
                    </div>
                `;

                // ----- Sticky footer CTAs -----
                let footerHtml = '';
                if (order.status === 'PENDING_PAYMENT') {
                    footerHtml = `
                        <div class="flex gap-2">
                            <button onclick="window.closeOrderDetailsModal(); window.cancelOrder('${order.id}')" class="w-1/3 py-3 bg-zinc-800 hover:bg-zinc-700 text-white rounded-xl text-sm font-bold active:scale-95 transition border border-zinc-700">ยกเลิก</button>
                            <button onclick="window.location.href='payment.html?orderId=${order.id}'" class="w-2/3 py-3 bg-gradient-to-r from-yellow-400 to-orange-500 text-white rounded-xl text-sm font-bold active:scale-95 transition shadow-lg shadow-orange-500/30 flex items-center justify-center gap-2">
                                <i class="ri-bank-card-line"></i> ชำระเงิน
                            </button>
                        </div>
                    `;
                } else if (order.status === 'PAID' || order.status === 'PROCESSING' || order.status === 'SHIPPED' || order.status === 'CANCELLED') {
                    footerHtml = `
                        <button onclick="window.closeOrderDetailsModal(); window.reorder('${order.id}')" class="w-full py-3 bg-gradient-to-r from-yellow-400 to-orange-500 text-white rounded-xl text-sm font-bold active:scale-95 transition shadow-lg shadow-orange-500/30 flex items-center justify-center gap-2">
                            <i class="ri-restart-line text-lg"></i> สั่งซื้ออีกครั้ง
                        </button>
                    `;
                }
                if (footer) {
                    if (footerHtml) {
                        footer.innerHTML = footerHtml;
                        footer.classList.remove('hidden');
                    } else {
                        footer.classList.add('hidden');
                        footer.innerHTML = '';
                    }
                }

                modal.classList.remove('hidden');
                setTimeout(() => modal.classList.add('show'), 10);
            };

            window.closeOrderDetailsModal = () => {
                window.currentOpenOrderId = null;
                const modal = document.getElementById('order-details-modal');
                if (!modal) return;
                modal.classList.remove('show');
                setTimeout(() => {
                    modal.classList.add('hidden');
                }, 300);
            };

            window.showRefundSlip = (url) => {
                const modal = document.getElementById('refund-slip-modal');
                const img = document.getElementById('refund-slip-img');
                if (modal && img) {
                    img.src = url;
                    modal.classList.remove('hidden');
                    setTimeout(() => modal.classList.add('show'), 10);
                }
            };
            window.closeRefundSlip = () => {
                const modal = document.getElementById('refund-slip-modal');
                if (modal) {
                    modal.classList.remove('show');
                    setTimeout(() => modal.classList.add('hidden'), 300);
                }
            };


            document.getElementById('order-details-modal')?.addEventListener('click', (e) => {
                if (e.target.id === 'order-details-modal') window.closeOrderDetailsModal();
            });

            const fetchHistory = async (silent = false) => {
                const wrapper = document.getElementById('history-list-wrapper');
                const isPoll = silent === 'poll';
                if (!silent) wrapper.innerHTML = '<div class="text-center py-8"><div class="animate-spin h-6 w-6 border-2 border-blue-500 border-t-transparent rounded-full mx-auto"></div></div>';
                
                const telegramId = tg.initDataUnsafe?.user?.id?.toString() || window.currentUser?.telegramUserId;
                if (!telegramId) {
                    if (!silent) wrapper.innerHTML = '<div class="text-center py-8 text-zinc-500">ไม่สามารถระบุตัวตนได้</div>';
                    return;
                }

                try {
                    const url = isPoll ? `/api/orders/history/${telegramId}?v=${new Date().getTime()}` : `/api/orders/history/${telegramId}`;
                    const res = await fetch(url, isPoll ? { cache: 'no-cache', headers: { 'x-silent-poll': 'true' } } : undefined);
                    const data = await res.json();
                    if (data.success) {
                        const getOState = (arr) => arr.map(o => ({id: o.id, s: o.status})).sort((a,b) => a.id.localeCompare(b.id));
                        const historyChanged = JSON.stringify(getOState(window.allOrders || [])) !== JSON.stringify(getOState(data.orders));
                        
                        window.allOrders = data.orders;
                        window.currentExpiryMinutes = data.orderExpiryMinutes;
                        window.currentTrackingTemplate = data.trackingUrlTemplate;
                        window.currentHistoryFilter = window.currentHistoryFilter || 'ALL';
                        
                        if (!silent || (isPoll && historyChanged)) {
                            window.filterHistory(window.currentHistoryFilter);
                            
                            // If order details modal is open, refresh it
                            const detailsModal = document.getElementById('order-details-modal');
                            if (detailsModal && !detailsModal.classList.contains('hidden') && window.currentOpenOrderId) {
                                window.showOrderDetails(window.currentOpenOrderId);
                            }
                        }
                        updatePendingBadge(data.orders);
                    } else {
                        if (!silent) wrapper.innerHTML = `<div class="text-center py-8 text-red-500">${data.error || 'โหลดประวัติล้มเหลว'}</div>`;
                    }
                } catch (err) {
                    console.error("Fetch History Error:", err);
                    if (!silent) wrapper.innerHTML = '<div class="text-center py-8 text-red-500">ข้อผิดพลาดในการเชื่อมต่อ</div>';
                }
            };
            
            window.filterHistory = (status) => {
                window.currentHistoryFilter = status;
                
                // Update active tab UI
                const tabs = document.querySelectorAll('.history-tab');
                tabs.forEach(tab => {
                    if (tab.dataset.status === status || tab.getAttribute('onclick').includes(`'${status}'`)) {
                        tab.classList.remove('text-zinc-500', 'hover:text-zinc-300', 'border-transparent');
                        tab.classList.add('text-brand-red', 'border-b-2', 'border-brand-red', 'active');
                    } else {
                        tab.classList.add('text-zinc-500', 'hover:text-zinc-300', 'border-transparent');
                        tab.classList.remove('text-brand-red', 'border-b-2', 'border-brand-red', 'active');
                    }
                });

                let filteredOrders = window.allOrders || [];
                if (status !== 'ALL') {
                    filteredOrders = filteredOrders.filter(o => o.status === status);
                }
                
                renderHistory(filteredOrders, window.currentExpiryMinutes, window.currentTrackingTemplate);
            };
            
            const updatePendingBadge = (orders) => {
                const pendingCount = orders.filter(o => o.status === 'PENDING_PAYMENT').length;
                const badge = document.getElementById('history-badge');
                if (badge) {
                    if (pendingCount > 0) {
                        badge.textContent = pendingCount;
                        badge.classList.remove('hidden');
                    } else {
                        badge.classList.add('hidden');
                    }
                }
            };

            const renderHistory = (orders, expiryMinutes = 30, trackingUrlTemplate = '') => {
                window.currentOrders = orders;
                window.currentTrackingTemplate = trackingUrlTemplate;
                const wrapper = document.getElementById('history-list-wrapper');
                if (!orders || orders.length === 0) {
                    wrapper.innerHTML = `
                        <div class="flex flex-col items-center justify-center py-16 text-zinc-500 gap-3">
                            <div class="w-16 h-16 rounded-full bg-zinc-800/60 flex items-center justify-center">
                                <i class="ri-receipt-line text-3xl text-zinc-600"></i>
                            </div>
                            <p class="text-sm">ยังไม่มีประวัติการสั่งซื้อ</p>
                            <button onclick="window.closeHistoryModal()" class="mt-2 px-5 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded-lg text-xs font-bold transition active:scale-95">เริ่มช้อปปิ้ง</button>
                        </div>`;
                    return;
                }

                if (window.historyIntervals) {
                    window.historyIntervals.forEach(clearInterval);
                }
                window.historyIntervals = [];

                const now = Date.now();
                let html = '';

                orders.forEach(order => {
                    const meta = STATUS_META[order.status] || STATUS_META.CANCELLED;
                    const dateRel = formatRelativeDate(order.createdAt);
                    const totalUnits = (order.items || []).reduce((s, i) => s + i.quantity, 0);

                    // Item preview chips (max 3 + "+N more")
                    const items = order.items || [];
                    const previewItems = items.slice(0, 3).map(i => {
                        const nic = i.product.nicotine !== null ? ` ${i.product.nicotine}%` : '';
                        return `<span class="item-chip">${i.product.nameEn}${nic} ×${i.quantity}</span>`;
                    }).join('');
                    const moreItems = items.length > 3 ? `<span class="item-chip">+${items.length - 3} รายการ</span>` : '';

                    // Pending expiry & status
                    let pillLabel = meta.label;
                    let pillClass = meta.key;
                    let expiryHtml = '';
                    let actionsHtml = '';

                    if (order.status === 'PENDING_PAYMENT') {
                        const expiryMs = new Date(order.createdAt).getTime() + (expiryMinutes * 60 * 1000);
                        const remainingMs = expiryMs - now;
                        if (remainingMs > 0) {
                            expiryHtml = `<div class="text-[11px] text-orange-400 mt-1.5 font-mono flex items-center gap-1"><i class="ri-timer-flash-line"></i> หมดเวลาใน <span id="countdown-${order.id}">--:--</span></div>`;
                            actionsHtml = `
                                <div class="flex gap-2 mt-3 pt-3 border-t border-white/5">
                                    <button onclick="event.stopPropagation(); window.cancelOrder('${order.id}')" class="flex-1 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded-lg text-xs font-bold active:scale-95 transition border border-zinc-700">ยกเลิก</button>
                                    <button onclick="event.stopPropagation(); window.location.href='payment.html?orderId=${order.id}'" class="flex-1 py-2 bg-gradient-to-r from-yellow-400 to-orange-500 text-white rounded-lg text-xs font-bold active:scale-95 transition shadow-md shadow-orange-500/20 flex items-center justify-center gap-1">
                                        <i class="ri-bank-card-line"></i> ชำระเงิน
                                    </button>
                                </div>`;

                            setTimeout(() => {
                                const el = document.getElementById(`countdown-${order.id}`);
                                if (!el) return;
                                const updateTimer = () => {
                                    const r = expiryMs - Date.now();
                                    if (r <= 0) {
                                        el.textContent = "00:00";
                                        const hm = document.getElementById('history-modal');
                                        if (hm && !hm.classList.contains('hidden')) fetchHistory();
                                        return false;
                                    }
                                    const m = Math.floor(r / 60000);
                                    const s = Math.floor((r % 60000) / 1000);
                                    el.textContent = `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
                                    return true;
                                };
                                updateTimer();
                                const intv = setInterval(() => { if (!updateTimer()) clearInterval(intv); }, 1000);
                                window.historyIntervals.push(intv);
                            }, 0);
                        } else {
                            pillLabel = 'หมดเวลาชำระเงิน';
                            pillClass = 'cancelled';
                        }
                    } else if (order.trackingNumber && order.status === 'SHIPPED') {
                        const trackers = order.trackingNumber.split(',').map(t => t.trim()).filter(Boolean).slice(0, 2);
                        const links = trackers.map(t => {
                            let url = trackingUrlTemplate.replace('{{TRACK}}', t);
                            url = url.startsWith('http') ? url : 'https://' + url;
                            return `<a href="${url}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()" class="inline-flex items-center gap-1.5 px-2.5 py-1 bg-blue-500/10 hover:bg-blue-500/20 text-blue-300 border border-blue-500/25 rounded-md text-[11px] font-mono font-bold transition"><i class="ri-truck-line"></i> ${t}</a>`;
                        }).join('');
                        const more = order.trackingNumber.split(',').length > 2 ? '<span class="text-[10px] text-zinc-500">+อีก</span>' : '';
                        actionsHtml = `<div class="flex flex-wrap gap-2 mt-3 pt-3 border-t border-white/5">${links}${more}</div>`;
                    }

                    html += `
                        <div class="order-card status-${pillClass} p-4 cursor-pointer" onclick="window.showOrderDetails('${order.id}')">
                            <div class="pl-2">
                                <!-- Top: status + date + arrow -->
                                <div class="flex items-start justify-between gap-2 mb-2.5">
                                    <div class="min-w-0">
                                        <span class="status-pill ${pillClass}"><i class="${meta.icon} text-[11px]"></i> ${pillLabel}</span>
                                        <div class="text-[11px] text-zinc-500 mt-1.5">${dateRel}</div>
                                        ${expiryHtml}
                                    </div>
                                    <i class="ri-arrow-right-s-line text-zinc-500 text-xl flex-shrink-0"></i>
                                </div>

                                <!-- Order ID + items -->
                                <div class="flex flex-wrap items-center gap-1.5 mb-3">
                                    <span class="font-mono text-[10px] text-zinc-500">${order.id}</span>
                                    <span class="text-zinc-700">·</span>
                                    ${previewItems}${moreItems}
                                </div>

                                <!-- Bottom: total -->
                                <div class="flex items-end justify-between pt-2 border-t border-white/5">
                                    <div class="text-[11px] text-zinc-500">${totalUnits} ชิ้น</div>
                                    <div class="text-right">
                                        <div class="text-[10px] text-zinc-500 leading-none mb-0.5">ยอดรวม</div>
                                        <div class="total-amount-gold text-lg leading-none">฿${parseFloat(order.totalAmount).toLocaleString('th-TH')}</div>
                                    </div>
                                </div>

                                ${actionsHtml}
                            </div>
                        </div>
                    `;
                });
                wrapper.innerHTML = html;
            };

            window.cancelOrder = async (orderId) => {
                tg.showConfirm('คุณต้องการยกเลิกคำสั่งซื้อนี้ใช่หรือไม่?', async (confirmed) => {
                    if (confirmed) {
                        try {
                            const res = await fetch(`/api/orders/${orderId}/cancel`, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ initData: tg.initData })
                            });
                            const data = await res.json();
                            if (data.success) {
                                showToast('ยกเลิกคำสั่งซื้อเรียบร้อย', 'success');
                                fetchHistory(); // Refresh list
                            } else {
                                showToast(data.error || 'ยกเลิกไม่สำเร็จ', 'error');
                            }
                        } catch (err) {
                            showToast('เกิดข้อผิดพลาดในการเชื่อมต่อ', 'error');
                        }
                    }
                });
            };

            window.reorder = async (orderId) => {
                const wrapper = document.getElementById('history-list-wrapper');
                const originalHtml = wrapper.innerHTML;
                wrapper.innerHTML = '<div class="text-center py-8"><div class="animate-spin h-6 w-6 border-2 border-blue-500 border-t-transparent rounded-full mx-auto"></div><p class="text-zinc-400 text-xs mt-2">กำลังดึงข้อมูล...</p></div>';

                try {
                    const telegramId = tg.initDataUnsafe?.user?.id?.toString() || window.currentUser?.telegramUserId;
                    const res = await fetch(`/api/orders/history/${telegramId}`);
                    const data = await res.json();
                    
                    if (data.success) {
                        const order = data.orders.find(o => o.id === orderId);
                        if (order && order.items) {
                            let addedCount = 0;
                            let oosCount = 0;
                            
                            // ⭐️ NEW: Clear the cart before adding reordered items
                            window.cart = [];
                            
                            order.items.forEach(item => {
                                const product = window.allProducts.find(p => p.id == item.productId);
                                if (product && product.status !== 'OUT_OF_STOCK' && product.stockQuantity > 0) {
                                    const availableQty = Math.min(item.quantity, product.stockQuantity);
                                    
                                    const cartItem = window.cart.find(c => c.id == product.id);
                                    if (cartItem) {
                                        const newQty = Math.min(cartItem.quantity + availableQty, product.stockQuantity);
                                        cartItem.quantity = newQty;
                                    } else {
                                        const category = window.allCategories.find(c => c.id == product.categoryId);
                                        window.cart.push({
                                            id: product.id, 
                                            nameEn: product.nameEn, 
                                            nameTh: product.nameTh, 
                                            nicotine: product.nicotine, 
                                            imageUrl: product.imageUrl, 
                                            price: category ? parseFloat(category.price) : 0, 
                                            categoryName: category ? category.name : '', 
                                            categoryId: product.categoryId, 
                                            quantity: availableQty 
                                        });
                                    }
                                    addedCount++;
                                    if (availableQty < item.quantity) oosCount++; // Partial add
                                } else {
                                    oosCount++; // Fully out of stock
                                }
                            });
                            
                            saveCart();
                            window.updateCartIcon();
                            
                            closeHistoryModal();
                            setTimeout(() => {
                                if (oosCount > 0) {
                                    showToast('สินค้าบางรายการหมด หรือจำนวนไม่พอ', 'warning');
                                } else {
                                    showToast('เพิ่มรายการลงตะกร้าเรียบร้อย', 'success');
                                }
                                openCartModal();
                            }, 300);
                        }
                    }
                } catch (err) {
                    console.error("Reorder Error:", err);
                    showToast('เกิดข้อผิดพลาดในการดึงข้อมูลสินค้า', 'error');
                } finally {
                    // Restore html in background in case they come back
                    if (document.getElementById('history-modal').classList.contains('hidden')) {
                        wrapper.innerHTML = originalHtml;
                    }
                }
            };
            // --- END NEW ---

            const executeCheckout = async () => {
                if (cart.length === 0) return;

                if (!selectedAddressId) {
                    tg.showAlert('กรุณาเลือกที่อยู่จัดส่งก่อนชำระเงิน');
                    return;
                }

                // --- NEW: Identify and Filter out items that became OUT_OF_STOCK ---
                const outOfStockItems = cart.filter(item => {
                    const product = allProducts.find(p => p.id == item.id);
                    return !product || product.status === 'OUT_OF_STOCK' || product.stockQuantity <= 0;
                });

                const availableItems = cart.filter(item => {
                    const product = allProducts.find(p => p.id == item.id);
                    return product && product.status !== 'OUT_OF_STOCK' && product.stockQuantity > 0;
                });

                // Show notifications for each out-of-stock item
                if (outOfStockItems.length > 0) {
                    outOfStockItems.forEach(item => {
                        showToast(`สินค้า ${item.nameEn} หมด`, 'error');
                    });
                }

                if (availableItems.length === 0) {
                    // All items are gone
                    return;
                }

                if (availableItems.length < cart.length) {
                    // Some items were removed, wait a tiny bit so error toasts are seen first
                    setTimeout(() => {
                        showToast('ตัดรายการสินค้าที่หมดออกให้แล้ว', 'info');
                        // Update cart in state to remove out of stock items before proceeding
                        window.cart = availableItems;
                        window.updateCartUI();
                    }, 500);
                    return; // Stop here, let them review the updated cart
                }

                const total = availableItems.reduce((sum, item) => sum + (item.price * item.quantity), 0);
                const isFree = total >= (window.shippingConfig?.freeMin ?? 500);
                const shipFee = !isFree ? (window.shippingConfig?.fee ?? 60) : 0;
                
                let discountAmount = 0;
                let appliedCouponId = null;

                if (window.appliedCoupon) {
                    const c = window.appliedCoupon.coupon;
                    if (total >= parseFloat(c.minPurchase || 0)) {
                        if (c.type === 'DISCOUNT_PERCENT') discountAmount = total * (parseFloat(c.value) / 100);
                        else if (c.type === 'DISCOUNT_FLAT') discountAmount = parseFloat(c.value);
                        appliedCouponId = c.id;
                    }
                }

                const finalTotal = Math.max(0, total + shipFee - discountAmount);

                try {
                    // Show loading on the button
                    const btn = document.getElementById('copy-cart-btn');
                    const originalText = btn.innerHTML;
                    btn.innerHTML = '<div class="animate-spin h-5 w-5 border-2 border-white border-t-transparent rounded-full mx-auto"></div>';
                    btn.disabled = true;

                    const res = await fetch('/api/orders/checkout', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            initData: tg.initData,
                            cart: availableItems,
                            shippingAddressId: selectedAddressId,
                            appliedCouponId: appliedCouponId,
                            discountAmount: discountAmount,
                            totalAmount: finalTotal
                        })
                    });

                    const data = await res.json();

                    if (data.success) {
                        // Clear the cart immediately since the order is created and saved in History
                        window.cart = [];
                        saveCart();
                        window.updateCartIcon();
                        if (typeof window.updateCartModalDisplay === 'function') window.updateCartModalDisplay();
                        
                        btn.innerHTML = originalText;
                        btn.disabled = false;

                        // Redirect to payment page
                        window.location.href = `payment.html?orderId=${data.orderId}&v=${Date.now()}`;
                    } else if (data.stockIssues) {
                        btn.innerHTML = originalText;
                        btn.disabled = false;

                        // --- NEW: Handle automatic stock adjustment ---
                        let adjustedMessage = '';
                        data.stockIssues.forEach(issue => {
                            const cartItem = window.cart.find(i => i.id == issue.id);
                            if (cartItem) {
                                if (issue.error === 'OUT_OF_STOCK' || issue.available <= 0) {
                                    window.cart = window.cart.filter(i => i.id != issue.id);
                                    showToast(`สินค้า ${issue.name} หมด ถูกตัดออกจากตะกร้าแล้ว`, 'error');
                                } else if (issue.error === 'INSUFFICIENT_STOCK') {
                                    cartItem.quantity = issue.available;
                                    showToast(`สินค้า ${issue.name} เหลือเพียง ${issue.available} ชิ้น ระบบปรับยอดให้แล้ว`, 'warning');
                                }
                            }
                        });

                        // Refresh UI and save corrected cart
                        saveCart();
                        window.updateCartUI();
                        
                        tg.showAlert('สินค้าบางรายการมีการเปลี่ยนแปลงสต็อก ระบบได้ปรับปรุงตะกร้าของคุณให้แล้ว กรุณาตรวจสอบยอดเงินและทำรายการใหม่อีกครั้ง');
                    } else {
                        btn.innerHTML = originalText;
                        btn.disabled = false;
                        
                        // Prevent WebAppPopupParamInvalid by truncating or using toast
                        const errMsg = data.error || 'เกิดข้อผิดพลาดในการสั่งซื้อ';
                        if (errMsg.length > 200) {
                            showToast('เกิดข้อผิดพลาดจากเซิร์ฟเวอร์', 'error');
                            console.error("Backend Error:", errMsg);
                        } else {
                            tg.showAlert(errMsg);
                        }
                    }
                } catch (err) {
                    console.error('Checkout Error:', err);
                    const btn = document.getElementById('copy-cart-btn');
                    btn.innerHTML = 'ชำระเงิน';
                    btn.disabled = false;
                    
                    const errMsg = err.message || 'Unknown error';
                    if (errMsg.length > 200) {
                        showToast('เกิดข้อผิดพลาดในการเชื่อมต่อ', 'error');
                    } else {
                        tg.showAlert(`Error: ${errMsg}`);
                    }
                }
            };

            // --- Fly to Cart Animation ---
            const flyToCart = (btn) => {
                const cartBtn = document.getElementById('cart-button');
                if (!cartBtn) return;

                const card = btn.closest('.info-card');
                if (!card) return;
                
                // Find the active slide's image to ensure we pick the visible one
                const activeSlide = card.querySelector('.swiper-slide-active') || card.querySelector('.swiper-slide');
                const img = activeSlide ? activeSlide.querySelector('img') : card.querySelector('img');
                
                if (!img) return;

                // Identify Product and Category for custom icon
                const productId = parseInt(btn.dataset.productId);
                const product = allProducts.find(p => p.id === productId);
                const category = product ? allCategories.find(c => c.id === product.categoryId) : null;
                const customIconUrl = category?.productIcon;

                const imgRect = img.getBoundingClientRect();
                const cartRect = cartBtn.getBoundingClientRect();

                let clone;
                if (customIconUrl) {
                    clone = document.createElement('img');
                    clone.src = customIconUrl;
                    clone.style.objectFit = 'contain';
                } else {
                    clone = img.cloneNode();
                }

                clone.style.position = 'fixed';
                clone.style.left = `${imgRect.left}px`;
                clone.style.top = `${imgRect.top}px`;
                clone.style.width = `${imgRect.width * 1.3}px`;
                clone.style.height = `${imgRect.height * 1.3}px`;
                clone.style.zIndex = '9999';
                clone.style.borderRadius = '1rem'; // Match card radius initially
                clone.style.transition = 'all 0.6s cubic-bezier(0.2, 0.8, 0.2, 1)';
                clone.style.opacity = '0.9';
                clone.style.pointerEvents = 'none';

                document.body.appendChild(clone);

                // Force reflow
                requestAnimationFrame(() => {
                    const targetX = cartRect.left + (cartRect.width / 2) - (imgRect.width * 0.1 / 2);
                    const targetY = cartRect.top + (cartRect.height / 2) - (imgRect.height * 0.1 / 2);

                    clone.style.left = `${targetX}px`;
                    clone.style.top = `${targetY}px`;
                    clone.style.transform = 'scale(0.3)';
                    clone.style.opacity = '0.5';
                    clone.style.borderRadius = '50%';
                });

                setTimeout(() => {
                    clone.remove();
                    // Animate cart button
                    cartBtn.classList.add('cart-bump-anim');
                    setTimeout(() => cartBtn.classList.remove('cart-bump-anim'), 300);
                }, 600);
            };

            // --- Product Modal Functions ---
            const openQuickViewModal = (product) => {
                activeProduct = product;
                
                // --- Header Modification ---
                const category = allCategories.find(c => c.id === product.categoryId);
                const modalTitleEl = document.getElementById('modal-product-name');
                const nicotineStr = product.nicotine !== null ? `(${product.nicotine}%)` : '';
                
                // New Header Format:
                // English Name (nicotine%)
                // Thai Name (nicotine%)
                // Category Name
                modalTitleEl.innerHTML = `
                    <div class="flex flex-col items-start gap-0.5">
                        <span class="text-lg font-bold text-white leading-tight">${product.nameEn || ''} ${nicotineStr}</span>
                        <span class="text-sm text-zinc-400 font-normal">${product.nameTh || ''} ${nicotineStr}</span>
                        <span class="text-xs text-brand-red font-bold uppercase tracking-wide bg-red-500/10 px-2 py-0.5 rounded mt-1">${category?.name || ''}</span>
                    </div>
                `;

                document.getElementById('modal-product-description').textContent = product.description || '';
                
                // Image and levels are intentionally hidden from review modal
                const levelBarsContainer = document.getElementById('modal-level-bars');
                if (levelBarsContainer) levelBarsContainer.innerHTML = '';

                const avgRatingEl = document.getElementById('modal-avg-rating');
                if (product.reviewCount > 0) {
                    avgRatingEl.innerHTML = `<i class="ri-star-fill text-yellow-400"></i><span>${product.averageRating.toFixed(1)} (${product.reviewCount} รีวิว)</span>`;
                } else {
                    avgRatingEl.innerHTML = `<span class="text-xs text-zinc-500">ยังไม่มีรีวิว</span>`;
                }
                document.getElementById('read-reviews-btn').onclick = handleReadReviews;
                document.getElementById('write-review-btn').onclick = handleWriteReview;
                document.body.classList.add('modal-open');
                productModal.classList.remove('hidden');
                setTimeout(() => productModal.classList.add('show'), 10);
                handleReadReviews();
            };

            const closeQuickViewModal = () => {
                productModal.classList.remove('show');
                setTimeout(() => {
                    productModal.classList.add('hidden');
                    document.body.classList.remove('modal-open');
                    activeProduct = null;
                    reviewContentContainer.innerHTML = '';
                }, 300);
            };
            
            window.currentReviewSort = 'newest';
            window.currentReviewFilterStar = null;

            const handleReadReviews = async () => {
                document.getElementById('read-reviews-btn').classList.add('text-brand-red', 'border-brand-red');
                document.getElementById('read-reviews-btn').classList.remove('text-zinc-500', 'border-transparent');
                document.getElementById('write-review-btn').classList.add('text-zinc-500', 'border-transparent');
                document.getElementById('write-review-btn').classList.remove('text-brand-red', 'border-brand-red');

                const telegramId = tg.initDataUnsafe?.user?.id?.toString() || window.currentUser?.telegramUserId || '';
                reviewContentContainer.innerHTML = `<div class="text-center text-zinc-400 py-4"><div class="animate-spin h-6 w-6 border-2 border-brand-red border-t-transparent rounded-full mx-auto mb-2"></div>กำลังโหลดรีวิว...</div>`;
                
                try {
                    let url = `/api/reviews/${activeProduct.id}?sort=${window.currentReviewSort}&telegramId=${telegramId}`;
                    if (window.currentReviewFilterStar) {
                        url += `&star=${window.currentReviewFilterStar}`;
                    }
                    const response = await fetch(url);
                    const data = await response.json();
                    
                    if (data.success) {
                        renderReviews(data.stats, data.reviews);
                    } else {
                        reviewContentContainer.innerHTML = `<div class="text-center text-red-400 py-4">${data.error}</div>`;
                    }
                } catch (error) {
                    reviewContentContainer.innerHTML = `<div class="text-center text-red-400 py-4">เกิดข้อผิดพลาดในการโหลดรีวิว</div>`;
                }
            };
            window.handleReadReviews = handleReadReviews;
            
            window.toggleLikeReview = async (reviewId, btnElement) => {
                const telegramId = tg.initDataUnsafe?.user?.id?.toString() || window.currentUser?.telegramUserId || '';
                if (!telegramId) {
                    tg.showAlert('กรุณาเข้าสู่ระบบก่อนกด Like');
                    return;
                }

                // Optimistic UI update
                const icon = btnElement.querySelector('i');
                const countSpan = btnElement.querySelector('.like-count');
                let count = parseInt(countSpan.innerText);
                let isCurrentlyLiked = icon.classList.contains('ri-thumb-up-fill');

                if (isCurrentlyLiked) {
                    icon.classList.remove('ri-thumb-up-fill', 'text-brand-red');
                    icon.classList.add('ri-thumb-up-line');
                    count--;
                } else {
                    icon.classList.remove('ri-thumb-up-line');
                    icon.classList.add('ri-thumb-up-fill', 'text-brand-red');
                    count++;
                }
                countSpan.innerText = count;

                try {
                    const response = await fetch(`/api/reviews/${reviewId}/like`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ initData: tg.initData })
                    });
                    const result = await response.json();
                    
                    if (!result.success) {
                        // Revert if failed
                        tg.showAlert(result.error || 'Failed to toggle like');
                        handleReadReviews(); // Re-render to get correct state
                    }
                } catch (e) {
                    console.error(e);
                    handleReadReviews(); // Re-render to get correct state
                }
            };

            const renderReviews = (stats, reviews) => {
                // Header Stats
                let html = `
                    <div class="bg-zinc-900/60 p-4 rounded-xl border border-zinc-800 mb-4">
                        <div class="flex items-center gap-4">
                            <div class="text-center flex-shrink-0 w-24">
                                <div class="text-4xl font-bold text-white leading-none">${stats.averageRating}</div>
                                <div class="flex text-yellow-400 text-[10px] my-1.5 justify-center">
                                    ${[...Array(5)].map((_, i) => `<i class="${i < Math.round(stats.averageRating) ? 'ri-star-fill' : 'ri-star-line'}"></i>`).join('')}
                                </div>
                                <div class="text-[10px] text-zinc-500">${stats.totalReviews} ratings</div>
                            </div>
                            <div class="flex-1 space-y-1">
                                ${[5,4,3,2,1].map(star => {
                                    const count = stats.starCounts[star] || 0;
                                    const pct = stats.totalReviews > 0 ? (count / stats.totalReviews) * 100 : 0;
                                    return `
                                    <div class="flex items-center text-[10px] text-zinc-400 gap-2">
                                        <div class="w-2 text-right">${star}</div>
                                        <div class="flex-1 h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                                            <div class="h-full bg-yellow-400 rounded-full" style="width: ${pct}%"></div>
                                        </div>
                                        <div class="w-4 text-left">${count}</div>
                                    </div>
                                    `;
                                }).join('')}
                            </div>
                        </div>
                    </div>
                `;

                // Filters
                html += `
                    <div class="flex overflow-x-auto gap-2 pb-2 mb-3 no-scrollbar">
                        <button onclick="window.currentReviewFilterStar = null; handleReadReviews();" class="px-3 py-1 rounded-full text-xs whitespace-nowrap transition border ${window.currentReviewFilterStar === null ? 'bg-brand-red text-white border-brand-red font-bold' : 'bg-zinc-800 text-zinc-300 border-zinc-700'}">ทั้งหมด</button>
                        ${[5,4,3,2,1].map(star => `
                            <button onclick="window.currentReviewFilterStar = ${star}; handleReadReviews();" class="flex items-center gap-1 px-3 py-1 rounded-full text-xs whitespace-nowrap transition border ${window.currentReviewFilterStar === star ? 'bg-brand-red text-white border-brand-red font-bold' : 'bg-zinc-800 text-zinc-300 border-zinc-700'}">
                                ${star} <i class="ri-star-fill ${window.currentReviewFilterStar === star ? 'text-white' : 'text-yellow-400'} text-[10px]"></i>
                            </button>
                        `).join('')}
                    </div>
                `;

                // Sort Dropdown
                html += `
                    <div class="flex justify-end mb-3">
                        <select id="review-sort-select" class="bg-zinc-800 text-zinc-300 text-xs px-2 py-1 rounded-lg border border-zinc-700 focus:outline-none focus:border-brand-red" onchange="window.currentReviewSort = this.value; handleReadReviews();">
                            <option value="newest" ${window.currentReviewSort === 'newest' ? 'selected' : ''}>ล่าสุด - เก่าสุด</option>
                            <option value="oldest" ${window.currentReviewSort === 'oldest' ? 'selected' : ''}>เก่าสุด - ล่าสุด</option>
                            <option value="most_likes" ${window.currentReviewSort === 'most_likes' ? 'selected' : ''}>ยอดไลค์ มาก - น้อย</option>
                            <option value="least_likes" ${window.currentReviewSort === 'least_likes' ? 'selected' : ''}>ยอดไลค์ น้อย - มาก</option>
                        </select>
                    </div>
                `;

                if (reviews.length === 0) {
                    html += `<div class="text-center text-zinc-500 text-sm py-8 bg-zinc-900/30 rounded-xl">ยังไม่มีรีวิวในหมวดหมู่นี้</div>`;
                    reviewContentContainer.innerHTML = html;
                    return;
                }

                html += `<div class="space-y-3">` + reviews.map(r => `
                    <div class="bg-zinc-800/80 p-3.5 rounded-xl border border-zinc-700/50">
                        <div class="flex justify-between items-start mb-2">
                            <div class="flex items-center gap-2.5">
                                <div class="w-8 h-8 rounded-full bg-zinc-700 flex items-center justify-center text-sm font-bold text-zinc-300 shadow-inner">
                                    ${r.author.charAt(0).toUpperCase()}
                                </div>
                                <div>
                                    <div class="text-sm font-semibold text-white flex items-center gap-1">
                                        ${r.author} 
                                        ${r.author.includes('*') ? '<i class="ri-user-unfollow-line text-[10px] text-zinc-500" title="Anonymous"></i>' : ''}
                                    </div>
                                    <div class="flex items-center gap-1.5 mt-0.5">
                                        <div class="flex gap-0.5 text-[10px]">
                                            ${[...Array(5)].map((_, i) => `<i class="${i < r.rating ? 'ri-star-fill text-yellow-400' : 'ri-star-fill text-zinc-600'}"></i>`).join('')}
                                        </div>
                                        <span class="text-[10px] text-zinc-500">• ${r.createdAt}</span>
                                    </div>
                                </div>
                            </div>
                        </div>
                        <p class="text-sm text-zinc-300 mb-2 whitespace-pre-wrap leading-relaxed">${r.comment}</p>
                        ${r.tags && r.tags.length > 0 ? `
                            <div class="flex flex-wrap gap-1.5 mb-3">
                                ${r.tags.map(t => `<span class="bg-zinc-900 text-zinc-400 text-[10px] px-2 py-0.5 rounded-full border border-zinc-700/50">${t}</span>`).join('')}
                            </div>
                        ` : ''}
                        <div class="flex justify-end pt-2 border-t border-zinc-700/50">
                            <button onclick="window.toggleLikeReview(${r.id}, this)" class="flex items-center gap-1.5 text-xs font-medium text-zinc-400 hover:text-white transition px-2 py-1 rounded-lg hover:bg-zinc-700/50">
                                <i class="${r.isLikedByMe ? 'ri-thumb-up-fill text-brand-red' : 'ri-thumb-up-line'} text-base"></i>
                                <span class="like-count">${r.likesCount}</span> 
                            </button>
                        </div>
                    </div>
                `).join('') + `</div>`;
                
                reviewContentContainer.innerHTML = html;
            };

            const handleWriteReview = async () => {
                if (!currentUser) {
                    tg.showAlert('กรุณาเข้าสู่ระบบก่อนเขียนรีวิว');
                    return;
                }

                document.getElementById('write-review-btn').classList.add('text-brand-red', 'border-brand-red');
                document.getElementById('write-review-btn').classList.remove('text-zinc-500', 'border-transparent');
                document.getElementById('read-reviews-btn').classList.add('text-zinc-500', 'border-transparent');
                document.getElementById('read-reviews-btn').classList.remove('text-brand-red', 'border-brand-red');

                reviewContentContainer.innerHTML = `<div class="text-center text-zinc-400 py-4"><div class="animate-spin h-6 w-6 border-2 border-brand-red border-t-transparent rounded-full mx-auto mb-2"></div>กำลังตรวจสอบสิทธิ์...</div>`;

                try {
                    const response = await fetch(`/api/reviews/check-eligibility/${activeProduct.id}?initData=${encodeURIComponent(tg.initData)}`);
                    const result = await response.json();

                    if (result.eligible) {
                        renderReviewForm();
                    } else {
                        let msg = "คุณไม่สามารถรีวิวสินค้านี้ได้";
                        if (result.reason === "ALREADY_REVIEWED") msg = "คุณเคยรีวิวสินค้านี้ไปแล้ว";
                        if (result.reason === "NOT_PURCHASED") msg = "คุณต้องสั่งซื้อสินค้านี้ก่อนจึงจะสามารถรีวิวได้";
                        
                        reviewContentContainer.innerHTML = `
                            <div class="text-center py-8">
                                <i class="ri-error-warning-line text-4xl text-zinc-500 mb-2"></i>
                                <p class="text-zinc-400 text-sm">${msg}</p>
                                <button onclick="document.getElementById('read-reviews-btn').click()" class="mt-4 px-4 py-2 bg-zinc-800 text-white text-sm rounded-xl">กลับไปหน้ารีวิว</button>
                            </div>
                        `;
                    }
                } catch (error) {
                    reviewContentContainer.innerHTML = `<div class="text-center text-red-400 py-4">เกิดข้อผิดพลาดในการตรวจสอบสิทธิ์</div>`;
                }
            };

            const renderReviewForm = () => {
                const predefinedTags = ["ส่งไว", "สินค้าคุณภาพดี", "คุ้มค่า", "แพ็คเกจดี", "รสชาติเยี่ยม", "บริการดี"];
                
                reviewContentContainer.innerHTML = `
                    <div class="space-y-4 pt-2">
                        <div class="text-center font-semibold text-white">คุณรู้สึกอย่างไรกับสินค้านี้?</div>
                        
                        <div id="star-rating" class="flex justify-center gap-2 text-4xl cursor-pointer text-zinc-600">
                            ${[...Array(5)].map((_, i) => `<i class="ri-star-fill transition-colors" data-value="${i+1}"></i>`).join('')}
                        </div>
                        
                        <div id="review-extra-fields" class="hidden space-y-4 mt-4 animate-fade-in">
                            <div>
                                <p class="text-xs text-zinc-400 mb-2 px-1">จุดเด่นที่ชอบ (เลือกได้มากกว่า 1)</p>
                                <div class="flex flex-wrap gap-2" id="review-tags-container">
                                    ${predefinedTags.map(tag => `
                                        <button class="review-tag-btn px-3 py-1.5 border border-zinc-600 text-zinc-400 hover:text-white hover:border-zinc-400 rounded-full text-xs transition" data-tag="${tag}">
                                            ${tag}
                                        </button>
                                    `).join('')}
                                </div>
                            </div>

                            <div>
                                <textarea id="review-comment" class="w-full bg-zinc-900 border border-zinc-700 rounded-xl p-3 text-sm text-white focus:ring-1 focus:ring-brand-red focus:border-brand-red focus:outline-none placeholder-zinc-500 resize-none" rows="3" placeholder="บอกเล่าประสบการณ์การใช้งานของคุณ..." maxlength="200" oninput="document.getElementById('char-count').innerText = this.value.length"></textarea>
                                <div class="text-right text-[10px] text-zinc-500 mt-1"><span id="char-count">0</span>/200</div>
                            </div>
                            
                            <div class="flex items-center gap-2 text-sm text-zinc-300 bg-zinc-900/50 p-3 rounded-xl border border-zinc-800">
                                <input type="checkbox" id="review-anonymous" class="rounded w-4 h-4 bg-zinc-900 border-zinc-600 text-brand-red focus:ring-brand-red focus:ring-offset-zinc-800">
                                <label for="review-anonymous" class="flex-1 cursor-pointer">ซ่อนชื่อบางส่วน (เช่น R****X)</label>
                            </div>
                            
                            <button id="submit-review-btn" class="w-full py-3.5 bg-brand-red text-white hover:bg-red-600 rounded-xl font-bold text-sm transition-transform active:scale-95 shadow-lg shadow-red-500/20">
                                ยืนยันการส่งรีวิว
                            </button>
                        </div>
                    </div>
                `;
                
                let selectedRating = 0;
                let selectedTags = new Set();
                const starContainer = document.getElementById('star-rating');
                const stars = starContainer.querySelectorAll('i');
                const extraFields = document.getElementById('review-extra-fields');

                starContainer.addEventListener('mouseover', e => {
                    if (e.target.tagName === 'I') {
                        const hoverValue = parseInt(e.target.dataset.value);
                        stars.forEach(star => {
                            star.classList.toggle('text-yellow-400', parseInt(star.dataset.value) <= hoverValue);
                        });
                    }
                });

                starContainer.addEventListener('mouseout', () => {
                     stars.forEach(star => {
                        star.classList.toggle('text-yellow-400', parseInt(star.dataset.value) <= selectedRating);
                    });
                });

                starContainer.addEventListener('click', e => {
                    if (e.target.tagName === 'I') {
                        selectedRating = parseInt(e.target.dataset.value);
                        stars.forEach(star => {
                           star.classList.toggle('text-yellow-400', parseInt(star.dataset.value) <= selectedRating);
                        });
                        extraFields.classList.remove('hidden'); // Show fields after rating
                    }
                });

                // Tag selection
                document.querySelectorAll('.review-tag-btn').forEach(btn => {
                    btn.addEventListener('click', function() {
                        const tag = this.dataset.tag;
                        if (selectedTags.has(tag)) {
                            selectedTags.delete(tag);
                            this.classList.remove('bg-brand-red/20', 'border-brand-red', 'text-brand-red');
                            this.classList.add('border-zinc-600', 'text-zinc-400');
                        } else {
                            selectedTags.add(tag);
                            this.classList.remove('border-zinc-600', 'text-zinc-400');
                            this.classList.add('bg-brand-red/20', 'border-brand-red', 'text-brand-red');
                        }
                    });
                });

                const submitBtn = document.getElementById('submit-review-btn');
                if(submitBtn){
                    submitBtn.onclick = async function() {
                        const comment = document.getElementById('review-comment').value;
                        const isAnonymous = document.getElementById('review-anonymous').checked;

                        if (selectedRating === 0 || !comment.trim()) {
                            tg.showAlert('กรุณาให้คะแนนดาวและพิมพ์ความคิดเห็น');
                            return;
                        }
                        
                        const btn = this;
                        const originalText = btn.innerHTML;
                        btn.innerHTML = '<div class="animate-spin h-5 w-5 border-2 border-white border-t-transparent rounded-full mx-auto"></div>';
                        btn.disabled = true;

                        await handleSubmitReview(selectedRating, comment, Array.from(selectedTags), isAnonymous, btn, originalText);
                    };
                }
            };
            
            const handleSubmitReview = async (rating, comment, tags, isAnonymous, btn, originalText) => {
                try {
                    const response = await fetch('/api/reviews', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            productId: activeProduct.id,
                            customerId: currentUser.customerId,
                            rating: rating,
                            comment: comment,
                            tags: tags,
                            isAnonymous: isAnonymous,
                            initData: tg.initData
                        })
                    });
                    const result = await response.json();
                    
                    if (btn) {
                        btn.innerHTML = originalText;
                        btn.disabled = false;
                    }

                    if (result.success) {
                        let msg = 'ขอบคุณสำหรับรีวิวของคุณ!';
                        if (result.pointsAwarded > 0) {
                            msg += ` คุณได้รับ +${result.pointsAwarded} แต้ม`;
                        }
                        tg.showAlert(msg);
                        window.currentReviewSort = 'newest'; // Reset to newest after review
                        document.getElementById('read-reviews-btn').click(); // Switch back to Read tab
                    } else {
                        tg.showAlert(result.error || 'Failed to submit review.');
                    }
                } catch (error) {
                    if (btn) {
                        btn.innerHTML = originalText;
                        btn.disabled = false;
                    }
                    tg.showAlert('เกิดข้อผิดพลาดในการเชื่อมต่อ');
                }
            };

            // --- Render Functions ---
            // --- Event Listeners for Special Filters ---
            specialFilterContainer.addEventListener('click', (e) => {
                const btn = e.target.closest('.special-filter-btn');
                if (!btn) return;

                const filterType = btn.dataset.filter; // hot, new, cool

                if (currentFilter.specials.has(filterType)) {
                    currentFilter.specials.delete(filterType);
                    btn.classList.remove('active');
                } else {
                    currentFilter.specials.add(filterType);
                    btn.classList.add('active');
                }

                renderProducts();
            });

            const renderBanners = (banners) => {
                if (!banners || banners.length === 0) {
                    bannerContainer.classList.add('hidden');
                    return;
                }
                bannerContainer.innerHTML = `<div id="banner-swiper" class="swiper-container"><div class="swiper-wrapper">${banners.map(b => `<div class="swiper-slide"><img src="${b.imageUrl}" alt="Banner"></div>`).join('')}</div><div class="swiper-pagination"></div></div>`;
                new Swiper('#banner-swiper', { loop: banners.length > 2, autoplay: { delay: 3000 }, pagination: { el: '.swiper-pagination', clickable: true } });
                bannerContainer.classList.remove('hidden');
            };

            const renderCategories = (categories) => {
                allCategories = categories;
                categorySelector.innerHTML = categories.map(c => `
                    <div class="category-wrapper" data-category-id="${c.id}">
                        <div class="category-item">
                            ${c.imageUrl ? `<img src="${c.imageUrl}" alt="${c.name}">` : '<i class="ri-image-line text-gray-500 text-xl"></i>'}
                        </div>
                        <span class="category-label">${c.name}</span>
                    </div>
                `).join('');
                if (categories.length > 0) {
                    currentFilter.categoryId = categories[0].id;
                    categorySelector.children[0].classList.add('active');
                    updateSectionTitle();
                    renderProducts();
                }
            };

            // --- Helper Functions ---
            const renderDots = (level) => {
                let dotsHtml = '<div class="level-dots-container">';
                for (let i = 1; i <= 6; i++) {
                    const activeClass = i <= level ? `active-${i}` : '';
                    dotsHtml += `<div class="level-dot ${activeClass}"></div>`;
                }
                dotsHtml += '</div>';
                return dotsHtml;
            };

            const createCartControlHtml = (p, isOutOfStock, mode = 'standard') => {
                // --- SuperAdmin UI: IS / OOS Toggle ---
                if (currentUser && currentUser.role === 'SuperAdmin' && mode === 'standard') {
                    const currentStatus = isOutOfStock ? 'OUT_OF_STOCK' : 'IN_STOCK';
                    return `
                        <div class="admin-status-toggle" data-product-id="${p.id}" data-current-status="${currentStatus}">
                            <button class="admin-status-btn ${!isOutOfStock ? 'active-is' : ''}" 
                                    style="pointer-events: none;">IS</button>
                            <button class="admin-status-btn ${isOutOfStock ? 'active-oos' : ''}" 
                                    style="pointer-events: none;">OOS</button>
                        </div>
                    `;
                }

                if (isOutOfStock) {
                    if (mode === 'mini') {
                        return `<button class="w-8 h-8 rounded-full bg-zinc-700 text-zinc-500 flex items-center justify-center cursor-not-allowed opacity-50 grayscale" disabled><i class="ri-shopping-cart-2-line"></i></button>`;
                    }
                    return `
                        <button class="add-to-cart-btn r-btn mr-1 !bg-none !bg-zinc-600 !text-zinc-400 !cursor-not-allowed !opacity-50 !grayscale !shadow-none" data-product-id="${p.id}" disabled>
                            <i class="ri-shopping-cart-2-line mr-1"></i> Add
                        </button>
                    `;
                }

                const cartItem = window.cart.find(item => item.id === p.id);
                if (cartItem && cartItem.quantity > 0) {
                    const isAtMaxStock = cartItem.quantity >= p.stockQuantity;
                    return `
                        <div class="cart-control-wrapper ${mode === 'mini' ? '!p-1 !gap-1 !bg-zinc-900/80' : ''}">
                            <button class="cart-qty-btn btn-minus ${mode === 'mini' ? '!w-7 !h-7 !text-xs' : ''}" data-product-id="${p.id}" data-action="minus">
                                <i class="${cartItem.quantity === 1 ? 'ri-delete-bin-line' : 'ri-subtract-line'}"></i>
                            </button>
                            <div class="cart-qty-display ${mode === 'mini' ? '!min-w-[20px] !text-sm' : ''}">${cartItem.quantity}</div>
                            <button class="cart-qty-btn btn-plus ${mode === 'mini' ? '!w-7 !h-7 !text-xs' : ''} ${isAtMaxStock ? 'opacity-50 cursor-not-allowed' : ''}" data-product-id="${p.id}" data-action="plus" ${isAtMaxStock ? 'disabled' : ''}>
                                <i class="ri-add-line"></i>
                            </button>
                        </div>
                    `;
                }

                if (mode === 'mini') {
                    return `
                        <button class="add-to-cart-btn w-8 h-8 rounded-full bg-gradient-to-r from-yellow-400 to-orange-500 text-white flex items-center justify-center shadow-lg active:scale-90 transition" 
                            data-product-id="${p.id}">
                            <i class="ri-shopping-cart-2-line"></i>
                        </button>
                    `;
                }

                return `
                    <button class="add-to-cart-btn r-btn mr-1" data-product-id="${p.id}">
                        <i class="ri-shopping-cart-2-line mr-1"></i> Add
                    </button>
                `;
            };

            const createProductCardHtml = (p) => {
                const category = allCategories.find(c => c.id === p.categoryId);
                const price = category ? parseFloat(category.price).toLocaleString('th-TH') : '';
                const isOutOfStock = p.status === 'OUT_OF_STOCK';
                
                // Adaptive Logic
                const isDevice = (category && category.type === 'DEVICE') || (p.color || p.battery || p.wattage);
                const isFav = favorites.includes(p.id);
                const favBtnHtml = `
                    <button class="fav-btn ${isFav ? 'active' : ''} ${isDevice ? 'pos-bottom-center' : 'pos-mid-right'}" data-product-id="${p.id}">
                        <i class="${isFav ? 'ri-heart-3-fill' : 'ri-heart-3-line'}"></i>
                    </button>
                `;

                // --- Badge Logic ---
                
                // 1. Device Badges (Always show HOT/NEW placeholders for alignment, changing style)
                let deviceStatusBadge = '';
                if (isDevice) {
                    const hotClass = p.isHot 
                        ? 'badge-bg-hot badge-text-shadow shadow-sm' 
                        : 'badge-bg-zinc';
                    
                    const newClass = p.isNew 
                        ? 'badge-bg-new badge-text-shadow shadow-sm' 
                        : 'badge-bg-zinc';

                    deviceStatusBadge = `
                        <div class="flex items-center r-gap-1">
                            <div class="inline-flex items-center justify-center r-badge-xs font-bold rounded-full ${hotClass}"><i class="ri-fire-fill mr-0.5 r-badge-sm"></i>HOT</div>
                            <div class="inline-flex items-center justify-center r-badge-xs font-bold rounded-full ${newClass}"><i class="ri-sparkling-fill mr-0.5 r-badge-sm"></i>NEW</div>
                        </div>
                    `;
                }

                // 2. Pod/Disposable Badges (Always show HOT, NEW, COOL placeholders)
                let podStatusBadge = '';
                if (!isDevice) {
                    // HOT Badge
                    const hotClass = p.isHot 
                        ? 'badge-bg-hot badge-text-shadow shadow-sm' 
                        : 'badge-bg-zinc';
                    
                    // NEW Badge
                    const newClass = p.isNew 
                        ? 'badge-bg-new badge-text-shadow shadow-sm' 
                        : 'badge-bg-zinc';
                        
                    // COOL Badge
                    const coolClass = (p.coolnessLevel >= 6) 
                        ? 'badge-bg-cool badge-text-shadow shadow-sm' 
                        : 'badge-bg-zinc';

                    podStatusBadge = `
                        <div class="pod-badge-row r-gap-1">
                            <div class="inline-flex items-center justify-center r-badge-xs font-bold rounded-full ${hotClass}"><i class="ri-fire-fill mr-0.5 r-badge-sm"></i>HOT</div>
                            <div class="inline-flex items-center justify-center r-badge-xs font-bold rounded-full ${newClass}"><i class="ri-sparkling-fill mr-0.5 r-badge-sm"></i>NEW</div>
                            <div class="inline-flex items-center justify-center r-badge-xs font-bold rounded-full ${coolClass}"><i class="ri-snowy-line mr-0.5 r-badge-sm"></i>COOL</div>
                        </div>
                    `;
                }

                // Inventory Badge (Low Stock or Out of Stock)
                let inventoryBadge = '';
                if (p.isLowStock && !isOutOfStock) {
                    inventoryBadge = `<div class="absolute top-2 left-2 bg-orange-500/90 text-white text-[0.65rem] font-bold px-2 py-0.5 rounded backdrop-blur-md shadow-lg shadow-orange-500/20 z-10 tracking-wide animate-pulse flex items-center gap-1"><i class="ri-alarm-warning-fill"></i>ใกล้หมด (${p.stockQuantity})</div>`;
                }

                // --- CONTENT GENERATION ---
                
                // Slide 1 Content
                let slide1Content = '';
                if (isDevice) {
                    // DEVICE LAYOUT: Image Left, Info Right
                    slide1Content = `
                        <div class="flex flex-row h-full r-gap-1">
                            ${inventoryBadge}
                            <div class="w-1/4 h-full rounded-2xl overflow-hidden relative flex-shrink-0 card-image-container">
                                <img src="${p.imageUrl || 'logo.png'}" alt="${p.nameEn}" style="object-fit: contain !important;" class="product-image w-full h-full" crossorigin="anonymous">
                                ${favBtnHtml}
                            </div>
                            <div class="w-3/4 flex flex-col h-full pt-[2.5cqi] pb-[5cqi] pr-[2.5cqi] relative">

                                <div class="mb-auto flex flex-col items-start w-full">
                                    <!-- Row 1: Status Badge (Hot/New) -->
                                    <div class="min-h-[1.25rem] r-mb-1">
                                        ${deviceStatusBadge}
                                    </div>

                                    <!-- Row 2: Name -->
                                    <div class="info-card-name-en leading-tight line-clamp-2 font-semibold r-mb-1">${p.nameEn || ''}</div>

                                    <!-- Row 3: Color Badge -->
                                    ${p.color ? `<div class="inline-flex items-center r-badge-color font-bold px-[5cqi] py-[1.25cqi] rounded-full bg-zinc-700 text-zinc-200 border border-zinc-600 shadow-sm"><i class="ri-palette-line mr-1"></i>${p.color}</div>` : ''}
                                </div>

                                <!-- Bottom: Price above Button -->
                                <div class="flex flex-col items-end r-gap-1 mt-[5cqi]">
                                     <div class="info-card-price-badge font-bold leading-none">฿${price}</div>
                                     <div class="w-full flex justify-end cart-control-container" data-product-id="${p.id}">
                                        ${createCartControlHtml(p, isOutOfStock)}
                                     </div>
                                </div>
                            </div>
                        </div>
                    `;
                } else {
                    // POD LAYOUT (Standard with new badge row)
                    slide1Content = `
                        ${inventoryBadge}
                        <div class="card-image-container">
                            <img src="${p.imageUrl || 'logo.png'}" alt="${p.nameEn}" class="product-image" crossorigin="anonymous">
                            ${favBtnHtml}
                        </div>                        
                        <div class="card-content-wrapper">
                            ${podStatusBadge}
                            <div class="info-card-name-en">${p.nameEn || ''}</div>
                            <div class="info-card-name-th">${category ? category.name : ''} ${p.nicotine !== null ? `(${p.nicotine}%)` : ''}</div>
                        </div>
                        
                        <div class="card-bottom-row">
                                <div class="info-card-price-badge">฿${price}</div>
                                <div class="cart-control-container" data-product-id="${p.id}">
                                    ${createCartControlHtml(p, isOutOfStock)}
                                </div>
                        </div>
                    `;
                }

                // Slide 2 Content (Details)
                let slide2Content = '';
                if (isDevice) {
                     // DEVICE SPECS LIST (Redesigned)
                     slide2Content = `
                        <div class="flex flex-col h-full pt-[2.5cqi]">
                            <div class="r-text-sm font-bold text-white r-mb-3">Specifications</div>
                            
                            <div class="r-gap-3 flex-grow flex flex-col">
                                <div class="flex items-center justify-between border-b border-zinc-700/50 pb-[5cqi]">
                                    <div class="flex items-center r-gap-1 text-zinc-400">
                                        <i class="ri-battery-charge-line"></i>
                                        <span class="r-text-xs">Battery</span>
                                    </div>
                                    <span class="r-text-sm font-medium text-white">${p.battery || '-'}</span>
                                </div>
                                <div class="flex items-center justify-between pb-[5cqi]">
                                    <div class="flex items-center r-gap-1 text-zinc-400">
                                        <i class="ri-flashlight-line"></i>
                                        <span class="r-text-xs">Output</span>
                                    </div>
                                    <span class="r-text-sm font-medium text-white">${p.wattage || '-'}</span>
                                </div>
                            </div>

                            <div class="mt-auto card-bottom-row">
                                 <div class="info-card-price-badge">฿${price}</div>
                                 <div class="cart-control-container" data-product-id="${p.id}">
                                    ${createCartControlHtml(p, isOutOfStock)}
                                 </div>
                            </div>
                        </div>
                     `;
                } else {
                    // POD FLAVOR BARS
                    slide2Content = `
                        <div class="card-content-wrapper pt-[5cqi]">
                            <div class="info-card-name-en">${p.nameEn || ''}</div>
                            <div class="info-card-name-th r-mb-2">${p.nameTh || (category ? category.name : '')} ${p.nicotine !== null ? `(${p.nicotine}%)` : ''}</div>
                            
                            <div class="space-y-1">
                                <div class="level-row">
                                    <span class="level-label">Cooling</span>
                                    ${renderDots(p.coolnessLevel || 0)}
                                </div>
                                <div class="level-row">
                                    <span class="level-label">Sweetness</span>
                                    ${renderDots(p.sweetnessLevel || 0)}
                                </div>
                                <div class="level-row">
                                    <span class="level-label">Richness</span>
                                    ${renderDots(p.flavorIntensityLevel || 0)}
                                </div>
                            </div>
                        </div>

                        <div class="card-bottom-row">
                                <div class="info-card-price-badge">฿${price}</div>
                                <div class="cart-control-container" data-product-id="${p.id}">
                                    ${createCartControlHtml(p, isOutOfStock)}
                                </div>
                        </div>
                    `;
                }

                return `
                <div class="info-card ${isDevice ? 'type-device' : 'type-pod'} ${isOutOfStock ? 'is-out-of-stock' : ''} swiper-container-card" data-product-id="${p.id}" data-is-device="${isDevice}">
                    <div class="swiper product-card-swiper" id="swiper-${p.id}">
                        <div class="swiper-wrapper">
                            
                            <!-- Slide 1: Main View -->
                            <div class="swiper-slide">
                                ${slide1Content}
                            </div>

                            <!-- Slide 2: Details View -->
                            <div class="swiper-slide">
                                ${slide2Content}
                            </div>
                            
                        </div>
                        <div class="swiper-pagination"></div>
                    </div>
                </div>
                `;
            };

            const renderProducts = () => {
                const filteredProducts = allProducts.filter(p => 
                    (currentFilter.categoryId === null || p.categoryId === currentFilter.categoryId) &&
                    ((p.nameTh || '').toLowerCase().includes(currentFilter.searchTerm) || (p.nameEn || '').toLowerCase().includes(currentFilter.searchTerm)) &&
                    (currentFilter.nicotine === null || p.nicotine === currentFilter.nicotine) &&
                    (currentFilter.specials.size === 0 || 
                        [...currentFilter.specials].every(special => {
                            if (special === 'hot') return p.isHot;
                            if (special === 'new') return p.isNew;
                            if (special === 'cool') return p.coolnessLevel >= 6;
                            if (special === 'outstock') return p.status === 'OUT_OF_STOCK' || p.stockQuantity <= (storeSetting.outOfStockThreshold || 0);
                            return true;
                        })
                    )
                );

                // --- E-commerce Inventory Override ---
                // Map to a new array to prevent mutating the global window.allProducts which breaks the polling diff
                let renderReadyProducts = filteredProducts.map(origP => {
                    const p = { ...origP };
                    const outThreshold = storeSetting.outOfStockThreshold || 0;
                    const lowThreshold = storeSetting.lowStockThreshold || 50;

                    if (p.stockQuantity <= outThreshold) {
                        p.status = 'OUT_OF_STOCK';
                        p.isLowStock = false;
                    } else if (p.stockQuantity <= lowThreshold) {
                        p.isLowStock = true;
                    } else {
                        p.isLowStock = false;
                    }
                    return p;
                });

                // Check if we are in "All Nicotine" mode
                // Only if filtering by category (usually implies viewing a product line) and nicotine is ALL
                if (currentFilter.nicotine === null && renderReadyProducts.length > 0) {
                    // Unified Sorted Grid View (Nicotine Low -> High)
                    productGrid.style.display = 'block'; // Block to contain header + grid
                    
                    const sortedProducts = [...renderReadyProducts].sort((a, b) => {
                        // Handle nulls: push to end (matches previous "Others" at bottom behavior)
                        if (a.nicotine === null && b.nicotine !== null) return 1;
                        if (a.nicotine !== null && b.nicotine === null) return -1;
                        if (a.nicotine === null && b.nicotine === null) return 0;
                        
                        // Both have nicotine: compare values (3% -> 5%)
                        return a.nicotine - b.nicotine;
                    });

                    productGrid.innerHTML = `
                        <div class="mb-4 px-1">
                            <span class="text-xs text-zinc-500 font-medium">[${sortedProducts.length} items]</span>
                        </div>
                        <div class="product-group-grid">
                            ${sortedProducts.map(createProductCardHtml).join('')}
                        </div>
                    `;

                } else {
                    // Standard Filtered View (specific nicotine selected OR no results)
                    if (currentFilter.nicotine !== null && renderReadyProducts.length > 0) {
                        productGrid.style.display = 'block';
                        productGrid.innerHTML = `
                            <div class="mb-4 px-1">
                                <span class="text-xs text-zinc-500 font-medium">[${renderReadyProducts.length} items]</span>
                            </div>
                            <div class="product-group-grid">
                                ${renderReadyProducts.map(createProductCardHtml).join('')}
                            </div>
                        `;
                    } else {
                        productGrid.style.display = 'grid'; // Re-enable grid layout for general searches or no results
                        productGrid.innerHTML = renderReadyProducts.map(createProductCardHtml).join('');
                    }
                }
                
                initCardSwipers();
            };

            const initCardSwipers = () => {
                document.querySelectorAll('.product-card-swiper').forEach(el => {
                    new Swiper(el, {
                        pagination: {
                            el: el.querySelector('.swiper-pagination'),
                            clickable: true,
                        },
                        nested: true,
                        allowTouchMove: true,
                        observer: true,
                        observeParents: true
                    });
                });
            };

            const renderNicotineFilters = () => {
                const productsInCategory = allProducts.filter(p => p.categoryId === currentFilter.categoryId);
                const uniqueNicLevels = [...new Set(productsInCategory.map(p => p.nicotine).filter(n => n !== null))].sort((a, b) => a - b);

                if (uniqueNicLevels.length <= 1) {
                    nicotineFilterContainer.innerHTML = '';
                    currentFilter.nicotine = null;
                    return;
                }

                let buttonsHTML = `<button class="nic-filter-btn ${currentFilter.nicotine === null ? 'active' : ''}" data-nic="null">All</button>`;
                buttonsHTML += uniqueNicLevels.map(nic => 
                    `<button class="nic-filter-btn ${currentFilter.nicotine === nic ? 'active' : ''}" data-nic="${nic}">${nic}%</button>`
                ).join('');
                
                nicotineFilterContainer.innerHTML = buttonsHTML;

                nicotineFilterContainer.querySelectorAll('.nic-filter-btn').forEach(btn => {
                    btn.addEventListener('click', (e) => {
                        nicotineFilterContainer.querySelector('.active')?.classList.remove('active');
                        e.currentTarget.classList.add('active');
                        const nicValue = e.currentTarget.dataset.nic;
                        currentFilter.nicotine = nicValue === 'null' ? null : parseInt(nicValue);
                        renderProducts();
                        window.scrollTo({ top: 0, behavior: 'smooth' });
                    });
                });
            };

            const updateSectionTitle = () => {
                const activeCategory = allCategories.find(c => c.id === currentFilter.categoryId);
                if(activeCategory) {
                    const price = parseFloat(activeCategory.price).toLocaleString('th-TH') + '฿';
                    categoryNameDisplay.textContent = activeCategory.name;
                    categoryPriceDisplay.textContent = price;
                    renderNicotineFilters();

                    // Update Special Filters based on Category Type and Role
                    const isDevice = activeCategory.type === 'DEVICE';
                    const filterHotBtn = document.querySelector('.special-filter-btn.filter-hot');
                    const filterNewBtn = document.querySelector('.special-filter-btn.filter-new');
                    const filterCoolBtn = document.querySelector('.special-filter-btn.filter-cool');
                    const filterOutStockBtn = document.querySelector('.special-filter-btn.filter-outstock');

                    // If SuperAdmin: Hide Hot/New/Cool, show OutStock toggle
                    if (currentUser && currentUser.role === 'SuperAdmin') {
                        filterHotBtn.classList.add('hidden');
                        filterNewBtn.classList.add('hidden');
                        filterCoolBtn.classList.add('hidden');
                        filterOutStockBtn.classList.remove('hidden');
                    } else {
                        // Regular User: Show Hot/New/Cool, hide OutStock
                        filterHotBtn.classList.remove('hidden');
                        filterNewBtn.classList.remove('hidden');
                        filterOutStockBtn.classList.add('hidden');

                        if (isDevice) {
                            filterHotBtn.innerHTML = '<i class="ri-fire-fill mr-1"></i>สียอดนิยม';
                            filterNewBtn.innerHTML = '<i class="ri-sparkling-fill mr-1"></i>สีใหม่';
                            filterCoolBtn.classList.add('hidden');
                            
                            if (currentFilter.specials.has('cool')) {
                                currentFilter.specials.delete('cool');
                                filterCoolBtn.classList.remove('active');
                                renderProducts();
                            }
                        } else {
                            filterHotBtn.innerHTML = '<i class="ri-fire-fill mr-1"></i>กลิ่นยอดนิยม';
                            filterNewBtn.innerHTML = '<i class="ri-sparkling-fill mr-1"></i>กลิ่นใหม่';
                            filterCoolBtn.classList.remove('hidden');
                        }
                    }
                }
            };


            // --- Event Listeners ---
                        categorySelector.addEventListener('click', (e) => {
                            const target = e.target.closest('.category-wrapper');
                            if (!target) return;
            
                            // --- Haptic Feedback Fix ---
                            try {
                                if (window.Telegram?.WebApp?.HapticFeedback) {
                                    window.Telegram.WebApp.HapticFeedback.selectionChanged();
                                } else if (window.Telegram?.WebApp?.hapticFeedback) {
                                    window.Telegram.WebApp.hapticFeedback.selectionChanged();
                                }
                            } catch (err) {}
            
                            categorySelector.querySelector('.active')?.classList.remove('active');                target.classList.add('active');
                target.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
                currentFilter.categoryId = parseInt(target.dataset.categoryId);
                currentFilter.nicotine = null;
                
                // Reset Special Filters
                currentFilter.specials.clear();
                document.querySelectorAll('.special-filter-btn').forEach(btn => btn.classList.remove('active'));

                updateSectionTitle();
                renderProducts();
                window.scrollTo({ top: 0, behavior: 'smooth' });
            });

            productGrid.addEventListener('click', async (e) => {
                const favBtn = e.target.closest('.fav-btn');
                if (favBtn) {
                    e.stopPropagation();
                    const productId = parseInt(favBtn.dataset.productId);
                    toggleFavorite(productId, favBtn);
                    return;
                }

                // --- Handle SuperAdmin Status Toggle ---
                const statusToggle = e.target.closest('.admin-status-toggle');
                if (statusToggle) {
                    e.stopPropagation();
                    const productId = parseInt(statusToggle.dataset.productId);
                    const currentStatus = statusToggle.dataset.currentStatus;
                    const newStatus = currentStatus === 'IN_STOCK' ? 'OUT_OF_STOCK' : 'IN_STOCK';
                    
                    try {
                        const response = await fetch(`/api/products/${productId}/status`, {
                            method: 'PATCH',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ status: newStatus, initData: tg.initData })
                        });
                        const result = await response.json();
                        if (result.success) {
                            showToast(`อัปเดตเป็น ${newStatus === 'IN_STOCK' ? 'พร้อมส่ง' : 'หมด'}`, 'success');
                            const p = allProducts.find(p => p.id === productId);
                            if (p) p.status = newStatus;
                            updateProductCardCartControl(productId);
                        } else {
                            showToast(result.error || 'Failed to update', 'error');
                        }
                    } catch (err) {
                        console.error('Update Status Error:', err);
                        showToast('Error updating status', 'error');
                    }
                    return;
                }

                // --- Handle Qty Controls (+ / -) ---
                const qtyBtn = e.target.closest('.cart-qty-btn');
                if (qtyBtn) {
                    e.stopPropagation();
                    const productIdAttr = qtyBtn.getAttribute('data-product-id');
                    const action = qtyBtn.getAttribute('data-action');
                    const productId = parseInt(productIdAttr);

                    if (!isNaN(productId)) {
                        window.updateQuantity(productId, action === 'plus' ? 1 : -1);
                    }
                    return;
                }
                const addToCartBtn = e.target.closest('.add-to-cart-btn');
                if (addToCartBtn) {
                    e.stopPropagation();
                    const productId = parseInt(addToCartBtn.dataset.productId);
                    const product = allProducts.find(p => p.id === productId);
                    if (product.status === 'OUT_OF_STOCK') {
                        showToast('สินค้าหมด', 'error');
                    } else {
                        addToCart(productId);
                    }
                    return;
                }
                
                const card = e.target.closest('.info-card');
                if (card) {
                    const productId = parseInt(card.dataset.productId);
                    const product = allProducts.find(p => p.id === productId);
                    if (product) {
                        openQuickViewModal(product);
                    }
                }
            });

            cartListWrapper.addEventListener('click', (e) => {
                const qtyBtn = e.target.closest('.cart-qty-btn');
                if (qtyBtn) {
                    e.stopPropagation();
                    const productId = parseInt(qtyBtn.getAttribute('data-product-id'));
                    const action = qtyBtn.getAttribute('data-action') || (qtyBtn.dataset.change === '1' ? 'plus' : 'minus');
                    if (!isNaN(productId)) {
                        window.updateQuantity(productId, action === 'plus' ? 1 : -1);
                    }
                    return;
                }
            });

            favListWrapper.addEventListener('click', (e) => {
                const qtyBtn = e.target.closest('.cart-qty-btn');
                if (qtyBtn) {
                    e.stopPropagation();
                    const productId = parseInt(qtyBtn.getAttribute('data-product-id'));
                    const action = qtyBtn.getAttribute('data-action');
                    if (!isNaN(productId)) {
                        window.updateQuantity(productId, action === 'plus' ? 1 : -1);
                    }
                    return;
                }

                const addToCartBtn = e.target.closest('.add-to-cart-btn');
                if (addToCartBtn) {
                    e.stopPropagation();
                    const productId = parseInt(addToCartBtn.dataset.productId);
                    addToCart(productId);
                    return;
                }
            });

            closeProductModalBtn.addEventListener('click', closeQuickViewModal);
            productModal.addEventListener('click', (e) => e.target === productModal && closeQuickViewModal());
            
            favButton.addEventListener('click', openFavModal);
            closeFavModalBtn.addEventListener('click', closeFavModal);
            favModal.addEventListener('click', (e) => e.target === favModal && closeFavModal());

            cartButton.addEventListener('click', openCartModal);
            closeCartModalBtn.addEventListener('click', closeCartModal);
            cartModal.addEventListener('click', (e) => e.target === cartModal && closeCartModal());
            copyCartBtn.addEventListener('click', executeCheckout);
            clearCartBtn.addEventListener('click', clearCart);

            // --- Expose functions for inline HTML handlers ---
            window.toggleFavorite = toggleFavorite;
            window.addToCart = addToCart;
            window.flyToCart = flyToCart;
            window.showToast = showToast;
            window.closeFavModal = closeFavModal;
            window.openCartModal = openCartModal;

            // --- Main Fetch and Initialization ---
            try {
                const authResponse = await fetch('/api/auth', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ initData: tg.initData })
                });
                if (authResponse.ok) {
                    const authData = await authResponse.json();

                    if (authData.isMember) {
                        currentUser = authData.customer;
                        window.currentUser = currentUser;

                        // Track user in PostHog
                        if (window.posthog) {
                            posthog.identify(currentUser.telegramUserId || tg.initDataUnsafe?.user?.id?.toString(), {
                                customerId: currentUser.customerId,
                                name: `${currentUser.firstName} ${currentUser.lastName || ''}`.trim()
                            });
                        }

                        // --- SuperAdmin UI Adjustments ---
                        if (currentUser && currentUser.role === 'SuperAdmin') {
                            cartButton.classList.add('hidden');
                            // Refresh products to show IS/OOS toggles
                            if (allProducts.length > 0) renderProducts();
                        }
                    } else {
                        // User is not a member, clear local storage to simulate a fresh session
                        localStorage.removeItem('shoppingCart');
                        localStorage.removeItem('favorites');
                        window.cart = [];
                        window.favorites = [];
                    }
                }
                const response = await fetch('/api/products', { cache: 'no-cache' });
                if (!response.ok) {
                    const errorData = await response.json();
                    throw new Error(errorData.message || `Network response was not ok. Status: ${response.status}`);
                }
                
                const data = await response.json();
                window.allProducts = allProducts = data.products;
                window.allCategories = allCategories = data.categories;
                if (data.storeSetting) {
                    storeSetting = data.storeSetting;
                }

                // --- FETCH SHIPPING CONFIG ---
                try {
                    const shipRes = await fetch('/api/config/shipping');
                    const shipData = await shipRes.json();
                    if (shipData.success) {
                        window.shippingConfig = { fee: shipData.shippingFee, freeMin: shipData.freeShippingMin };
                    }
                } catch (err) { console.error("Failed to load shipping config:", err); }

                // Setup Ticker Default
                if (data.tickerDefaultMessage) {
                    defaultTickerMessage = data.tickerDefaultMessage;
                    showTicker(defaultTickerMessage, 'DEFAULT', false);
                }

                // Silently load shipping addresses to restore previous selection
                fetchAddresses();

                await loadCart();
                loadFavorites();
                fetchHistory(true); // Silent fetch to populate pending badge
                renderBanners(data.banners);
                renderCategories(data.categories);

            // Real-time push: listen to admin status toggles via Socket.io
            // (the server emits 'product_update' from /api/products/:id/status)
            try {
                if (typeof io === 'function') {
                    const socket = io();
                    socket.on('product_update', (payload) => {
                        if (!payload || typeof payload.productId === 'undefined') return;
                        const p = (window.allProducts || []).find(x => x.id === payload.productId);
                        if (!p) return;
                        if (typeof payload.status !== 'undefined') p.status = payload.status;
                        if (typeof payload.stock !== 'undefined') p.stockQuantity = payload.stock;
                        if (typeof window.updateProductCardCartControl === 'function') {
                            window.updateProductCardCartControl(payload.productId);
                        }
                    });
                }
            } catch(e) { /* socket optional */ }

            // Background polling (30s) for everything sockets don't cover (banners/categories/ticker/store settings)
            setInterval(async () => {
                try {
                    const res = await fetch('/api/products?v=' + new Date().getTime(), { cache: 'no-cache', headers: { 'x-silent-poll': 'true' } });
                    const data = await res.json();
                    if (data.products && window.allProducts) {
                        let needsProductRender = false;
                        let needsCategoryRender = false;
                        let needsBannerRender = false;

                        if (JSON.stringify(window.allCategories) !== JSON.stringify(data.categories)) {
                            window.allCategories = allCategories = data.categories;
                            needsCategoryRender = true;
                        }

                        if (JSON.stringify(window.allBanners) !== JSON.stringify(data.banners)) {
                            window.allBanners = allBanners = data.banners;
                            needsBannerRender = true;
                        }

                        if (JSON.stringify(window.storeSetting) !== JSON.stringify(data.storeSetting)) {
                            window.storeSetting = storeSetting = data.storeSetting;
                            needsProductRender = true;
                        }

                        // Optimize product re-rendering: Only re-render if a product crosses a stock threshold, changes price, or changes active state.
                        const getPState = (arr, settings) => {
                            const outThresh = settings?.outOfStockThreshold || 0;
                            const lowThresh = settings?.lowStockThreshold || 50;
                            return arr.map(p => {
                                let state = 'IN_STOCK';
                                if (p.stockQuantity <= outThresh) state = 'OUT';
                                else if (p.stockQuantity <= lowThresh) state = 'LOW';
                                return {id: p.id, state: state, p: parseFloat(p.price).toFixed(2), a: p.isActive};
                            }).sort((a,b) => a.id - b.id);
                        };
                        
                        if (JSON.stringify(getPState(window.allProducts, window.storeSetting)) !== JSON.stringify(getPState(data.products, data.storeSetting))) {
                            needsProductRender = true;
                        }
                        
                        // ALWAYS update the global data silently so the cart logic has the latest exact stock quantities
                        window.allProducts = allProducts = data.products;

                        if (needsBannerRender) renderBanners(window.allBanners);
                        if (needsCategoryRender) renderCategories(window.allCategories);
                        
                        fetchHistory('poll');
                        if (needsProductRender) {
                            const container = document.getElementById('products-container');
                            if (container) {
                                // Prevent scroll jumping by temporarily freezing container height
                                const prevHeight = container.offsetHeight;
                                container.style.minHeight = prevHeight + 'px';
                                
                                renderProducts(window.currentCategoryId);
                                
                                // Release height lock after render frame
                                requestAnimationFrame(() => {
                                    container.style.minHeight = '';
                                });
                            } else {
                                renderProducts(window.currentCategoryId);
                            }
                            updateCartModal();
                        }
                    }
                } catch(e) {
                    // Ignore polling errors
                }
            }, 30000); // 30 seconds (reduced from 10s — Socket.io covers status changes in real time)


                appContainer.classList.remove('hidden');
                loader.remove();

            } catch (error) {
                console.error('[CLIENT ERROR] Failed to load product page data:', error);
                loader.innerHTML = `<p class="text-center text-red-400">เกิดข้อผิดพลาดในการโหลดข้อมูล: ${error.message}</p>`;
            }
        });
    