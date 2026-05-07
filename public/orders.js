// orders.js — หน้าออเดอร์ของฉัน (customer order tracking)
//
// Responsibilities:
//   - Fetch /api/orders/history/:tgId
//   - Render filterable list (4 tabs: ALL / PENDING / SHIPPING / CANCELLED)
//   - Open detail modal with 4-step timeline
//   - Smart courier detection → open tracking URL
//   - Subscribe socket order_update → refresh + flash highlight
//   - Update bottom-nav badge dot
//
// Pattern: vanilla JS, no framework. Reuse window.t() shim from i18n.js.

(function () {
    'use strict';

    const tg = window.Telegram && window.Telegram.WebApp;
    const tt = (k, f) => (window.t ? window.t(k, f) : f);
    const _esc = (s) => String(s == null ? '' : s).replace(/[<>&"']/g, c =>
        ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]));
    const _fmt = (n) => Number(n || 0).toLocaleString('th-TH', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
    const _date = (iso) => {
        if (!iso) return '';
        const d = new Date(iso);
        if (window.formatDate) return window.formatDate(d, { day: 'numeric', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' });
        return d.toLocaleString('th-TH', { day: 'numeric', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' });
    };
    const _dateRel = (iso) => {
        if (!iso) return '';
        const ms = Date.now() - new Date(iso).getTime();
        const m = Math.floor(ms / 60000);
        if (m < 1) return tt('time.just_now', 'เมื่อกี้');
        if (m < 60) return `${m} ${tt('time.min_ago', 'นาทีก่อน')}`;
        const h = Math.floor(m / 60);
        if (h < 24) return `${h} ${tt('time.hour_ago', 'ชม. ก่อน')}`;
        const d = Math.floor(h / 24);
        if (d < 7) return `${d} ${tt('time.day_ago', 'วันก่อน')}`;
        return _date(iso);
    };

    // --- Toast ---
    function showToast(msg, type = 'info') {
        const wrap = document.getElementById('toast-container');
        if (!wrap) return;
        const icon = type === 'success' ? 'ri-checkbox-circle-fill'
            : type === 'error' ? 'ri-close-circle-fill'
            : 'ri-information-fill';
        const el = document.createElement('div');
        el.className = `toast ${type}`;
        el.innerHTML = `<i class="${icon} toast-icon"></i><span>${_esc(msg)}</span>`;
        wrap.appendChild(el);
        void el.offsetWidth;
        el.classList.add('show');
        setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 400); }, 2500);
    }

    // --- Status meta ---
    const STATUS_META = {
        PENDING_PAYMENT: { label: () => tt('status.pending_payment', 'รอชำระเงิน'), pillCls: 'bg-yellow-500/15 text-yellow-300 border-yellow-500/30', icon: 'ri-time-line', step: 0 },
        PAID:            { label: () => tt('status.paid', 'ชำระเงินแล้ว'),         pillCls: 'bg-blue-500/15 text-blue-300 border-blue-500/30',     icon: 'ri-checkbox-circle-line', step: 1 },
        PROCESSING:      { label: () => tt('status.processing', 'กำลังแพ็คสินค้า'), pillCls: 'bg-cyan-500/15 text-cyan-300 border-cyan-500/30',     icon: 'ri-archive-line',         step: 2 },
        SHIPPED:         { label: () => tt('status.shipped', 'จัดส่งแล้ว'),         pillCls: 'bg-green-500/15 text-green-400 border-green-500/30',  icon: 'ri-truck-line',           step: 3 },
        CANCELLED:       { label: () => tt('status.cancelled', 'ยกเลิก'),           pillCls: 'bg-red-500/15 text-red-400 border-red-500/30',        icon: 'ri-close-circle-line',    step: -1 },
    };
    const MISMATCH_PILL_CLS = 'bg-purple-500/15 text-purple-300 border-purple-500/30';

    // --- Filter tab → status set ---
    const TAB_FILTERS = {
        ALL:       () => true,
        PENDING:   (o) => o.status === 'PENDING_PAYMENT',
        SHIPPING:  (o) => ['PAID', 'PROCESSING', 'SHIPPED'].includes(o.status),
        CANCELLED: (o) => o.status === 'CANCELLED',
    };

    // --- Smart courier detection ---
    const COURIERS = [
        { id: 'thp',   name: 'ไปรษณีย์ไทย',  test: (n) => /^[A-Z]{2}\d{9}TH$/i.test(n) || /^(EH|ER|RC|PC|RA|RD|RH|RR|EL|EM|EN|EP|EU|EV|EW|EX|EY|EZ)/i.test(n), url: (n) => `https://track.thailandpost.co.th/?trackNumber=${encodeURIComponent(n)}`,           icon: 'ri-mail-send-line' },
        { id: 'kerry', name: 'Kerry Express', test: (n) => /^(KEX|PSP|SMR|KER)/i.test(n),                                                                                                                              url: (n) => `https://th.kerryexpress.com/th/track/?track=${encodeURIComponent(n)}`,         icon: 'ri-truck-line' },
        { id: 'flash', name: 'Flash Express', test: (n) => /^TH\d{12,}$/i.test(n),                                                                                                                                    url: (n) => `https://www.flashexpress.com/fle/tracking?se=${encodeURIComponent(n)}`,        icon: 'ri-flashlight-line' },
        { id: 'jt',    name: 'J&T Express',   test: (n) => /^JT\d+/i.test(n) || /^60\d{10}/.test(n),                                                                                                                  url: (n) => `https://www.jtexpress.co.th/index/query/gzquery.html?bills=${encodeURIComponent(n)}`, icon: 'ri-truck-line' },
        { id: 'scg',   name: 'SCG Express',   test: (n) => /^SCG/i.test(n),                                                                                                                                           url: (n) => `https://www.scgexpress.co.th/tracking?tracking_no=${encodeURIComponent(n)}`,    icon: 'ri-truck-line' },
    ];
    function detectCourier(num) {
        if (!num) return null;
        for (const c of COURIERS) if (c.test(num)) return c;
        return null;
    }
    function getRememberedCourier(orderId) {
        try { return localStorage.getItem(`courier:${orderId}`); } catch (e) { return null; }
    }
    function rememberCourier(orderId, courierId) {
        try { localStorage.setItem(`courier:${orderId}`, courierId); } catch (e) {}
    }

    // --- State ---
    let _allOrders = [];
    let _currentTab = 'ALL';
    let _currentOpenOrderId = null;
    let _telegramId = null;
    let _trackingUrlTemplate = '';
    let _refetchTimer = null;

    // --- Fetch ---
    async function fetchOrders() {
        if (!_telegramId) return;
        try {
            const res = await fetch(`/api/orders/history/${encodeURIComponent(_telegramId)}?v=${Date.now()}`, {
                cache: 'no-cache',
                headers: { 'x-silent-poll': 'true' },
            });
            const data = await res.json();
            if (!data || !data.success) {
                if (res.status === 404) {
                    _allOrders = [];
                    _trackingUrlTemplate = '';
                    renderUI();
                    return;
                }
                throw new Error(data?.error || 'load failed');
            }
            _allOrders = data.orders || [];
            _trackingUrlTemplate = data.trackingUrlTemplate || '';
            renderUI();
        } catch (e) {
            console.error('[orders] fetch error:', e);
            const list = document.getElementById('orders-list');
            if (list) list.innerHTML = `<div class="text-center py-10 text-red-400 text-sm">${_esc(e.message || 'เกิดข้อผิดพลาด')}<br><button onclick="window._ordersRefetch()" class="mt-3 px-4 py-2 bg-zinc-800 rounded-lg text-zinc-200 text-xs">${tt('common.retry', 'ลองใหม่')}</button></div>`;
        }
    }
    window._ordersRefetch = fetchOrders; // expose สำหรับปุ่ม retry

    // --- Counts + UI ---
    function getCounts() {
        const c = { ALL: _allOrders.length, PENDING: 0, SHIPPING: 0, CANCELLED: 0 };
        for (const o of _allOrders) {
            if (TAB_FILTERS.PENDING(o)) c.PENDING++;
            if (TAB_FILTERS.SHIPPING(o)) c.SHIPPING++;
            if (TAB_FILTERS.CANCELLED(o)) c.CANCELLED++;
        }
        return c;
    }
    function renderUI() {
        const counts = getCounts();
        Object.entries(counts).forEach(([k, n]) => {
            document.querySelectorAll(`[data-tab-count="${k}"]`).forEach(el => el.textContent = n > 99 ? '99+' : n);
        });
        renderList();
        updateNavBadge();
    }
    function updateNavBadge() {
        const dot = document.getElementById('nav-orders-dot');
        if (!dot) return;
        const pending = _allOrders.filter(o => TAB_FILTERS.PENDING(o) || TAB_FILTERS.SHIPPING(o)).length;
        if (pending > 0) {
            dot.textContent = pending > 9 ? '9+' : String(pending);
            dot.classList.remove('hidden');
        } else {
            dot.classList.add('hidden');
        }
    }

    function renderList() {
        const list = document.getElementById('orders-list');
        if (!list) return;
        const filter = TAB_FILTERS[_currentTab] || TAB_FILTERS.ALL;
        const orders = _allOrders.filter(filter);
        if (!orders.length) {
            list.innerHTML = renderEmptyState(_allOrders.length === 0);
            return;
        }
        list.innerHTML = orders.map((o, idx) => renderCard(o, idx)).join('');
    }

    function renderEmptyState(isTotallyEmpty) {
        if (isTotallyEmpty) {
            return `
                <div class="flex flex-col items-center text-center py-16 px-6">
                    <i class="ri-shopping-bag-3-line text-zinc-700" style="font-size:72px"></i>
                    <div class="text-base font-bold text-zinc-300 mt-4" data-i18n="orders.empty.title">ยังไม่มีออเดอร์</div>
                    <div class="text-xs text-zinc-500 mt-1" data-i18n="orders.empty.subtitle">ไปดูสินค้ากันเลย!</div>
                    <a href="products.html?v=2" class="mt-5 px-5 py-3 bg-gradient-to-br from-yellow-400 to-orange-500 rounded-xl text-white font-bold text-sm shadow-[0_0_20px_rgba(245,158,11,0.3)] active:scale-95 transition flex items-center gap-2">
                        <i class="ri-shopping-cart-line"></i> <span data-i18n="orders.empty.cta">เริ่มช้อปปิ้ง</span>
                    </a>
                </div>`;
        }
        return `
            <div class="flex flex-col items-center text-center py-12 px-6">
                <i class="ri-search-line text-zinc-700" style="font-size:48px"></i>
                <div class="text-sm font-bold text-zinc-400 mt-3" data-i18n="orders.empty_filter.title">ไม่มีออเดอร์ในหมวดนี้</div>
                <button onclick="window._ordersSetTab('ALL')" class="mt-4 px-4 py-2 bg-zinc-800 rounded-lg text-zinc-200 text-xs font-bold border border-zinc-700 active:scale-95 transition" data-i18n="orders.empty_filter.clear">ดูออเดอร์ทั้งหมด</button>
            </div>`;
    }

    function renderCard(o, idx) {
        const meta = STATUS_META[o.status] || STATUS_META.CANCELLED;
        const isMismatch = o.status === 'PENDING_PAYMENT' && o.mismatchLocked;
        const pillCls = isMismatch ? MISMATCH_PILL_CLS : meta.pillCls;
        const pillIcon = isMismatch ? 'ri-error-warning-line' : meta.icon;
        const pillLabel = isMismatch ? tt('orders.timeline.mismatch_warning', 'รอตรวจสลิป') : meta.label();
        const isPrize = o.kind === 'PRIZE_DELIVERY';
        const totalUnits = (o.items || []).reduce((s, i) => s + (i.quantity || 0), 0);

        // Item preview avatars (max 3)
        const items = o.items || [];
        const previewImgs = items.slice(0, 3).map((it, i) => {
            const img = it.product?.imageUrl;
            const mlClass = i > 0 ? '-ml-2' : '';
            return img
                ? `<img src="${_esc(img)}" class="w-9 h-9 rounded-full object-cover border-2 border-zinc-900 ${mlClass}" alt="">`
                : `<div class="w-9 h-9 rounded-full bg-zinc-700 border-2 border-zinc-900 flex items-center justify-center text-xs ${mlClass}">🛍</div>`;
        }).join('');
        const moreItemsTxt = items.length > 3
            ? `<span class="text-[11px] text-zinc-400 ml-2">${tt('orders.card.items_more', 'และอีก {n} ชิ้น').replace('{n}', String(items.length - 3))}</span>`
            : (totalUnits > 0 ? `<span class="text-[11px] text-zinc-500 ml-2">${totalUnits} ชิ้น</span>` : '');

        // Action buttons
        let primaryBtn = '';
        const tracking = o.trackingNumber && String(o.trackingNumber).trim();
        if (o.status === 'PENDING_PAYMENT' && !o.mismatchLocked) {
            primaryBtn = `<button onclick="event.stopPropagation();window._ordersGoPayment('${_esc(o.id)}')" class="flex-1 py-2.5 bg-gradient-to-br from-yellow-400 to-orange-500 text-white rounded-xl text-xs font-bold active:scale-95 transition shadow-[0_0_12px_rgba(245,158,11,0.25)] flex items-center justify-center gap-1.5">
                <i class="ri-bank-card-line"></i> ${tt('cart.checkout', 'ชำระเงิน')}
            </button>`;
        } else if (isMismatch) {
            primaryBtn = `<button onclick="event.stopPropagation();window._ordersContactAdmin('${_esc(o.id)}')" class="flex-1 py-2.5 bg-purple-500/20 text-purple-300 border border-purple-500/30 rounded-xl text-xs font-bold active:scale-95 transition flex items-center justify-center gap-1.5">
                <i class="ri-customer-service-2-line"></i> ${tt('orders.card.contact_admin', 'ทักแอดมิน')}
            </button>`;
        } else if (tracking && o.status === 'SHIPPED') {
            primaryBtn = `<button onclick="event.stopPropagation();window._ordersOpenTracking('${_esc(o.id)}')" class="flex-1 py-2.5 bg-gradient-to-br from-yellow-400 to-orange-500 text-white rounded-xl text-xs font-bold active:scale-95 transition shadow-[0_0_12px_rgba(245,158,11,0.25)] flex items-center justify-center gap-1.5">
                <i class="ri-truck-line"></i> ${tt('orders.card.track', 'ติดตามพัสดุ')}
            </button>`;
        }
        const detailBtn = `<button onclick="event.stopPropagation();window._ordersOpenDetail('${_esc(o.id)}')" class="flex-1 py-2.5 bg-zinc-800 text-zinc-200 border border-zinc-700 rounded-xl text-xs font-bold active:scale-95 transition flex items-center justify-center gap-1.5">
            <i class="ri-eye-line"></i> ${tt('orders.card.detail', 'ดูรายละเอียด')}
        </button>`;

        const animDelay = Math.min(idx, 8) * 40;
        return `
            <div id="ord-card-${_esc(o.id)}" class="bg-[var(--secondary-bg)] rounded-2xl p-4 mb-3 border border-zinc-800 cursor-pointer hover:bg-[#252525] active:scale-[0.99] transition item-fade-in"
                 style="animation-delay:${animDelay}ms"
                 onclick="window._ordersOpenDetail('${_esc(o.id)}')">
                <div class="flex items-center justify-between gap-2 mb-1.5">
                    <div class="flex items-center gap-1.5 flex-wrap min-w-0">
                        <code class="font-mono text-[11px] text-zinc-400">#${_esc(o.id)}</code>
                        ${isPrize ? '<span class="text-[9px] px-1.5 py-0.5 rounded bg-purple-500/20 text-purple-300 font-bold">PRZ</span>' : ''}
                    </div>
                    <span class="text-[10px] px-2 py-0.5 rounded-full border ${pillCls} flex items-center gap-1 whitespace-nowrap"><i class="${pillIcon}"></i>${_esc(pillLabel)}</span>
                </div>
                <div class="text-[11px] text-zinc-500 mb-3">${_dateRel(o.createdAt)}</div>
                <div class="flex items-center justify-between mb-3">
                    <div class="flex items-center">${previewImgs || '<div class="w-9 h-9 rounded-full bg-zinc-700 flex items-center justify-center">🛍</div>'}${moreItemsTxt}</div>
                    <div class="text-right">
                        <div class="text-[10px] text-zinc-500 leading-none">${tt('orders.card.total', 'ยอดรวม')}</div>
                        <div class="text-lg font-bold leading-tight bg-gradient-to-r from-yellow-400 to-orange-500 bg-clip-text text-transparent">฿${_fmt(o.totalAmount)}</div>
                    </div>
                </div>
                <div class="flex gap-2">
                    ${primaryBtn}${detailBtn}
                </div>
            </div>`;
    }

    // --- Detail modal ---
    function openDetail(orderId) {
        const o = _allOrders.find(x => x.id === orderId);
        if (!o) return;
        _currentOpenOrderId = orderId;
        try { tg?.HapticFeedback?.impactOccurred?.('light'); } catch (e) {}
        document.body.classList.add('no-scroll');
        const modal = document.getElementById('ord-detail-modal');
        const body = document.getElementById('ord-detail-body');
        if (!modal || !body) return;
        body.innerHTML = renderDetailBody(o);
        modal.classList.add('show');
    }
    function closeDetail() {
        _currentOpenOrderId = null;
        document.body.classList.remove('no-scroll');
        document.getElementById('ord-detail-modal')?.classList.remove('show');
    }
    window._ordersOpenDetail = openDetail;
    window._ordersCloseDetail = closeDetail;

    function renderDetailBody(o) {
        const meta = STATUS_META[o.status] || STATUS_META.CANCELLED;
        const isMismatch = o.status === 'PENDING_PAYMENT' && o.mismatchLocked;
        const isCancelled = o.status === 'CANCELLED';
        const isPrize = o.kind === 'PRIZE_DELIVERY';

        // Step status
        const currentStep = isCancelled ? -1 : (meta.step ?? 0);
        const stepData = [
            { label: tt('orders.timeline.step.order',     'สั่งซื้อ'),    icon: 'ri-shopping-bag-line',     ts: o.createdAt },
            { label: tt('orders.timeline.step.paid',      'ชำระแล้ว'),  icon: 'ri-bank-card-line',        ts: o.payment?.verifiedAt },
            { label: tt('orders.timeline.step.preparing', 'กำลังเตรียม'), icon: 'ri-archive-2-line',        ts: o.firstBillAt },
            { label: tt('orders.timeline.step.shipped',   'จัดส่งแล้ว'), icon: 'ri-truck-line',            ts: (o.status === 'SHIPPED' ? o.updatedAt : null) },
        ];
        const timelineHtml = stepData.map((s, idx) => {
            let cls = '';
            let dotContent;
            if (isCancelled) {
                cls = idx === 0 ? 'done' : 'cancelled';
                dotContent = idx === 0 ? '<i class="ri-check-line"></i>' : `<i class="${s.icon}"></i>`;
            } else if (idx < currentStep) { cls = 'done'; dotContent = '<i class="ri-check-line"></i>'; }
            else if (idx === currentStep) { cls = 'current'; dotContent = `<i class="${s.icon}"></i>`; }
            else { dotContent = `<i class="${s.icon}"></i>`; }
            const lineCls = (idx < currentStep && !isCancelled) ? 'done' : '';
            return `
                <div class="flex flex-col items-center text-center min-w-[60px] od-step ${cls}">
                    <div class="od-step-dot">${dotContent}</div>
                    <div class="text-[10px] mt-1.5 leading-tight ${cls === 'current' ? 'text-white font-bold' : (cls === 'done' ? 'text-orange-300' : 'text-zinc-500')}">${_esc(s.label)}</div>
                    ${s.ts && (cls === 'done' || cls === 'current') ? `<div class="text-[9px] text-zinc-500 font-mono mt-0.5">${_dateRel(s.ts)}</div>` : ''}
                </div>
                ${idx < stepData.length - 1 ? `<div class="od-step-line ${lineCls}"></div>` : ''}
            `;
        }).join('');

        // Cancelled banner override
        const cancelledBanner = isCancelled ? `
            <div class="bg-red-500/10 border border-red-500/30 rounded-xl p-3 mb-4 text-center">
                <i class="ri-close-circle-line text-red-400 text-2xl"></i>
                <div class="text-red-300 font-bold text-sm mt-1" data-i18n="orders.timeline.cancelled_banner">ออเดอร์นี้ถูกยกเลิก</div>
            </div>` : '';

        // Mismatch warning + CTA
        const mismatchHtml = isMismatch ? renderMismatchBox(o) : '';

        // Items
        let itemsHtml = '';
        let subtotal = 0;
        for (const it of (o.items || [])) {
            const price = parseFloat(it.priceAtPurchase || 0);
            const lineTotal = price * it.quantity;
            subtotal += lineTotal;
            const name = it.product?.nameTh || it.product?.nameEn || `#${it.productId}`;
            const img = it.product?.imageUrl;
            const nic = (it.product?.nicotine != null) ? ` <span class="text-[10px] text-zinc-500">(${it.product.nicotine}%)</span>` : '';
            itemsHtml += `
                <div class="flex items-center gap-3 py-2 border-b border-white/5 last:border-0">
                    ${img ? `<img src="${_esc(img)}" class="w-11 h-11 rounded-lg object-cover" alt="">` : '<div class="w-11 h-11 rounded-lg bg-zinc-800 flex items-center justify-center">🛍</div>'}
                    <div class="flex-1 min-w-0">
                        <div class="text-sm text-zinc-200 truncate">${_esc(name)}${nic}</div>
                        <div class="text-[11px] text-zinc-500 mt-0.5">×${it.quantity} · ฿${_fmt(price)}</div>
                    </div>
                    <div class="text-sm font-medium text-zinc-200 whitespace-nowrap">฿${_fmt(lineTotal)}</div>
                </div>`;
        }

        // Address
        const addr = o.shippingAddress;
        const addressHtml = addr ? `
            <div class="text-[11px] text-zinc-400 font-bold mb-1.5 flex items-center gap-1.5"><i class="ri-map-pin-2-fill text-blue-400"></i> ${tt('orders.detail.shipping_address', 'ที่อยู่จัดส่ง')}</div>
            <div class="bg-[var(--secondary-bg)] rounded-xl p-3 mb-4">
                <div class="text-sm text-white font-medium">${_esc(addr.receiverName || '-')}</div>
                <div class="text-[11px] text-zinc-400 mb-1">${_esc(addr.phone || '')}</div>
                <div class="text-xs text-zinc-300 leading-relaxed">${_esc([addr.address, addr.subdistrict, addr.district, addr.province, addr.zipcode].filter(Boolean).join(' '))}</div>
            </div>` : '';

        // Tracking
        const trackingHtml = o.trackingNumber ? renderTrackingBlock(o) : '';

        // Bill number
        const billHtml = o.billNumber ? `
            <div class="text-[11px] text-zinc-400 font-bold mb-1.5 flex items-center gap-1.5"><i class="ri-receipt-line text-amber-400"></i> ${tt('order.bill_number', 'เลขบิล')}</div>
            <div class="bg-[var(--secondary-bg)] rounded-xl p-3 mb-4 font-mono text-sm text-amber-300">${_esc(o.billNumber)}</div>` : '';

        // Summary
        const discount = parseFloat(o.discountAmount || 0);
        const total = parseFloat(o.totalAmount || 0);
        const shippingFromOrder = (o.shippingFee != null) ? parseFloat(o.shippingFee) : Math.max(0, Math.round(total - subtotal + discount));
        const summaryHtml = `
            <div class="text-[11px] text-zinc-400 font-bold mb-1.5 flex items-center gap-1.5"><i class="ri-bill-line text-yellow-400"></i> ${tt('orders.detail.summary', 'สรุปยอด')}</div>
            <div class="bg-[var(--secondary-bg)] rounded-xl p-3 mb-4 text-sm">
                <div class="flex justify-between text-zinc-300 py-1">
                    <span>${tt('payment.subtotal', 'ค่าสินค้า')}</span>
                    <span>฿${_fmt(subtotal)}</span>
                </div>
                ${discount > 0 ? `
                <div class="flex justify-between text-green-400 py-1">
                    <span>${tt('orders.detail.coupon', 'คูปองที่ใช้')}${o.appliedCouponId ? ` <span class="text-[10px] text-zinc-500">(${_esc(o.appliedCouponId)})</span>` : ''}</span>
                    <span>-฿${_fmt(discount)}</span>
                </div>` : ''}
                <div class="flex justify-between text-zinc-300 py-1">
                    <span>${tt('payment.shipping', 'ค่าจัดส่ง')}</span>
                    <span class="${shippingFromOrder === 0 ? 'text-green-400 font-bold' : ''}">${shippingFromOrder === 0 ? tt('shipping.free', 'ฟรี') : '฿' + _fmt(shippingFromOrder)}</span>
                </div>
                <div class="border-t border-white/10 mt-2 pt-2 flex justify-between items-baseline">
                    <span class="font-bold text-white">${tt('cart.total', 'ยอดสุทธิ')}</span>
                    <span class="text-2xl font-bold bg-gradient-to-r from-yellow-400 to-orange-500 bg-clip-text text-transparent">฿${_fmt(total)}</span>
                </div>
            </div>`;

        // Admin note
        const noteHtml = o.adminNote ? `
            <div class="text-[11px] text-zinc-400 font-bold mb-1.5 flex items-center gap-1.5"><i class="ri-sticky-note-line text-zinc-300"></i> ${tt('orders.detail.note', 'หมายเหตุจากแอดมิน')}</div>
            <div class="bg-zinc-800/60 border border-zinc-700 rounded-xl p-3 mb-4 text-xs text-zinc-300 leading-relaxed whitespace-pre-wrap">${_esc(o.adminNote)}</div>` : '';

        return `
            <button onclick="window._ordersCloseDetail()" class="absolute top-4 right-4 w-9 h-9 rounded-full bg-zinc-800 text-zinc-300 flex items-center justify-center active:scale-90 transition z-10"><i class="ri-close-line text-xl"></i></button>

            <div class="text-center mb-3">
                <div class="text-[11px] text-zinc-500 font-mono">#${_esc(o.id)} ${isPrize ? '<span class="ml-1 text-[9px] px-1.5 py-0.5 rounded bg-purple-500/20 text-purple-300">PRZ</span>' : ''}</div>
                <div class="text-base font-bold text-white mt-1 flex items-center justify-center gap-1.5">
                    <i class="${meta.icon} text-orange-300"></i> ${_esc(meta.label())}
                </div>
                <div class="text-[11px] text-zinc-500 mt-0.5">${_date(o.createdAt)}</div>
            </div>

            ${cancelledBanner}

            <div class="flex items-center justify-between mb-5 px-1">
                ${timelineHtml}
            </div>

            ${mismatchHtml}
            ${addressHtml}
            ${trackingHtml}
            ${billHtml}

            <div class="text-[11px] text-zinc-400 font-bold mb-1.5 flex items-center gap-1.5"><i class="ri-shopping-bag-3-fill text-orange-400"></i> ${tt('orders.detail.items', 'รายการสินค้า')}</div>
            <div class="bg-[var(--secondary-bg)] rounded-xl p-3 mb-4">${itemsHtml || `<div class="text-xs text-zinc-500 text-center py-2">${tt('orders.detail.no_items', 'ไม่มีรายการ')}</div>`}</div>

            ${summaryHtml}
            ${noteHtml}

            ${o.status === 'PENDING_PAYMENT' && !o.mismatchLocked ? `
            <button onclick="window._ordersGoPayment('${_esc(o.id)}')" class="w-full py-3 bg-gradient-to-br from-yellow-400 to-orange-500 text-white rounded-xl font-bold text-sm shadow-[0_0_15px_rgba(245,158,11,0.3)] active:scale-95 transition flex items-center justify-center gap-2 mt-2">
                <i class="ri-bank-card-line"></i> ${tt('cart.checkout', 'ชำระเงิน')}
            </button>` : ''}
        `;
    }

    function renderMismatchBox(o) {
        const op = o.overPaidInfo;
        const expected = parseFloat(o.totalAmount || 0);
        const actual = o.payment?.amount ? parseFloat(o.payment.amount) : 0;
        const diff = Math.max(0, Math.round((expected - actual) * 100) / 100);
        return `
            <div class="bg-purple-500/10 border border-purple-500/30 rounded-xl p-4 mb-4">
                <div class="flex items-start gap-2 mb-3">
                    <i class="ri-error-warning-fill text-purple-300 text-xl flex-shrink-0"></i>
                    <div class="text-sm font-bold text-purple-200" data-i18n="orders.timeline.mismatch_warning">ยอดสลิปไม่ตรง — รอแอดมินตัดสินใจ</div>
                </div>
                <div class="grid grid-cols-3 gap-2 mb-3 text-xs">
                    <div class="bg-zinc-800/60 rounded-lg p-2 text-center">
                        <div class="text-zinc-500 text-[10px]">${tt('lock.to_pay', 'ต้องโอน')}</div>
                        <div class="text-white font-bold mt-0.5">฿${_fmt(expected)}</div>
                    </div>
                    <div class="bg-zinc-800/60 rounded-lg p-2 text-center">
                        <div class="text-zinc-500 text-[10px]">${tt('lock.paid', 'โอนแล้ว')}</div>
                        <div class="text-white font-bold mt-0.5">฿${_fmt(actual)}</div>
                    </div>
                    <div class="bg-purple-500/15 border border-purple-500/30 rounded-lg p-2 text-center">
                        <div class="text-purple-200 text-[10px]">${tt('lock.under_label', 'ขาดอีก')}</div>
                        <div class="text-purple-200 font-bold mt-0.5">฿${_fmt(diff)}</div>
                    </div>
                </div>
                <div class="space-y-2">
                    <button onclick="window._ordersCopyMismatchMsg('${_esc(o.id)}')" class="w-full py-2.5 bg-gradient-to-r from-purple-500 to-fuchsia-500 rounded-xl text-white font-bold text-xs active:scale-95 transition flex items-center justify-center gap-2">
                        <i class="ri-clipboard-line"></i> ${tt('lock.under_copy', 'คัดลอกข้อความ')}
                    </button>
                    <button onclick="window._ordersContactAdmin('${_esc(o.id)}')" class="w-full py-2.5 bg-zinc-800 border border-zinc-700 rounded-xl text-zinc-200 font-medium text-xs active:scale-95 transition flex items-center justify-center gap-2">
                        <i class="ri-chat-3-line"></i> ${tt('btn.close_and_chat', 'ปิดและทักแอดมิน')}
                    </button>
                </div>
            </div>`;
    }

    function renderTrackingBlock(o) {
        const trackings = String(o.trackingNumber).split(',').map(t => t.trim()).filter(Boolean);
        if (!trackings.length) return '';
        const chips = trackings.map(t => {
            const detected = detectCourier(t);
            const rememberedId = !detected ? getRememberedCourier(o.id) : null;
            const courier = detected || (rememberedId ? COURIERS.find(c => c.id === rememberedId) : null);
            const courierName = courier ? courier.name : tt('orders.courier.unknown', 'ตรวจไม่พบขนส่ง');
            const onclick = courier
                ? `window.open('${courier.url(t)}','_blank')`
                : `window._ordersAskCourier('${_esc(o.id)}','${_esc(t)}')`;
            return `
                <div class="bg-[var(--secondary-bg)] rounded-xl p-3 mb-2 last:mb-0">
                    <div class="flex items-center justify-between gap-2 mb-2">
                        <div class="font-mono text-sm text-white truncate">${_esc(t)}</div>
                        <div class="text-[10px] px-2 py-0.5 rounded-full ${courier ? 'bg-blue-500/15 text-blue-300 border border-blue-500/30' : 'bg-zinc-800 text-zinc-400 border border-zinc-700'}">${_esc(courierName)}</div>
                    </div>
                    <button onclick="${onclick}" class="w-full py-2 bg-gradient-to-br from-yellow-400 to-orange-500 text-white rounded-lg text-xs font-bold active:scale-95 transition flex items-center justify-center gap-1.5">
                        <i class="${courier ? courier.icon : 'ri-question-line'}"></i> ${courier ? tt('orders.courier.open', 'เปิดเว็บขนส่ง') : tt('orders.courier.select', 'เลือกขนส่ง')}
                    </button>
                </div>`;
        }).join('');
        return `
            <div class="text-[11px] text-zinc-400 font-bold mb-1.5 flex items-center gap-1.5"><i class="ri-truck-fill text-blue-400"></i> ${tt('orders.detail.tracking', 'เลขพัสดุ')}</div>
            ${chips}`;
    }

    // --- Actions ---
    window._ordersGoPayment = (orderId) => {
        try { tg?.HapticFeedback?.impactOccurred?.('medium'); } catch (e) {}
        window.location.href = `payment.html?orderId=${encodeURIComponent(orderId)}`;
    };
    window._ordersOpenTracking = (orderId) => {
        const o = _allOrders.find(x => x.id === orderId);
        if (!o || !o.trackingNumber) return;
        const trackings = String(o.trackingNumber).split(',').map(t => t.trim()).filter(Boolean);
        if (!trackings.length) return;
        if (trackings.length > 1) {
            // Multiple → just open detail modal
            openDetail(orderId);
            return;
        }
        const t = trackings[0];
        const detected = detectCourier(t);
        const rememberedId = !detected ? getRememberedCourier(orderId) : null;
        const courier = detected || (rememberedId ? COURIERS.find(c => c.id === rememberedId) : null);
        if (courier) {
            try { tg?.HapticFeedback?.impactOccurred?.('medium'); } catch (e) {}
            window.open(courier.url(t), '_blank');
        } else {
            window._ordersAskCourier(orderId, t);
        }
    };
    window._ordersAskCourier = (orderId, trackingNumber) => {
        const buttons = COURIERS.map(c => ({ id: c.id, type: 'default', text: c.name }));
        buttons.push({ id: 'cancel', type: 'cancel', text: tt('common.cancel', 'ยกเลิก') });
        try {
            tg.showPopup({
                title: tt('orders.courier.select', 'เลือกขนส่ง'),
                message: trackingNumber,
                buttons,
            }, (id) => {
                if (!id || id === 'cancel') return;
                const courier = COURIERS.find(c => c.id === id);
                if (!courier) return;
                rememberCourier(orderId, courier.id);
                window.open(courier.url(trackingNumber), '_blank');
            });
        } catch (e) {
            // Fallback if showPopup limited (max 3 buttons in some Telegram versions)
            const choice = prompt(tt('orders.courier.select', 'เลือกขนส่ง') + ':\n' + COURIERS.map((c, i) => `${i + 1}. ${c.name}`).join('\n'));
            const idx = parseInt(choice, 10) - 1;
            if (Number.isFinite(idx) && COURIERS[idx]) {
                rememberCourier(orderId, COURIERS[idx].id);
                window.open(COURIERS[idx].url(trackingNumber), '_blank');
            }
        }
    };
    window._ordersCopyMismatchMsg = (orderId) => {
        const o = _allOrders.find(x => x.id === orderId);
        if (!o) return;
        const expected = parseFloat(o.totalAmount || 0);
        const actual = o.payment?.amount ? parseFloat(o.payment.amount) : 0;
        const diff = Math.max(0, Math.round((expected - actual) * 100) / 100);
        const fmt = (n) => Number(n).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        const msg = `📌 แจ้งโอนเงินขาด\n\nออเดอร์: #${o.id}\nยอดที่ต้องโอน: ฿${fmt(expected)}\nยอดที่โอนแล้ว: ฿${fmt(actual)}\nขาดอีก: ฿${fmt(diff)}\n\nลูกค้า: ${o.customerId}`;
        const fallback = () => {
            const ta = document.createElement('textarea');
            ta.value = msg; document.body.appendChild(ta); ta.select();
            try { document.execCommand('copy'); showToast(tt('msg.copied', 'คัดลอกแล้ว'), 'success'); } catch (e) {}
            ta.remove();
        };
        try {
            if (navigator.clipboard?.writeText) navigator.clipboard.writeText(msg).then(() => showToast(tt('msg.copied', 'คัดลอกแล้ว'), 'success')).catch(fallback);
            else fallback();
        } catch (e) { fallback(); }
    };
    window._ordersContactAdmin = (orderId) => {
        // Pattern เดียวกับ payment.html — ปิด mini app เพื่อให้ลูกค้ากลับไปแชทบอท
        window._ordersCopyMismatchMsg(orderId);
        setTimeout(() => { try { tg?.close(); } catch (e) { window.close(); } }, 400);
    };

    // --- Tab switching ---
    window._ordersSetTab = (tab) => {
        if (!TAB_FILTERS[tab]) tab = 'ALL';
        _currentTab = tab;
        try { tg?.HapticFeedback?.selectionChanged?.(); } catch (e) {}
        document.querySelectorAll('.ord-tab').forEach(btn => {
            const isActive = btn.dataset.tab === tab;
            if (isActive) {
                btn.className = 'ord-tab whitespace-nowrap text-xs font-bold px-4 py-1.5 rounded-full bg-gradient-to-br from-yellow-400 to-orange-500 text-white shadow-[0_0_15px_rgba(245,158,11,0.3)] active:scale-95 transition flex items-center gap-1.5';
                const cnt = btn.querySelector('.ord-count'); if (cnt) cnt.className = 'ord-count text-[10px] bg-white/25 px-1.5 rounded-full';
            } else {
                btn.className = 'ord-tab whitespace-nowrap text-xs font-bold px-4 py-1.5 rounded-full bg-zinc-800 text-zinc-400 border border-zinc-700 active:scale-95 transition flex items-center gap-1.5';
                const cnt = btn.querySelector('.ord-count'); if (cnt) cnt.className = 'ord-count text-[10px] bg-zinc-700 px-1.5 rounded-full';
            }
        });
        renderList();
    };

    // --- Realtime ---
    function setupSocket() {
        const trySocket = setInterval(() => {
            const sock = window.appSocket;
            if (!sock) return;
            clearInterval(trySocket);
            const debounceRefetch = (orderId) => {
                if (_refetchTimer) clearTimeout(_refetchTimer);
                _refetchTimer = setTimeout(() => {
                    fetchOrders().then(() => flashCard(orderId));
                }, 400);
            };
            sock.on('order_update', (payload) => {
                if (!payload?.id) return;
                debounceRefetch(payload.id);
                if (_currentOpenOrderId === payload.id) {
                    // Re-render modal after refetch (debounce delay)
                    setTimeout(() => {
                        if (_currentOpenOrderId === payload.id) {
                            const body = document.getElementById('ord-detail-body');
                            const o = _allOrders.find(x => x.id === payload.id);
                            if (body && o) body.innerHTML = renderDetailBody(o);
                        }
                    }, 600);
                }
                try { tg?.HapticFeedback?.notificationOccurred?.('success'); } catch (e) {}
            });
            sock.on('connect', () => fetchOrders());
        }, 100);
        setTimeout(() => clearInterval(trySocket), 5000);
    }
    function flashCard(orderId) {
        const card = document.getElementById(`ord-card-${orderId}`);
        if (!card) return;
        card.classList.remove('flash-update');
        void card.offsetWidth;
        card.classList.add('flash-update');
    }

    // --- Init ---
    function init() {
        if (!tg) return;
        try { tg.ready(); tg.expand(); } catch (e) {}
        try { tg.setHeaderColor?.('#121212'); tg.setBackgroundColor?.('#121212'); } catch (e) {}

        const tgUid = tg.initDataUnsafe?.user?.id;
        if (!tgUid) {
            const list = document.getElementById('orders-list');
            if (list) list.innerHTML = `<div class="text-center py-10 text-zinc-400 text-sm">${tt('history.no_identity', 'ไม่สามารถระบุตัวตนได้')}</div>`;
            document.getElementById('loading-screen')?.classList.add('hidden');
            document.getElementById('app-content')?.classList.remove('hidden');
            return;
        }
        _telegramId = String(tgUid);

        // Reveal page
        document.getElementById('loading-screen')?.classList.add('hidden');
        document.getElementById('app-content')?.classList.remove('hidden');

        // Bind tab clicks
        document.querySelectorAll('.ord-tab').forEach(btn => {
            btn.addEventListener('click', () => window._ordersSetTab(btn.dataset.tab));
        });
        // Bind modal backdrop click → close
        const modal = document.getElementById('ord-detail-modal');
        modal?.addEventListener('click', (e) => { if (e.target === modal) closeDetail(); });

        // Initial fetch
        fetchOrders();
        setupSocket();
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
