const fs = require('fs');
const path = 'public/products.html';
let html = fs.readFileSync(path, 'utf8');

// 1. Force buttons to use window. prefixed functions for global reliability
html = html.replace(/onclick=\"addToCart/g, 'onclick=\"window.addToCart');
html = html.replace(/onclick=\"updateQuantity/g, 'onclick=\"window.updateQuantity');

// 2. Fix the createCartControlHtml to include ONCLICK handlers
const oldControlRegex = /<button class=\"cart-qty-btn btn-minus .*?data-action=\"minus\">/g;
html = html.replace(oldControlRegex, (match) => {
    const idMatch = match.match(/data-product-id=\"(\d+)\"/);
    if (idMatch) return `<button class="cart-qty-btn btn-minus" onclick="window.updateQuantity(${idMatch[1]}, -1)">`;
    return match;
});

const oldPlusRegex = /<button class=\"cart-qty-btn btn-plus .*?data-action=\"plus\">/g;
html = html.replace(oldPlusRegex, (match) => {
    const idMatch = match.match(/data-product-id=\"(\d+)\"/);
    if (idMatch) return `<button class="cart-qty-btn btn-plus" onclick="window.updateQuantity(${idMatch[1]}, 1)">`;
    return match;
});

// 3. Fix the "Add" button in listing
const oldAddBtnRegex = /<button class=\"add-to-cart-btn .*?data-product-id=\"(\d+)\">/g;
html = html.replace(oldAddBtnRegex, (match, id) => {
    return `<button class="add-to-cart-btn r-btn mr-1" onclick="window.addToCart(${id})">`;
});

// 4. Ensure Coupon Area is visible if cart has items
html = html.replace(/couponArea\.classList\.add\('hidden'\);/g, "if(cart.length > 0) { couponArea.classList.remove('hidden'); if(!appliedCoupon) document.getElementById('cart-coupon-name').textContent = 'ยังไม่ได้เลือกคูปอง'; } else { couponArea.classList.add('hidden'); }");

// 5. Expose functions to window at the top level
if (!html.includes('window.updateQuantity = updateQuantity;')) {
    html = html.replace('// --- GLOBAL STATE ---', 'window.updateQuantity = (id, chg) => updateQuantity(id, chg);\nwindow.addToCart = (id) => addToCart(id);\n// --- GLOBAL STATE ---');
}

fs.writeFileSync(path, html, 'utf8');
console.log('✅ UI Fixes Applied: Buttons and Coupons should now work.');
