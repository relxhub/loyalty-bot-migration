const fs = require('fs');
const path = 'public/products.html';
let html = fs.readFileSync(path, 'utf8');

// The missing functions that are critical for the cart calculation
const missingFunctions = `
            // --- Coupon System Helper Functions ---
            const renderCouponInCart = (totalAmount) => {
                const couponArea = document.getElementById("cart-coupon-area");
                const couponNameEl = document.getElementById("cart-coupon-name");
                const couponValueEl = document.getElementById("cart-coupon-value");
                const cartTotalPrice = document.getElementById("cart-total-price");
                const copyCartBtn = document.getElementById("copy-cart-btn");

                if (!appliedCoupon) {
                    couponArea.classList.add("hidden");
                    return totalAmount;
                }

                couponArea.classList.remove("hidden");
                couponNameEl.textContent = 'คูปอง: ' + appliedCoupon.coupon.name;
                
                let saving = 0;
                const coupon = appliedCoupon.coupon;
                if (coupon.type === "DISCOUNT_PERCENT") {
                    saving = totalAmount * (parseFloat(coupon.value) / 100);
                    couponValueEl.textContent = '-฿' + saving.toLocaleString("th-TH");
                } else if (coupon.type === "DISCOUNT_FLAT") {
                    saving = parseFloat(coupon.value);
                    couponValueEl.textContent = '-฿' + saving.toLocaleString("th-TH");
                } else if (coupon.type === "GIFT") {
                    couponValueEl.textContent = "FREE GIFT";
                    renderGiftOptions(coupon.giftProductId);
                }

                // Update copy button state for gifts
                if (coupon.type === "GIFT" && !selectedGift) {
                    copyCartBtn.disabled = true;
                    copyCartBtn.textContent = "กรุณาเลือกของแถม";
                    copyCartBtn.classList.replace("bg-green-600", "bg-zinc-600");
                } else {
                    copyCartBtn.disabled = false;
                    copyCartBtn.textContent = "คัดลอกรายการ";
                    copyCartBtn.classList.replace("bg-zinc-600", "bg-green-600");
                }

                return totalAmount - saving;
            };

            const renderGiftOptions = (productId) => {
                const giftArea = document.getElementById("gift-selection-area");
                const giftList = document.getElementById("gift-list");
                const gift = allProducts.find(p => p.id === productId);

                if (!gift) {
                    giftArea.classList.add("hidden");
                    return;
                }

                giftArea.classList.remove("hidden");
                giftList.innerHTML = '<div onclick=\"window.selectGift(' + gift.id + ')\" class=\"p-1 rounded-xl border-2 transition active:scale-95 ' + (selectedGift === gift.id ? 'border-yellow-500 bg-yellow-500/10' : 'border-zinc-700 bg-zinc-900/50') + '\"><img src=\"' + gift.imageUrl + '\" class=\"w-full aspect-square object-contain rounded-lg\"><p class=\"text-[8px] text-center mt-1 truncate text-zinc-400\">' + gift.nameEn + '</p></div>';
            };

            window.selectGift = (id) => {
                selectedGift = id;
                try { tg.hapticFeedback.impactOccurred("medium"); } catch(e) {}
                updateCartModalDisplay();
            };
`;

// Insert these functions before the end of the script block
const scriptEnd = html.lastIndexOf('});\n    </script>');
if (scriptEnd !== -1) {
    html = html.substring(0, scriptEnd) + missingFunctions + html.substring(scriptEnd);
    console.log('✅ Restored missing coupon functions.');
}

fs.writeFileSync(path, html, 'utf8');
console.log('🚀 products.html full restoration complete.');
