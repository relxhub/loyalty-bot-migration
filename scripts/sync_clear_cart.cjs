const fs = require('fs');
const path = 'public/products.html';
let html = fs.readFileSync(path, 'utf8');

// 1. Fix clearCart to properly sync with the product list UI
const newClearCart = `
            const clearCart = () => {
                if (confirm('ยืนยันล้างตะกร้าสินค้าทั้งหมด?')) {
                    window.cart = [];
                    localStorage.setItem('shoppingCart', JSON.stringify([]));
                    
                    // Refresh everything
                    if (typeof window.updateCartUI === 'function') window.updateCartUI();
                    if (typeof window.calculateCartTotals === 'function') window.calculateCartTotals();
                    if (typeof window.updateCartIcon === 'function') window.updateCartIcon();
                    if (typeof window.updateCartModalDisplay === 'function') window.updateCartModalDisplay();
                    
                    // CRITICAL: Refresh the product listing to show "Add" buttons again
                    if (typeof renderProducts === 'function') renderProducts();
                    
                    showToast('ล้างตะกร้าเรียบร้อย', 'info');
                }
            };`;

html = html.replace(/const clearCart = \(\) => \{[\s\S]*?showToast\('ล้างตะกร้าเรียบร้อย', 'info'\);\s*\}\s*\};/, newClearCart);

// 2. Double check and fix any window.window. prefix errors accidentally introduced
html = html.replace(/window\.window\./g, 'window.');

fs.writeFileSync(path, html, 'utf8');
console.log('✅ Synchronized clearCart with Product List UI.');
