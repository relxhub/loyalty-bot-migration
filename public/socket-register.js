// socket-register.js
//
// Shared boot script: ทุกหน้าลูกค้าโหลดไฟล์นี้ → register socket connection
// เข้า room `cust:<telegramId>` เพื่อรับ targeted events (points/coupon/order ของลูกค้าคนนี้)
//
// Convention: หน้าใดที่อยากใช้ socket realtime — โหลด socket.io.js + ไฟล์นี้
// แล้วเข้าถึง shared instance ผ่าน window.appSocket
//
// ทำงาน idempotent: เรียกซ้ำได้, return socket เดิม

(function () {
    'use strict';
    if (typeof io !== 'function') return; // socket.io ไม่ได้โหลด — skip silently

    function ensureSocket() {
        if (window.appSocket) return window.appSocket;
        const socket = io();
        window.appSocket = socket;

        const tg = window.Telegram && window.Telegram.WebApp;
        const tgUid = tg?.initDataUnsafe?.user?.id;
        if (tgUid) {
            const telegramId = String(tgUid);
            // ส่ง register หลัง connect (รวมถึงทุก reconnect — สำคัญสำหรับการอยู่ใน room ต่อ)
            const register = () => socket.emit('register', { telegramId });
            socket.on('connect', register);
            // ถ้า connect แล้วก่อนเราจะผูก handler — ส่งทันที
            if (socket.connected) register();
        }
        return socket;
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', ensureSocket);
    } else {
        ensureSocket();
    }
})();
