// public/i18n.js
// Lightweight i18n for ONEHUB Mini App. No bundler; loaded via <script>.
//
// Usage:
//   HTML  : <span data-i18n="nav.home">หน้าหลัก</span>
//   Input : <input data-i18n-placeholder="search.placeholder" placeholder="ค้นหา...">
//   JS    : showToast(t('msg.added_to_cart'), 'success')
//   Toggle: <button onclick="toggleLang()">🌐 <span data-i18n="lang.current">TH</span></button>
//
// Default lang: prefer localStorage → tg.initDataUnsafe.user.language_code → 'th'

(function () {
    const STORAGE_KEY = 'app_lang';
    const SUPPORTED = ['th', 'en'];
    const FALLBACK = 'th';

    let dict = {};

    function detectLang() {
        try {
            const saved = localStorage.getItem(STORAGE_KEY);
            if (saved && SUPPORTED.includes(saved)) return saved;
        } catch (e) {}
        try {
            const code = window.Telegram?.WebApp?.initDataUnsafe?.user?.language_code;
            if (code && code.toLowerCase().startsWith('th')) return 'th';
            if (code) return 'en';
        } catch (e) {}
        return FALLBACK;
    }

    async function loadDict(lang) {
        try {
            const res = await fetch(`/i18n/${lang}.json?v=1`, { cache: 'no-cache' });
            if (!res.ok) throw new Error('dict ' + res.status);
            dict = await res.json();
        } catch (e) {
            console.error('[i18n] failed to load dict:', e.message);
            dict = {};
        }
    }

    function t(key, fallback) {
        if (key in dict) return dict[key];
        return fallback != null ? fallback : key;
    }

    function applyLangToDOM(root) {
        const r = root || document;
        r.querySelectorAll('[data-i18n]').forEach((el) => {
            const key = el.getAttribute('data-i18n');
            const v = t(key, null);
            if (v != null && v !== key) el.textContent = v;
        });
        r.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
            const key = el.getAttribute('data-i18n-placeholder');
            const v = t(key, null);
            if (v != null && v !== key) el.placeholder = v;
        });
        r.querySelectorAll('[data-i18n-html]').forEach((el) => {
            const key = el.getAttribute('data-i18n-html');
            const v = t(key, null);
            if (v != null && v !== key) el.innerHTML = v;
        });
        document.documentElement.lang = window.__lang === 'en' ? 'en' : 'th';
        document.documentElement.dataset.lang = window.__lang;
    }

    function setLang(lang) {
        if (!SUPPORTED.includes(lang)) return;
        try { localStorage.setItem(STORAGE_KEY, lang); } catch (e) {}
        location.reload();
    }

    function toggleLang() {
        setLang(window.__lang === 'th' ? 'en' : 'th');
    }

    // formatDate(value, opts?) — convenient wrapper that picks Thai/English locale automatically
    function formatDate(value, options) {
        const d = value instanceof Date ? value : new Date(value);
        if (isNaN(d.getTime())) return '';
        const locale = window.__lang === 'en' ? 'en-GB' : 'th-TH';
        const opts = options || { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' };
        return d.toLocaleDateString(locale, { timeZone: 'Asia/Bangkok', ...opts });
    }

    let _readyResolve;
    const ready = new Promise((res) => { _readyResolve = res; });

    async function init() {
        window.__lang = detectLang();
        await loadDict(window.__lang);
        // expose globals
        window.t = t;
        window.setLang = setLang;
        window.toggleLang = toggleLang;
        window.applyLangToDOM = applyLangToDOM;
        window.formatDate = formatDate;
        window.langReady = ready;
        applyLangToDOM();
        _readyResolve(window.__lang);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
