const fs = require('fs');
const path = 'public/products.html';
let html = fs.readFileSync(path, 'utf8');

// 1. Rename old duplicate functions inside DOMContentLoaded to avoid conflicts
const oldFunctions = [
    'const updateCartUI = async (productId = null) =>',
    'const autoApplyBestCoupon = async () =>',
    'const updateCartIcon = () =>',
    'const updateCartModalDisplay = () =>',
    'const updateQuantity = (productId, change) =>',
    'const addToCart = (productId) =>'
];

oldFunctions.forEach(fn => {
    // We only want to rename the ones inside DOMContentLoaded (which appear later in the file)
    const firstIdx = html.indexOf(fn);
    const secondIdx = html.indexOf(fn, firstIdx + 1);
    if (secondIdx !== -1) {
        const renamed = fn.replace('const ', 'const OLD_');
        // Replace only the second occurrence
        html = html.substring(0, secondIdx) + renamed + html.substring(secondIdx + fn.length);
        console.log(`✅ Renamed duplicate: ${fn}`);
    }
});

// 2. Ensure Coupon Area is visible and correctly positioned
// We'll move the coupon area above the summary in the HTML structure if it's not already there
const couponAreaMarker = '<!-- Coupon Applied Info -->';
const summaryMarker = '<div class=\"space-y-1.5 text-sm\">';
if (html.includes(couponAreaMarker) && html.includes(summaryMarker)) {
    // Find the coupon area block
    const couponStart = html.indexOf('<div id=\"cart-coupon-area\"');
    const couponEnd = html.indexOf('</div>', html.indexOf('<!-- Gift Selection Section -->')) + 6; // Rough end estimate
    
    // This part is tricky via string replace, so we'll just ensure the Logic shows it
    html = html.replace(\"if (couponArea) couponArea.classList.add('hidden');\", \"if (couponArea) { if(cart.length > 0) couponArea.classList.remove('hidden'); else couponArea.classList.add('hidden'); }\");
}

// 3. Force initial calculation after data load
if (html.includes('appContainer.classList.remove(\'hidden\');')) {
    html = html.replace('appContainer.classList.remove(\'hidden\');', 'if(cart.length > 0) updateCartUI();\n                appContainer.classList.remove(\'hidden\');');
}

fs.writeFileSync(path, html, 'utf8');
console.log('🚀 products.html targeted repair complete.');
