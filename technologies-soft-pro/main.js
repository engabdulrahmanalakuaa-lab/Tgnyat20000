/**
 * تقنيات سوفت - نظام إدارة المطعم الاحترافي
 * الإصدار: 3.0.0
 * تصميم م/ عبدالرحمن الاكوع - 773579486 967+
 *
 * ملف main.js: العملية الرئيسية لـ Electron
 * يحتوي على:
 *  - تهيئة قاعدة البيانات SQLite (better-sqlite3)
 *  - جميع قنوات IPC للتواصل مع الواجهة
 *  - نظام الخصومات / العملاء / الموردين / جرد المخزون
 *  - النسخ الاحتياطي التلقائي (كل إغلاق + كل 24 ساعة)
 *  - تسجيل الأخطاء في ملفات logs
 *  - دعم الطباعة الحرارية + إعداداتها
 */

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const Database = require('better-sqlite3');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const { ThermalPrinter, PrinterTypes } = require('node-thermal-printer');
const pdfMake = require('pdfmake');

let mainWindow;
let db;
let backupIntervalId = null;

// مسارات النظام
const dbDir = app.getPath('userData');
const dbPath = path.join(dbDir, 'technologies_soft.db');
const backupDir = path.join(dbDir, 'backups');
const logsDir = path.join(dbDir, 'logs');
const imagesDir = path.join(dbDir, 'product-images');

// إنشاء المجلدات الضرورية
if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
if (!fs.existsSync(imagesDir)) fs.mkdirSync(imagesDir, { recursive: true });

// ========== نظام تسجيل الأخطاء ==========
function logError(context, error) {
    try {
        const today = new Date().toISOString().slice(0, 10);
        const logFile = path.join(logsDir, `error_${today}.log`);
        const stack = error && error.stack ? error.stack : 'لا يوجد stack';
        const msg = `[${new Date().toISOString()}] [${context}]\nالرسالة: ${error && error.message ? error.message : error}\nالمكدس: ${stack}\n${'='.repeat(80)}\n`;
        fs.appendFileSync(logFile, msg);
    } catch (e) {
        console.error('فشل تسجيل الخطأ:', e);
    }
}

// التقاط الأخطاء غير المعالجة
process.on('uncaughtException', (err) => {
    logError('uncaughtException', err);
    console.error('خطأ غير معالج:', err);
});
process.on('unhandledRejection', (reason) => {
    logError('unhandledRejection', reason);
});

// ========== تهيئة قاعدة البيانات ==========
function initializeDatabase() {
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    const createTables = `
        CREATE TABLE IF NOT EXISTS companies (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            phone TEXT,
            address TEXT,
            tax_number TEXT,
            tax_rate REAL DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            company_id INTEGER,
            full_name TEXT,
            username TEXT UNIQUE,
            password_hash TEXT,
            role TEXT DEFAULT 'cashier',
            is_blocked INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(company_id) REFERENCES companies(id)
        );
        CREATE TABLE IF NOT EXISTS permissions (
            user_id INTEGER PRIMARY KEY,
            can_edit_products INTEGER DEFAULT 0,
            can_edit_prices INTEGER DEFAULT 0,
            can_edit_users INTEGER DEFAULT 0,
            can_view_reports INTEGER DEFAULT 0,
            can_close_shift INTEGER DEFAULT 0,
            can_refund INTEGER DEFAULT 0,
            FOREIGN KEY(user_id) REFERENCES users(id)
        );
        CREATE TABLE IF NOT EXISTS categories (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            company_id INTEGER,
            name TEXT,
            FOREIGN KEY(company_id) REFERENCES companies(id)
        );
        CREATE TABLE IF NOT EXISTS products (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            company_id INTEGER,
            name TEXT,
            category_id INTEGER,
            price REAL,
            cost REAL DEFAULT 0,
            barcode TEXT,
            recipe TEXT,
            image TEXT,
            unit TEXT DEFAULT 'قطعة',
            daily_forecast INTEGER DEFAULT 0,
            monthly_forecast INTEGER DEFAULT 0,
            FOREIGN KEY(company_id) REFERENCES companies(id),
            FOREIGN KEY(category_id) REFERENCES categories(id)
        );
        CREATE TABLE IF NOT EXISTS raw_materials (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            company_id INTEGER,
            name TEXT,
            unit TEXT,
            current_stock REAL DEFAULT 0,
            min_stock REAL DEFAULT 0,
            purchase_price REAL DEFAULT 0,
            FOREIGN KEY(company_id) REFERENCES companies(id)
        );
        CREATE TABLE IF NOT EXISTS tables (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            company_id INTEGER,
            name TEXT,
            status TEXT DEFAULT 'free',
            FOREIGN KEY(company_id) REFERENCES companies(id)
        );
        CREATE TABLE IF NOT EXISTS waiters (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            company_id INTEGER,
            name TEXT,
            user_id INTEGER,
            FOREIGN KEY(company_id) REFERENCES companies(id),
            FOREIGN KEY(user_id) REFERENCES users(id)
        );
        CREATE TABLE IF NOT EXISTS shifts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            company_id INTEGER,
            user_id INTEGER,
            opening_cash REAL,
            closing_cash REAL,
            expected_cash REAL,
            cash_difference REAL,
            date TEXT,
            status TEXT DEFAULT 'open',
            closed_at DATETIME,
            FOREIGN KEY(company_id) REFERENCES companies(id),
            FOREIGN KEY(user_id) REFERENCES users(id)
        );
        CREATE TABLE IF NOT EXISTS orders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            company_id INTEGER,
            table_id INTEGER,
            waiter_id INTEGER,
            user_id INTEGER,
            customer_id INTEGER,
            subtotal REAL DEFAULT 0,
            total REAL,
            tax REAL DEFAULT 0,
            total_with_tax REAL,
            discount REAL DEFAULT 0,
            discount_type TEXT DEFAULT 'amount',
            payment_method TEXT DEFAULT 'cash',
            paid_amount REAL,
            change_amount REAL,
            order_type TEXT DEFAULT 'سفري',
            date TEXT,
            time TEXT,
            shift_id INTEGER,
            status TEXT DEFAULT 'completed',
            notes TEXT,
            FOREIGN KEY(company_id) REFERENCES companies(id),
            FOREIGN KEY(table_id) REFERENCES tables(id),
            FOREIGN KEY(waiter_id) REFERENCES waiters(id),
            FOREIGN KEY(user_id) REFERENCES users(id),
            FOREIGN KEY(customer_id) REFERENCES customers(id),
            FOREIGN KEY(shift_id) REFERENCES shifts(id)
        );
        CREATE TABLE IF NOT EXISTS order_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            order_id INTEGER,
            product_id INTEGER,
            qty INTEGER,
            price REAL,
            discount REAL DEFAULT 0,
            FOREIGN KEY(order_id) REFERENCES orders(id),
            FOREIGN KEY(product_id) REFERENCES products(id)
        );
        CREATE TABLE IF NOT EXISTS refunds (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            order_id INTEGER,
            user_id INTEGER,
            amount REAL,
            reason TEXT,
            date TEXT,
            FOREIGN KEY(order_id) REFERENCES orders(id),
            FOREIGN KEY(user_id) REFERENCES users(id)
        );
        CREATE TABLE IF NOT EXISTS inventory_transactions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            company_id INTEGER,
            material_id INTEGER,
            qty_change REAL,
            type TEXT,
            reference TEXT,
            supplier_id INTEGER,
            notes TEXT,
            date TEXT,
            user_id INTEGER,
            FOREIGN KEY(company_id) REFERENCES companies(id),
            FOREIGN KEY(material_id) REFERENCES raw_materials(id),
            FOREIGN KEY(supplier_id) REFERENCES suppliers(id),
            FOREIGN KEY(user_id) REFERENCES users(id)
        );
        CREATE TABLE IF NOT EXISTS expenses (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            company_id INTEGER,
            month TEXT,
            category TEXT,
            description TEXT,
            amount REAL,
            type TEXT DEFAULT 'fixed',
            date TEXT,
            user_id INTEGER,
            FOREIGN KEY(company_id) REFERENCES companies(id),
            FOREIGN KEY(user_id) REFERENCES users(id)
        );
        CREATE TABLE IF NOT EXISTS audit_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            action TEXT,
            details TEXT,
            ip TEXT,
            date DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(user_id) REFERENCES users(id)
        );
        CREATE TABLE IF NOT EXISTS settings (
            company_id INTEGER PRIMARY KEY,
            safe_mode INTEGER DEFAULT 0,
            currency TEXT DEFAULT 'SAR',
            pagination INTEGER DEFAULT 20,
            show_company_screen INTEGER DEFAULT 1,
            profit_margin_percent REAL DEFAULT 30,
            printer_type TEXT DEFAULT 'EPSON',
            printer_interface TEXT DEFAULT 'USB',
            printer_port TEXT DEFAULT '',
            printer_width INTEGER DEFAULT 48,
            FOREIGN KEY(company_id) REFERENCES companies(id)
        );
        CREATE TABLE IF NOT EXISTS customers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            company_id INTEGER,
            name TEXT NOT NULL,
            phone TEXT,
            address TEXT,
            notes TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(company_id) REFERENCES companies(id)
        );
        CREATE TABLE IF NOT EXISTS suppliers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            company_id INTEGER,
            name TEXT NOT NULL,
            phone TEXT,
            address TEXT,
            notes TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(company_id) REFERENCES companies(id)
        );
    `;
    db.exec(createTables);

    // إضافة الأعمدة الجديدة لقواعد البيانات القديمة (الترقية)
    const safeAlter = (sql) => { try { db.exec(sql); } catch (e) {} };
    safeAlter("ALTER TABLE orders ADD COLUMN order_type TEXT DEFAULT 'سفري'");
    safeAlter("ALTER TABLE orders ADD COLUMN customer_id INTEGER");
    safeAlter("ALTER TABLE orders ADD COLUMN discount_type TEXT DEFAULT 'amount'");
    safeAlter("ALTER TABLE orders ADD COLUMN subtotal REAL DEFAULT 0");
    safeAlter("ALTER TABLE orders ADD COLUMN notes TEXT");
    safeAlter("ALTER TABLE order_items ADD COLUMN discount REAL DEFAULT 0");
    safeAlter("ALTER TABLE inventory_transactions ADD COLUMN supplier_id INTEGER");
    safeAlter("ALTER TABLE inventory_transactions ADD COLUMN notes TEXT");
    safeAlter("ALTER TABLE settings ADD COLUMN printer_type TEXT DEFAULT 'EPSON'");
    safeAlter("ALTER TABLE settings ADD COLUMN printer_interface TEXT DEFAULT 'USB'");
    safeAlter("ALTER TABLE settings ADD COLUMN printer_port TEXT DEFAULT ''");
    safeAlter("ALTER TABLE settings ADD COLUMN printer_width INTEGER DEFAULT 48");

    // البيانات الافتراضية (أول تشغيل فقط)
    const row = db.prepare("SELECT COUNT(*) as count FROM companies").get();
    if (!row || row.count === 0) {
        const companyId = 1;
        db.prepare("INSERT INTO companies (id, name, phone, address, tax_rate) VALUES (?, ?, ?, ?, ?)")
          .run(companyId, 'مطعم تقنيات سوفت', '773579486', 'اليمن - صنعاء', 0);

        const hash = bcrypt.hashSync('77357233199477', 10);
        db.prepare("INSERT INTO users (id, company_id, full_name, username, password_hash, role) VALUES (?, ?, ?, ?, ?, ?)")
          .run(1, companyId, 'المدير العام', 'admin', hash, 'admin');
        db.prepare("INSERT INTO permissions (user_id, can_edit_products, can_edit_prices, can_edit_users, can_view_reports, can_close_shift, can_refund) VALUES (?,1,1,1,1,1,1)")
          .run(1);

        const hashAcc = bcrypt.hashSync('77357233199477', 10);
        const accResult = db.prepare("INSERT INTO users (company_id, full_name, username, password_hash, role) VALUES (?, ?, ?, ?, ?)")
          .run(companyId, 'المحاسب', 'accountant', hashAcc, 'accountant');
        db.prepare("INSERT INTO permissions (user_id, can_edit_products, can_edit_prices, can_edit_users, can_view_reports, can_close_shift, can_refund) VALUES (?,0,0,0,1,1,0)")
          .run(accResult.lastInsertRowid);

        const hashCash = bcrypt.hashSync('77357233199477', 10);
        const cashResult = db.prepare("INSERT INTO users (company_id, full_name, username, password_hash, role) VALUES (?, ?, ?, ?, ?)")
          .run(companyId, 'الكاشير', 'cashier', hashCash, 'cashier');
        db.prepare("INSERT INTO permissions (user_id, can_edit_products, can_edit_prices, can_edit_users, can_view_reports, can_close_shift, can_refund) VALUES (?,0,0,0,0,0,0)")
          .run(cashResult.lastInsertRowid);

        db.prepare("INSERT INTO settings (company_id) VALUES (?)").run(companyId);

        const categories = ['أكلات شعبية', 'غداء', 'المعصوب', 'مشروبات'];
        for (let cat of categories) {
            db.prepare("INSERT INTO categories (company_id, name) VALUES (?,?)").run(companyId, cat);
        }
    }
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1366,
        height: 820,
        minWidth: 1024,
        minHeight: 700,
        icon: path.join(__dirname, 'build', 'icon.ico'),
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        },
        title: 'تقنيات سوفت - نظام المطعم'
    });
    mainWindow.loadFile('index.html');
    // إخفاء قائمة الإعدادات الافتراضية
    mainWindow.setMenuBarVisibility(false);
}

app.whenReady().then(() => {
    initializeDatabase();
    createWindow();
    // بدء النسخ الاحتياطي التلقائي كل 24 ساعة
    backupIntervalId = setInterval(() => {
        backupDatabase();
    }, 24 * 60 * 60 * 1000);
});

// نسخ احتياطي تلقائي قبل الإغلاق
app.on('before-quit', () => {
    try {
        backupDatabase();
    } catch (e) {
        logError('before-quit-backup', e);
    }
});

app.on('window-all-closed', () => {
    if (backupIntervalId) clearInterval(backupIntervalId);
    if (process.platform !== 'darwin') {
        try { backupDatabase(); } catch (e) { logError('window-closed-backup', e); }
        if (db) db.close();
        app.quit();
    }
});

// ========== دوال مساعدة ==========
function logAudit(userId, action, details) {
    try {
        db.prepare("INSERT INTO audit_log (user_id, action, details) VALUES (?,?,?)")
          .run(userId, action, details);
    } catch (e) {
        logError('logAudit', e);
    }
}

function backupDatabase() {
    try {
        const now = new Date();
        const ts = now.toISOString().slice(0, 19).replace(/[:T]/g, '-');
        const backupFile = path.join(backupDir, `backup_${ts}.db`);
        fs.copyFileSync(dbPath, backupFile);

        // الاحتفاظ بآخر 7 نسخ احتياطية فقط
        const files = fs.readdirSync(backupDir)
            .filter(f => f.startsWith('backup_') && f.endsWith('.db'))
            .map(f => ({
                name: f,
                time: fs.statSync(path.join(backupDir, f)).mtime.getTime()
            }))
            .sort((a, b) => b.time - a.time);

        if (files.length > 7) {
            for (let i = 7; i < files.length; i++) {
                fs.unlinkSync(path.join(backupDir, files[i].name));
            }
        }
        return { success: true, path: backupFile };
    } catch (e) {
        logError('backupDatabase', e);
        return { success: false, error: e.message };
    }
}

// ========== تغليف دوال better-sqlite3 ==========
function dbAll(sql, params = []) {
    return new Promise((resolve, reject) => {
        try {
            const stmt = db.prepare(sql);
            const rows = stmt.all(...params);
            resolve(rows);
        } catch (err) {
            logError('dbAll: ' + sql, err);
            reject(err);
        }
    });
}
function dbGet(sql, params = []) {
    return new Promise((resolve, reject) => {
        try {
            const stmt = db.prepare(sql);
            const row = stmt.get(...params);
            resolve(row);
        } catch (err) {
            logError('dbGet: ' + sql, err);
            reject(err);
        }
    });
}
function dbRun(sql, params = []) {
    return new Promise((resolve, reject) => {
        try {
            const stmt = db.prepare(sql);
            const info = stmt.run(...params);
            resolve({ changes: info.changes, lastInsertRowid: info.lastInsertRowid });
        } catch (err) {
            logError('dbRun: ' + sql, err);
            reject(err);
        }
    });
}

// ========== قنوات IPC الأساسية ==========
ipcMain.handle('db-query', (event, sql, params) => dbAll(sql, params));
ipcMain.handle('db-run', (event, sql, params) => dbRun(sql, params));
ipcMain.handle('db-get', (event, sql, params) => dbGet(sql, params));

// ========== المستخدمين والصلاحيات ==========
ipcMain.handle('login', async (event, { username, password }) => {
    try {
        const user = await dbGet("SELECT * FROM users WHERE username=? AND is_blocked=0", [username]);
        if (!user) return { success: false, error: 'اسم المستخدم غير موجود أو محظور' };
        const valid = bcrypt.compareSync(password, user.password_hash);
        if (!valid) return { success: false, error: 'كلمة المرور خاطئة' };
        const perms = await dbGet("SELECT * FROM permissions WHERE user_id=?", [user.id]) || {};
        logAudit(user.id, 'login', 'تسجيل دخول');
        return { success: true, user: { ...user, permissions: perms } };
    } catch (e) {
        logError('login', e);
        return { success: false, error: 'حدث خطأ أثناء تسجيل الدخول' };
    }
});

ipcMain.handle('create-user', async (event, data) => {
    try {
        const { company_id, full_name, username, password, role, currentUserId } = data;
        const hash = bcrypt.hashSync(password, 10);
        const result = await dbRun(
            "INSERT INTO users (company_id, full_name, username, password_hash, role) VALUES (?,?,?,?,?)",
            [company_id, full_name, username, hash, role]
        );
        const perms = {
            admin: { can_edit_products: 1, can_edit_prices: 1, can_edit_users: 1, can_view_reports: 1, can_close_shift: 1, can_refund: 1 },
            accountant: { can_edit_products: 0, can_edit_prices: 0, can_edit_users: 0, can_view_reports: 1, can_close_shift: 1, can_refund: 0 },
            cashier: { can_edit_products: 0, can_edit_prices: 0, can_edit_users: 0, can_view_reports: 0, can_close_shift: 0, can_refund: 0 }
        };
        const p = perms[role] || perms.cashier;
        await dbRun(
            "INSERT INTO permissions (user_id, can_edit_products, can_edit_prices, can_edit_users, can_view_reports, can_close_shift, can_refund) VALUES (?,?,?,?,?,?,?)",
            [result.lastInsertRowid, p.can_edit_products, p.can_edit_prices, p.can_edit_users, p.can_view_reports, p.can_close_shift, p.can_refund]
        );
        logAudit(currentUserId, 'create_user', `إنشاء مستخدم: ${username}`);
        return { success: true, id: result.lastInsertRowid };
    } catch (e) {
        logError('create-user', e);
        return { success: false, error: e.message };
    }
});

ipcMain.handle('update-user', async (event, data) => {
    try {
        const { id, full_name, username, password, role, currentUserId } = data;
        const cu = await dbGet("SELECT role FROM users WHERE id=?", [currentUserId]);
        if (!cu || (cu.role !== 'admin' && currentUserId !== id)) {
            return { success: false, error: 'ليس لديك صلاحية لتعديل هذا المستخدم' };
        }
        if (password && password.length > 0) {
            const hash = bcrypt.hashSync(password, 10);
            await dbRun("UPDATE users SET full_name=?, username=?, password_hash=?, role=? WHERE id=?",
                [full_name, username, hash, role, id]);
        } else {
            await dbRun("UPDATE users SET full_name=?, username=?, role=? WHERE id=?",
                [full_name, username, role, id]);
        }
        logAudit(currentUserId, 'update_user', `تحديث بيانات المستخدم: ${username}`);
        return { success: true };
    } catch (e) {
        logError('update-user', e);
        return { success: false, error: e.message };
    }
});

ipcMain.handle('toggle-block', async (event, { userId, currentUserId }) => {
    try {
        const user = await dbGet("SELECT is_blocked FROM users WHERE id=?", [userId]);
        if (!user) return { success: false, error: 'المستخدم غير موجود' };
        await dbRun("UPDATE users SET is_blocked=? WHERE id=?", [user.is_blocked ? 0 : 1, userId]);
        logAudit(currentUserId, 'toggle_block', `تغيير حالة الحظر للمستخدم #${userId}`);
        return { success: true };
    } catch (e) {
        logError('toggle-block', e);
        return { success: false, error: e.message };
    }
});

// ========== بيانات الشركة والضريبة ==========
ipcMain.handle('get-company', async () => {
    return await dbGet("SELECT * FROM companies LIMIT 1");
});

ipcMain.handle('update-company', async (event, data) => {
    try {
        const { name, phone, address, tax_number, tax_rate, userId } = data;
        await dbRun("UPDATE companies SET name=?, phone=?, address=?, tax_number=?, tax_rate=? WHERE id=1",
            [name, phone, address, tax_number, tax_rate || 0]);
        logAudit(userId, 'update_company', 'تعديل بيانات المطعم');
        return { success: true };
    } catch (e) {
        logError('update-company', e);
        return { success: false, error: e.message };
    }
});

ipcMain.handle('get-tax-rate', async () => {
    const row = await dbGet("SELECT tax_rate FROM companies WHERE id=1");
    return row ? row.tax_rate : 0;
});

// ========== الإعدادات ==========
ipcMain.handle('get-settings', async (event, companyId) => {
    const row = await dbGet("SELECT * FROM settings WHERE company_id=?", [companyId]);
    return row || {};
});

ipcMain.handle('save-settings', async (event, { companyId, settings, userId }) => {
    try {
        await dbRun(`UPDATE settings SET safe_mode=?, pagination=?, profit_margin_percent=?,
            printer_type=?, printer_interface=?, printer_port=?, printer_width=? WHERE company_id=?`,
            [
                settings.safe_mode || 0,
                settings.pagination || 20,
                settings.profit_margin_percent || 30,
                settings.printer_type || 'EPSON',
                settings.printer_interface || 'USB',
                settings.printer_port || '',
                settings.printer_width || 48,
                companyId
            ]);
        logAudit(userId, 'save_settings', 'تعديل الإعدادات');
        return { success: true };
    } catch (e) {
        logError('save-settings', e);
        return { success: false, error: e.message };
    }
});

// ========== المنتجات والأقسام ==========
ipcMain.handle('save-product', async (event, data) => {
    try {
        const { id, company_id, name, price, cost, category_id, barcode, recipe, unit, image, userId } = data;
        if (id) {
            await dbRun("UPDATE products SET name=?, price=?, category_id=?, cost=?, barcode=?, recipe=?, unit=?, image=? WHERE id=? AND company_id=?",
                [name, price, category_id, cost || 0, barcode, recipe, unit, image, id, company_id]);
            logAudit(userId, 'edit_product', `تعديل منتج: ${name}`);
            return { success: true, id };
        } else {
            const result = await dbRun(
                "INSERT INTO products (company_id, name, price, category_id, cost, barcode, recipe, unit, image) VALUES (?,?,?,?,?,?,?,?,?)",
                [company_id, name, price, category_id, cost || 0, barcode, recipe, unit, image]
            );
            logAudit(userId, 'add_product', `إضافة منتج: ${name}`);
            return { success: true, id: result.lastInsertRowid };
        }
    } catch (e) {
        logError('save-product', e);
        return { success: false, error: e.message };
    }
});

ipcMain.handle('delete-product', async (event, { id, company_id, userId }) => {
    try {
        await dbRun("DELETE FROM products WHERE id=? AND company_id=?", [id, company_id]);
        logAudit(userId, 'delete_product', `حذف منتج #${id}`);
        return { success: true };
    } catch (e) {
        logError('delete-product', e);
        return { success: false, error: e.message };
    }
});

ipcMain.handle('save-category', async (event, { company_id, name, userId }) => {
    try {
        const result = await dbRun("INSERT INTO categories (company_id, name) VALUES (?,?)", [company_id, name]);
        logAudit(userId, 'add_category', `إضافة قسم: ${name}`);
        return { success: true, id: result.lastInsertRowid };
    } catch (e) {
        logError('save-category', e);
        return { success: false, error: e.message };
    }
});

ipcMain.handle('delete-category', async (event, { id, userId }) => {
    try {
        await dbRun("DELETE FROM categories WHERE id=?", [id]);
        logAudit(userId, 'delete_category', `حذف قسم #${id}`);
        return { success: true };
    } catch (e) {
        logError('delete-category', e);
        return { success: false, error: e.message };
    }
});

// ========== المواد الخام ==========
ipcMain.handle('save-material', async (event, data) => {
    try {
        const { id, company_id, name, unit, min_stock, purchase_price } = data;
        if (id) {
            await dbRun("UPDATE raw_materials SET name=?, unit=?, min_stock=?, purchase_price=? WHERE id=? AND company_id=?",
                [name, unit, min_stock, purchase_price, id, company_id]);
            return { success: true, id };
        } else {
            const result = await dbRun(
                "INSERT INTO raw_materials (company_id, name, unit, min_stock, purchase_price) VALUES (?,?,?,?,?)",
                [company_id, name, unit, min_stock, purchase_price]
            );
            return { success: true, id: result.lastInsertRowid };
        }
    } catch (e) {
        logError('save-material', e);
        return { success: false, error: e.message };
    }
});

ipcMain.handle('delete-material', async (event, { id, company_id }) => {
    try {
        await dbRun("DELETE FROM raw_materials WHERE id=? AND company_id=?", [id, company_id]);
        return { success: true };
    } catch (e) {
        logError('delete-material', e);
        return { success: false, error: e.message };
    }
});

// ========== المخزون: توريد + جرد + حركة ==========
ipcMain.handle('add-stock', async (event, { material_id, qty, supplier_id, notes, userId }) => {
    try {
        // معاملة (Transaction) لضمان الذرية
        const tx = db.transaction(() => {
            db.prepare("UPDATE raw_materials SET current_stock = current_stock + ? WHERE id=?")
              .run(qty, material_id);
            db.prepare(
                "INSERT INTO inventory_transactions (company_id, material_id, qty_change, type, reference, supplier_id, notes, date, user_id) VALUES (?,?,?,?,?,?,?,?,?)"
            ).run(1, material_id, qty, 'supply', notes || 'توريد', supplier_id || null, notes || '', new Date().toISOString().slice(0,10), userId);
        });
        tx();
        logAudit(userId, 'add_stock', `توريد مادة #${material_id} بكمية ${qty}`);
        return { success: true };
    } catch (e) {
        logError('add-stock', e);
        return { success: false, error: e.message };
    }
});

// جرد المخزون (تعديل يدوي للكمية)
ipcMain.handle('adjust-stock', async (event, { material_id, new_qty, reason, userId, company_id }) => {
    try {
        const tx = db.transaction(() => {
            const mat = db.prepare("SELECT current_stock FROM raw_materials WHERE id=?").get(material_id);
            const oldQty = mat ? mat.current_stock : 0;
            const diff = new_qty - oldQty;
            db.prepare("UPDATE raw_materials SET current_stock = ? WHERE id=?")
              .run(new_qty, material_id);
            db.prepare(
                "INSERT INTO inventory_transactions (company_id, material_id, qty_change, type, reference, notes, date, user_id) VALUES (?,?,?,?,?,?,?,?)"
            ).run(company_id, material_id, diff, 'adjustment', reason || 'جرد', reason || '', new Date().toISOString().slice(0,10), userId);
        });
        tx();
        logAudit(userId, 'adjust_stock', `جرد مادة #${material_id} الكمية الجديدة: ${new_qty} - السبب: ${reason}`);
        return { success: true };
    } catch (e) {
        logError('adjust-stock', e);
        return { success: false, error: e.message };
    }
});

// تقرير حركة المخزون
ipcMain.handle('get-inventory-movement', async (event, { startDate, endDate, materialId, type, companyId }) => {
    try {
        let sql = `SELECT it.*, rm.name as material_name, rm.unit, u.full_name as user_name, s.name as supplier_name
                   FROM inventory_transactions it
                   LEFT JOIN raw_materials rm ON it.material_id = rm.id
                   LEFT JOIN users u ON it.user_id = u.id
                   LEFT JOIN suppliers s ON it.supplier_id = s.id
                   WHERE it.company_id=?`;
        const params = [companyId];
        if (startDate) { sql += " AND it.date >= ?"; params.push(startDate); }
        if (endDate) { sql += " AND it.date <= ?"; params.push(endDate); }
        if (materialId) { sql += " AND it.material_id = ?"; params.push(materialId); }
        if (type && type !== 'all') { sql += " AND it.type = ?"; params.push(type); }
        sql += " ORDER BY it.date DESC, it.id DESC LIMIT 500";
        return await dbAll(sql, params);
    } catch (e) {
        logError('get-inventory-movement', e);
        return [];
    }
});

// التحقق من المواد الناقصة
ipcMain.handle('get-low-stock', async (event, companyId) => {
    try {
        return await dbAll(
            "SELECT * FROM raw_materials WHERE company_id=? AND current_stock <= min_stock AND min_stock > 0",
            [companyId]
        );
    } catch (e) {
        logError('get-low-stock', e);
        return [];
    }
});

// ========== الطلبات (مع دعم الخصومات والعملاء) ==========
ipcMain.handle('create-order', async (event, data) => {
    try {
        const {
            company_id, table_id, waiter_id, user_id, customer_id,
            subtotal, total, tax, total_with_tax,
            discount, discount_type,
            payment_method, paid_amount, change_amount,
            order_type, shift_id, notes, items
        } = data;

        const today = new Date().toISOString().slice(0,10);
        const time = new Date().toLocaleTimeString('ar-EG', { hour12: false });

        // استخدام معاملة لضمان ذرية العملية
        let orderId = null;
        const tx = db.transaction(() => {
            const insertOrder = db.prepare(
                `INSERT INTO orders (company_id, table_id, waiter_id, user_id, customer_id,
                 subtotal, total, tax, total_with_tax, discount, discount_type,
                 payment_method, paid_amount, change_amount, order_type, date, time, shift_id, notes, status)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
            );
            const res = insertOrder.run(
                company_id, table_id || null, waiter_id || null, user_id, customer_id || null,
                subtotal || total, total, tax || 0, total_with_tax || total,
                discount || 0, discount_type || 'amount',
                payment_method, paid_amount, change_amount || 0,
                order_type || 'سفري', today, time, shift_id || null, notes || ''
            );
            orderId = res.lastInsertRowid;

            const insertItem = db.prepare("INSERT INTO order_items (order_id, product_id, qty, price, discount) VALUES (?,?,?,?,?)");
            const updateMaterial = db.prepare("UPDATE raw_materials SET current_stock = current_stock - ? WHERE id=? AND company_id=?");
            const insertInvTx = db.prepare(
                "INSERT INTO inventory_transactions (company_id, material_id, qty_change, type, reference, date, user_id) VALUES (?,?,?,?,?,?,?)"
            );

            for (let item of items) {
                insertItem.run(orderId, item.id, item.qty, item.price, item.discount || 0);
                if (item.recipe) {
                    try {
                        const recipe = typeof item.recipe === 'string' ? JSON.parse(item.recipe) : item.recipe;
                        if (Array.isArray(recipe)) {
                            for (let comp of recipe) {
                                updateMaterial.run(comp.qty * item.qty, comp.material_id, company_id);
                                insertInvTx.run(company_id, comp.material_id, -comp.qty * item.qty, 'consumption', `طلب #${orderId}`, today, user_id);
                            }
                        }
                    } catch(e) {
                        logError('create-order recipe parse', e);
                    }
                }
            }

            if (table_id) {
                db.prepare("UPDATE tables SET status='occupied' WHERE id=?").run(table_id);
            }
        });
        tx();

        logAudit(user_id, 'create_order', `طلب #${orderId} بقيمة ${total}`);
        return { success: true, orderId };
    } catch (e) {
        logError('create-order', e);
        return { success: false, error: e.message };
    }
});

// تعديل طلب موجود
ipcMain.handle('update-order', async (event, data) => {
    try {
        const {
            orderId, company_id, table_id, waiter_id, customer_id,
            subtotal, total, tax, total_with_tax, discount, discount_type,
            payment_method, order_type, notes, items, userId
        } = data;

        const tx = db.transaction(() => {
            // 1. إعادة الكميات السابقة للمخزون
            const oldItems = db.prepare("SELECT * FROM order_items WHERE order_id=?").all(orderId);
            for (let oi of oldItems) {
                const prod = db.prepare("SELECT recipe FROM products WHERE id=?").get(oi.product_id);
                if (prod && prod.recipe) {
                    try {
                        const recipe = JSON.parse(prod.recipe);
                        for (let comp of recipe) {
                            db.prepare("UPDATE raw_materials SET current_stock = current_stock + ? WHERE id=?")
                              .run(comp.qty * oi.qty, comp.material_id);
                        }
                    } catch (e) {}
                }
            }
            // 2. حذف order_items القديمة
            db.prepare("DELETE FROM order_items WHERE order_id=?").run(orderId);

            // 3. تحديث رأس الطلب
            db.prepare(`UPDATE orders SET table_id=?, waiter_id=?, customer_id=?,
                       subtotal=?, total=?, tax=?, total_with_tax=?, discount=?, discount_type=?,
                       payment_method=?, order_type=?, notes=? WHERE id=?`)
              .run(
                table_id || null, waiter_id || null, customer_id || null,
                subtotal || total, total, tax || 0, total_with_tax || total,
                discount || 0, discount_type || 'amount',
                payment_method, order_type || 'سفري', notes || '', orderId
              );

            // 4. إضافة الأصناف الجديدة وتحديث المخزون
            const insertItem = db.prepare("INSERT INTO order_items (order_id, product_id, qty, price, discount) VALUES (?,?,?,?,?)");
            const updateMaterial = db.prepare("UPDATE raw_materials SET current_stock = current_stock - ? WHERE id=? AND company_id=?");
            const today = new Date().toISOString().slice(0,10);
            for (let item of items) {
                insertItem.run(orderId, item.id, item.qty, item.price, item.discount || 0);
                if (item.recipe) {
                    try {
                        const recipe = typeof item.recipe === 'string' ? JSON.parse(item.recipe) : item.recipe;
                        if (Array.isArray(recipe)) {
                            for (let comp of recipe) {
                                updateMaterial.run(comp.qty * item.qty, comp.material_id, company_id);
                                db.prepare(
                                    "INSERT INTO inventory_transactions (company_id, material_id, qty_change, type, reference, date, user_id) VALUES (?,?,?,?,?,?,?)"
                                ).run(company_id, comp.material_id, -comp.qty * item.qty, 'consumption', `تعديل طلب #${orderId}`, today, userId);
                            }
                        }
                    } catch (e) {}
                }
            }
        });
        tx();
        logAudit(userId, 'update_order', `تعديل طلب #${orderId} - الإجمالي الجديد: ${total}`);
        return { success: true };
    } catch (e) {
        logError('update-order', e);
        return { success: false, error: e.message };
    }
});

// جلب طلب مع أصنافه
ipcMain.handle('get-order-details', async (event, orderId) => {
    try {
        const order = await dbGet(
            `SELECT o.*, t.name as table_name, w.name as waiter_name, u.full_name as user_name, c.name as customer_name, c.phone as customer_phone
             FROM orders o
             LEFT JOIN tables t ON o.table_id=t.id
             LEFT JOIN waiters w ON o.waiter_id=w.id
             LEFT JOIN users u ON o.user_id=u.id
             LEFT JOIN customers c ON o.customer_id=c.id
             WHERE o.id=?`, [orderId]
        );
        if (!order) return null;
        const items = await dbAll(
            `SELECT oi.*, p.name as product_name, p.recipe FROM order_items oi
             LEFT JOIN products p ON oi.product_id=p.id WHERE oi.order_id=?`, [orderId]
        );
        return { ...order, items };
    } catch (e) {
        logError('get-order-details', e);
        return null;
    }
});

// ========== إرجاع الطلبات ==========
ipcMain.handle('refund-order', async (event, { orderId, userId, reason }) => {
    try {
        const order = await dbGet("SELECT * FROM orders WHERE id=?", [orderId]);
        if (!order) return { success: false, error: 'الطلب غير موجود' };
        if (order.status === 'refunded') return { success: false, error: 'الطلب مرتجع مسبقاً' };

        const tx = db.transaction(() => {
            const items = db.prepare("SELECT * FROM order_items WHERE order_id=?").all(orderId);
            for (let item of items) {
                const product = db.prepare("SELECT * FROM products WHERE id=?").get(item.product_id);
                if (product && product.recipe) {
                    try {
                        const recipe = JSON.parse(product.recipe);
                        for (let comp of recipe) {
                            db.prepare("UPDATE raw_materials SET current_stock = current_stock + ? WHERE id=?")
                              .run(comp.qty * item.qty, comp.material_id);
                        }
                    } catch(e) {}
                }
            }
            db.prepare("UPDATE orders SET status='refunded' WHERE id=?").run(orderId);
            db.prepare("INSERT INTO refunds (order_id, user_id, amount, reason, date) VALUES (?,?,?,?,?)")
              .run(orderId, userId, order.total, reason, new Date().toISOString());
        });
        tx();
        logAudit(userId, 'refund_order', `إرجاع طلب #${orderId}`);
        return { success: true };
    } catch (e) {
        logError('refund-order', e);
        return { success: false, error: e.message };
    }
});

// ========== الورديات ==========
ipcMain.handle('open-shift', async (event, { company_id, user_id, opening_cash }) => {
    try {
        const today = new Date().toISOString().slice(0,10);
        const result = await dbRun(
            "INSERT INTO shifts (company_id, user_id, opening_cash, date, status) VALUES (?,?,?,?,?)",
            [company_id, user_id, opening_cash, today, 'open']
        );
        logAudit(user_id, 'open_shift', `فتح وردية #${result.lastInsertRowid}`);
        return { success: true, shiftId: result.lastInsertRowid };
    } catch (e) {
        logError('open-shift', e);
        return { success: false, error: e.message };
    }
});

ipcMain.handle('close-shift', async (event, { shiftId, actual_cash, userId }) => {
    try {
        const shift = await dbGet("SELECT * FROM shifts WHERE id=?", [shiftId]);
        if (!shift) return { success: false, error: 'الوردية غير موجودة' };
        if (shift.status !== 'open') return { success: false, error: 'الوردية مغلقة' };

        const totalSales = await dbGet(
            "SELECT COALESCE(SUM(total_with_tax),0) as total FROM orders WHERE shift_id=? AND status='completed' AND payment_method='cash'",
            [shiftId]
        );
        const expected = shift.opening_cash + (totalSales ? totalSales.total : 0);
        const difference = actual_cash - expected;

        await dbRun("UPDATE shifts SET closing_cash=?, expected_cash=?, cash_difference=?, status='closed', closed_at=CURRENT_TIMESTAMP WHERE id=?",
            [actual_cash, expected, difference, shiftId]);
        backupDatabase();
        logAudit(userId, 'close_shift', `إغلاق وردية #${shiftId}، الفارق: ${difference}`);
        return { success: true, expected, difference };
    } catch (e) {
        logError('close-shift', e);
        return { success: false, error: e.message };
    }
});

// ========== المصروفات ==========
ipcMain.handle('add-expense', async (event, data) => {
    try {
        const { company_id, month, category, description, amount, type, user_id } = data;
        await dbRun(
            "INSERT INTO expenses (company_id, month, category, description, amount, type, date, user_id) VALUES (?,?,?,?,?,?,?,?)",
            [company_id, month, category, description, amount, type, new Date().toISOString().slice(0,10), user_id]
        );
        logAudit(user_id, 'add_expense', `إضافة مصروف: ${description} بقيمة ${amount}`);
        return { success: true };
    } catch (e) {
        logError('add-expense', e);
        return { success: false, error: e.message };
    }
});

ipcMain.handle('delete-expense', async (event, { id, userId }) => {
    try {
        await dbRun("DELETE FROM expenses WHERE id=?", [id]);
        logAudit(userId, 'delete_expense', `حذف مصروف #${id}`);
        return { success: true };
    } catch (e) {
        logError('delete-expense', e);
        return { success: false, error: e.message };
    }
});

// ========== التقارير ==========
ipcMain.handle('get-sales-report', async (event, { startDate, endDate, companyId }) => {
    return await dbAll(
        `SELECT date, COUNT(*) as count, SUM(total) as total, SUM(tax) as tax, SUM(total_with_tax) as total_with_tax,
         payment_method, SUM(paid_amount) as paid
         FROM orders WHERE company_id=? AND date BETWEEN ? AND ? AND status='completed'
         GROUP BY date, payment_method ORDER BY date`,
        [companyId, startDate, endDate]
    );
});

ipcMain.handle('get-profit-report', async (event, { startDate, endDate, companyId }) => {
    const orders = await dbAll(
        `SELECT o.id, o.total, o.total_with_tax, o.tax, o.discount, oi.product_id, oi.qty, p.cost, p.name as product_name, p.price
         FROM orders o
         JOIN order_items oi ON o.id = oi.order_id
         JOIN products p ON oi.product_id = p.id
         WHERE o.company_id=? AND o.date BETWEEN ? AND ? AND o.status='completed'`,
        [companyId, startDate, endDate]
    );
    let totalCost = 0;
    const productProfits = {};
    const seenOrders = new Set();
    let totalSales = 0;
    for (let row of orders) {
        totalCost += (row.cost || 0) * row.qty;
        if (!seenOrders.has(row.id)) {
            seenOrders.add(row.id);
            totalSales += row.total;
        }
        if (!productProfits[row.product_id]) {
            productProfits[row.product_id] = { name: row.product_name, qty: 0, sales: 0, cost: 0 };
        }
        productProfits[row.product_id].qty += row.qty;
        productProfits[row.product_id].sales += row.qty * row.price;
        productProfits[row.product_id].cost += row.qty * (row.cost || 0);
    }
    const profit = totalSales - totalCost;
    return {
        totalSales, totalCost, profit,
        products: Object.values(productProfits).map(p => ({ ...p, profit: p.sales - p.cost }))
    };
});

ipcMain.handle('get-expense-report', async (event, { startDate, endDate, companyId }) => {
    return await dbAll(
        "SELECT category, SUM(amount) as total FROM expenses WHERE company_id=? AND date BETWEEN ? AND ? GROUP BY category",
        [companyId, startDate, endDate]
    );
});

ipcMain.handle('get-inventory-report', async (event, { companyId }) => {
    return await dbAll("SELECT * FROM raw_materials WHERE company_id=?", [companyId]);
});

// تقرير أداء الكباتن
ipcMain.handle('get-waiters-performance', async (event, { startDate, endDate, companyId }) => {
    return await dbAll(
        `SELECT w.id, w.name, COUNT(o.id) as orders_count, COALESCE(SUM(o.total_with_tax),0) as total_sales
         FROM waiters w
         LEFT JOIN orders o ON w.id = o.waiter_id AND o.date BETWEEN ? AND ? AND o.status='completed'
         WHERE w.company_id=?
         GROUP BY w.id, w.name
         ORDER BY total_sales DESC`,
        [startDate, endDate, companyId]
    );
});

// تقرير أداء الطاولات
ipcMain.handle('get-tables-performance', async (event, { startDate, endDate, companyId }) => {
    return await dbAll(
        `SELECT t.id, t.name, COUNT(o.id) as orders_count, COALESCE(SUM(o.total_with_tax),0) as total_sales
         FROM tables t
         LEFT JOIN orders o ON t.id = o.table_id AND o.date BETWEEN ? AND ? AND o.status='completed'
         WHERE t.company_id=?
         GROUP BY t.id, t.name
         ORDER BY total_sales DESC`,
        [startDate, endDate, companyId]
    );
});

// تقرير المبيعات حسب العميل
ipcMain.handle('get-customers-report', async (event, { startDate, endDate, companyId }) => {
    return await dbAll(
        `SELECT c.id, c.name, c.phone, COUNT(o.id) as orders_count, COALESCE(SUM(o.total_with_tax),0) as total_spent
         FROM customers c
         LEFT JOIN orders o ON c.id = o.customer_id AND o.date BETWEEN ? AND ? AND o.status='completed'
         WHERE c.company_id=?
         GROUP BY c.id
         ORDER BY total_spent DESC`,
        [startDate, endDate, companyId]
    );
});

// المبيعات اليومية للرسوم البيانية
ipcMain.handle('get-daily-sales-chart', async (event, { startDate, endDate, companyId }) => {
    return await dbAll(
        `SELECT date, COALESCE(SUM(total_with_tax),0) as total, COUNT(*) as orders_count
         FROM orders WHERE company_id=? AND date BETWEEN ? AND ? AND status='completed'
         GROUP BY date ORDER BY date`,
        [companyId, startDate, endDate]
    );
});

// توزيع المبيعات حسب طريقة الدفع
ipcMain.handle('get-payment-distribution', async (event, { startDate, endDate, companyId }) => {
    return await dbAll(
        `SELECT payment_method, COUNT(*) as count, COALESCE(SUM(total_with_tax),0) as total
         FROM orders WHERE company_id=? AND date BETWEEN ? AND ? AND status='completed'
         GROUP BY payment_method`,
        [companyId, startDate, endDate]
    );
});

// ========== الطباعة الحرارية المحسنة ==========
ipcMain.handle('print-thermal', async (event, { text, html, userId, companyId }) => {
    try {
        // قراءة إعدادات الطابعة
        const settings = await dbGet("SELECT * FROM settings WHERE company_id=?", [companyId || 1]);
        const printerType = settings && settings.printer_type === 'STAR' ? PrinterTypes.STAR : PrinterTypes.EPSON;
        const iface = settings && settings.printer_interface ? settings.printer_interface : 'USB';
        const port = settings && settings.printer_port ? settings.printer_port : '';

        let interfaceStr = 'printer:auto';
        if (iface === 'Network' && port) interfaceStr = `tcp://${port}`;
        else if (iface === 'Serial' && port) interfaceStr = port;
        else if (iface === 'USB') interfaceStr = 'printer:auto';

        const printer = new ThermalPrinter({
            type: printerType,
            interface: interfaceStr,
            characterSet: 'PC864_ARABIC',
            removeSpecialCharacters: false,
            width: settings ? settings.printer_width || 48 : 48,
            options: { timeout: 5000 }
        });
        const isConnected = await printer.isPrinterConnected();
        if (!isConnected) throw new Error('الطابعة غير متصلة');

        if (text) {
            printer.alignCenter();
            printer.println(text);
        }
        printer.cut();
        await printer.execute();
        logAudit(userId, 'print_receipt', 'طباعة فاتورة حرارية');
        return { success: true, method: 'thermal' };
    } catch (e) {
        logError('print-thermal', e);
        // الرجوع للطباعة عبر نافذة المتصفح
        if (mainWindow && html) {
            mainWindow.webContents.send('fallback-print', html);
        }
        return { success: false, method: 'fallback', error: e.message };
    }
});

// ========== الصور ==========
ipcMain.handle('save-product-image', async (event, { fileName, buffer }) => {
    try {
        const filePath = path.join(imagesDir, fileName);
        fs.writeFileSync(filePath, Buffer.from(buffer));
        return { success: true, imagePath: `product-images/${fileName}` };
    } catch (e) {
        logError('save-product-image', e);
        return { success: false, error: e.message };
    }
});

ipcMain.handle('get-product-image', (event, imagePath) => {
    try {
        if (!imagePath) return { success: false };
        const fullPath = path.join(app.getPath('userData'), imagePath);
        if (fs.existsSync(fullPath)) {
            const buffer = fs.readFileSync(fullPath);
            return { success: true, buffer: buffer.toString('base64') };
        }
        return { success: false };
    } catch (e) {
        logError('get-product-image', e);
        return { success: false };
    }
});

// ========== نسخ احتياطي + استعادة ==========
ipcMain.handle('manual-backup', async () => {
    return backupDatabase();
});

ipcMain.handle('list-backups', async () => {
    try {
        const files = fs.readdirSync(backupDir)
            .filter(f => f.startsWith('backup_') && f.endsWith('.db'))
            .map(f => {
                const stat = fs.statSync(path.join(backupDir, f));
                return { name: f, size: stat.size, mtime: stat.mtime };
            })
            .sort((a, b) => b.mtime - a.mtime);
        return files;
    } catch (e) {
        logError('list-backups', e);
        return [];
    }
});

ipcMain.handle('restore-backup', async (event, { fileName, userId }) => {
    try {
        const filePath = path.join(backupDir, fileName);
        if (!fs.existsSync(filePath)) return { success: false, error: 'الملف غير موجود' };
        // إغلاق قاعدة البيانات أولاً
        if (db) db.close();
        // النسخ
        fs.copyFileSync(filePath, dbPath);
        // إعادة فتح القاعدة
        initializeDatabase();
        logAudit(userId, 'restore_backup', `استعادة نسخة احتياطية: ${fileName}`);
        return { success: true };
    } catch (e) {
        logError('restore-backup', e);
        return { success: false, error: e.message };
    }
});

ipcMain.handle('restore-from-file', async (event, { filePath, userId }) => {
    try {
        if (!fs.existsSync(filePath)) return { success: false, error: 'الملف غير موجود' };
        // أخذ نسخة قبل الاستبدال
        backupDatabase();
        if (db) db.close();
        fs.copyFileSync(filePath, dbPath);
        initializeDatabase();
        logAudit(userId, 'restore_backup_file', `استعادة من ملف: ${filePath}`);
        return { success: true };
    } catch (e) {
        logError('restore-from-file', e);
        return { success: false, error: e.message };
    }
});

// اختيار ملف نسخة احتياطية
ipcMain.handle('choose-backup-file', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
        title: 'اختر ملف النسخة الاحتياطية',
        properties: ['openFile'],
        filters: [{ name: 'Database', extensions: ['db'] }]
    });
    if (result.canceled || !result.filePaths.length) return null;
    return result.filePaths[0];
});

// ========== الطاولات والكباتن ==========
ipcMain.handle('save-table', async (event, { id, company_id, name }) => {
    try {
        if (id) {
            await dbRun("UPDATE tables SET name=? WHERE id=?", [name, id]);
        } else {
            await dbRun("INSERT INTO tables (company_id, name) VALUES (?,?)", [company_id, name]);
        }
        return { success: true };
    } catch (e) {
        logError('save-table', e);
        return { success: false, error: e.message };
    }
});

ipcMain.handle('delete-table', async (event, { id }) => {
    try {
        await dbRun("DELETE FROM tables WHERE id=?", [id]);
        return { success: true };
    } catch (e) { return { success: false, error: e.message }; }
});

ipcMain.handle('save-waiter', async (event, { id, company_id, name }) => {
    try {
        if (id) {
            await dbRun("UPDATE waiters SET name=? WHERE id=?", [name, id]);
        } else {
            await dbRun("INSERT INTO waiters (company_id, name) VALUES (?,?)", [company_id, name]);
        }
        return { success: true };
    } catch (e) {
        logError('save-waiter', e);
        return { success: false, error: e.message };
    }
});

ipcMain.handle('delete-waiter', async (event, { id }) => {
    try {
        await dbRun("DELETE FROM waiters WHERE id=?", [id]);
        return { success: true };
    } catch (e) { return { success: false, error: e.message }; }
});

// ========== العملاء ==========
ipcMain.handle('save-customer', async (event, data) => {
    try {
        const { id, company_id, name, phone, address, notes, userId } = data;
        if (id) {
            await dbRun("UPDATE customers SET name=?, phone=?, address=?, notes=? WHERE id=? AND company_id=?",
                [name, phone, address, notes, id, company_id]);
            logAudit(userId, 'edit_customer', `تعديل عميل: ${name}`);
            return { success: true, id };
        } else {
            const r = await dbRun(
                "INSERT INTO customers (company_id, name, phone, address, notes) VALUES (?,?,?,?,?)",
                [company_id, name, phone, address, notes]
            );
            logAudit(userId, 'add_customer', `إضافة عميل: ${name}`);
            return { success: true, id: r.lastInsertRowid };
        }
    } catch (e) {
        logError('save-customer', e);
        return { success: false, error: e.message };
    }
});

ipcMain.handle('delete-customer', async (event, { id, userId }) => {
    try {
        await dbRun("DELETE FROM customers WHERE id=?", [id]);
        logAudit(userId, 'delete_customer', `حذف عميل #${id}`);
        return { success: true };
    } catch (e) { return { success: false, error: e.message }; }
});

// ========== الموردين ==========
ipcMain.handle('save-supplier', async (event, data) => {
    try {
        const { id, company_id, name, phone, address, notes, userId } = data;
        if (id) {
            await dbRun("UPDATE suppliers SET name=?, phone=?, address=?, notes=? WHERE id=? AND company_id=?",
                [name, phone, address, notes, id, company_id]);
            logAudit(userId, 'edit_supplier', `تعديل مورد: ${name}`);
            return { success: true, id };
        } else {
            const r = await dbRun(
                "INSERT INTO suppliers (company_id, name, phone, address, notes) VALUES (?,?,?,?,?)",
                [company_id, name, phone, address, notes]
            );
            logAudit(userId, 'add_supplier', `إضافة مورد: ${name}`);
            return { success: true, id: r.lastInsertRowid };
        }
    } catch (e) {
        logError('save-supplier', e);
        return { success: false, error: e.message };
    }
});

ipcMain.handle('delete-supplier', async (event, { id, userId }) => {
    try {
        await dbRun("DELETE FROM suppliers WHERE id=?", [id]);
        logAudit(userId, 'delete_supplier', `حذف مورد #${id}`);
        return { success: true };
    } catch (e) { return { success: false, error: e.message }; }
});

// ========== تصدير PDF ==========
ipcMain.handle('export-pdf', async (event, { content, title, userId }) => {
    try {
        const doc = {
            content: content,
            defaultStyle: { font: 'Tajawal' }
        };
        const pdfDoc = pdfMake.createPdf(doc);
        const filePath = path.join(app.getPath('documents'), `${title}_${Date.now()}.pdf`);
        return new Promise((resolve) => {
            pdfDoc.getBuffer((buffer) => {
                fs.writeFile(filePath, buffer, (err) => {
                    if (err) resolve({ success: false, error: err.message });
                    else {
                        logAudit(userId, 'export_pdf', `تصدير تقرير: ${title}`);
                        resolve({ success: true, path: filePath });
                    }
                });
            });
        });
    } catch (e) {
        logError('export-pdf', e);
        return { success: false, error: e.message };
    }
});

// ========== سجل التدقيق ==========
ipcMain.handle('get-audit-log', async (event, { limit = 200 }) => {
    return await dbAll(
        `SELECT a.*, u.full_name FROM audit_log a
         LEFT JOIN users u ON a.user_id = u.id
         ORDER BY a.date DESC LIMIT ?`, [limit]
    );
});

// ========== مسار بيانات المستخدم ==========
ipcMain.handle('get-user-data-path', () => {
    return app.getPath('userData');
});

// ========== حفظ ملف Excel من الواجهة ==========
ipcMain.handle('save-excel-file', async (event, { fileName, buffer }) => {
    try {
        const result = await dialog.showSaveDialog(mainWindow, {
            title: 'حفظ ملف Excel',
            defaultPath: path.join(app.getPath('documents'), fileName),
            filters: [{ name: 'Excel', extensions: ['xlsx'] }]
        });
        if (result.canceled || !result.filePath) return { success: false, canceled: true };
        fs.writeFileSync(result.filePath, Buffer.from(buffer));
        return { success: true, path: result.filePath };
    } catch (e) {
        logError('save-excel-file', e);
        return { success: false, error: e.message };
    }
});

console.log('✅ تقنيات سوفت - نظام المطعم الاحترافي v3.0.0 جاهز');
