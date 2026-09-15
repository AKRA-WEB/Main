const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const indexPath = path.join(__dirname, '..', 'index.html');
const versionPath = path.join(__dirname, '..', 'version.json');
const html = fs.readFileSync(indexPath, 'utf8');
const versionData = JSON.parse(fs.readFileSync(versionPath, 'utf8'));

test('1. Version Parity & Syntax Verification', () => {
    const match = html.match(/const CURRENT_VERSION = ["']([^"']+)["'];/);
    assert(match, 'CURRENT_VERSION must exist in index.html');
    assert.strictEqual(match[1], versionData.version, 'index.html version must match version.json');
    assert.strictEqual(match[1], '20260915.02', 'Version must be 20260915.02');

    // Parse all inline scripts
    const scriptRegex = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
    let count = 0;
    let m;
    while ((m = scriptRegex.exec(html)) !== null) {
        count++;
        assert.doesNotThrow(() => {
            new vm.Script(m[1]);
        }, `Script block ${count} must compile with zero syntax errors`);
    }
    assert(count > 0, 'Must have found at least one script block');
});

test('2. Strict Invariant: Official App Names NOT Modified', () => {
    const expectedLabels = {
        "app-w5": "เบิกย้ายสินค้า (AKRA)",
        "app-trd": "เบิกย้ายสินค้าสต๊อก (AKRA>TRD)",
        "app-gr": "ตรวจรับเข้าสินค้า (GR)",
        "app-pr": "ขอสั่งชื้อสินค้า (PR)",
        "app-pick": "บิลเบิกสินค้า (Picking)",
        "app-tracking": "จัดการคำสั่งชื้อ (PO)",
        "app-damage": "รับคืนสินค้าและเคลม",
        "app-kpi": "KPI Tracker",
        "app-manual": "คู่มือ"
    };

    for (const [id, name] of Object.entries(expectedLabels)) {
        assert(html.includes(`"${id}": "${name}"`), `App ID ${id} must keep exact official name: "${name}"`);
    }
});

test('3. Technical Clutter Removed from Employee Portal Markup', () => {
    // Availability & Security status cards must not exist in employee portal
    assert(!html.includes('app-access-count'), 'app-access-count card must be removed');
    assert(!html.includes('main-access-card'), 'main-access-card markup must be removed');
    assert(!html.includes('main-access-pill'), 'main-access-pill must be removed');
    assert(!html.includes('เปิดจากสิทธิ์ปัจจุบัน'), 'Footer tag เปิดจากสิทธิ์ปัจจุบัน must be removed');
});

test('4. Dashboard Controls & Grid Functional Execution', () => {
    // Extract main script
    const scriptRegex = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
    let mainScript = '';
    let m;
    while ((m = scriptRegex.exec(html)) !== null) {
        if (m[1].includes('MAIN_APP_LABELS')) {
            mainScript = m[1];
            break;
        }
    }
    assert(mainScript, 'Main script must be found');

    // Create synthetic DOM environment
    const createdElements = [];
    class MockElement {
        constructor(tagName) {
            this.tagName = tagName;
            this.className = '';
            this.textContent = '';
            this._innerHTML = '';
            this.dataset = {};
            this.style = {
                setProperty: (k, v) => { this.style[k] = v; }
            };
            this.attributes = {};
            this.children = [];
            this.listeners = {};
            createdElements.push(this);
        }
        get innerHTML() { return this._innerHTML; }
        set innerHTML(val) {
            this._innerHTML = val;
            if (!val) this.children = [];
        }
        setAttribute(k, v) { this.attributes[k] = v; }
        getAttribute(k) { return this.attributes[k]; }
        addEventListener(event, fn) {
            this.listeners[event] = this.listeners[event] || [];
            this.listeners[event].push(fn);
        }
        appendChild(child) {
            this.children.push(child);
            return child;
        }
        append(...items) {
            for (const it of items) {
                if (typeof it === 'string' || (it && it.nodeType === 3)) {
                    this.textContent += (it.nodeType === 3 ? it.data : it);
                } else {
                    this.children.push(it);
                }
            }
        }
        replaceChildren() {
            this.children = [];
            this.textContent = '';
        }
        querySelector() { return null; }
        querySelectorAll() { return []; }
        closest() { return null; }
        classList = {
            add: (c) => { this.className += ` ${c}`; },
            remove: (c) => { this.className = this.className.replace(c, '').trim(); },
            toggle: (c, force) => {
                if (force) this.className += ` ${c}`;
                else this.className = this.className.replace(c, '').trim();
            },
            contains: (c) => this.className.includes(c)
        };
    }

    const elementsMap = {
        'user-name-display': new MockElement('div'),
        'admin-btn': new MockElement('button'),
        'exec-btn': new MockElement('a'),
        'app-grid': new MockElement('section'),
        'app-grid-count': new MockElement('span'),
        'main-category-tabs': new MockElement('div'),
        'login-form': new MockElement('form'),
        'logout-btn': new MockElement('button'),
        'line-account-btn': new MockElement('button'),
        'close-line-modal-btn': new MockElement('button'),
        'line-connect-btn': new MockElement('button'),
        'line-unbind-btn': new MockElement('button'),
        'change-pwd-btn': new MockElement('button'),
        'close-pwd-modal-btn': new MockElement('button'),
        'cancel-change-pwd-btn': new MockElement('button'),
        'change-pwd-form': new MockElement('form'),
        'forgot-password-btn': new MockElement('button'),
        'close-forgot-modal-btn': new MockElement('button'),
        'confirm-forgot-btn': new MockElement('button'),
        'change-password-modal': new MockElement('div'),
        'forgot-password-modal': new MockElement('div'),
        'toast-container': new MockElement('div')
    };

    const sandbox = {
        document: {
            getElementById: (id) => elementsMap[id] || null,
            createElement: (tag) => new MockElement(tag),
            createTextNode: (text) => ({ nodeType: 3, data: text }),
            addEventListener: () => {},
            body: { classList: { toggle: () => {} } }
        },
        window: {
            location: { href: 'https://example.com' },
            addEventListener: () => {},
            open: () => {}
        },
        sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
        localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
        lucide: { createIcons: () => {} },
        console: console,
        fetch: async () => ({ ok: true, json: async () => ({}) }),
        setTimeout: () => {},
        clearTimeout: () => {},
        AbortController: AbortController,
        URL: URL
    };

    vm.createContext(sandbox);
    vm.runInContext(mainScript, sandbox);

    const App = vm.runInContext('App', sandbox);
    const state = vm.runInContext('state', sandbox);
    const getAppCategory = vm.runInContext('getAppCategory', sandbox);

    // Assert App and helper functions exist
    assert(typeof App === 'object', 'App object must exist');
    assert(typeof App.renderDashboard === 'function', 'App.renderDashboard must exist');
    assert(typeof getAppCategory === 'function', 'getAppCategory function must exist');

    // Simulate logged in user with ADMIN role
    state.currentUser = 'AKRA ADMIN';
    state.currentRoles = ['ADMIN'];
    state.sessionToken = 'token-12345';
    state.appConfig = [
        { id: "app-w5", name: "เบิกย้ายสินค้า (AKRA)", icon: "package", url: "https://akra-web.github.io/W5/", roles: ["ADMIN"] },
        { id: "app-trd", name: "เบิกย้ายสินค้าสต๊อก (AKRA>TRD)", icon: "repeat", url: "https://akra-web.github.io/TRDAKRA/", roles: ["ADMIN"] },
        { id: "app-gr", name: "ตรวจรับเข้าสินค้า (GR)", icon: "clipboard-check", url: "https://akra-web.github.io/GR/", roles: ["ADMIN"] },
        { id: "app-pr", name: "ขอสั่งชื้อสินค้า (PR)", icon: "shopping-cart", url: "https://akra-web.github.io/PR/", roles: ["ADMIN"] },
        { id: "app-pick", name: "บิลเบิกสินค้า (Picking)", icon: "package-check", url: "https://akra-web.github.io/Picking/", roles: ["ADMIN"] },
        { id: "app-tracking", name: "จัดการคำสั่งชื้อ (PO)", icon: "truck", url: "https://akra-web.github.io/TrackingPO/", roles: ["ADMIN"] },
        { id: "app-damage", name: "รับคืนสินค้าและเคลม", icon: "package-x", url: "https://akra-web.github.io/Returnitem/", roles: ["ADMIN"] },
        { id: "app-kpi", name: "KPI Tracker", icon: "bar-chart-2", url: "https://akra-web.github.io/KPITRACKER/", roles: ["ADMIN"] },
        { id: "app-manual", name: "คู่มือ", icon: "book-open", url: "https://akra-web.github.io/SOP/", roles: ["ADMIN"] }
    ];

    // Initial render - all 9 apps
    App.renderDashboard();
    assert.strictEqual(elementsMap['app-grid-count'].textContent, '09', 'Should show 09 apps for all categories');
    assert.strictEqual(elementsMap['app-grid'].children.length, 9, 'Should render 9 cards');

    // Filter by category: "warehouse" -> should have 3 apps (w5, trd, pick)
    state.appActiveCategory = 'warehouse';
    App.renderDashboard();
    assert.strictEqual(elementsMap['app-grid-count'].textContent, '03', 'Warehouse category should have 3 apps');
    assert.strictEqual(elementsMap['app-grid'].children.length, 3);

    // Filter by category: "procurement" -> should have 4 apps (gr, pr, tracking, damage)
    state.appActiveCategory = 'procurement';
    App.renderDashboard();
    assert.strictEqual(elementsMap['app-grid-count'].textContent, '04', 'Procurement category should have 4 apps');
    assert.strictEqual(elementsMap['app-grid'].children.length, 4);

    // Filter by category with zero matching apps
    state.appActiveCategory = 'nonexistent';
    App.renderDashboard();
    assert.strictEqual(elementsMap['app-grid-count'].textContent, '00', 'Nonexistent category should show 00');
    assert(elementsMap['app-grid'].innerHTML.includes('ไม่พบแอปพลิเคชันในหมวดหมู่นี้'), 'Empty category message must appear');
});

