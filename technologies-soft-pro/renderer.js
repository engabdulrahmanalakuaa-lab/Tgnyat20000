/**
 * تقنيات سوفت - نظام إدارة المطعم الاحترافي
 * الإصدار: 3.0.0
 * تصميم م/ عبدالرحمن الاكوع - 773579486 967+
 *
 * ملف renderer.js: واجهة المستخدم وإدارة كل الصفحات
 */

const { ipcRenderer } = require('electron');

// ========== المتغيرات العامة ==========
let currentUser = null;
let currentCompany = null;
let currentShift = null;
let cart = [];
let cartDiscount = 0;          // خصم الفاتورة (نسبة أو مبلغ)
let cartDiscountType = 'amount'; // 'amount' أو 'percent'
let totalSalesCash = 0;
let currentCategory = 'all';
let selectedPayment = 'cash';
let currentShiftId = null;
let taxRate = 0;
let userDataPath = null;
let editingOrderId = null;     // معرف الطلب الجاري تعديله (null في حالة طلب جديد)
let productsCache = [];
let materialsCache = [];
let customersCache = [];
let suppliersCache = [];
let categoriesCache = [];
let tablesCache = [];
let waitersCache = [];
let chartsInstances = {};      // مخازن للرسوم البيانية لإلغائها لاحقاً
let currentCustomerId = null;  // العميل المرتبط بالفاتورة الحالية

const FA = (icon) => `<i class="fas fa-${icon}"></i>`;

// ========== Toast notifications ==========
function showToast(message, type = 'success', duration = 3000) {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    const icons = { success: 'check-circle', danger: 'exclamation-circle', warning: 'exclamation-triangle', info: 'info-circle' };
    toast.innerHTML = `<i class="fas fa-${icons[type] || 'info-circle'}"></i> <span>${message}</span>`;
    container.appendChild(toast);
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(-20px)';
        setTimeout(() => toast.remove(), 300);
    }, duration);
}

// ========== الصياغة (formatting) ==========
function fmt(num) {
    if (num === null || num === undefined || isNaN(num)) return '0.00';
    return Number(num).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtInt(num) {
    if (!num) return '0';
    return Number(num).toLocaleString('en-US');
}
function todayStr() { return new Date().toISOString().slice(0, 10); }
function nowTimeStr() { return new Date().toLocaleTimeString('en-US', { hour12: false }); }

// ========== الحفاظ على السلة في localStorage ==========
function saveCartState() {
    try {
        localStorage.setItem('cart_backup', JSON.stringify({
            cart, cartDiscount, cartDiscountType, selectedPayment, currentCustomerId,
            timestamp: Date.now()
        }));
    } catch (e) {}
}
function loadCartState() {
    try {
        const raw = localStorage.getItem('cart_backup');
        if (!raw) return null;
        const data = JSON.parse(raw);
        // إعادة فقط إذا كانت السلة محفوظة خلال آخر 12 ساعة
        if (Date.now() - data.timestamp > 12 * 3600 * 1000) {
            localStorage.removeItem('cart_backup');
            return null;
        }
        return data;
    } catch (e) { return null; }
}
function clearCartState() {
    try { localStorage.removeItem('cart_backup'); } catch (e) {}
}

// ========== تسجيل الدخول ==========
async function submitLogin() {
    const username = document.getElementById('login-username').value.trim();
    const password = document.getElementById('login-password').value.trim();
    if (!username || !password) {
        showToast('أدخل اسم المستخدم وكلمة المرور', 'warning');
        return;
    }

    try {
        const result = await ipcRenderer.invoke('login', { username, password });
        if (!result.success) {
            showToast(result.error || 'بيانات الدخول خاطئة', 'danger');
            return;
        }
        currentUser = result.user;
        document.getElementById('current-user-display').innerText = currentUser.full_name;
        document.getElementById('user-role-badge').innerText = roleArabic(currentUser.role);
        document.getElementById('user-avatar').innerText = (currentUser.full_name || 'م').charAt(0);

        document.getElementById('login-screen').style.display = 'none';
        document.getElementById('app-main').style.display = 'flex';

        await loadCompanyData();
        const settings = await ipcRenderer.invoke('get-settings', currentCompany.id);
        window.appSettings = settings || {};

        await initUserDataPath();
        await openShiftIfNeeded();

        const company = await ipcRenderer.invoke('get-company');
        taxRate = company ? company.tax_rate || 0 : 0;

        if (!currentCompany.name || currentCompany.name === 'مطعم تقنيات سوفت') {
            openCompanyModal();
        } else {
            switchTab('dashboard');
        }

        // التحقق من المواد الناقصة في بداية الجلسة
        setTimeout(checkLowStockAlerts, 1200);

        showToast(`مرحباً بك ${currentUser.full_name}`, 'success');
    } catch (e) {
        console.error(e);
        showToast('حدث خطأ أثناء تسجيل الدخول', 'danger');
    }
}

function roleArabic(r) {
    return ({ admin: 'مدير', accountant: 'محاسب', cashier: 'كاشير' })[r] || r;
}

async function initUserDataPath() {
    userDataPath = await ipcRenderer.invoke('get-user-data-path');
}

async function loadCompanyData() {
    const company = await ipcRenderer.invoke('get-company');
    if (company) {
        currentCompany = company;
        taxRate = company.tax_rate || 0;
    } else {
        const result = await ipcRenderer.invoke('db-run',
            "INSERT INTO companies (name, phone, address, tax_rate) VALUES (?, ?, ?, ?)",
            ['مطعم تقنيات سوفت', '773579486', 'اليمن - صنعاء', 0]);
        if (result.lastInsertRowid) {
            currentCompany = { id: result.lastInsertRowid, name: 'مطعم تقنيات سوفت', phone: '773579486', address: 'اليمن - صنعاء', tax_rate: 0 };
            taxRate = 0;
        }
    }
    if (currentCompany) document.title = `تقنيات سوفت - ${currentCompany.name}`;
}

function openCompanyModal() {
    document.getElementById('company-name').value = currentCompany ? currentCompany.name : '';
    document.getElementById('company-phone').value = currentCompany ? currentCompany.phone : '';
    document.getElementById('company-address').value = currentCompany ? currentCompany.address : '';
    document.getElementById('company-tax').value = currentCompany ? currentCompany.tax_number || '' : '';
    document.getElementById('company-tax-rate').value = currentCompany ? currentCompany.tax_rate || 0 : 0;
    document.getElementById('company-modal').classList.add('active');
}

async function saveCompanyFromModal() {
    const name = document.getElementById('company-name').value.trim();
    const phone = document.getElementById('company-phone').value.trim();
    const address = document.getElementById('company-address').value.trim();
    const tax_number = document.getElementById('company-tax').value.trim();
    const tax_rate = parseFloat(document.getElementById('company-tax-rate').value) || 0;
    if (!name) { showToast('اسم المطعم مطلوب', 'warning'); return; }

    const r = await ipcRenderer.invoke('update-company', { name, phone, address, tax_number, tax_rate, userId: currentUser.id });
    if (!r.success) { showToast(r.error || 'خطأ في الحفظ', 'danger'); return; }

    currentCompany.name = name;
    currentCompany.phone = phone;
    currentCompany.address = address;
    currentCompany.tax_number = tax_number;
    currentCompany.tax_rate = tax_rate;
    taxRate = tax_rate;
    document.title = `تقنيات سوفت - ${name}`;
    document.getElementById('company-modal').classList.remove('active');
    showToast(`تم حفظ البيانات. الضريبة: ${tax_rate}%`, 'success');
    switchTab('dashboard');
}

// ========== الورديات ==========
async function openShiftIfNeeded() {
    // التحقق من وجود وردية مفتوحة لنفس المستخدم في اليوم الحالي
    const today = todayStr();
    const openShift = await ipcRenderer.invoke('db-get',
        "SELECT * FROM shifts WHERE user_id=? AND status='open' ORDER BY id DESC LIMIT 1",
        [currentUser.id]);
    if (openShift) {
        currentShift = openShift;
        currentShiftId = openShift.id;
        return;
    }
    // طلب فتح وردية جديدة
    const opening = prompt('فتح وردية جديدة - أدخل الرصيد الافتتاحي (نقدي):', '0');
    if (opening === null) return;
    const amt = parseFloat(opening) || 0;
    const r = await ipcRenderer.invoke('open-shift', { company_id: currentCompany.id, user_id: currentUser.id, opening_cash: amt });
    if (r.success) {
        currentShiftId = r.shiftId;
        currentShift = { id: r.shiftId, opening_cash: amt };
        showToast(`تم فتح وردية #${r.shiftId} برصيد ${fmt(amt)}`, 'success');
    } else {
        showToast(r.error || 'فشل فتح الوردية', 'danger');
    }
}

async function checkLowStockAlerts() {
    if (!currentCompany) return;
    const lowStock = await ipcRenderer.invoke('get-low-stock', currentCompany.id);
    if (lowStock && lowStock.length > 0) {
        const names = lowStock.map(m => `- ${m.name} (${m.current_stock} ${m.unit})`).join('\n');
        showToast(`تنبيه: ${lowStock.length} مادة بحاجة لإعادة تموين!`, 'warning', 5000);
        console.warn('مواد ناقصة:\n' + names);
    }
}

// ========== التنقل بين التبويبات ==========
function switchTab(tab) {
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    const btn = document.querySelector(`.nav-btn[data-tab="${tab}"]`);
    if (btn) btn.classList.add('active');

    // إلغاء الرسوم البيانية السابقة
    Object.values(chartsInstances).forEach(c => { try { c.destroy(); } catch (e) {} });
    chartsInstances = {};

    const renderers = {
        dashboard: renderDashboard,
        pos: renderPOS,
        orders: renderOrders,
        products: renderProducts,
        categories: renderCategories,
        materials: renderMaterials,
        inventory: renderInventory,
        customers: renderCustomers,
        suppliers: renderSuppliers,
        tables: renderTables,
        waiters: renderWaiters,
        reports: renderReports,
        expenses: renderExpenses,
        audit: renderAuditLog,
        users: renderUsers,
        settings: renderSettings
    };
    const fn = renderers[tab];
    if (fn) fn();
}

document.addEventListener('click', e => {
    const t = e.target.closest('.nav-btn');
    if (t && t.dataset.tab) switchTab(t.dataset.tab);
});

// ========== لوحة التحكم (Dashboard) ==========
async function renderDashboard() {
    const main = document.getElementById('main-content');
    const today = todayStr();

    const todayOrders = await ipcRenderer.invoke('db-get',
        "SELECT COUNT(*) as count, COALESCE(SUM(total_with_tax),0) as total FROM orders WHERE company_id=? AND date=? AND status='completed'",
        [currentCompany.id, today]);
    const productCount = await ipcRenderer.invoke('db-get',
        "SELECT COUNT(*) as count FROM products WHERE company_id=?", [currentCompany.id]);
    const customersCount = await ipcRenderer.invoke('db-get',
        "SELECT COUNT(*) as count FROM customers WHERE company_id=?", [currentCompany.id]);
    const lowStock = await ipcRenderer.invoke('get-low-stock', currentCompany.id);

    // مبيعات آخر 7 أيام للرسم البياني
    const last7Start = new Date(Date.now() - 6 * 86400000).toISOString().slice(0, 10);
    const weekSales = await ipcRenderer.invoke('get-daily-sales-chart', {
        startDate: last7Start, endDate: today, companyId: currentCompany.id
    });

    main.innerHTML = `
        <div class="page-header">
            <h1>${FA('tachometer-alt')} لوحة التحكم</h1>
            <div class="page-actions">
                <span class="badge">${new Date().toLocaleDateString('ar-EG', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</span>
            </div>
        </div>

        ${currentShift ? `
            <div class="shift-info-box">
                <span>${FA('clock')} وردية مفتوحة #${currentShift.id} - الرصيد الافتتاحي: ${fmt(currentShift.opening_cash)}</span>
                <button class="btn btn-danger btn-sm" onclick="closeShiftPrompt()"><i class="fas fa-lock"></i> إغلاق الوردية</button>
            </div>
        ` : '<div class="alert-warning">لا توجد وردية مفتوحة حالياً</div>'}

        <div class="stats-grid">
            <div class="stat-card success">
                <div class="stat-icon">${FA('chart-line')}</div>
                <div class="stat-info"><h3>مبيعات اليوم</h3><p>${fmt(todayOrders.total)}</p><div class="stat-sub">${currentCompany.tax_rate ? 'شامل الضريبة' : ''}</div></div>
            </div>
            <div class="stat-card info">
                <div class="stat-icon">${FA('receipt')}</div>
                <div class="stat-info"><h3>عدد الطلبات اليوم</h3><p>${fmtInt(todayOrders.count)}</p></div>
            </div>
            <div class="stat-card">
                <div class="stat-icon">${FA('boxes')}</div>
                <div class="stat-info"><h3>عدد المنتجات</h3><p>${fmtInt(productCount.count)}</p></div>
            </div>
            <div class="stat-card warning">
                <div class="stat-icon">${FA('exclamation-triangle')}</div>
                <div class="stat-info"><h3>مواد ناقصة</h3><p>${fmtInt(lowStock.length)}</p><div class="stat-sub">${lowStock.length ? 'تحتاج تموين' : 'كل شيء جيد'}</div></div>
            </div>
            <div class="stat-card info">
                <div class="stat-icon">${FA('users')}</div>
                <div class="stat-info"><h3>عملاء مسجلون</h3><p>${fmtInt(customersCount.count)}</p></div>
            </div>
        </div>

        <div class="charts-grid">
            <div class="chart-container">
                <h3>${FA('chart-bar')} مبيعات آخر 7 أيام</h3>
                <div class="chart-wrap"><canvas id="weekChart"></canvas></div>
            </div>
            <div class="chart-container">
                <h3>${FA('chart-pie')} توزيع طرق الدفع (اليوم)</h3>
                <div class="chart-wrap"><canvas id="paymentChart"></canvas></div>
            </div>
        </div>

        ${lowStock.length > 0 ? `
            <div class="alert-warning">
                <strong>${FA('exclamation-triangle')} تنبيه:</strong> ${lowStock.length} مادة وصلت للحد الأدنى:
                <ul style="margin-top:6px; padding-right:18px;">
                    ${lowStock.slice(0, 5).map(m => `<li>${m.name} (المتوفر: ${fmt(m.current_stock)} ${m.unit} / الحد الأدنى: ${fmt(m.min_stock)})</li>`).join('')}
                </ul>
            </div>
        ` : ''}
    `;

    // رسم آخر 7 أيام
    const labels = [];
    const values = [];
    for (let i = 6; i >= 0; i--) {
        const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
        const found = weekSales.find(r => r.date === d);
        labels.push(d.slice(5));
        values.push(found ? found.total : 0);
    }
    const ctx1 = document.getElementById('weekChart');
    if (ctx1) {
        chartsInstances.week = new Chart(ctx1, {
            type: 'bar',
            data: { labels, datasets: [{ label: 'المبيعات', data: values, backgroundColor: 'rgba(30,136,229,0.7)', borderRadius: 6 }] },
            options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } }
        });
    }

    // توزيع طرق الدفع اليوم
    const payToday = await ipcRenderer.invoke('get-payment-distribution', {
        startDate: today, endDate: today, companyId: currentCompany.id
    });
    const ctx2 = document.getElementById('paymentChart');
    if (ctx2 && payToday.length) {
        const labelsMap = { cash: 'نقدي', card: 'بطاقة', transfer: 'تحويل' };
        chartsInstances.payment = new Chart(ctx2, {
            type: 'doughnut',
            data: {
                labels: payToday.map(p => labelsMap[p.payment_method] || p.payment_method),
                datasets: [{ data: payToday.map(p => p.total), backgroundColor: ['#1e88e5', '#00bcd4', '#4caf50', '#ff9800'] }]
            },
            options: { responsive: true, maintainAspectRatio: false }
        });
    } else if (ctx2) {
        ctx2.parentElement.innerHTML = '<div class="empty-state"><i class="fas fa-chart-pie"></i><p>لا توجد مبيعات اليوم</p></div>';
    }
}

async function closeShiftPrompt() {
    if (!currentShiftId) { showToast('لا توجد وردية مفتوحة', 'warning'); return; }
    const actual = prompt('أدخل الرصيد النقدي الفعلي عند إغلاق الوردية:');
    if (actual === null) return;
    const amount = parseFloat(actual) || 0;
    const r = await ipcRenderer.invoke('close-shift', { shiftId: currentShiftId, actual_cash: amount, userId: currentUser.id });
    if (r.success) {
        showToast(`تم إغلاق الوردية. المتوقع: ${fmt(r.expected)} - الفارق: ${fmt(r.difference)}`, 'success', 5000);
        currentShift = null;
        currentShiftId = null;
        switchTab('dashboard');
    } else {
        showToast(r.error || 'خطأ في إغلاق الوردية', 'danger');
    }
}

// ========== نقطة البيع ==========
async function renderPOS() {
    // تحميل البيانات المطلوبة
    categoriesCache = await ipcRenderer.invoke('db-query', "SELECT * FROM categories WHERE company_id=? ORDER BY name", [currentCompany.id]);
    productsCache = await ipcRenderer.invoke('db-query', "SELECT * FROM products WHERE company_id=? ORDER BY name", [currentCompany.id]);
    materialsCache = await ipcRenderer.invoke('db-query', "SELECT * FROM raw_materials WHERE company_id=?", [currentCompany.id]);
    tablesCache = await ipcRenderer.invoke('db-query', "SELECT * FROM tables WHERE company_id=? ORDER BY name", [currentCompany.id]);
    waitersCache = await ipcRenderer.invoke('db-query', "SELECT * FROM waiters WHERE company_id=? ORDER BY name", [currentCompany.id]);
    customersCache = await ipcRenderer.invoke('db-query', "SELECT * FROM customers WHERE company_id=? ORDER BY name", [currentCompany.id]);

    // استعادة السلة في حال انقطاع التيار
    if (cart.length === 0 && !editingOrderId) {
        const saved = loadCartState();
        if (saved && saved.cart && saved.cart.length) {
            if (confirm('تم العثور على سلة محفوظة من جلسة سابقة. هل تريد استعادتها؟')) {
                cart = saved.cart;
                cartDiscount = saved.cartDiscount || 0;
                cartDiscountType = saved.cartDiscountType || 'amount';
                selectedPayment = saved.selectedPayment || 'cash';
                currentCustomerId = saved.currentCustomerId || null;
            } else {
                clearCartState();
            }
        }
    }

    const main = document.getElementById('main-content');
    main.innerHTML = `
        <div class="page-header">
            <h1>${FA('cash-register')} ${editingOrderId ? `تعديل الطلب #${editingOrderId}` : 'نقطة البيع'}</h1>
            <div class="page-actions">
                ${editingOrderId ? `<button class="btn btn-secondary" onclick="cancelEditOrder()"><i class="fas fa-times"></i> إلغاء التعديل</button>` : ''}
                <button class="btn btn-warning" onclick="openRefundModal()"><i class="fas fa-undo"></i> إرجاع طلب</button>
            </div>
        </div>

        <div class="pos-container">
            <!-- قسم المنتجات -->
            <div class="menu-section">
                <div class="menu-toolbar">
                    <input type="text" id="pos-search" placeholder="بحث: اسم المنتج أو الباركود..." oninput="filterPOSItems()">
                </div>
                <div class="category-grid" id="pos-categories"></div>
                <div class="items-grid" id="pos-items"></div>
            </div>

            <!-- قسم الفاتورة -->
            <div class="invoice-section">
                <h3>${FA('shopping-cart')} الفاتورة الحالية</h3>

                <div class="form-row" style="margin-bottom:8px;">
                    <div class="form-group" style="margin:0;">
                        <label style="font-size:11px;">نوع الطلب</label>
                        <select id="order-type" style="padding:6px;">
                            <option value="سفري">سفري</option>
                            <option value="محلي">محلي</option>
                        </select>
                    </div>
                    <div class="form-group" style="margin:0;">
                        <label style="font-size:11px;">الطاولة</label>
                        <select id="order-table" style="padding:6px;">
                            <option value="">-</option>
                            ${tablesCache.map(t => `<option value="${t.id}">${t.name}</option>`).join('')}
                        </select>
                    </div>
                </div>
                <div class="form-row" style="margin-bottom:8px;">
                    <div class="form-group" style="margin:0;">
                        <label style="font-size:11px;">الكابتن</label>
                        <select id="order-waiter" style="padding:6px;">
                            <option value="">-</option>
                            ${waitersCache.map(w => `<option value="${w.id}">${w.name}</option>`).join('')}
                        </select>
                    </div>
                    <div class="form-group" style="margin:0;">
                        <label style="font-size:11px;">العميل</label>
                        <select id="order-customer" style="padding:6px;" onchange="currentCustomerId = this.value || null; saveCartState();">
                            <option value="">عميل عابر</option>
                            ${customersCache.map(c => `<option value="${c.id}" ${currentCustomerId == c.id ? 'selected' : ''}>${c.name}${c.phone ? ' - ' + c.phone : ''}</option>`).join('')}
                        </select>
                    </div>
                </div>

                <div class="cart-items" id="cart-items"></div>

                <!-- خصم الفاتورة -->
                <div style="display:grid; grid-template-columns: 1fr 90px 90px; gap:6px; margin-bottom:6px;">
                    <input type="number" id="cart-discount-input" value="${cartDiscount}" min="0" step="0.01" placeholder="قيمة الخصم"
                        oninput="cartDiscount = parseFloat(this.value) || 0; updateInvoiceTotals(); saveCartState();"
                        style="padding:8px; border:2px solid #cfd8dc; border-radius:6px;">
                    <select id="cart-discount-type" onchange="cartDiscountType = this.value; updateInvoiceTotals(); saveCartState();"
                        style="padding:8px; border:2px solid #cfd8dc; border-radius:6px;">
                        <option value="amount" ${cartDiscountType === 'amount' ? 'selected' : ''}>مبلغ</option>
                        <option value="percent" ${cartDiscountType === 'percent' ? 'selected' : ''}>%</option>
                    </select>
                    <button class="btn btn-secondary btn-sm" onclick="document.getElementById('cart-discount-input').value=0; cartDiscount=0; updateInvoiceTotals();">${FA('times')}</button>
                </div>

                <div class="invoice-summary">
                    <div class="summary-row"><span>المجموع الفرعي:</span><span id="cart-subtotal">0.00</span></div>
                    <div class="summary-row"><span>خصم الفاتورة:</span><span id="cart-discount-amount" style="color:var(--danger);">0.00</span></div>
                    <div class="summary-row" id="tax-row" style="display:${taxRate > 0 ? 'flex' : 'none'};"><span>الضريبة (${taxRate}%):</span><span id="cart-tax">0.00</span></div>
                    <div class="summary-row total"><span>الإجمالي:</span><span id="cart-total">0.00</span></div>
                </div>

                <div class="payment-options">
                    <button class="${selectedPayment === 'cash' ? 'active' : ''}" data-payment="cash" onclick="setPayment('cash')">${FA('money-bill')} نقدي</button>
                    <button class="${selectedPayment === 'card' ? 'active' : ''}" data-payment="card" onclick="setPayment('card')">${FA('credit-card')} بطاقة</button>
                    <button class="${selectedPayment === 'transfer' ? 'active' : ''}" data-payment="transfer" onclick="setPayment('transfer')">${FA('exchange-alt')} تحويل</button>
                </div>

                <div style="display:flex; gap:8px;">
                    <button class="btn btn-danger" style="flex:1;" onclick="clearCart()">${FA('trash')} مسح</button>
                    <button class="btn btn-success btn-lg" style="flex:2;" onclick="${editingOrderId ? 'saveEditedOrder()' : 'completeSale()'}">${FA('check')} ${editingOrderId ? 'حفظ التعديل' : 'إتمام البيع'}</button>
                </div>
            </div>
        </div>
    `;
    renderPOSCategories();
    renderPOSItems();
    renderCart();
}

function renderPOSCategories() {
    const cont = document.getElementById('pos-categories');
    if (!cont) return;
    cont.innerHTML = `<button class="cat-btn ${currentCategory === 'all' ? 'active' : ''}" onclick="setCategory('all')">الكل</button>` +
        categoriesCache.map(c => `<button class="cat-btn ${currentCategory == c.id ? 'active' : ''}" onclick="setCategory(${c.id})">${c.name}</button>`).join('');
}

function setCategory(id) {
    currentCategory = id;
    renderPOSCategories();
    renderPOSItems();
}

function renderPOSItems() {
    const cont = document.getElementById('pos-items');
    if (!cont) return;
    const searchInput = document.getElementById('pos-search');
    const q = searchInput ? searchInput.value.trim().toLowerCase() : '';
    let items = productsCache;
    if (currentCategory !== 'all') items = items.filter(p => p.category_id == currentCategory);
    if (q) {
        items = items.filter(p => (p.name || '').toLowerCase().includes(q) ||
                                  (p.barcode || '').toLowerCase().includes(q) ||
                                  String(p.price).includes(q));
    }
    if (items.length === 0) {
        cont.innerHTML = '<div class="empty-state" style="grid-column:1/-1;"><i class="fas fa-search"></i><p>لا توجد منتجات</p></div>';
        return;
    }
    cont.innerHTML = items.map(p => {
        const warn = hasLowStockForProduct(p);
        return `
            <div class="item-card ${warn ? 'stock-warning' : ''}" onclick="addToCart(${p.id})">
                <div class="item-img"><i class="fas fa-utensils"></i></div>
                <div class="item-name">${p.name}</div>
                <div class="item-price">${fmt(p.price)}</div>
            </div>`;
    }).join('');
}

function filterPOSItems() { renderPOSItems(); }

// التحقق ما إذا كان المنتج يحتوي على مادة ناقصة
function hasLowStockForProduct(product) {
    if (!product.recipe) return false;
    try {
        const recipe = JSON.parse(product.recipe);
        if (!Array.isArray(recipe)) return false;
        for (let comp of recipe) {
            const mat = materialsCache.find(m => m.id == comp.material_id);
            if (mat && mat.min_stock > 0 && mat.current_stock <= mat.min_stock) return true;
        }
    } catch (e) {}
    return false;
}

function addToCart(productId) {
    const product = productsCache.find(p => p.id === productId);
    if (!product) return;

    // التحقق من توفر المواد الخام
    if (product.recipe) {
        try {
            const recipe = JSON.parse(product.recipe);
            for (let comp of recipe) {
                const mat = materialsCache.find(m => m.id == comp.material_id);
                if (mat && mat.current_stock < comp.qty) {
                    if (!confirm(`المادة "${mat.name}" غير كافية (المتوفر: ${mat.current_stock} ${mat.unit}). هل تريد المتابعة؟`)) return;
                }
            }
        } catch (e) {}
    }

    const existing = cart.find(i => i.id === productId);
    if (existing) {
        existing.qty++;
    } else {
        cart.push({
            id: product.id, name: product.name, price: product.price,
            qty: 1, recipe: product.recipe, discount: 0
        });
    }
    renderCart();
    saveCartState();
}

function renderCart() {
    const cont = document.getElementById('cart-items');
    if (!cont) return;
    if (cart.length === 0) {
        cont.innerHTML = '<div class="empty-state"><i class="fas fa-shopping-cart"></i><p>السلة فارغة</p></div>';
    } else {
        cont.innerHTML = cart.map((it, idx) => `
            <div class="cart-item">
                <div>
                    <div class="cart-item-name">${it.name}</div>
                    <div class="cart-item-meta">${fmt(it.price)} × ${it.qty}${it.discount ? ` <span style="color:var(--danger);">(خصم: ${fmt(it.discount)})</span>` : ''}</div>
                </div>
                <div class="cart-item-controls">
                    <button class="qty-btn minus" onclick="changeQty(${idx}, -1)">-</button>
                    <span class="qty-display">${it.qty}</span>
                    <button class="qty-btn" onclick="changeQty(${idx}, 1)">+</button>
                    <button class="remove-btn" onclick="removeFromCart(${idx})" title="حذف"><i class="fas fa-trash"></i></button>
                    <button class="remove-btn" onclick="setItemDiscount(${idx})" title="خصم على هذا الصنف" style="color:var(--warning);"><i class="fas fa-percent"></i></button>
                </div>
                <div class="cart-item-price" style="grid-column:1/-1; text-align:left;">${fmt(it.price * it.qty - (it.discount || 0))}</div>
            </div>
        `).join('');
    }
    updateInvoiceTotals();
}

function changeQty(idx, delta) {
    cart[idx].qty += delta;
    if (cart[idx].qty <= 0) cart.splice(idx, 1);
    renderCart();
    saveCartState();
}
function removeFromCart(idx) {
    cart.splice(idx, 1);
    renderCart();
    saveCartState();
}
function setItemDiscount(idx) {
    const it = cart[idx];
    const lineTotal = it.price * it.qty;
    const val = prompt(`خصم الصنف "${it.name}" (الإجمالي: ${fmt(lineTotal)})\nأدخل قيمة الخصم بالعملة:`, it.discount || 0);
    if (val === null) return;
    const n = parseFloat(val);
    if (isNaN(n) || n < 0) { showToast('قيمة غير صحيحة', 'warning'); return; }
    if (n > lineTotal) { showToast('الخصم أكبر من السعر', 'warning'); return; }
    cart[idx].discount = n;
    renderCart();
    saveCartState();
}

function updateInvoiceTotals() {
    const subtotal = cart.reduce((s, i) => s + (i.price * i.qty - (i.discount || 0)), 0);
    let discountAmount = 0;
    if (cartDiscountType === 'percent') {
        discountAmount = subtotal * (cartDiscount / 100);
    } else {
        discountAmount = cartDiscount;
    }
    if (discountAmount > subtotal) discountAmount = subtotal;
    const afterDiscount = subtotal - discountAmount;
    const tax = taxRate > 0 ? afterDiscount * (taxRate / 100) : 0;
    const total = afterDiscount + tax;

    const $ = id => document.getElementById(id);
    if ($('cart-subtotal')) $('cart-subtotal').innerText = fmt(subtotal);
    if ($('cart-discount-amount')) $('cart-discount-amount').innerText = fmt(discountAmount);
    if ($('cart-tax')) $('cart-tax').innerText = fmt(tax);
    if ($('cart-total')) $('cart-total').innerText = fmt(total);
}

function setPayment(method) {
    selectedPayment = method;
    document.querySelectorAll('.payment-options button').forEach(b => {
        b.classList.toggle('active', b.dataset.payment === method);
    });
    saveCartState();
}

function clearCart() {
    if (cart.length === 0) return;
    if (!confirm('مسح السلة بالكامل؟')) return;
    cart = [];
    cartDiscount = 0;
    currentCustomerId = null;
    renderCart();
    clearCartState();
}

async function completeSale() {
    if (cart.length === 0) { showToast('السلة فارغة', 'warning'); return; }
    if (!currentShiftId) { showToast('يجب فتح وردية أولاً', 'warning'); return; }

    const subtotal = cart.reduce((s, i) => s + (i.price * i.qty - (i.discount || 0)), 0);
    let discountAmount = cartDiscountType === 'percent' ? subtotal * (cartDiscount / 100) : cartDiscount;
    if (discountAmount > subtotal) discountAmount = subtotal;
    const afterDiscount = subtotal - discountAmount;
    const tax = taxRate > 0 ? afterDiscount * (taxRate / 100) : 0;
    const total = afterDiscount + tax;

    let paidAmount = total;
    if (selectedPayment === 'cash') {
        const paid = prompt(`الإجمالي: ${fmt(total)}\nأدخل المبلغ المدفوع:`, fmt(total));
        if (paid === null) return;
        paidAmount = parseFloat(paid);
        if (isNaN(paidAmount) || paidAmount < total) {
            if (!confirm(`المبلغ ${fmt(paidAmount)} أقل من الإجمالي ${fmt(total)}. هل تريد المتابعة؟`)) return;
        }
    }
    const changeAmount = paidAmount - total;
    const tableId = document.getElementById('order-table').value || null;
    const waiterId = document.getElementById('order-waiter').value || null;
    const orderType = document.getElementById('order-type').value;
    const customerId = document.getElementById('order-customer').value || null;

    const data = {
        company_id: currentCompany.id,
        table_id: tableId, waiter_id: waiterId, user_id: currentUser.id, customer_id: customerId,
        subtotal: subtotal, total: afterDiscount, tax: tax, total_with_tax: total,
        discount: discountAmount, discount_type: cartDiscountType,
        payment_method: selectedPayment, paid_amount: paidAmount, change_amount: changeAmount,
        order_type: orderType, shift_id: currentShiftId,
        items: cart, notes: ''
    };

    const r = await ipcRenderer.invoke('create-order', data);
    if (r.success) {
        showToast(`تم إنشاء الطلب #${r.orderId}`, 'success');
        // طباعة الفاتورة
        printReceipt(r.orderId, data, paidAmount, changeAmount);
        cart = [];
        cartDiscount = 0;
        currentCustomerId = null;
        clearCartState();
        renderPOS();
    } else {
        showToast(r.error || 'خطأ في حفظ الطلب', 'danger');
    }
}

// ========== طباعة الفاتورة ==========
function buildReceiptHTML(orderId, data, paidAmount, changeAmount) {
    const lines = [];
    lines.push(`<div style="text-align:center; font-weight:800; font-size:14px;">${currentCompany.name}</div>`);
    if (currentCompany.phone) lines.push(`<div style="text-align:center;">${currentCompany.phone}</div>`);
    if (currentCompany.address) lines.push(`<div style="text-align:center; font-size:11px;">${currentCompany.address}</div>`);
    if (currentCompany.tax_number) lines.push(`<div style="text-align:center; font-size:11px;">الرقم الضريبي: ${currentCompany.tax_number}</div>`);
    lines.push(`<div style="text-align:center; border-top:1px dashed #000; border-bottom:1px dashed #000; padding:4px 0; margin:6px 0; font-weight:800;">فاتورة ضريبية مبسطة</div>`);
    lines.push(`<div>رقم الفاتورة: ${orderId}</div>`);
    lines.push(`<div>التاريخ: ${todayStr()} ${nowTimeStr()}</div>`);
    lines.push(`<div>الكاشير: ${currentUser.full_name}</div>`);
    if (data.order_type) lines.push(`<div>نوع الطلب: ${data.order_type}</div>`);
    lines.push(`<div style="border-top:1px dashed #000; margin-top:6px; padding-top:4px;"></div>`);
    lines.push(`<table style="width:100%; font-size:11px; border-collapse:collapse;">
        <tr style="border-bottom:1px solid #000;"><th style="text-align:right;">الصنف</th><th>كمية</th><th>سعر</th><th>إجمالي</th></tr>
        ${data.items.map(it => `<tr><td>${it.name}</td><td style="text-align:center;">${it.qty}</td><td style="text-align:center;">${fmt(it.price)}</td><td style="text-align:left;">${fmt(it.price * it.qty - (it.discount || 0))}</td></tr>`).join('')}
    </table>`);
    lines.push(`<div style="border-top:1px dashed #000; margin-top:6px;"></div>`);
    lines.push(`<div>المجموع الفرعي: ${fmt(data.subtotal || data.total + data.discount)}</div>`);
    if (data.discount > 0) lines.push(`<div>الخصم: ${fmt(data.discount)}</div>`);
    if (data.tax > 0) lines.push(`<div>الضريبة (${taxRate}%): ${fmt(data.tax)}</div>`);
    lines.push(`<div style="font-weight:800; font-size:14px;">الإجمالي: ${fmt(data.total_with_tax)}</div>`);
    lines.push(`<div>طريقة الدفع: ${({ cash:'نقدي', card:'بطاقة', transfer:'تحويل' })[data.payment_method] || data.payment_method}</div>`);
    if (data.payment_method === 'cash') {
        lines.push(`<div>المدفوع: ${fmt(paidAmount)}</div>`);
        lines.push(`<div>المتبقي: ${fmt(changeAmount)}</div>`);
    }
    lines.push(`<div style="border-top:1px dashed #000; margin-top:6px; padding-top:6px; text-align:center; font-size:10px;">شكراً لزيارتكم</div>`);
    lines.push(`<div style="text-align:center; font-size:10px; margin-top:6px;">تصميم م/ عبدالرحمن الاكوع - 773579486 967+</div>`);
    return lines.join('');
}

async function printReceipt(orderId, data, paidAmount, changeAmount) {
    const html = buildReceiptHTML(orderId, data, paidAmount, changeAmount);
    document.getElementById('thermal-receipt').innerHTML = html;
    document.getElementById('thermal-receipt').style.display = 'block';

    // محاولة الطباعة الحرارية، وإلا الطباعة عبر نافذة المتصفح
    try {
        const text = document.getElementById('thermal-receipt').innerText;
        const r = await ipcRenderer.invoke('print-thermal', { text, html, userId: currentUser.id, companyId: currentCompany.id });
        if (!r.success) {
            window.print();
        }
    } catch (e) {
        window.print();
    }
    setTimeout(() => {
        document.getElementById('thermal-receipt').style.display = 'none';
    }, 1500);
}

// طباعة فاتورة قديمة من قائمة الطلبات
async function reprintOrder(orderId) {
    const detail = await ipcRenderer.invoke('get-order-details', orderId);
    if (!detail) { showToast('الطلب غير موجود', 'danger'); return; }
    const data = {
        order_type: detail.order_type,
        items: detail.items.map(i => ({ name: i.product_name, qty: i.qty, price: i.price, discount: i.discount })),
        subtotal: detail.subtotal || detail.total,
        discount: detail.discount,
        tax: detail.tax,
        total_with_tax: detail.total_with_tax,
        payment_method: detail.payment_method
    };
    printReceipt(orderId, data, detail.paid_amount || detail.total_with_tax, detail.change_amount || 0);
}

// استقبال الطباعة الاحتياطية من main
ipcRenderer.on('fallback-print', (event, html) => {
    document.getElementById('thermal-receipt').innerHTML = html;
    document.getElementById('thermal-receipt').style.display = 'block';
    setTimeout(() => {
        window.print();
        setTimeout(() => { document.getElementById('thermal-receipt').style.display = 'none'; }, 1000);
    }, 200);
});

function openRefundModal() {
    document.getElementById('refund-modal').classList.add('active');
}
async function processRefund() {
    const orderId = parseInt(document.getElementById('refund-order-id').value);
    const reason = document.getElementById('refund-reason').value.trim();
    if (!orderId) { showToast('أدخل رقم الطلب', 'warning'); return; }
    if (!reason) { showToast('أدخل سبب الإرجاع', 'warning'); return; }
    if (!confirm(`تأكيد إرجاع الطلب #${orderId}؟`)) return;
    const r = await ipcRenderer.invoke('refund-order', { orderId, userId: currentUser.id, reason });
    if (r.success) {
        showToast('تم إرجاع الطلب', 'success');
        document.getElementById('refund-modal').classList.remove('active');
        document.getElementById('refund-order-id').value = '';
        document.getElementById('refund-reason').value = '';
    } else {
        showToast(r.error || 'فشل إرجاع الطلب', 'danger');
    }
}

// ========== تعديل طلب موجود ==========
async function editOrder(orderId) {
    const detail = await ipcRenderer.invoke('get-order-details', orderId);
    if (!detail) { showToast('الطلب غير موجود', 'danger'); return; }
    if (detail.status === 'refunded') { showToast('لا يمكن تعديل طلب مرتجع', 'warning'); return; }

    cart = detail.items.map(i => ({
        id: i.product_id, name: i.product_name,
        price: i.price, qty: i.qty, recipe: i.recipe, discount: i.discount || 0
    }));
    cartDiscount = detail.discount || 0;
    cartDiscountType = detail.discount_type || 'amount';
    selectedPayment = detail.payment_method;
    currentCustomerId = detail.customer_id;
    editingOrderId = orderId;
    switchTab('pos');
    setTimeout(() => {
        const tEl = document.getElementById('order-table');
        const wEl = document.getElementById('order-waiter');
        const oEl = document.getElementById('order-type');
        if (tEl && detail.table_id) tEl.value = detail.table_id;
        if (wEl && detail.waiter_id) wEl.value = detail.waiter_id;
        if (oEl) oEl.value = detail.order_type;
    }, 200);
}

async function saveEditedOrder() {
    if (!editingOrderId) return;
    if (cart.length === 0) { showToast('السلة فارغة', 'warning'); return; }

    const subtotal = cart.reduce((s, i) => s + (i.price * i.qty - (i.discount || 0)), 0);
    let discountAmount = cartDiscountType === 'percent' ? subtotal * (cartDiscount / 100) : cartDiscount;
    if (discountAmount > subtotal) discountAmount = subtotal;
    const afterDiscount = subtotal - discountAmount;
    const tax = taxRate > 0 ? afterDiscount * (taxRate / 100) : 0;
    const total = afterDiscount + tax;

    const r = await ipcRenderer.invoke('update-order', {
        orderId: editingOrderId, company_id: currentCompany.id,
        table_id: document.getElementById('order-table').value || null,
        waiter_id: document.getElementById('order-waiter').value || null,
        customer_id: document.getElementById('order-customer').value || null,
        subtotal: subtotal, total: afterDiscount, tax: tax, total_with_tax: total,
        discount: discountAmount, discount_type: cartDiscountType,
        payment_method: selectedPayment, order_type: document.getElementById('order-type').value,
        notes: '', items: cart, userId: currentUser.id
    });
    if (r.success) {
        showToast('تم تعديل الطلب', 'success');
        cancelEditOrder();
        switchTab('orders');
    } else {
        showToast(r.error || 'خطأ في تعديل الطلب', 'danger');
    }
}

function cancelEditOrder() {
    editingOrderId = null;
    cart = [];
    cartDiscount = 0;
    currentCustomerId = null;
    clearCartState();
}

// ========== قائمة الطلبات + تعديل/إرجاع/إعادة طباعة ==========
async function renderOrders() {
    const main = document.getElementById('main-content');
    main.innerHTML = `
        <div class="page-header">
            <h1>${FA('receipt')} قائمة الطلبات</h1>
            <div class="page-actions">
                <button class="btn btn-success" onclick="exportOrdersExcel()"><i class="fas fa-file-excel"></i> تصدير Excel</button>
            </div>
        </div>

        <div class="chart-container" style="margin-bottom:14px;">
            <h3>${FA('filter')} الفلاتر</h3>
            <div class="form-row three">
                <div class="form-group"><label>من تاريخ</label><input type="date" id="ord-from" value="${todayStr()}"></div>
                <div class="form-group"><label>إلى تاريخ</label><input type="date" id="ord-to" value="${todayStr()}"></div>
                <div class="form-group">
                    <label>الحالة</label>
                    <select id="ord-status">
                        <option value="all">الكل</option>
                        <option value="completed">مكتمل</option>
                        <option value="refunded">مرتجع</option>
                    </select>
                </div>
            </div>
            <div class="form-row three">
                <div class="form-group">
                    <label>طريقة الدفع</label>
                    <select id="ord-payment">
                        <option value="all">الكل</option>
                        <option value="cash">نقدي</option>
                        <option value="card">بطاقة</option>
                        <option value="transfer">تحويل</option>
                    </select>
                </div>
                <div class="form-group"><label>بحث</label><input type="text" id="ord-search" placeholder="رقم الطلب أو اسم العميل..."></div>
                <div class="form-group" style="display:flex; align-items:flex-end;">
                    <button class="btn btn-primary" style="width:100%;" onclick="loadOrdersList()"><i class="fas fa-search"></i> بحث</button>
                </div>
            </div>
        </div>

        <div id="orders-table-wrap"></div>
    `;
    loadOrdersList();
}

async function loadOrdersList() {
    const from = document.getElementById('ord-from').value || todayStr();
    const to = document.getElementById('ord-to').value || todayStr();
    const status = document.getElementById('ord-status').value;
    const payment = document.getElementById('ord-payment').value;
    const search = document.getElementById('ord-search').value.trim();

    let sql = `SELECT o.*, t.name as table_name, w.name as waiter_name, u.full_name as user_name, c.name as customer_name
               FROM orders o
               LEFT JOIN tables t ON o.table_id=t.id
               LEFT JOIN waiters w ON o.waiter_id=w.id
               LEFT JOIN users u ON o.user_id=u.id
               LEFT JOIN customers c ON o.customer_id=c.id
               WHERE o.company_id=? AND o.date BETWEEN ? AND ?`;
    const params = [currentCompany.id, from, to];
    if (status && status !== 'all') { sql += " AND o.status=?"; params.push(status); }
    if (payment && payment !== 'all') { sql += " AND o.payment_method=?"; params.push(payment); }
    if (search) {
        sql += " AND (CAST(o.id AS TEXT) LIKE ? OR c.name LIKE ?)";
        params.push(`%${search}%`, `%${search}%`);
    }
    sql += " ORDER BY o.id DESC LIMIT 500";
    const rows = await ipcRenderer.invoke('db-query', sql, params);

    const wrap = document.getElementById('orders-table-wrap');
    if (!rows.length) {
        wrap.innerHTML = '<div class="empty-state"><i class="fas fa-receipt"></i><p>لا توجد طلبات</p></div>';
        return;
    }
    wrap.innerHTML = `<div class="table-wrap"><table>
        <thead><tr>
            <th>#</th><th>التاريخ</th><th>الوقت</th><th>العميل</th><th>الطاولة</th><th>الكابتن</th>
            <th>الإجمالي</th><th>الضريبة</th><th>الإجمالي شامل</th><th>الدفع</th><th>الحالة</th><th>إجراءات</th>
        </tr></thead><tbody>
        ${rows.map(o => `<tr ${o.status === 'refunded' ? 'style="opacity:0.55;"' : ''}>
            <td><strong>#${o.id}</strong></td>
            <td>${o.date}</td>
            <td>${o.time || ''}</td>
            <td>${o.customer_name || '-'}</td>
            <td>${o.table_name || '-'}</td>
            <td>${o.waiter_name || '-'}</td>
            <td>${fmt(o.total)}</td>
            <td>${fmt(o.tax)}</td>
            <td><strong>${fmt(o.total_with_tax)}</strong></td>
            <td><span class="badge ${o.payment_method === 'cash' ? 'badge-success' : ''}">${({cash:'نقدي',card:'بطاقة',transfer:'تحويل'})[o.payment_method] || o.payment_method}</span></td>
            <td><span class="badge ${o.status === 'refunded' ? 'badge-danger' : 'badge-success'}">${o.status === 'refunded' ? 'مرتجع' : 'مكتمل'}</span></td>
            <td>
                <button class="btn btn-info btn-sm" onclick="viewOrder(${o.id})" title="عرض"><i class="fas fa-eye"></i></button>
                <button class="btn btn-warning btn-sm" onclick="editOrder(${o.id})" title="تعديل" ${o.status === 'refunded' ? 'disabled' : ''}><i class="fas fa-edit"></i></button>
                <button class="btn btn-secondary btn-sm" onclick="reprintOrder(${o.id})" title="إعادة طباعة"><i class="fas fa-print"></i></button>
                <button class="btn btn-danger btn-sm" onclick="quickRefund(${o.id})" title="إرجاع" ${o.status === 'refunded' ? 'disabled' : ''}><i class="fas fa-undo"></i></button>
            </td>
        </tr>`).join('')}
        </tbody></table></div>`;
}

async function quickRefund(orderId) {
    const reason = prompt(`سبب إرجاع الطلب #${orderId}؟`);
    if (!reason) return;
    const r = await ipcRenderer.invoke('refund-order', { orderId, userId: currentUser.id, reason });
    if (r.success) { showToast('تم الإرجاع', 'success'); loadOrdersList(); }
    else showToast(r.error || 'فشل الإرجاع', 'danger');
}

async function viewOrder(orderId) {
    const d = await ipcRenderer.invoke('get-order-details', orderId);
    if (!d) return;
    const mc = document.getElementById('modal-content');
    mc.innerHTML = `
        <div class="modal-header">
            <h3><i class="fas fa-receipt"></i> تفاصيل الطلب #${d.id}</h3>
            <button class="modal-close" onclick="document.getElementById('modal').classList.remove('active')">&times;</button>
        </div>
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-bottom:14px; font-size:13px;">
            <div><strong>التاريخ:</strong> ${d.date} ${d.time || ''}</div>
            <div><strong>الكاشير:</strong> ${d.user_name || '-'}</div>
            <div><strong>العميل:</strong> ${d.customer_name || 'عميل عابر'}</div>
            <div><strong>الطاولة:</strong> ${d.table_name || '-'}</div>
            <div><strong>الكابتن:</strong> ${d.waiter_name || '-'}</div>
            <div><strong>نوع الطلب:</strong> ${d.order_type || '-'}</div>
        </div>
        <table style="width:100%;">
            <thead><tr><th>الصنف</th><th>السعر</th><th>الكمية</th><th>الخصم</th><th>الإجمالي</th></tr></thead>
            <tbody>
                ${d.items.map(i => `<tr><td>${i.product_name}</td><td>${fmt(i.price)}</td><td>${i.qty}</td><td>${fmt(i.discount)}</td><td>${fmt(i.price * i.qty - (i.discount || 0))}</td></tr>`).join('')}
            </tbody>
        </table>
        <div style="margin-top:14px; padding-top:10px; border-top:2px dashed #cfd8dc;">
            <div class="summary-row"><span>المجموع الفرعي:</span><span>${fmt(d.subtotal || d.total + d.discount)}</span></div>
            <div class="summary-row"><span>خصم الفاتورة:</span><span class="text-danger">${fmt(d.discount)}</span></div>
            <div class="summary-row"><span>الضريبة:</span><span>${fmt(d.tax)}</span></div>
            <div class="summary-row total"><span>الإجمالي:</span><span>${fmt(d.total_with_tax)}</span></div>
        </div>
        <div style="margin-top:14px; display:flex; gap:6px; justify-content:flex-end;">
            <button class="btn btn-secondary" onclick="reprintOrder(${d.id})"><i class="fas fa-print"></i> إعادة طباعة</button>
            <button class="btn btn-primary" onclick="document.getElementById('modal').classList.remove('active')">إغلاق</button>
        </div>
    `;
    document.getElementById('modal').classList.add('active');
}

function exportOrdersExcel() {
    const rows = Array.from(document.querySelectorAll('#orders-table-wrap table tbody tr')).map(tr => {
        return Array.from(tr.querySelectorAll('td')).slice(0, 11).map(td => td.innerText);
    });
    if (rows.length === 0) { showToast('لا توجد بيانات', 'warning'); return; }
    const header = ['رقم', 'التاريخ', 'الوقت', 'العميل', 'الطاولة', 'الكابتن', 'الإجمالي', 'الضريبة', 'الإجمالي شامل', 'الدفع', 'الحالة'];
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([header, ...rows]);
    XLSX.utils.book_append_sheet(wb, ws, 'الطلبات');
    XLSX.writeFile(wb, `orders_${todayStr()}.xlsx`);
    showToast('تم تصدير الملف', 'success');
}

// ========== المنتجات ==========
async function renderProducts() {
    categoriesCache = await ipcRenderer.invoke('db-query', "SELECT * FROM categories WHERE company_id=? ORDER BY name", [currentCompany.id]);
    materialsCache = await ipcRenderer.invoke('db-query', "SELECT * FROM raw_materials WHERE company_id=?", [currentCompany.id]);
    productsCache = await ipcRenderer.invoke('db-query',
        `SELECT p.*, c.name as cat_name FROM products p LEFT JOIN categories c ON p.category_id=c.id WHERE p.company_id=? ORDER BY p.name`,
        [currentCompany.id]);

    const main = document.getElementById('main-content');
    main.innerHTML = `
        <div class="page-header">
            <h1>${FA('boxes')} المنتجات</h1>
            <div class="page-actions">
                <input type="text" id="prod-search" placeholder="بحث بالاسم، الباركود، السعر، أو التصنيف..." oninput="filterProducts()" style="padding:8px 12px; border:2px solid #cfd8dc; border-radius:6px; width:280px;">
                <button class="btn btn-primary" onclick="openProductModal()"><i class="fas fa-plus"></i> إضافة منتج</button>
            </div>
        </div>
        <div id="products-table-wrap"></div>
    `;
    filterProducts();
}

function filterProducts() {
    const q = (document.getElementById('prod-search') || {}).value || '';
    const search = q.trim().toLowerCase();
    let items = productsCache;
    if (search) {
        items = items.filter(p => (p.name || '').toLowerCase().includes(search) ||
                                  (p.barcode || '').toLowerCase().includes(search) ||
                                  String(p.price).includes(search) ||
                                  (p.cat_name || '').toLowerCase().includes(search));
    }
    const wrap = document.getElementById('products-table-wrap');
    if (!items.length) { wrap.innerHTML = '<div class="empty-state"><i class="fas fa-box-open"></i><p>لا توجد منتجات</p></div>'; return; }
    wrap.innerHTML = `<div class="table-wrap"><table>
        <thead><tr><th>#</th><th>الاسم</th><th>القسم</th><th>السعر</th><th>التكلفة</th><th>الوحدة</th><th>الباركود</th><th>إجراءات</th></tr></thead>
        <tbody>${items.map(p => `<tr>
            <td>${p.id}</td>
            <td><strong>${p.name}</strong></td>
            <td>${p.cat_name || '-'}</td>
            <td>${fmt(p.price)}</td>
            <td>${fmt(p.cost)}</td>
            <td>${p.unit || 'قطعة'}</td>
            <td>${p.barcode || '-'}</td>
            <td>
                <button class="btn btn-warning btn-sm" onclick="openProductModal(${p.id})"><i class="fas fa-edit"></i></button>
                <button class="btn btn-danger btn-sm" onclick="deleteProduct(${p.id})"><i class="fas fa-trash"></i></button>
            </td>
        </tr>`).join('')}</tbody></table></div>`;
}

function openProductModal(productId = null) {
    const p = productId ? productsCache.find(x => x.id == productId) : null;
    let recipe = [];
    if (p && p.recipe) { try { recipe = JSON.parse(p.recipe); } catch (e) {} }

    const mc = document.getElementById('modal-content');
    mc.innerHTML = `
        <div class="modal-header">
            <h3><i class="fas fa-${productId ? 'edit' : 'plus'}"></i> ${productId ? 'تعديل منتج' : 'إضافة منتج'}</h3>
            <button class="modal-close" onclick="document.getElementById('modal').classList.remove('active')">&times;</button>
        </div>
        <div class="form-row">
            <div class="form-group"><label>اسم المنتج *</label><input type="text" id="p-name" value="${p ? p.name : ''}"></div>
            <div class="form-group"><label>القسم</label>
                <select id="p-cat">
                    <option value="">-</option>
                    ${categoriesCache.map(c => `<option value="${c.id}" ${p && p.category_id == c.id ? 'selected' : ''}>${c.name}</option>`).join('')}
                </select>
            </div>
        </div>
        <div class="form-row three">
            <div class="form-group"><label>السعر *</label><input type="number" id="p-price" step="0.01" value="${p ? p.price : 0}"></div>
            <div class="form-group"><label>التكلفة</label><input type="number" id="p-cost" step="0.01" value="${p ? p.cost : 0}"></div>
            <div class="form-group"><label>الوحدة</label><input type="text" id="p-unit" value="${p ? p.unit || 'قطعة' : 'قطعة'}"></div>
        </div>
        <div class="form-group"><label>الباركود</label><input type="text" id="p-barcode" value="${p ? p.barcode || '' : ''}"></div>

        <div class="form-group">
            <label>المكونات (المواد الخام)</label>
            <div id="recipe-list" style="border:1px solid #cfd8dc; border-radius:8px; padding:8px; max-height:200px; overflow-y:auto;">
                ${recipe.map((r, i) => recipeRowHTML(r, i)).join('')}
            </div>
            <button class="btn btn-secondary btn-sm" onclick="addRecipeRow()" style="margin-top:6px;"><i class="fas fa-plus"></i> إضافة مكون</button>
        </div>

        <div style="display:flex; gap:6px; margin-top:14px;">
            <button class="btn btn-secondary" style="flex:1;" onclick="document.getElementById('modal').classList.remove('active')">إلغاء</button>
            <button class="btn btn-primary" style="flex:2;" onclick="saveProduct(${productId})"><i class="fas fa-save"></i> حفظ</button>
        </div>
    `;
    document.getElementById('modal').classList.add('active');
}

function recipeRowHTML(r, i) {
    return `<div class="recipe-row" style="display:grid; grid-template-columns: 1fr 100px 30px; gap:6px; margin-bottom:5px;">
        <select class="r-mat">
            <option value="">اختر مادة...</option>
            ${materialsCache.map(m => `<option value="${m.id}" ${r && r.material_id == m.id ? 'selected' : ''}>${m.name} (${m.unit})</option>`).join('')}
        </select>
        <input type="number" class="r-qty" placeholder="كمية" step="0.001" value="${r ? r.qty : ''}">
        <button class="btn btn-danger btn-sm" onclick="this.parentElement.remove()">×</button>
    </div>`;
}
function addRecipeRow() {
    const list = document.getElementById('recipe-list');
    const div = document.createElement('div');
    div.innerHTML = recipeRowHTML({}, list.children.length);
    list.appendChild(div.firstElementChild);
}

async function saveProduct(productId) {
    const name = document.getElementById('p-name').value.trim();
    if (!name) { showToast('الاسم مطلوب', 'warning'); return; }
    const price = parseFloat(document.getElementById('p-price').value) || 0;
    const cost = parseFloat(document.getElementById('p-cost').value) || 0;
    const cat = document.getElementById('p-cat').value || null;
    const unit = document.getElementById('p-unit').value.trim() || 'قطعة';
    const barcode = document.getElementById('p-barcode').value.trim();

    const recipe = [];
    document.querySelectorAll('.recipe-row').forEach(row => {
        const matId = row.querySelector('.r-mat').value;
        const qty = parseFloat(row.querySelector('.r-qty').value);
        if (matId && qty > 0) recipe.push({ material_id: parseInt(matId), qty });
    });

    const r = await ipcRenderer.invoke('save-product', {
        id: productId, company_id: currentCompany.id,
        name, price, cost, category_id: cat, barcode,
        recipe: JSON.stringify(recipe), unit, image: null,
        userId: currentUser.id
    });
    if (r.success) {
        showToast(productId ? 'تم التعديل' : 'تم الحفظ', 'success');
        document.getElementById('modal').classList.remove('active');
        renderProducts();
    } else {
        showToast(r.error || 'خطأ', 'danger');
    }
}

async function deleteProduct(id) {
    if (!confirm('حذف هذا المنتج؟')) return;
    const r = await ipcRenderer.invoke('delete-product', { id, company_id: currentCompany.id, userId: currentUser.id });
    if (r.success) { showToast('تم الحذف', 'success'); renderProducts(); }
    else showToast(r.error || 'خطأ', 'danger');
}

// ========== الأقسام ==========
async function renderCategories() {
    categoriesCache = await ipcRenderer.invoke('db-query', "SELECT * FROM categories WHERE company_id=? ORDER BY name", [currentCompany.id]);
    const main = document.getElementById('main-content');
    main.innerHTML = `
        <div class="page-header">
            <h1>${FA('tags')} الأقسام</h1>
            <div class="page-actions">
                <button class="btn btn-primary" onclick="addCategory()"><i class="fas fa-plus"></i> إضافة قسم</button>
            </div>
        </div>
        <div class="table-wrap"><table>
            <thead><tr><th>#</th><th>الاسم</th><th>إجراءات</th></tr></thead>
            <tbody>${categoriesCache.map(c => `<tr><td>${c.id}</td><td>${c.name}</td>
                <td><button class="btn btn-danger btn-sm" onclick="delCategory(${c.id})"><i class="fas fa-trash"></i></button></td>
            </tr>`).join('') || '<tr><td colspan="3" style="text-align:center; color:var(--text-muted); padding:20px;">لا توجد أقسام</td></tr>'}</tbody>
        </table></div>
    `;
}
async function addCategory() {
    const name = prompt('اسم القسم:');
    if (!name || !name.trim()) return;
    const r = await ipcRenderer.invoke('save-category', { company_id: currentCompany.id, name: name.trim(), userId: currentUser.id });
    if (r.success) { showToast('تم الإضافة', 'success'); renderCategories(); }
    else showToast(r.error || 'خطأ', 'danger');
}
async function delCategory(id) {
    if (!confirm('حذف القسم؟ سيتم احتساب المنتجات بدون قسم')) return;
    const r = await ipcRenderer.invoke('delete-category', { id, userId: currentUser.id });
    if (r.success) { showToast('تم الحذف', 'success'); renderCategories(); }
}

// ========== المواد الخام ==========
async function renderMaterials() {
    materialsCache = await ipcRenderer.invoke('db-query', "SELECT * FROM raw_materials WHERE company_id=? ORDER BY name", [currentCompany.id]);
    const main = document.getElementById('main-content');
    main.innerHTML = `
        <div class="page-header">
            <h1>${FA('cubes')} المواد الخام</h1>
            <div class="page-actions">
                <button class="btn btn-primary" onclick="openMaterialModal()"><i class="fas fa-plus"></i> إضافة مادة</button>
            </div>
        </div>
        <div class="table-wrap"><table>
            <thead><tr><th>#</th><th>الاسم</th><th>الوحدة</th><th>المخزون الحالي</th><th>الحد الأدنى</th><th>سعر الشراء</th><th>الحالة</th><th>إجراءات</th></tr></thead>
            <tbody>${materialsCache.map(m => {
                const low = m.min_stock > 0 && m.current_stock <= m.min_stock;
                return `<tr ${low ? 'class="stock-danger"' : ''}>
                    <td>${m.id}</td><td><strong>${m.name}</strong></td><td>${m.unit}</td>
                    <td>${fmt(m.current_stock)}</td><td>${fmt(m.min_stock)}</td><td>${fmt(m.purchase_price)}</td>
                    <td>${low ? '<span class="badge badge-danger">ناقص</span>' : '<span class="badge badge-success">طبيعي</span>'}</td>
                    <td>
                        <button class="btn btn-success btn-sm" onclick="openAddStockModal(${m.id})" title="توريد"><i class="fas fa-plus"></i></button>
                        <button class="btn btn-warning btn-sm" onclick="openMaterialModal(${m.id})"><i class="fas fa-edit"></i></button>
                        <button class="btn btn-danger btn-sm" onclick="delMaterial(${m.id})"><i class="fas fa-trash"></i></button>
                    </td>
                </tr>`;
            }).join('') || '<tr><td colspan="8" style="text-align:center; color:var(--text-muted); padding:20px;">لا توجد مواد</td></tr>'}</tbody>
        </table></div>
    `;
}

function openMaterialModal(id = null) {
    const m = id ? materialsCache.find(x => x.id == id) : null;
    const mc = document.getElementById('modal-content');
    mc.innerHTML = `
        <div class="modal-header">
            <h3><i class="fas fa-cubes"></i> ${id ? 'تعديل مادة' : 'إضافة مادة خام'}</h3>
            <button class="modal-close" onclick="document.getElementById('modal').classList.remove('active')">&times;</button>
        </div>
        <div class="form-row">
            <div class="form-group"><label>الاسم *</label><input type="text" id="m-name" value="${m ? m.name : ''}"></div>
            <div class="form-group"><label>الوحدة *</label><input type="text" id="m-unit" value="${m ? m.unit : 'كجم'}" placeholder="كجم، لتر، قطعة..."></div>
        </div>
        <div class="form-row">
            <div class="form-group"><label>الحد الأدنى للمخزون</label><input type="number" id="m-min" step="0.001" value="${m ? m.min_stock : 0}"></div>
            <div class="form-group"><label>سعر الشراء (للوحدة)</label><input type="number" id="m-price" step="0.01" value="${m ? m.purchase_price : 0}"></div>
        </div>
        <div style="display:flex; gap:6px; margin-top:14px;">
            <button class="btn btn-secondary" style="flex:1;" onclick="document.getElementById('modal').classList.remove('active')">إلغاء</button>
            <button class="btn btn-primary" style="flex:2;" onclick="saveMaterial(${id})"><i class="fas fa-save"></i> حفظ</button>
        </div>
    `;
    document.getElementById('modal').classList.add('active');
}
async function saveMaterial(id) {
    const name = document.getElementById('m-name').value.trim();
    if (!name) { showToast('الاسم مطلوب', 'warning'); return; }
    const r = await ipcRenderer.invoke('save-material', {
        id, company_id: currentCompany.id,
        name, unit: document.getElementById('m-unit').value.trim() || 'وحدة',
        min_stock: parseFloat(document.getElementById('m-min').value) || 0,
        purchase_price: parseFloat(document.getElementById('m-price').value) || 0
    });
    if (r.success) { showToast(id ? 'تم التعديل' : 'تم الإضافة', 'success'); document.getElementById('modal').classList.remove('active'); renderMaterials(); }
    else showToast(r.error || 'خطأ', 'danger');
}
async function delMaterial(id) {
    if (!confirm('حذف هذه المادة؟')) return;
    const r = await ipcRenderer.invoke('delete-material', { id, company_id: currentCompany.id });
    if (r.success) { showToast('تم الحذف', 'success'); renderMaterials(); }
}

async function openAddStockModal(materialId) {
    suppliersCache = await ipcRenderer.invoke('db-query', "SELECT * FROM suppliers WHERE company_id=? ORDER BY name", [currentCompany.id]);
    const m = materialsCache.find(x => x.id == materialId);
    const mc = document.getElementById('modal-content');
    mc.innerHTML = `
        <div class="modal-header">
            <h3><i class="fas fa-plus-circle"></i> توريد مادة: ${m.name}</h3>
            <button class="modal-close" onclick="document.getElementById('modal').classList.remove('active')">&times;</button>
        </div>
        <div class="form-group"><label>الكمية الموردة (${m.unit}) *</label><input type="number" id="stock-qty" step="0.001" min="0.001"></div>
        <div class="form-group"><label>المورد</label>
            <select id="stock-supplier">
                <option value="">- بدون -</option>
                ${suppliersCache.map(s => `<option value="${s.id}">${s.name}</option>`).join('')}
            </select>
        </div>
        <div class="form-group"><label>ملاحظات</label><input type="text" id="stock-notes" placeholder="فاتورة رقم..."></div>
        <div style="display:flex; gap:6px;">
            <button class="btn btn-secondary" style="flex:1;" onclick="document.getElementById('modal').classList.remove('active')">إلغاء</button>
            <button class="btn btn-success" style="flex:2;" onclick="confirmAddStock(${materialId})"><i class="fas fa-check"></i> تأكيد التوريد</button>
        </div>
    `;
    document.getElementById('modal').classList.add('active');
}
async function confirmAddStock(materialId) {
    const qty = parseFloat(document.getElementById('stock-qty').value);
    if (!qty || qty <= 0) { showToast('أدخل كمية صحيحة', 'warning'); return; }
    const supplier_id = document.getElementById('stock-supplier').value || null;
    const notes = document.getElementById('stock-notes').value.trim();
    const r = await ipcRenderer.invoke('add-stock', { material_id: materialId, qty, supplier_id, notes, userId: currentUser.id });
    if (r.success) { showToast('تم التوريد', 'success'); document.getElementById('modal').classList.remove('active'); renderMaterials(); }
    else showToast(r.error || 'خطأ', 'danger');
}

// ========== جرد المخزون ==========
async function renderInventory() {
    materialsCache = await ipcRenderer.invoke('db-query', "SELECT * FROM raw_materials WHERE company_id=? ORDER BY name", [currentCompany.id]);
    const main = document.getElementById('main-content');
    main.innerHTML = `
        <div class="page-header">
            <h1>${FA('warehouse')} جرد المخزون وحركاته</h1>
        </div>
        <div class="tabs-row">
            <button class="tab-btn active" onclick="switchInvTab(this, 'adjust')">جرد المواد</button>
            <button class="tab-btn" onclick="switchInvTab(this, 'movement')">حركة المخزون</button>
        </div>
        <div id="inv-tab-content"></div>
    `;
    showInvAdjust();
}

function switchInvTab(btn, tab) {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    if (tab === 'adjust') showInvAdjust();
    else showInvMovement();
}

function showInvAdjust() {
    const cont = document.getElementById('inv-tab-content');
    cont.innerHTML = `
        <div class="alert-info">${FA('info-circle')} اضغط على "جرد" لتعديل الكمية الفعلية لكل مادة مع تسجيل السبب</div>
        <div class="table-wrap"><table>
            <thead><tr><th>#</th><th>الاسم</th><th>الوحدة</th><th>الكمية الحالية</th><th>الحد الأدنى</th><th>إجراء</th></tr></thead>
            <tbody>${materialsCache.map(m => `<tr>
                <td>${m.id}</td><td><strong>${m.name}</strong></td><td>${m.unit}</td>
                <td>${fmt(m.current_stock)}</td><td>${fmt(m.min_stock)}</td>
                <td><button class="btn btn-warning btn-sm" onclick="openAdjustModal(${m.id})"><i class="fas fa-balance-scale"></i> جرد</button></td>
            </tr>`).join('')}</tbody>
        </table></div>
    `;
}
function openAdjustModal(materialId) {
    const m = materialsCache.find(x => x.id == materialId);
    const mc = document.getElementById('modal-content');
    mc.innerHTML = `
        <div class="modal-header">
            <h3><i class="fas fa-balance-scale"></i> جرد: ${m.name}</h3>
            <button class="modal-close" onclick="document.getElementById('modal').classList.remove('active')">&times;</button>
        </div>
        <div class="alert-info">الكمية الحالية في النظام: <strong>${fmt(m.current_stock)} ${m.unit}</strong></div>
        <div class="form-group"><label>الكمية الفعلية الجديدة (${m.unit}) *</label><input type="number" id="adj-qty" step="0.001" min="0" value="${m.current_stock}"></div>
        <div class="form-group"><label>السبب *</label>
            <select id="adj-reason">
                <option value="جرد دوري">جرد دوري</option>
                <option value="تالف">تالف</option>
                <option value="هدر">هدر</option>
                <option value="منتهي الصلاحية">منتهي الصلاحية</option>
                <option value="خطأ تسجيل">تصحيح خطأ تسجيل</option>
                <option value="أخرى">أخرى</option>
            </select>
        </div>
        <div class="form-group"><label>ملاحظات</label><input type="text" id="adj-notes"></div>
        <div style="display:flex; gap:6px;">
            <button class="btn btn-secondary" style="flex:1;" onclick="document.getElementById('modal').classList.remove('active')">إلغاء</button>
            <button class="btn btn-warning" style="flex:2;" onclick="confirmAdjust(${materialId})"><i class="fas fa-check"></i> تأكيد الجرد</button>
        </div>
    `;
    document.getElementById('modal').classList.add('active');
}
async function confirmAdjust(materialId) {
    const new_qty = parseFloat(document.getElementById('adj-qty').value);
    if (isNaN(new_qty) || new_qty < 0) { showToast('كمية غير صحيحة', 'warning'); return; }
    const reason = document.getElementById('adj-reason').value + ': ' + document.getElementById('adj-notes').value;
    const r = await ipcRenderer.invoke('adjust-stock', { material_id: materialId, new_qty, reason, userId: currentUser.id, company_id: currentCompany.id });
    if (r.success) { showToast('تم الجرد', 'success'); document.getElementById('modal').classList.remove('active'); renderInventory(); }
    else showToast(r.error || 'خطأ', 'danger');
}

async function showInvMovement() {
    const cont = document.getElementById('inv-tab-content');
    cont.innerHTML = `
        <div class="form-row three" style="margin-bottom:14px;">
            <div class="form-group"><label>من تاريخ</label><input type="date" id="mv-from" value="${new Date(Date.now() - 30*86400000).toISOString().slice(0,10)}"></div>
            <div class="form-group"><label>إلى تاريخ</label><input type="date" id="mv-to" value="${todayStr()}"></div>
            <div class="form-group">
                <label>النوع</label>
                <select id="mv-type">
                    <option value="all">الكل</option>
                    <option value="supply">توريد</option>
                    <option value="consumption">استهلاك</option>
                    <option value="adjustment">جرد</option>
                </select>
            </div>
        </div>
        <div class="form-row">
            <div class="form-group">
                <label>المادة</label>
                <select id="mv-mat">
                    <option value="">الكل</option>
                    ${materialsCache.map(m => `<option value="${m.id}">${m.name}</option>`).join('')}
                </select>
            </div>
            <div class="form-group" style="display:flex; align-items:flex-end;">
                <button class="btn btn-primary" style="width:100%;" onclick="loadMovementList()"><i class="fas fa-search"></i> عرض</button>
            </div>
        </div>
        <div id="mv-list"></div>
    `;
    loadMovementList();
}

async function loadMovementList() {
    const startDate = document.getElementById('mv-from').value;
    const endDate = document.getElementById('mv-to').value;
    const type = document.getElementById('mv-type').value;
    const materialId = document.getElementById('mv-mat').value || null;
    const rows = await ipcRenderer.invoke('get-inventory-movement', { startDate, endDate, materialId, type, companyId: currentCompany.id });
    const cont = document.getElementById('mv-list');
    if (!rows.length) { cont.innerHTML = '<div class="empty-state"><i class="fas fa-exchange-alt"></i><p>لا توجد حركات</p></div>'; return; }
    const typeLabels = { supply: 'توريد', consumption: 'استهلاك', adjustment: 'جرد' };
    cont.innerHTML = `<div class="table-wrap"><table>
        <thead><tr><th>التاريخ</th><th>المادة</th><th>النوع</th><th>الكمية</th><th>المرجع</th><th>المورد</th><th>المستخدم</th></tr></thead>
        <tbody>${rows.map(r => `<tr>
            <td>${r.date}</td>
            <td>${r.material_name}</td>
            <td><span class="badge ${r.type === 'supply' ? 'badge-success' : r.type === 'consumption' ? 'badge-danger' : 'badge-warning'}">${typeLabels[r.type] || r.type}</span></td>
            <td><strong>${r.qty_change > 0 ? '+' : ''}${fmt(r.qty_change)} ${r.unit}</strong></td>
            <td>${r.reference || '-'}</td>
            <td>${r.supplier_name || '-'}</td>
            <td>${r.user_name || '-'}</td>
        </tr>`).join('')}</tbody>
    </table></div>`;
}

// ========== العملاء ==========
async function renderCustomers() {
    customersCache = await ipcRenderer.invoke('db-query', "SELECT * FROM customers WHERE company_id=? ORDER BY name", [currentCompany.id]);
    const main = document.getElementById('main-content');
    main.innerHTML = `
        <div class="page-header">
            <h1>${FA('users')} العملاء</h1>
            <div class="page-actions">
                <button class="btn btn-primary" onclick="openCustomerModal()"><i class="fas fa-plus"></i> إضافة عميل</button>
            </div>
        </div>
        <div class="table-wrap"><table>
            <thead><tr><th>#</th><th>الاسم</th><th>الهاتف</th><th>العنوان</th><th>ملاحظات</th><th>إجراءات</th></tr></thead>
            <tbody>${customersCache.length ? customersCache.map(c => `<tr>
                <td>${c.id}</td><td><strong>${c.name}</strong></td><td>${c.phone || '-'}</td><td>${c.address || '-'}</td><td>${c.notes || '-'}</td>
                <td>
                    <button class="btn btn-warning btn-sm" onclick="openCustomerModal(${c.id})"><i class="fas fa-edit"></i></button>
                    <button class="btn btn-danger btn-sm" onclick="delCustomer(${c.id})"><i class="fas fa-trash"></i></button>
                </td>
            </tr>`).join('') : '<tr><td colspan="6" style="text-align:center; color:var(--text-muted); padding:20px;">لا يوجد عملاء</td></tr>'}</tbody>
        </table></div>
    `;
}
function openCustomerModal(id = null) {
    const c = id ? customersCache.find(x => x.id == id) : null;
    const mc = document.getElementById('modal-content');
    mc.innerHTML = `
        <div class="modal-header"><h3><i class="fas fa-user"></i> ${id ? 'تعديل عميل' : 'إضافة عميل'}</h3>
            <button class="modal-close" onclick="document.getElementById('modal').classList.remove('active')">&times;</button>
        </div>
        <div class="form-row">
            <div class="form-group"><label>الاسم *</label><input type="text" id="cu-name" value="${c ? c.name : ''}"></div>
            <div class="form-group"><label>الهاتف</label><input type="text" id="cu-phone" value="${c ? c.phone || '' : ''}"></div>
        </div>
        <div class="form-group"><label>العنوان</label><input type="text" id="cu-address" value="${c ? c.address || '' : ''}"></div>
        <div class="form-group"><label>ملاحظات</label><textarea id="cu-notes">${c ? c.notes || '' : ''}</textarea></div>
        <div style="display:flex; gap:6px;">
            <button class="btn btn-secondary" style="flex:1;" onclick="document.getElementById('modal').classList.remove('active')">إلغاء</button>
            <button class="btn btn-primary" style="flex:2;" onclick="saveCustomer(${id})"><i class="fas fa-save"></i> حفظ</button>
        </div>
    `;
    document.getElementById('modal').classList.add('active');
}
async function saveCustomer(id) {
    const name = document.getElementById('cu-name').value.trim();
    if (!name) { showToast('الاسم مطلوب', 'warning'); return; }
    const r = await ipcRenderer.invoke('save-customer', {
        id, company_id: currentCompany.id, name,
        phone: document.getElementById('cu-phone').value.trim(),
        address: document.getElementById('cu-address').value.trim(),
        notes: document.getElementById('cu-notes').value.trim(),
        userId: currentUser.id
    });
    if (r.success) { showToast(id ? 'تم التعديل' : 'تم الإضافة', 'success'); document.getElementById('modal').classList.remove('active'); renderCustomers(); }
    else showToast(r.error || 'خطأ', 'danger');
}
async function delCustomer(id) {
    if (!confirm('حذف هذا العميل؟')) return;
    const r = await ipcRenderer.invoke('delete-customer', { id, userId: currentUser.id });
    if (r.success) { showToast('تم الحذف', 'success'); renderCustomers(); }
}

// ========== الموردون ==========
async function renderSuppliers() {
    suppliersCache = await ipcRenderer.invoke('db-query', "SELECT * FROM suppliers WHERE company_id=? ORDER BY name", [currentCompany.id]);
    const main = document.getElementById('main-content');
    main.innerHTML = `
        <div class="page-header">
            <h1>${FA('truck')} الموردون</h1>
            <div class="page-actions"><button class="btn btn-primary" onclick="openSupplierModal()"><i class="fas fa-plus"></i> إضافة مورد</button></div>
        </div>
        <div class="table-wrap"><table>
            <thead><tr><th>#</th><th>الاسم</th><th>الهاتف</th><th>العنوان</th><th>ملاحظات</th><th>إجراءات</th></tr></thead>
            <tbody>${suppliersCache.length ? suppliersCache.map(s => `<tr>
                <td>${s.id}</td><td><strong>${s.name}</strong></td><td>${s.phone || '-'}</td><td>${s.address || '-'}</td><td>${s.notes || '-'}</td>
                <td>
                    <button class="btn btn-warning btn-sm" onclick="openSupplierModal(${s.id})"><i class="fas fa-edit"></i></button>
                    <button class="btn btn-danger btn-sm" onclick="delSupplier(${s.id})"><i class="fas fa-trash"></i></button>
                </td>
            </tr>`).join('') : '<tr><td colspan="6" style="text-align:center; color:var(--text-muted); padding:20px;">لا يوجد موردون</td></tr>'}</tbody>
        </table></div>
    `;
}
function openSupplierModal(id = null) {
    const s = id ? suppliersCache.find(x => x.id == id) : null;
    const mc = document.getElementById('modal-content');
    mc.innerHTML = `
        <div class="modal-header"><h3><i class="fas fa-truck"></i> ${id ? 'تعديل مورد' : 'إضافة مورد'}</h3>
            <button class="modal-close" onclick="document.getElementById('modal').classList.remove('active')">&times;</button>
        </div>
        <div class="form-row">
            <div class="form-group"><label>الاسم *</label><input type="text" id="su-name" value="${s ? s.name : ''}"></div>
            <div class="form-group"><label>الهاتف</label><input type="text" id="su-phone" value="${s ? s.phone || '' : ''}"></div>
        </div>
        <div class="form-group"><label>العنوان</label><input type="text" id="su-address" value="${s ? s.address || '' : ''}"></div>
        <div class="form-group"><label>ملاحظات</label><textarea id="su-notes">${s ? s.notes || '' : ''}</textarea></div>
        <div style="display:flex; gap:6px;">
            <button class="btn btn-secondary" style="flex:1;" onclick="document.getElementById('modal').classList.remove('active')">إلغاء</button>
            <button class="btn btn-primary" style="flex:2;" onclick="saveSupplier(${id})"><i class="fas fa-save"></i> حفظ</button>
        </div>
    `;
    document.getElementById('modal').classList.add('active');
}
async function saveSupplier(id) {
    const name = document.getElementById('su-name').value.trim();
    if (!name) { showToast('الاسم مطلوب', 'warning'); return; }
    const r = await ipcRenderer.invoke('save-supplier', {
        id, company_id: currentCompany.id, name,
        phone: document.getElementById('su-phone').value.trim(),
        address: document.getElementById('su-address').value.trim(),
        notes: document.getElementById('su-notes').value.trim(),
        userId: currentUser.id
    });
    if (r.success) { showToast(id ? 'تم التعديل' : 'تم الإضافة', 'success'); document.getElementById('modal').classList.remove('active'); renderSuppliers(); }
    else showToast(r.error || 'خطأ', 'danger');
}
async function delSupplier(id) {
    if (!confirm('حذف هذا المورد؟')) return;
    const r = await ipcRenderer.invoke('delete-supplier', { id, userId: currentUser.id });
    if (r.success) { showToast('تم الحذف', 'success'); renderSuppliers(); }
}

// ========== الطاولات ==========
async function renderTables() {
    tablesCache = await ipcRenderer.invoke('db-query', "SELECT * FROM tables WHERE company_id=? ORDER BY name", [currentCompany.id]);
    const main = document.getElementById('main-content');
    main.innerHTML = `
        <div class="page-header">
            <h1>${FA('chair')} الطاولات</h1>
            <div class="page-actions">
                <button class="btn btn-primary" onclick="addTable()"><i class="fas fa-plus"></i> إضافة طاولة</button>
            </div>
        </div>
        <div class="table-wrap"><table>
            <thead><tr><th>#</th><th>الاسم</th><th>الحالة</th><th>إجراءات</th></tr></thead>
            <tbody>${tablesCache.length ? tablesCache.map(t => `<tr>
                <td>${t.id}</td><td><strong>${t.name}</strong></td>
                <td><span class="badge ${t.status === 'free' ? 'badge-success' : 'badge-warning'}">${t.status === 'free' ? 'فارغة' : 'مشغولة'}</span></td>
                <td>
                    <button class="btn btn-secondary btn-sm" onclick="toggleTableStatus(${t.id}, '${t.status}')">${t.status === 'free' ? 'حجز' : 'تحرير'}</button>
                    <button class="btn btn-danger btn-sm" onclick="delTable(${t.id})"><i class="fas fa-trash"></i></button>
                </td>
            </tr>`).join('') : '<tr><td colspan="4" style="text-align:center; color:var(--text-muted); padding:20px;">لا توجد طاولات</td></tr>'}</tbody>
        </table></div>
    `;
}
async function addTable() {
    const name = prompt('اسم الطاولة (مثال: طاولة 1):');
    if (!name) return;
    await ipcRenderer.invoke('save-table', { company_id: currentCompany.id, name: name.trim() });
    showToast('تم الإضافة', 'success'); renderTables();
}
async function delTable(id) {
    if (!confirm('حذف الطاولة؟')) return;
    await ipcRenderer.invoke('delete-table', { id });
    renderTables();
}
async function toggleTableStatus(id, status) {
    await ipcRenderer.invoke('db-run', "UPDATE tables SET status=? WHERE id=?", [status === 'free' ? 'occupied' : 'free', id]);
    renderTables();
}

// ========== الكباتن ==========
async function renderWaiters() {
    waitersCache = await ipcRenderer.invoke('db-query', "SELECT * FROM waiters WHERE company_id=? ORDER BY name", [currentCompany.id]);
    const main = document.getElementById('main-content');
    main.innerHTML = `
        <div class="page-header">
            <h1>${FA('user-tie')} الكباتن</h1>
            <div class="page-actions">
                <button class="btn btn-primary" onclick="addWaiter()"><i class="fas fa-plus"></i> إضافة كابتن</button>
            </div>
        </div>
        <div class="table-wrap"><table>
            <thead><tr><th>#</th><th>الاسم</th><th>إجراءات</th></tr></thead>
            <tbody>${waitersCache.length ? waitersCache.map(w => `<tr>
                <td>${w.id}</td><td><strong>${w.name}</strong></td>
                <td><button class="btn btn-danger btn-sm" onclick="delWaiter(${w.id})"><i class="fas fa-trash"></i></button></td>
            </tr>`).join('') : '<tr><td colspan="3" style="text-align:center; color:var(--text-muted); padding:20px;">لا يوجد كباتن</td></tr>'}</tbody>
        </table></div>
    `;
}
async function addWaiter() {
    const name = prompt('اسم الكابتن:');
    if (!name) return;
    await ipcRenderer.invoke('save-waiter', { company_id: currentCompany.id, name: name.trim() });
    showToast('تم الإضافة', 'success'); renderWaiters();
}
async function delWaiter(id) {
    if (!confirm('حذف الكابتن؟')) return;
    await ipcRenderer.invoke('delete-waiter', { id });
    renderWaiters();
}


// ========== التقارير ==========
let currentReportTab = 'sales';
let reportChart = null;
let reportData = null;

async function renderReports() {
    document.getElementById('view-reports').innerHTML = `
        <h2><i class="fas fa-chart-line"></i> التقارير المتقدمة</h2>
        <div class="tabs-bar" style="display:flex; gap:8px; flex-wrap:wrap; margin:15px 0;">
            <button class="btn ${currentReportTab==='sales'?'btn-primary':'btn-secondary'}" onclick="switchReportTab('sales')"><i class="fas fa-receipt"></i> المبيعات</button>
            <button class="btn ${currentReportTab==='profit'?'btn-primary':'btn-secondary'}" onclick="switchReportTab('profit')"><i class="fas fa-coins"></i> الأرباح</button>
            <button class="btn ${currentReportTab==='waiters'?'btn-primary':'btn-secondary'}" onclick="switchReportTab('waiters')"><i class="fas fa-user-tie"></i> الكباتن</button>
            <button class="btn ${currentReportTab==='tables'?'btn-primary':'btn-secondary'}" onclick="switchReportTab('tables')"><i class="fas fa-chair"></i> الطاولات</button>
            <button class="btn ${currentReportTab==='customers'?'btn-primary':'btn-secondary'}" onclick="switchReportTab('customers')"><i class="fas fa-users"></i> العملاء</button>
            <button class="btn ${currentReportTab==='inventory'?'btn-primary':'btn-secondary'}" onclick="switchReportTab('inventory')"><i class="fas fa-boxes"></i> المخزون</button>
            <button class="btn ${currentReportTab==='expenses'?'btn-primary':'btn-secondary'}" onclick="switchReportTab('expenses')"><i class="fas fa-money-bill-wave"></i> المصروفات</button>
        </div>
        <div id="report-content"></div>
    `;
    loadReportContent();
}

function switchReportTab(tab) {
    currentReportTab = tab;
    if (reportChart) { try { reportChart.destroy(); } catch(e){} reportChart = null; }
    renderReports();
}

function dateFiltersHTML(prefix='rep') {
    const today = new Date().toISOString().split('T')[0];
    const monthAgo = new Date(Date.now() - 30*86400000).toISOString().split('T')[0];
    return `
        <div class="card" style="margin-bottom:15px;">
            <div style="display:flex; gap:10px; align-items:end; flex-wrap:wrap;">
                <div><label>من</label><input type="date" id="${prefix}-from" value="${monthAgo}" class="input"></div>
                <div><label>إلى</label><input type="date" id="${prefix}-to" value="${today}" class="input"></div>
                <button class="btn btn-primary" onclick="loadReportContent()"><i class="fas fa-search"></i> عرض</button>
                <button class="btn btn-success" onclick="exportReportExcel()"><i class="fas fa-file-excel"></i> تصدير Excel</button>
            </div>
        </div>
    `;
}

async function loadReportContent() {
    const c = document.getElementById('report-content');
    if (!c) return;
    
    if (currentReportTab === 'sales') {
        c.innerHTML = dateFiltersHTML() + `
            <div class="grid-2" style="display:grid; grid-template-columns:1fr 1fr; gap:15px;">
                <div class="card"><h3>المبيعات اليومية</h3><canvas id="salesChart" height="200"></canvas></div>
                <div class="card"><h3>توزيع طرق الدفع</h3><canvas id="paymentChart" height="200"></canvas></div>
            </div>
            <div class="card" style="margin-top:15px;"><div id="sales-summary"></div></div>
        `;
        const from = document.getElementById('rep-from')?.value;
        const to = document.getElementById('rep-to')?.value;
        const sales = await ipcRenderer.invoke('get-sales-report', { company_id: currentCompany.id, from, to });
        const daily = await ipcRenderer.invoke('get-daily-sales-chart', { company_id: currentCompany.id, from, to });
        const payments = await ipcRenderer.invoke('get-payment-distribution', { company_id: currentCompany.id, from, to });
        reportData = { type:'sales', sales, daily, payments };
        
        document.getElementById('sales-summary').innerHTML = `
            <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(180px, 1fr)); gap:15px;">
                <div class="stat-card" style="background:linear-gradient(135deg,#1e88e5,#0d47a1); color:#fff; padding:20px; border-radius:12px;">
                    <div style="font-size:14px; opacity:0.9;">إجمالي الفواتير</div>
                    <div style="font-size:28px; font-weight:bold;">${sales?.total_orders || 0}</div>
                </div>
                <div class="stat-card" style="background:linear-gradient(135deg,#00bcd4,#006064); color:#fff; padding:20px; border-radius:12px;">
                    <div style="font-size:14px; opacity:0.9;">إجمالي المبيعات</div>
                    <div style="font-size:28px; font-weight:bold;">${formatMoney(sales?.total_sales || 0)}</div>
                </div>
                <div class="stat-card" style="background:linear-gradient(135deg,#43a047,#1b5e20); color:#fff; padding:20px; border-radius:12px;">
                    <div style="font-size:14px; opacity:0.9;">صافي المبيعات</div>
                    <div style="font-size:28px; font-weight:bold;">${formatMoney((sales?.total_sales || 0) - (sales?.total_refunds || 0))}</div>
                </div>
                <div class="stat-card" style="background:linear-gradient(135deg,#e53935,#b71c1c); color:#fff; padding:20px; border-radius:12px;">
                    <div style="font-size:14px; opacity:0.9;">المرتجعات</div>
                    <div style="font-size:28px; font-weight:bold;">${formatMoney(sales?.total_refunds || 0)}</div>
                </div>
            </div>
        `;
        
        const ctx1 = document.getElementById('salesChart');
        if (ctx1 && daily?.length) {
            new Chart(ctx1, {
                type: 'bar',
                data: {
                    labels: daily.map(d => d.date),
                    datasets: [{ label: 'المبيعات', data: daily.map(d => d.total), backgroundColor: 'rgba(30,136,229,0.7)', borderColor: '#1e88e5', borderWidth: 2 }]
                },
                options: { responsive:true, plugins:{ legend:{ labels:{ color:'#e3f2fd' }}}, scales:{ x:{ ticks:{ color:'#90caf9' }}, y:{ ticks:{ color:'#90caf9' }}}}
            });
        }
        const ctx2 = document.getElementById('paymentChart');
        if (ctx2 && payments?.length) {
            new Chart(ctx2, {
                type: 'doughnut',
                data: {
                    labels: payments.map(p => p.payment_method || 'نقدي'),
                    datasets: [{ data: payments.map(p => p.total), backgroundColor: ['#1e88e5','#00bcd4','#43a047','#fb8c00','#e53935'] }]
                },
                options: { responsive:true, plugins:{ legend:{ position:'bottom', labels:{ color:'#e3f2fd' }}}}
            });
        }
    }
    
    else if (currentReportTab === 'profit') {
        c.innerHTML = dateFiltersHTML() + `<div class="card" id="profit-content"><div style="text-align:center; color:var(--text-muted);">جاري التحميل...</div></div>`;
        const from = document.getElementById('rep-from')?.value;
        const to = document.getElementById('rep-to')?.value;
        const profit = await ipcRenderer.invoke('get-profit-report', { company_id: currentCompany.id, from, to });
        reportData = { type:'profit', profit };
        const rows = profit?.products || [];
        document.getElementById('profit-content').innerHTML = `
            <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(180px, 1fr)); gap:15px; margin-bottom:20px;">
                <div class="stat-card" style="background:linear-gradient(135deg,#43a047,#1b5e20); color:#fff; padding:20px; border-radius:12px;">
                    <div style="font-size:14px;">إجمالي الإيرادات</div>
                    <div style="font-size:24px; font-weight:bold;">${formatMoney(profit?.total_revenue || 0)}</div>
                </div>
                <div class="stat-card" style="background:linear-gradient(135deg,#fb8c00,#e65100); color:#fff; padding:20px; border-radius:12px;">
                    <div style="font-size:14px;">إجمالي التكلفة</div>
                    <div style="font-size:24px; font-weight:bold;">${formatMoney(profit?.total_cost || 0)}</div>
                </div>
                <div class="stat-card" style="background:linear-gradient(135deg,#1e88e5,#0d47a1); color:#fff; padding:20px; border-radius:12px;">
                    <div style="font-size:14px;">صافي الربح</div>
                    <div style="font-size:24px; font-weight:bold;">${formatMoney(profit?.net_profit || 0)}</div>
                </div>
            </div>
            <h3>تفاصيل الأرباح حسب المنتج</h3>
            <div class="table-wrapper">
            <table class="data-table">
                <thead><tr><th>المنتج</th><th>الكمية المباعة</th><th>الإيرادات</th><th>التكلفة</th><th>الربح</th><th>نسبة الربح</th></tr></thead>
                <tbody>
                    ${rows.length ? rows.map(p => `
                        <tr>
                            <td><strong>${p.name}</strong></td>
                            <td>${p.qty_sold}</td>
                            <td>${formatMoney(p.revenue)}</td>
                            <td>${formatMoney(p.cost)}</td>
                            <td style="color:${p.profit>=0?'#43a047':'#e53935'}; font-weight:bold;">${formatMoney(p.profit)}</td>
                            <td>${p.revenue > 0 ? ((p.profit/p.revenue)*100).toFixed(1) : 0}%</td>
                        </tr>`).join('') : '<tr><td colspan="6" style="text-align:center; padding:20px; color:var(--text-muted);">لا توجد بيانات</td></tr>'}
                </tbody>
            </table></div>
        `;
    }
    
    else if (currentReportTab === 'waiters') {
        c.innerHTML = dateFiltersHTML() + `<div class="card"><canvas id="waitersChart" height="100"></canvas></div><div class="card" id="waiters-content" style="margin-top:15px;"></div>`;
        const from = document.getElementById('rep-from')?.value;
        const to = document.getElementById('rep-to')?.value;
        const data = await ipcRenderer.invoke('get-waiters-performance', { company_id: currentCompany.id, from, to });
        reportData = { type:'waiters', data };
        document.getElementById('waiters-content').innerHTML = `
            <h3>أداء الكباتن</h3>
            <div class="table-wrapper">
            <table class="data-table">
                <thead><tr><th>الكابتن</th><th>عدد الفواتير</th><th>إجمالي المبيعات</th><th>متوسط الفاتورة</th></tr></thead>
                <tbody>
                    ${data?.length ? data.map(w => `
                        <tr>
                            <td><strong>${w.waiter_name}</strong></td>
                            <td>${w.orders_count}</td>
                            <td>${formatMoney(w.total_sales)}</td>
                            <td>${formatMoney(w.orders_count > 0 ? w.total_sales/w.orders_count : 0)}</td>
                        </tr>`).join('') : '<tr><td colspan="4" style="text-align:center; padding:20px; color:var(--text-muted);">لا توجد بيانات</td></tr>'}
                </tbody>
            </table></div>
        `;
        const ctx = document.getElementById('waitersChart');
        if (ctx && data?.length) {
            new Chart(ctx, {
                type: 'bar',
                data: { labels: data.map(d=>d.waiter_name), datasets: [{ label:'المبيعات', data: data.map(d=>d.total_sales), backgroundColor:'rgba(0,188,212,0.7)' }] },
                options: { indexAxis:'y', responsive:true, plugins:{ legend:{ labels:{ color:'#e3f2fd' }}}, scales:{ x:{ ticks:{ color:'#90caf9' }}, y:{ ticks:{ color:'#90caf9' }}}}
            });
        }
    }
    
    else if (currentReportTab === 'tables') {
        c.innerHTML = dateFiltersHTML() + `<div class="card" id="tables-content"></div>`;
        const from = document.getElementById('rep-from')?.value;
        const to = document.getElementById('rep-to')?.value;
        const data = await ipcRenderer.invoke('get-tables-performance', { company_id: currentCompany.id, from, to });
        reportData = { type:'tables', data };
        document.getElementById('tables-content').innerHTML = `
            <h3>أداء الطاولات</h3>
            <div class="table-wrapper">
            <table class="data-table">
                <thead><tr><th>الطاولة</th><th>عدد الفواتير</th><th>إجمالي المبيعات</th></tr></thead>
                <tbody>
                    ${data?.length ? data.map(t => `
                        <tr>
                            <td><strong>${t.table_name}</strong></td>
                            <td>${t.orders_count}</td>
                            <td>${formatMoney(t.total_sales)}</td>
                        </tr>`).join('') : '<tr><td colspan="3" style="text-align:center; padding:20px; color:var(--text-muted);">لا توجد بيانات</td></tr>'}
                </tbody>
            </table></div>
        `;
    }
    
    else if (currentReportTab === 'customers') {
        c.innerHTML = dateFiltersHTML() + `<div class="card" id="customers-content"></div>`;
        const from = document.getElementById('rep-from')?.value;
        const to = document.getElementById('rep-to')?.value;
        const data = await ipcRenderer.invoke('get-customers-report', { company_id: currentCompany.id, from, to });
        reportData = { type:'customers', data };
        document.getElementById('customers-content').innerHTML = `
            <h3>تقرير العملاء</h3>
            <div class="table-wrapper">
            <table class="data-table">
                <thead><tr><th>العميل</th><th>الهاتف</th><th>عدد الفواتير</th><th>إجمالي المشتريات</th></tr></thead>
                <tbody>
                    ${data?.length ? data.map(cu => `
                        <tr>
                            <td><strong>${cu.name}</strong></td>
                            <td>${cu.phone || '-'}</td>
                            <td>${cu.orders_count}</td>
                            <td>${formatMoney(cu.total_purchases)}</td>
                        </tr>`).join('') : '<tr><td colspan="4" style="text-align:center; padding:20px; color:var(--text-muted);">لا توجد بيانات</td></tr>'}
                </tbody>
            </table></div>
        `;
    }
    
    else if (currentReportTab === 'inventory') {
        c.innerHTML = `<div class="card" id="inv-rep-content">جاري التحميل...</div>`;
        const data = await ipcRenderer.invoke('get-inventory-report', { company_id: currentCompany.id });
        reportData = { type:'inventory', data };
        document.getElementById('inv-rep-content').innerHTML = `
            <h3>تقرير المخزون</h3>
            <button class="btn btn-success" onclick="exportReportExcel()" style="margin-bottom:10px;"><i class="fas fa-file-excel"></i> تصدير Excel</button>
            <div class="table-wrapper">
            <table class="data-table">
                <thead><tr><th>المادة</th><th>الوحدة</th><th>الكمية الحالية</th><th>الحد الأدنى</th><th>القيمة</th><th>الحالة</th></tr></thead>
                <tbody>
                    ${data?.length ? data.map(m => {
                        const low = m.stock <= m.min_stock;
                        return `<tr>
                            <td><strong>${m.name}</strong></td>
                            <td>${m.unit || '-'}</td>
                            <td>${m.stock}</td>
                            <td>${m.min_stock}</td>
                            <td>${formatMoney((m.stock || 0) * (m.cost_price || 0))}</td>
                            <td>${low ? '<span style="color:#e53935;"><i class="fas fa-exclamation-triangle"></i> منخفض</span>' : '<span style="color:#43a047;"><i class="fas fa-check"></i> جيد</span>'}</td>
                        </tr>`;
                    }).join('') : '<tr><td colspan="6" style="text-align:center; padding:20px; color:var(--text-muted);">لا توجد بيانات</td></tr>'}
                </tbody>
            </table></div>
        `;
    }
    
    else if (currentReportTab === 'expenses') {
        c.innerHTML = dateFiltersHTML() + `<div class="card" id="exp-rep-content"></div>`;
        const from = document.getElementById('rep-from')?.value;
        const to = document.getElementById('rep-to')?.value;
        const data = await ipcRenderer.invoke('get-expense-report', { company_id: currentCompany.id, from, to });
        reportData = { type:'expenses', data };
        const total = (data || []).reduce((s, e) => s + (e.amount || 0), 0);
        document.getElementById('exp-rep-content').innerHTML = `
            <h3>تقرير المصروفات</h3>
            <div class="stat-card" style="background:linear-gradient(135deg,#e53935,#b71c1c); color:#fff; padding:20px; border-radius:12px; margin-bottom:15px; max-width:300px;">
                <div style="font-size:14px;">إجمالي المصروفات</div>
                <div style="font-size:28px; font-weight:bold;">${formatMoney(total)}</div>
            </div>
            <div class="table-wrapper">
            <table class="data-table">
                <thead><tr><th>التاريخ</th><th>الوصف</th><th>المبلغ</th></tr></thead>
                <tbody>
                    ${data?.length ? data.map(e => `
                        <tr>
                            <td>${formatDate(e.expense_date)}</td>
                            <td>${e.description}</td>
                            <td style="color:#e53935; font-weight:bold;">${formatMoney(e.amount)}</td>
                        </tr>`).join('') : '<tr><td colspan="3" style="text-align:center; padding:20px; color:var(--text-muted);">لا توجد بيانات</td></tr>'}
                </tbody>
            </table></div>
        `;
    }
}

async function exportReportExcel() {
    if (!reportData) { showToast('لا توجد بيانات للتصدير', 'warning'); return; }
    try {
        const wb = XLSX.utils.book_new();
        let rows = [];
        let sheetName = 'تقرير';
        
        if (reportData.type === 'sales') {
            sheetName = 'المبيعات';
            rows = [['التاريخ', 'إجمالي المبيعات']];
            (reportData.daily || []).forEach(d => rows.push([d.date, d.total]));
        } else if (reportData.type === 'profit') {
            sheetName = 'الأرباح';
            rows = [['المنتج', 'الكمية', 'الإيرادات', 'التكلفة', 'الربح']];
            (reportData.profit?.products || []).forEach(p => rows.push([p.name, p.qty_sold, p.revenue, p.cost, p.profit]));
        } else if (reportData.type === 'waiters') {
            sheetName = 'الكباتن';
            rows = [['الكابتن', 'عدد الفواتير', 'إجمالي المبيعات']];
            (reportData.data || []).forEach(w => rows.push([w.waiter_name, w.orders_count, w.total_sales]));
        } else if (reportData.type === 'tables') {
            sheetName = 'الطاولات';
            rows = [['الطاولة', 'عدد الفواتير', 'إجمالي المبيعات']];
            (reportData.data || []).forEach(t => rows.push([t.table_name, t.orders_count, t.total_sales]));
        } else if (reportData.type === 'customers') {
            sheetName = 'العملاء';
            rows = [['العميل', 'الهاتف', 'عدد الفواتير', 'إجمالي المشتريات']];
            (reportData.data || []).forEach(cu => rows.push([cu.name, cu.phone || '', cu.orders_count, cu.total_purchases]));
        } else if (reportData.type === 'inventory') {
            sheetName = 'المخزون';
            rows = [['المادة', 'الوحدة', 'الكمية', 'الحد الأدنى', 'سعر التكلفة', 'القيمة']];
            (reportData.data || []).forEach(m => rows.push([m.name, m.unit || '', m.stock, m.min_stock, m.cost_price, (m.stock||0)*(m.cost_price||0)]));
        } else if (reportData.type === 'expenses') {
            sheetName = 'المصروفات';
            rows = [['التاريخ', 'الوصف', 'المبلغ']];
            (reportData.data || []).forEach(e => rows.push([e.expense_date, e.description, e.amount]));
        }
        
        const ws = XLSX.utils.aoa_to_sheet(rows);
        XLSX.utils.book_append_sheet(wb, ws, sheetName);
        const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
        const buffer = Array.from(new Uint8Array(out));
        const result = await ipcRenderer.invoke('save-excel-file', { 
            filename: `${sheetName}_${new Date().toISOString().split('T')[0]}.xlsx`,
            buffer: buffer
        });
        if (result?.success) {
            showToast(`تم الحفظ في: ${result.path}`, 'success');
        }
    } catch (e) {
        console.error(e);
        showToast('فشل التصدير: ' + e.message, 'danger');
    }
}


// ========== المصروفات ==========
let expensesCache = [];
async function renderExpenses() {
    expensesCache = await ipcRenderer.invoke('get-expense-report', { company_id: currentCompany.id });
    const total = (expensesCache || []).reduce((s, e) => s + (e.amount || 0), 0);
    document.getElementById('view-expenses').innerHTML = `
        <h2><i class="fas fa-money-bill-wave"></i> المصروفات</h2>
        <div style="display:flex; gap:10px; margin:15px 0;">
            <button class="btn btn-primary" onclick="addExpense()"><i class="fas fa-plus"></i> مصروف جديد</button>
        </div>
        <div class="stat-card" style="background:linear-gradient(135deg,#e53935,#b71c1c); color:#fff; padding:20px; border-radius:12px; margin-bottom:15px; max-width:320px;">
            <div style="font-size:14px;">إجمالي المصروفات</div>
            <div style="font-size:28px; font-weight:bold;">${formatMoney(total)}</div>
        </div>
        <div class="table-wrapper">
        <table class="data-table">
            <thead><tr><th>التاريخ</th><th>الوصف</th><th>المبلغ</th><th>إجراءات</th></tr></thead>
            <tbody>
                ${expensesCache?.length ? expensesCache.map(e => `
                    <tr>
                        <td>${formatDate(e.expense_date)}</td>
                        <td>${e.description}</td>
                        <td style="color:#e53935; font-weight:bold;">${formatMoney(e.amount)}</td>
                        <td><button class="btn btn-danger btn-sm" onclick="delExpense(${e.id})"><i class="fas fa-trash"></i></button></td>
                    </tr>`).join('') : '<tr><td colspan="4" style="text-align:center; padding:20px; color:var(--text-muted);">لا توجد مصروفات</td></tr>'}
            </tbody>
        </table></div>
    `;
}

function addExpense() {
    openModal('مصروف جديد', `
        <div style="display:grid; gap:10px;">
            <div><label>الوصف</label><input id="exp-desc" class="input" placeholder="مثال: فاتورة كهرباء"></div>
            <div><label>المبلغ</label><input type="number" id="exp-amount" class="input" min="0" step="0.01"></div>
            <div><label>التاريخ</label><input type="date" id="exp-date" class="input" value="${new Date().toISOString().split('T')[0]}"></div>
        </div>
        <div style="display:flex; gap:10px; margin-top:15px; justify-content:flex-end;">
            <button class="btn btn-secondary" onclick="closeModal()">إلغاء</button>
            <button class="btn btn-primary" onclick="saveExpense()"><i class="fas fa-save"></i> حفظ</button>
        </div>
    `);
}

async function saveExpense() {
    const description = document.getElementById('exp-desc').value.trim();
    const amount = parseFloat(document.getElementById('exp-amount').value);
    const expense_date = document.getElementById('exp-date').value;
    if (!description || !amount || amount <= 0) { showToast('بيانات غير صحيحة', 'warning'); return; }
    await ipcRenderer.invoke('add-expense', { 
        company_id: currentCompany.id, 
        user_id: currentUser.id, 
        description, amount, expense_date 
    });
    showToast('تم حفظ المصروف', 'success');
    closeModal(); renderExpenses();
}

async function delExpense(id) {
    if (!confirm('حذف هذا المصروف؟')) return;
    await ipcRenderer.invoke('delete-expense', { id });
    renderExpenses();
}

// ========== سجل التدقيق ==========
async function renderAudit() {
    const logs = await ipcRenderer.invoke('get-audit-log', { company_id: currentCompany.id, limit: 200 });
    document.getElementById('view-audit').innerHTML = `
        <h2><i class="fas fa-history"></i> سجل التدقيق</h2>
        <div class="card">
            <div class="table-wrapper">
            <table class="data-table">
                <thead><tr><th>التاريخ والوقت</th><th>المستخدم</th><th>العملية</th><th>التفاصيل</th></tr></thead>
                <tbody>
                    ${logs?.length ? logs.map(l => `
                        <tr>
                            <td style="white-space:nowrap;">${formatDateTime(l.created_at)}</td>
                            <td><strong>${l.full_name || l.username || '-'}</strong></td>
                            <td><span class="badge">${l.action}</span></td>
                            <td style="max-width:400px; word-break:break-word;">${l.details || '-'}</td>
                        </tr>`).join('') : '<tr><td colspan="4" style="text-align:center; padding:20px; color:var(--text-muted);">لا توجد سجلات</td></tr>'}
                </tbody>
            </table></div>
        </div>
    `;
}

// ========== المستخدمين ==========
let usersCache = [];
async function renderUsers() {
    if (currentUser.role !== 'admin') {
        document.getElementById('view-users').innerHTML = '<div class="card"><h3 style="color:#e53935;"><i class="fas fa-lock"></i> هذا القسم متاح للمدير فقط</h3></div>';
        return;
    }
    usersCache = await ipcRenderer.invoke('get-users', { company_id: currentCompany.id });
    document.getElementById('view-users').innerHTML = `
        <h2><i class="fas fa-users-cog"></i> إدارة المستخدمين</h2>
        <div style="display:flex; gap:10px; margin:15px 0;">
            <button class="btn btn-primary" onclick="addUser()"><i class="fas fa-user-plus"></i> مستخدم جديد</button>
        </div>
        <div class="table-wrapper">
        <table class="data-table">
            <thead><tr><th>#</th><th>الاسم</th><th>اسم الدخول</th><th>الصلاحية</th><th>الحالة</th><th>إجراءات</th></tr></thead>
            <tbody>
                ${usersCache?.length ? usersCache.map(u => `
                    <tr>
                        <td>${u.id}</td>
                        <td><strong>${u.full_name}</strong></td>
                        <td>${u.username}</td>
                        <td>${roleArabic(u.role)}</td>
                        <td>${u.blocked ? '<span style="color:#e53935;"><i class="fas fa-ban"></i> محظور</span>' : '<span style="color:#43a047;"><i class="fas fa-check"></i> نشط</span>'}</td>
                        <td>
                            <button class="btn btn-sm btn-warning" onclick="editUser(${u.id})"><i class="fas fa-edit"></i></button>
                            <button class="btn btn-sm btn-secondary" onclick="changePassword(${u.id})"><i class="fas fa-key"></i></button>
                            ${u.id !== currentUser.id ? `<button class="btn btn-sm ${u.blocked?'btn-success':'btn-danger'}" onclick="toggleBlock(${u.id}, ${u.blocked})"><i class="fas fa-${u.blocked?'unlock':'lock'}"></i></button>` : ''}
                        </td>
                    </tr>`).join('') : '<tr><td colspan="6" style="text-align:center; padding:20px; color:var(--text-muted);">لا يوجد مستخدمين</td></tr>'}
            </tbody>
        </table></div>
    `;
}

function addUser() {
    openModal('مستخدم جديد', `
        <div style="display:grid; gap:10px;">
            <div><label>الاسم الكامل</label><input id="u-full" class="input"></div>
            <div><label>اسم الدخول</label><input id="u-name" class="input"></div>
            <div><label>كلمة المرور</label><input type="password" id="u-pass" class="input"></div>
            <div><label>الصلاحية</label>
                <select id="u-role" class="input">
                    <option value="cashier">كاشير</option>
                    <option value="manager">مدير قسم</option>
                    <option value="admin">مدير عام</option>
                </select>
            </div>
        </div>
        <div style="display:flex; gap:10px; margin-top:15px; justify-content:flex-end;">
            <button class="btn btn-secondary" onclick="closeModal()">إلغاء</button>
            <button class="btn btn-primary" onclick="saveNewUser()"><i class="fas fa-save"></i> حفظ</button>
        </div>
    `);
}

async function saveNewUser() {
    const full_name = document.getElementById('u-full').value.trim();
    const username = document.getElementById('u-name').value.trim();
    const password = document.getElementById('u-pass').value;
    const role = document.getElementById('u-role').value;
    if (!full_name || !username || !password) { showToast('جميع الحقول مطلوبة', 'warning'); return; }
    if (password.length < 4) { showToast('كلمة المرور قصيرة جداً', 'warning'); return; }
    const result = await ipcRenderer.invoke('create-user', { company_id: currentCompany.id, full_name, username, password, role });
    if (result?.success) {
        showToast('تم إنشاء المستخدم', 'success');
        closeModal(); renderUsers();
    } else {
        showToast(result?.message || 'فشل الإنشاء', 'danger');
    }
}

function editUser(id) {
    const u = usersCache.find(x => x.id === id);
    if (!u) return;
    openModal('تعديل المستخدم', `
        <div style="display:grid; gap:10px;">
            <div><label>الاسم الكامل</label><input id="u-full" class="input" value="${u.full_name}"></div>
            <div><label>الصلاحية</label>
                <select id="u-role" class="input">
                    <option value="cashier" ${u.role==='cashier'?'selected':''}>كاشير</option>
                    <option value="manager" ${u.role==='manager'?'selected':''}>مدير قسم</option>
                    <option value="admin" ${u.role==='admin'?'selected':''}>مدير عام</option>
                </select>
            </div>
        </div>
        <div style="display:flex; gap:10px; margin-top:15px; justify-content:flex-end;">
            <button class="btn btn-secondary" onclick="closeModal()">إلغاء</button>
            <button class="btn btn-primary" onclick="saveEditUser(${id})"><i class="fas fa-save"></i> حفظ</button>
        </div>
    `);
}

async function saveEditUser(id) {
    const full_name = document.getElementById('u-full').value.trim();
    const role = document.getElementById('u-role').value;
    await ipcRenderer.invoke('update-user', { id, full_name, role });
    showToast('تم التعديل', 'success');
    closeModal(); renderUsers();
}

function changePassword(id) {
    openModal('تغيير كلمة المرور', `
        <div style="display:grid; gap:10px;">
            <div><label>كلمة المرور الجديدة</label><input type="password" id="new-pass" class="input"></div>
            <div><label>تأكيد كلمة المرور</label><input type="password" id="new-pass2" class="input"></div>
        </div>
        <div style="display:flex; gap:10px; margin-top:15px; justify-content:flex-end;">
            <button class="btn btn-secondary" onclick="closeModal()">إلغاء</button>
            <button class="btn btn-primary" onclick="savePassword(${id})"><i class="fas fa-save"></i> حفظ</button>
        </div>
    `);
}

async function savePassword(id) {
    const p1 = document.getElementById('new-pass').value;
    const p2 = document.getElementById('new-pass2').value;
    if (p1.length < 4) { showToast('كلمة المرور قصيرة جداً', 'warning'); return; }
    if (p1 !== p2) { showToast('كلمتا المرور غير متطابقتين', 'warning'); return; }
    await ipcRenderer.invoke('update-user', { id, password: p1 });
    showToast('تم تغيير كلمة المرور', 'success');
    closeModal();
}

async function toggleBlock(id, currentlyBlocked) {
    if (!confirm(currentlyBlocked ? 'إلغاء حظر المستخدم؟' : 'حظر هذا المستخدم؟')) return;
    await ipcRenderer.invoke('toggle-block', { id, blocked: currentlyBlocked ? 0 : 1 });
    showToast('تم التحديث', 'success');
    renderUsers();
}


// ========== الإعدادات ==========
let currentSettingsTab = 'general';
async function renderSettings() {
    document.getElementById('view-settings').innerHTML = `
        <h2><i class="fas fa-cog"></i> الإعدادات</h2>
        <div class="tabs-bar" style="display:flex; gap:8px; flex-wrap:wrap; margin:15px 0;">
            <button class="btn ${currentSettingsTab==='general'?'btn-primary':'btn-secondary'}" onclick="switchSettingsTab('general')"><i class="fas fa-sliders-h"></i> عام</button>
            <button class="btn ${currentSettingsTab==='company'?'btn-primary':'btn-secondary'}" onclick="switchSettingsTab('company')"><i class="fas fa-building"></i> الشركة</button>
            <button class="btn ${currentSettingsTab==='printer'?'btn-primary':'btn-secondary'}" onclick="switchSettingsTab('printer')"><i class="fas fa-print"></i> الطابعة</button>
            <button class="btn ${currentSettingsTab==='backup'?'btn-primary':'btn-secondary'}" onclick="switchSettingsTab('backup')"><i class="fas fa-database"></i> النسخ الاحتياطي</button>
        </div>
        <div id="settings-content"></div>
    `;
    loadSettingsContent();
}

function switchSettingsTab(tab) {
    currentSettingsTab = tab;
    renderSettings();
}

async function loadSettingsContent() {
    const c = document.getElementById('settings-content');
    if (!c) return;
    const settings = await ipcRenderer.invoke('get-settings', { company_id: currentCompany.id }) || {};
    
    if (currentSettingsTab === 'general') {
        c.innerHTML = `
            <div class="card">
                <h3><i class="fas fa-sliders-h"></i> إعدادات عامة</h3>
                <div style="display:grid; gap:15px; max-width:500px;">
                    <div>
                        <label>نسبة الضريبة (%)</label>
                        <input type="number" id="s-tax" class="input" value="${settings.tax_rate || 0}" min="0" max="100" step="0.01">
                    </div>
                    <div>
                        <label>العملة</label>
                        <input id="s-currency" class="input" value="${settings.currency || 'ر.ي'}">
                    </div>
                    <div>
                        <label><input type="checkbox" id="s-print-auto" ${settings.auto_print==1?'checked':''}> طباعة الفاتورة تلقائياً بعد البيع</label>
                    </div>
                    <div>
                        <label><input type="checkbox" id="s-low-stock-alert" ${settings.low_stock_alert!=0?'checked':''}> تنبيه المخزون المنخفض</label>
                    </div>
                    <div>
                        <button class="btn btn-primary" onclick="saveGeneralSettings()"><i class="fas fa-save"></i> حفظ</button>
                    </div>
                </div>
            </div>
        `;
    }
    
    else if (currentSettingsTab === 'company') {
        c.innerHTML = `
            <div class="card">
                <h3><i class="fas fa-building"></i> بيانات الشركة</h3>
                <div style="display:grid; gap:15px; max-width:500px;">
                    <div><label>اسم الشركة</label><input id="c-name" class="input" value="${currentCompany.name || ''}"></div>
                    <div><label>الهاتف</label><input id="c-phone" class="input" value="${currentCompany.phone || ''}"></div>
                    <div><label>العنوان</label><input id="c-address" class="input" value="${currentCompany.address || ''}"></div>
                    <div><label>الرقم الضريبي</label><input id="c-tax-no" class="input" value="${currentCompany.tax_number || ''}"></div>
                    <div><button class="btn btn-primary" onclick="saveCompanyInfo()"><i class="fas fa-save"></i> حفظ</button></div>
                </div>
            </div>
        `;
    }
    
    else if (currentSettingsTab === 'printer') {
        c.innerHTML = `
            <div class="card">
                <h3><i class="fas fa-print"></i> إعدادات طابعة الإيصالات</h3>
                <div style="display:grid; gap:15px; max-width:500px;">
                    <div>
                        <label>نوع الطابعة</label>
                        <select id="p-type" class="input">
                            <option value="epson" ${settings.printer_type==='epson'?'selected':''}>EPSON</option>
                            <option value="star" ${settings.printer_type==='star'?'selected':''}>STAR</option>
                        </select>
                    </div>
                    <div>
                        <label>نوع الاتصال</label>
                        <select id="p-interface" class="input">
                            <option value="usb" ${settings.printer_interface==='usb'?'selected':''}>USB</option>
                            <option value="serial" ${settings.printer_interface==='serial'?'selected':''}>Serial (COM)</option>
                            <option value="network" ${settings.printer_interface==='network'?'selected':''}>Network (IP)</option>
                        </select>
                    </div>
                    <div>
                        <label>المنفذ / العنوان</label>
                        <input id="p-port" class="input" value="${settings.printer_port || ''}" placeholder="مثال: USB001 أو COM1 أو 192.168.1.100">
                        <small style="color:var(--text-muted);">USB: اسم الجهاز - Serial: COM1, COM2 - Network: عنوان IP</small>
                    </div>
                    <div>
                        <label>عرض الإيصال (مم)</label>
                        <select id="p-width" class="input">
                            <option value="58" ${settings.printer_width=='58'?'selected':''}>58 مم</option>
                            <option value="80" ${(settings.printer_width=='80'||!settings.printer_width)?'selected':''}>80 مم</option>
                        </select>
                    </div>
                    <div style="display:flex; gap:10px;">
                        <button class="btn btn-primary" onclick="savePrinterSettings()"><i class="fas fa-save"></i> حفظ</button>
                        <button class="btn btn-success" onclick="testPrinter()"><i class="fas fa-print"></i> اختبار الطباعة</button>
                    </div>
                </div>
            </div>
        `;
    }
    
    else if (currentSettingsTab === 'backup') {
        const backups = await ipcRenderer.invoke('list-backups') || [];
        c.innerHTML = `
            <div class="card">
                <h3><i class="fas fa-database"></i> النسخ الاحتياطي</h3>
                <p style="color:var(--text-muted);">يتم إنشاء نسخة احتياطية تلقائياً عند إغلاق التطبيق وكل 24 ساعة. يتم الاحتفاظ بآخر 7 نسخ.</p>
                <div style="display:flex; gap:10px; margin:15px 0; flex-wrap:wrap;">
                    <button class="btn btn-primary" onclick="manualBackup()"><i class="fas fa-download"></i> نسخة احتياطية الآن</button>
                    <button class="btn btn-warning" onclick="restoreFromFile()"><i class="fas fa-upload"></i> استرجاع من ملف خارجي</button>
                </div>
                <h4 style="margin-top:20px;">النسخ المتوفرة:</h4>
                <div class="table-wrapper">
                <table class="data-table">
                    <thead><tr><th>الاسم</th><th>الحجم</th><th>التاريخ</th><th>إجراءات</th></tr></thead>
                    <tbody>
                        ${backups.length ? backups.map(b => `
                            <tr>
                                <td>${b.name}</td>
                                <td>${(b.size/1024/1024).toFixed(2)} م.ب</td>
                                <td>${formatDateTime(b.mtime)}</td>
                                <td><button class="btn btn-sm btn-warning" onclick="restoreBackup('${b.path.replace(/\\/g,'\\\\')}')"><i class="fas fa-undo"></i> استرجاع</button></td>
                            </tr>`).join('') : '<tr><td colspan="4" style="text-align:center; padding:20px; color:var(--text-muted);">لا توجد نسخ احتياطية</td></tr>'}
                    </tbody>
                </table></div>
            </div>
        `;
    }
}

async function saveGeneralSettings() {
    const tax_rate = parseFloat(document.getElementById('s-tax').value) || 0;
    const currency = document.getElementById('s-currency').value.trim() || 'ر.ي';
    const auto_print = document.getElementById('s-print-auto').checked ? 1 : 0;
    const low_stock_alert = document.getElementById('s-low-stock-alert').checked ? 1 : 0;
    await ipcRenderer.invoke('save-settings', { 
        company_id: currentCompany.id, 
        settings: { tax_rate, currency, auto_print, low_stock_alert } 
    });
    showToast('تم الحفظ', 'success');
}

async function saveCompanyInfo() {
    const name = document.getElementById('c-name').value.trim();
    const phone = document.getElementById('c-phone').value.trim();
    const address = document.getElementById('c-address').value.trim();
    const tax_number = document.getElementById('c-tax-no').value.trim();
    await ipcRenderer.invoke('update-company', { id: currentCompany.id, name, phone, address, tax_number });
    Object.assign(currentCompany, { name, phone, address, tax_number });
    showToast('تم الحفظ', 'success');
    loadCompanyData();
}

async function savePrinterSettings() {
    const printer_type = document.getElementById('p-type').value;
    const printer_interface = document.getElementById('p-interface').value;
    const printer_port = document.getElementById('p-port').value.trim();
    const printer_width = document.getElementById('p-width').value;
    await ipcRenderer.invoke('save-settings', { 
        company_id: currentCompany.id, 
        settings: { printer_type, printer_interface, printer_port, printer_width } 
    });
    showToast('تم حفظ إعدادات الطابعة', 'success');
}

async function testPrinter() {
    try {
        const result = await ipcRenderer.invoke('print-thermal', { 
            company_id: currentCompany.id,
            test: true,
            content: 'اختبار طابعة\nتقنيات سوفت\n' + new Date().toLocaleString('ar-EG')
        });
        if (result?.success) showToast('تم إرسال طلب الطباعة', 'success');
        else showToast(result?.message || 'فشل الطباعة', 'danger');
    } catch (e) {
        showToast('خطأ: ' + e.message, 'danger');
    }
}

async function manualBackup() {
    const result = await ipcRenderer.invoke('manual-backup');
    if (result?.success) {
        showToast(`تم إنشاء النسخة: ${result.path}`, 'success');
        loadSettingsContent();
    } else {
        showToast('فشل إنشاء النسخة', 'danger');
    }
}

async function restoreBackup(backupPath) {
    if (!confirm('سيتم استبدال قاعدة البيانات الحالية بهذه النسخة. هل أنت متأكد؟\nسيتم إعادة تشغيل التطبيق.')) return;
    const result = await ipcRenderer.invoke('restore-backup', { path: backupPath });
    if (result?.success) {
        showToast('تم الاسترجاع. يرجى إعادة تشغيل التطبيق.', 'success');
        setTimeout(() => window.location.reload(), 2000);
    } else {
        showToast(result?.message || 'فشل الاسترجاع', 'danger');
    }
}

async function restoreFromFile() {
    const file = await ipcRenderer.invoke('choose-backup-file');
    if (!file) return;
    if (!confirm(`سيتم استبدال قاعدة البيانات الحالية بـ:\n${file}\n\nهل أنت متأكد؟`)) return;
    const result = await ipcRenderer.invoke('restore-from-file', { path: file });
    if (result?.success) {
        showToast('تم الاسترجاع. يرجى إعادة تشغيل التطبيق.', 'success');
        setTimeout(() => window.location.reload(), 2000);
    } else {
        showToast(result?.message || 'فشل الاسترجاع', 'danger');
    }
}

// ========== لوحة المفاتيح اللمسية ==========
let activeInput = null;
function setupTouchKeyboard() {
    document.addEventListener('focusin', (e) => {
        if (e.target.matches('input[type="text"], input[type="number"], input[type="password"], input[type="search"], textarea')) {
            activeInput = e.target;
        }
    });
    
    document.querySelectorAll('.key-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            if (!activeInput) return;
            const key = btn.dataset.key;
            if (key === 'BACKSPACE') {
                activeInput.value = activeInput.value.slice(0, -1);
            } else if (key === 'SPACE') {
                activeInput.value += ' ';
            } else if (key === 'CLEAR') {
                activeInput.value = '';
            } else if (key === 'CLOSE') {
                toggleKeyboard(false);
            } else if (key) {
                activeInput.value += key;
            }
            activeInput.dispatchEvent(new Event('input', { bubbles: true }));
            activeInput.focus();
        });
    });
}

function toggleKeyboard(show) {
    const kb = document.getElementById('touch-keyboard');
    if (!kb) return;
    if (show === undefined) show = kb.style.display === 'none';
    kb.style.display = show ? 'block' : 'none';
}

// ========== التهيئة ==========
document.addEventListener('DOMContentLoaded', () => {
    console.log('✅ تقنيات سوفت v3.0.0 - بدء التحميل...');
    
    // زر تسجيل الدخول
    const loginBtn = document.getElementById('login-btn');
    if (loginBtn) loginBtn.addEventListener('click', login);
    
    // Enter في حقول الدخول
    ['login-username', 'login-password'].forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            el.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') login();
            });
        }
    });
    
    // أزرار التنقل
    document.querySelectorAll('.nav-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const tab = btn.dataset.tab;
            if (tab) switchTab(tab);
        });
    });
    
    // زر تسجيل الخروج
    const logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', () => {
            if (confirm('هل تريد تسجيل الخروج؟')) {
                currentUser = null;
                document.getElementById('main-app').style.display = 'none';
                document.getElementById('login-screen').style.display = 'flex';
                document.getElementById('login-username').value = '';
                document.getElementById('login-password').value = '';
            }
        });
    }
    
    // زر إغلاق المودال
    document.querySelectorAll('.modal-close').forEach(btn => {
        btn.addEventListener('click', closeModal);
    });
    
    // النقر خارج المودال للإغلاق
    document.querySelectorAll('.modal').forEach(modal => {
        modal.addEventListener('click', (e) => {
            if (e.target === modal) closeModal();
        });
    });
    
    // لوحة المفاتيح اللمسية
    setupTouchKeyboard();
    const kbToggle = document.getElementById('kb-toggle');
    if (kbToggle) kbToggle.addEventListener('click', () => toggleKeyboard());
    
    // ESC لإغلاق المودال
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeModal();
    });
    
    console.log('✅ تقنيات سوفت v3.0.0 - واجهة المستخدم جاهزة');
});
