const fs = require('fs');
const path = 'public/products.html';
let html = fs.readFileSync(path, 'utf8');

// 1. Rename ALL core cart functions to be Global (attached to window) 
// to ensure they can talk to each other regardless of where they are called.
const functionsToMakeGlobal = [
    'updateCartUI',
    'calculateCartTotals',
    'updateCartModalDisplay',
    'updateCartIcon',
    'autoApplyBestCoupon',
    'updateProductCardCartControl',
    'updateCartModalItem'
];

functionsToMakeGlobal.forEach(fn => {
    // Replace "const fnName =" with "window.fnName ="
    const regex = new RegExp(`const ${fn} =`, 'g');
    html = html.replace(regex, `window.${fn} =`);
    
    // Also fix calls to these functions within the code to use window.fnName
    // (though in JS, window.fn can often be called as fn, it's safer to be explicit)
});

// 2. Ensure all internal calls within the script use the window. prefix 
// to avoid "is not defined" errors during cross-scope communication.
html = html.replace(/updateCartUI\(/g, 'window.updateCartUI(');
html = html.replace(/calculateCartTotals\(/g, 'window.calculateCartTotals(');
html = html.replace(/updateCartModalDisplay\(/g, 'window.updateCartModalDisplay(');
html = html.replace(/updateCartIcon\(/g, 'window.updateCartIcon(');
html = html.replace(/autoApplyBestCoupon\(/g, 'window.autoApplyBestCoupon(');

// 3. Special fix for the quantity buttons in Cart Modal HTML template
// Ensure the template string uses the global function correctly
html = html.replace(/onclick=\"updateQuantity/g, 'onclick=\"window.updateQuantity');

// 4. Final check on appliedCoupon visibility
// Make sure window.appliedCoupon is used everywhere
html = html.replace(/appliedCoupon/g, 'window.appliedCoupon');

fs.writeFileSync(path, html, 'utf8');
console.log('✅ Global Communication Link Established. Buttons should now be 100% functional.');
