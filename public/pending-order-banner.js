// pending-order-banner.js
//
// Floating banner ที่เตือนลูกค้าว่ามีออเดอร์ค้างชำระเงิน — inject ที่ทุกหน้าหลัก
// (home / products / dashboard / referral) เพื่อให้ลูกค้าหาทางกลับไปหน้าชำระได้
// ไม่ว่าจะเปิดหน้าไหน
//
// - ใช้ Telegram WebApp.initDataUnsafe.user.id เพื่อ identify
// - Poll /api/orders/pending/:telegramId ทุก 30 วิ (fallback ถ้า websocket ไม่ทำงาน)
// - แสดงคำสั่งซื้อที่เก่าที่สุด (ใกล้หมดเวลาที่สุด) เป็น banner
// - mismatchLocked → แสดงข้อความรอแอดมินแทน countdown
// - คลิกแบนเนอร์ → ไป payment.html?orderId=...
// - ปุ่ม × ปิดได้ (sessionStorage — เปิดแอปใหม่จะกลับมาแสดง)
// - ไม่แสดงในหน้า payment.html (เพราะอยู่ในหน้านั้นอยู่แล้ว)

(function () {
    'use strict';

    // ข้ามหน้า payment เพราะ countdown มีอยู่แล้วในหน้านั้น
    if (/payment\.html/i.test(window.location.pathname)) return;

    const POLL_INTERVAL_MS = 30000;
    const SS_DISMISS_KEY = 'pendingBannerDismiss';

    function getDismissedIds() {
        try {
            const raw = sessionStorage.getItem(SS_DISMISS_KEY);
            return raw ? new Set(JSON.parse(raw)) : new Set();
        } catch (e) { return new Set(); }
    }
    function dismissId(id) {
        try {
            const set = getDismissedIds();
            set.add(id);
            sessionStorage.setItem(SS_DISMISS_KEY, JSON.stringify([...set]));
        } catch (e) {}
    }

    function ensureBannerEl() {
        let el = document.getElementById('pending-order-banner');
        if (el) return el;
        el = document.createElement('div');
        el.id = 'pending-order-banner';
        el.style.cssText = [
            'position:fixed','top:0','left:0','right:0','z-index:90',
            'background:linear-gradient(90deg,rgba(251,146,60,0.95),rgba(239,68,68,0.95))',
            'color:white','padding:8px 12px','font-family:Kanit,sans-serif',
            'font-size:13px','box-shadow:0 2px 8px rgba(0,0,0,0.3)',
            'display:none','align-items:center','gap:8px','cursor:pointer',
            'backdrop-filter:blur(8px)','-webkit-backdrop-filter:blur(8px)',
            'border-bottom:1px solid rgba(255,255,255,0.15)'
        ].join(';');
        el.innerHTML = `
            <i class="ri-time-line" style="font-size:18px;flex-shrink:0"></i>
            <div style="flex:1;min-width:0;line-height:1.3">
                <div id="pob-title" style="font-weight:600;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis"></div>
                <div id="pob-sub" style="font-size:11px;opacity:0.9;white-space:nowrap;overflow:hidden;text-overflow:ellipsis"></div>
            </div>
            <span id="pob-cta" style="background:rgba(255,255,255,0.25);padding:5px 10px;border-radius:9999px;font-weight:700;font-size:11px;flex-shrink:0;white-space:nowrap">ชำระต่อ →</span>
            <button id="pob-close" type="button" aria-label="ปิด" style="background:transparent;border:none;color:white;opacity:0.7;cursor:pointer;font-size:18px;line-height:1;padding:4px 6px;flex-shrink:0">×</button>
        `;
        document.body.appendChild(el);

        // คลิกที่ banner (ยกเว้นปุ่มปิด) → ไปหน้า payment
        // SAFETY: ถ้า _expired = true (countdown ถึง 0 หรือ socket แจ้ง CANCELLED แล้ว)
        // จะไม่นำพาไปหน้าชำระ — กันลูกค้าโอนเงินเข้า order ที่ถูกยกเลิกไปแล้ว
        el.addEventListener('click', (e) => {
            if (e.target.closest('#pob-close')) return;
            if (el._expired) return;
            if (el._currentOrderId) {
                window.location.href = `payment.html?orderId=${encodeURIComponent(el._currentOrderId)}`;
            }
        });
        el.querySelector('#pob-close').addEventListener('click', (e) => {
            e.stopPropagation();
            if (el._currentOrderId) dismissId(el._currentOrderId);
            el.style.display = 'none';
        });

        return el;
    }

    function pickBest(orders) {
        // เลือก mismatchLocked ก่อน (ลูกค้าต้องเห็น/แชทแอดมิน), ถ้าไม่มีค่อย pick ตัวเก่าสุด
        if (!orders || orders.length === 0) return null;
        const dismissed = getDismissedIds();
        const visible = orders.filter(o => !dismissed.has(o.id));
        if (visible.length === 0) return null;
        const locked = visible.find(o => o.mismatchLocked);
        return locked || visible[0];
    }

    function fmtMoney(n) {
        return Number(n).toLocaleString('th-TH', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
    }

    let _tickInterval = null;
    function renderBanner(order) {
        const el = ensureBannerEl();
        if (!order) {
            el.style.display = 'none';
            el._currentOrderId = null;
            if (_tickInterval) { clearInterval(_tickInterval); _tickInterval = null; }
            return;
        }

        el._currentOrderId = order.id;
        el._expired = false;
        const titleEl = el.querySelector('#pob-title');
        const subEl = el.querySelector('#pob-sub');
        const ctaEl = el.querySelector('#pob-cta');
        titleEl.textContent = `ออเดอร์ #${order.id} • ฿${fmtMoney(order.totalAmount)}`;

        if (order.mismatchLocked) {
            subEl.textContent = '⚠️ ยอดสลิปไม่ตรง — รอแอดมินดำเนินการ กรุณาทักแชทบอท';
            ctaEl.textContent = 'ดูรายละเอียด →';
            el.style.background = 'linear-gradient(90deg,rgba(168,85,247,0.95),rgba(217,70,239,0.95))';
            if (_tickInterval) { clearInterval(_tickInterval); _tickInterval = null; }
        } else {
            ctaEl.textContent = 'ชำระต่อ →';
            el.style.background = 'linear-gradient(90deg,rgba(251,146,60,0.95),rgba(239,68,68,0.95))';
            const expiryMs = new Date(order.createdAt).getTime() + (order.expiryMinutes * 60 * 1000);
            const setExpiredUI = () => {
                el._expired = true;
                subEl.textContent = 'หมดเวลาชำระเงินแล้ว — ระบบจะยกเลิกออเดอร์นี้';
                ctaEl.textContent = 'หมดเวลา';
                ctaEl.style.opacity = '0.5';
                el.style.cursor = 'not-allowed';
                el.style.background = 'linear-gradient(90deg,rgba(120,120,120,0.85),rgba(80,80,80,0.85))';
            };
            const tick = () => {
                const remain = expiryMs - Date.now();
                if (remain <= 0) {
                    setExpiredUI();
                    if (_tickInterval) { clearInterval(_tickInterval); _tickInterval = null; }
                    // refresh ทันที — server expiry job น่าจะเพิ่งยกเลิกพอดี
                    setTimeout(() => { if (_currentTgId) fetchPending(_currentTgId); }, 1500);
                    return;
                }
                const m = Math.floor(remain / 60000);
                const s = Math.floor((remain % 60000) / 1000);
                subEl.textContent = `เหลือเวลาชำระ ${m.toString().padStart(2,'0')}:${s.toString().padStart(2,'0')}`;
                // reset cursor/opacity ในกรณี re-render หลัง expired
                el.style.cursor = 'pointer';
                ctaEl.style.opacity = '1';
            };
            tick();
            if (_tickInterval) clearInterval(_tickInterval);
            _tickInterval = setInterval(tick, 1000);
        }
        el.style.display = 'flex';
    }

    async function fetchPending(telegramId) {
        try {
            const res = await fetch(`/api/orders/pending/${encodeURIComponent(telegramId)}?v=${Date.now()}`, {
                cache: 'no-cache',
                headers: { 'x-silent-poll': 'true' },
            });
            const data = await res.json();
            if (!data.success) return;
            const best = pickBest(data.pendingOrders);
            renderBanner(best);
        } catch (e) { /* silent */ }
    }

    let _currentTgId = null;

    function init() {
        const tg = window.Telegram && window.Telegram.WebApp;
        const tgUid = tg?.initDataUnsafe?.user?.id;
        if (!tgUid) {
            // ไม่ได้เปิดผ่าน Telegram — ไม่มี identity → ไม่ต้องแสดง banner
            return;
        }
        const telegramId = String(tgUid);
        _currentTgId = telegramId;
        fetchPending(telegramId);
        setInterval(() => fetchPending(telegramId), POLL_INTERVAL_MS);

        // Realtime: subscribe socket order_update — ลบ/รีเฟรช banner ทันทีที่ order
        // ใดๆ ของลูกค้าเปลี่ยนสถานะ (เช่น auto-cancel, PAID, mismatchLocked)
        // SAFETY: กันลูกค้ากด banner ของ order ที่ถูก cancel ไปแล้วเพราะ poll ยังไม่มา
        try {
            if (typeof io === 'function') {
                const socket = io();
                socket.on('order_update', (payload) => {
                    if (!payload || !payload.id) return;
                    const el = document.getElementById('pending-order-banner');
                    // ถ้าเป็น order ที่กำลังโชว์อยู่และเปลี่ยนเป็น CANCELLED/PAID → freeze ทันที
                    if (el && el._currentOrderId === payload.id) {
                        if (payload.status === 'CANCELLED' || payload.status === 'PAID') {
                            el._expired = true;
                            el.style.display = 'none'; // ซ่อนเลย — บังคับ refetch จะแสดง order อื่น (ถ้ามี)
                        }
                    }
                    // refetch state สด — รวบทุก case (order ใหม่, mismatch, cancel, ฯลฯ)
                    fetchPending(telegramId);
                });

                // Reconnect handler — ถ้า socket หลุดแล้วกลับมา → fetch สดเพื่อ catch event ที่หาย
                socket.on('connect', () => fetchPending(telegramId));
            }
        } catch (e) { /* socket optional */ }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
