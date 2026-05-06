// public/auth-cache.js
// Shared auth cache — สำหรับให้หน้า render ทันทีจาก cache แล้ว refresh พื้นหลัง
// TTL 90 วินาที (สั้นพอที่ data ไม่ค้างนาน, นานพอช่วยตอนเปลี่ยนหน้า)

(function() {
    const KEY = 'auth_cache_v1';
    const TTL_MS = 90 * 1000;

    window.AuthCache = {
        get() {
            try {
                const raw = sessionStorage.getItem(KEY);
                if (!raw) return null;
                const parsed = JSON.parse(raw);
                if (!parsed || !parsed.t || !parsed.data) return null;
                if (Date.now() - parsed.t > TTL_MS) return null;
                return parsed.data;
            } catch (e) { return null; }
        },
        set(data) {
            try {
                if (!data || !data.customerId) return;
                sessionStorage.setItem(KEY, JSON.stringify({ t: Date.now(), data }));
            } catch (e) {}
        },
        clear() {
            try { sessionStorage.removeItem(KEY); } catch (e) {}
        },
        // Helper: ลองตั้ง currentUser + ซ่อน loading + render เร็วๆ
        // Page ส่ง renderFn (optional) มาเพื่อ render UI ทันที
        // คืน true ถ้า cache hit (page ตัดสินใจไม่ต้อง fetch ทันทีก็ได้)
        fastBoot(renderFn) {
            const cached = this.get();
            if (!cached) return false;
            try {
                window.currentUser = cached;
                const ls = document.getElementById('loading-screen');
                const ac = document.getElementById('app-content');
                if (ls) ls.classList.add('hidden');
                if (ac) ac.classList.remove('hidden');
                if (typeof renderFn === 'function') {
                    try { renderFn(cached); } catch (e) { console.warn('fastBoot render warn:', e); }
                }
            } catch (e) { return false; }
            return true;
        },
    };
})();
