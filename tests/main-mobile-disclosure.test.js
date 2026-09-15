const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const indexPath = path.join(__dirname, '..', 'index.html');
const html = fs.readFileSync(indexPath, 'utf8');

test('Mobile Account Disclosure Toggle Logic', () => {
    // 1. Static Verification
    assert(html.includes('id="mobile-account-toggle"'), 'Toggle button must exist');
    assert(html.includes('id="account-actions-menu"'), 'Account actions menu must exist');
    assert(html.includes('aria-expanded="false"'), 'Toggle should initially have aria-expanded=false');

    // 2. Syntax Verification
    const scriptRegex = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
    let scripts = [];
    let m;
    while ((m = scriptRegex.exec(html)) !== null) {
        scripts.push(m[1]);
        assert.doesNotThrow(() => {
            new vm.Script(m[1]);
        }, 'Script block must compile with zero syntax errors');
    }

    // 3. Mock DOM environment for logic test
    const toggleBtn = {
        id: 'mobile-account-toggle',
        attributes: { 'aria-expanded': 'false' },
        setAttribute(attr, val) { this.attributes[attr] = String(val); },
        getAttribute(attr) { return this.attributes[attr]; },
        contains(target) { return target === this; },
        click() { this.listeners.click && this.listeners.click({ stopPropagation: () => {} }); },
        focus() {},
        listeners: {},
        addEventListener(evt, cb) { this.listeners[evt] = cb; }
    };

    const menu = {
        id: 'account-actions-menu',
        classes: new Set(),
        classList: {
            contains: (cls) => menu.classes.has(cls),
            toggle: (cls, force) => {
                if (force) menu.classes.add(cls);
                else menu.classes.delete(cls);
            },
            remove: (cls) => menu.classes.delete(cls)
        },
        contains(target) { return target === this; }
    };

    const documentMock = {
        getElementById(id) {
            if (id === 'mobile-account-toggle') return toggleBtn;
            if (id === 'account-actions-menu') return menu;
            return null;
        },
        listeners: {},
        addEventListener(evt, cb) { this.listeners[evt] = cb; },
        dispatchEvent(evt) {
            if (this.listeners[evt.type]) this.listeners[evt.type](evt);
        }
    };

    const context = {
        document: documentMock,
        window: {
            MAIN_LIFF_ID: "mock",
            innerWidth: 375,
            listeners: {},
            addEventListener(evt, cb) { this.listeners[evt] = cb; },
            dispatchEvent(evt) {
                if (this.listeners[evt.type]) this.listeners[evt.type](evt);
            }
        },
        console: { warn: () => {} },
        App: { init: () => {} }
    };
    vm.createContext(context);

    // Extract the IIFE that registers the disclosure logic
    const allScripts = scripts.join('\n');
    const toggleScriptMatch = allScripts.match(/\/\/ Mobile Account Disclosure Toggle[\s\S]*?\}\)\(\);/);
    assert(toggleScriptMatch, 'Disclosure toggle IIFE should be found in scripts');

    // Run the toggle script
    new vm.Script(toggleScriptMatch[0]).runInContext(context);

    // Test initially closed
    assert.strictEqual(menu.classes.has('is-open'), false);
    assert.strictEqual(toggleBtn.getAttribute('aria-expanded'), 'false');

    // Test click open
    toggleBtn.click();
    assert.strictEqual(menu.classes.has('is-open'), true);
    assert.strictEqual(toggleBtn.getAttribute('aria-expanded'), 'true');

    // Test click outside closes
    documentMock.dispatchEvent({ type: 'click', target: {} }); // empty target means not inside menu or toggle
    assert.strictEqual(menu.classes.has('is-open'), false);
    assert.strictEqual(toggleBtn.getAttribute('aria-expanded'), 'false');

    // Test Escape closes
    toggleBtn.click(); // open again
    documentMock.dispatchEvent({ type: 'keydown', key: 'Escape' });
    assert.strictEqual(menu.classes.has('is-open'), false);
    assert.strictEqual(toggleBtn.getAttribute('aria-expanded'), 'false');

    // Test resize to desktop closes
    toggleBtn.click(); // open again
    context.window.innerWidth = 800;
    context.window.dispatchEvent({ type: 'resize' });
    assert.strictEqual(menu.classes.has('is-open'), false);
    assert.strictEqual(toggleBtn.getAttribute('aria-expanded'), 'false');
});
