const fs = require('fs');
const path = 'public/products.html';
let html = fs.readFileSync(path, 'utf8');

// 1. Remove the duplicate REDUNDANT_ state inside DOMContentLoaded
const stateToClean = [
    'let allProducts = [];',
    'let allCategories = [];',
    'let cart = [];',
    'let favorites = [];',
    'let currentUser = null;',
    'let activeProduct = null;',
    'let appliedCoupon = null;',
    'let selectedGift = null;'
];

stateToClean.forEach(st => {
    // Find the second occurrence (the one inside DOMContentLoaded)
    const firstIdx = html.indexOf(st);
    if (firstIdx !== -1) {
        const secondIdx = html.indexOf(st, firstIdx + 1);
        if (secondIdx !== -1) {
            html = html.substring(0, secondIdx) + '// CLEANED: ' + html.substring(secondIdx);
            console.log('✅ Cleaned duplicate state: ' + st);
        }
    }
});

// 2. Ensure all buttons call window. prefixed functions for reliability
html = html.replace(/onclick=\"updateQuantity/g, 'onclick=\"window.updateQuantity');
html = html.replace(/onclick=\"addToCart/g, 'onclick=\"window.addToCart');
html = html.replace(/onclick=\"openCartModal/g, 'onclick=\"window.openCartModal');

// 3. Fix the autoApplyBestCoupon to update the GLOBAL appliedCoupon
// We'll search for the one that is NOT redundant
if (!html.includes('window.autoApplyBestCoupon = autoApplyBestCoupon;')) {
    html = html.replace('// --- GLOBAL STATE ---', 'window.autoApplyBestCoupon = () => autoApplyBestCoupon();\n// --- GLOBAL STATE ---');
}

fs.writeFileSync(path, html, 'utf8');
console.log('🚀 UI Repair Complete: Buttons and Coupons should now sync perfectly.');
