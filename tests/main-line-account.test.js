const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const htmlPath = path.join(__dirname, '../index.html');
const versionPath = path.join(__dirname, '../version.json');
const html = fs.readFileSync(htmlPath, 'utf8');
const versionData = JSON.parse(fs.readFileSync(versionPath, 'utf8'));

test('Version Parity: CURRENT_VERSION in index.html matches version.json', () => {
  const match = html.match(/const CURRENT_VERSION = ["']([^"']+)["'];/);
  assert(match, 'CURRENT_VERSION must be declared in index.html');
  const indexVersion = match[1];
  assert.strictEqual(indexVersion, versionData.version, `index.html version (${indexVersion}) must match version.json (${versionData.version})`);
  assert.strictEqual(indexVersion, '20260907.01', 'Version must be bumped to 20260907.01');
});

test('Syntax check: All inline scripts parse with zero syntax errors via vm.Script', () => {
  const scriptRegex = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  let count = 0;
  while ((match = scriptRegex.exec(html)) !== null) {
    count++;
    assert.doesNotThrow(() => {
      new vm.Script(match[1]);
    }, `Inline script block ${count} must compile with zero syntax errors`);
  }
  assert(count > 0, 'Must have found at least one script block');
});

test('DOM Structure: Header LINE button and Modal elements exist with correct markup', () => {
  assert(html.includes('id="line-account-btn"'), 'Header must contain line-account-btn');
  assert(html.includes('id="line-status-dot"'), 'Button must contain line-status-dot');
  assert(html.includes('id="line-status-badge"'), 'Button must contain line-status-badge');
  assert(html.includes('id="line-account-modal"'), 'DOM must contain line-account-modal');
  assert(html.includes('id="line-connect-btn"'), 'Modal must contain line-connect-btn');
  assert(html.includes('id="line-unbind-btn"'), 'Modal must contain line-unbind-btn');
  assert(html.includes('id="line-state-linked"'), 'Modal must contain line-state-linked section');
  assert(html.includes('id="line-state-unlinked"'), 'Modal must contain line-state-unlinked section');
});

test('Functional: LineAccount lifecycle, UI rendering, intent validation and actions', async () => {
  // Extract script content
  const scriptMatch = html.match(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/i);
  assert(scriptMatch, 'Script block must exist');
  const scriptCode = scriptMatch[1];

  // Create lightweight DOM and storage mock environment
  const elements = new Map();
  const createElement = (id, initialClass = '') => {
    let _className = initialClass;
    let classes = new Set(initialClass.split(' ').filter(Boolean));
    const el = {
      id,
      get className() { return _className; },
      set className(val) {
        _className = String(val || '');
        classes = new Set(_className.split(' ').filter(Boolean));
      },
      title: '',
      textContent: '',
      disabled: false,
      classList: {
        add: (...names) => { names.forEach(n => classes.add(n)); _className = Array.from(classes).join(' '); },
        remove: (...names) => { names.forEach(n => classes.delete(n)); _className = Array.from(classes).join(' '); },
        toggle: (name, force) => {
          if (force !== undefined) {
            if (force) classes.add(name);
            else classes.delete(name);
          } else {
            if (classes.has(name)) classes.delete(name);
            else classes.add(name);
          }
          _className = Array.from(classes).join(' ');
        },
        contains: (name) => classes.has(name)
      },
      addEventListener: () => {},
      appendChild: () => {},
      replaceChildren: () => {},
      focus: () => {}
    };
    elements.set(id, el);
    return el;
  };

  [
    'line-account-btn', 'line-status-dot', 'line-status-badge',
    'line-account-modal', 'close-line-modal-btn', 'line-modal-title',
    'line-modal-loading', 'line-modal-error', 'line-modal-error-msg',
    'line-state-linked', 'line-state-unlinked', 'line-linked-name',
    'line-connect-btn', 'line-unbind-btn', 'user-name-display',
    'login-form', 'logout-btn', 'admin-btn', 'back-to-dash-btn',
    'refresh-data-btn', 'refresh-icon', 'change-password-modal',
    'change-pwd-btn', 'close-pwd-modal-btn', 'cancel-change-pwd-btn',
    'change-pwd-form', 'forgot-password-modal', 'forgot-password-btn',
    'close-forgot-modal-btn', 'confirm-forgot-btn', 'username-input',
    'password-input', 'remember-id-checkbox', 'login-btn', 'login-btn-text',
    'curr-pwd-input', 'new-pwd-input', 'confirm-pwd-input', 'submit-change-pwd-btn'
  ].forEach(id => createElement(id));

  const storage = new Map();
  const safeStorageMock = {
    getItem: (k) => storage.get(k) || null,
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: (k) => storage.delete(k)
  };

  const sessionStorageStore = new Map();
  const sessionStorageMock = {
    getItem: (k) => sessionStorageStore.get(k) || null,
    setItem: (k, v) => sessionStorageStore.set(k, String(v)),
    removeItem: (k) => sessionStorageStore.delete(k)
  };

  let postedActions = [];
  let toasts = [];

  const sandbox = {
    window: {
      location: new URL('https://akra-web.github.io/'),
      history: { replaceState: () => {} },
      addEventListener: () => {}
    },
    document: {
      getElementById: (id) => elements.get(id) || null,
      querySelector: () => null,
      createElement: (tag) => ({ setAttribute: () => {}, addEventListener: () => {} }),
      addEventListener: () => {},
      head: { appendChild: () => {} },
      body: {}
    },
    sessionStorage: sessionStorageMock,
    localStorage: safeStorageMock,
    confirm: () => true,
    alert: () => {},
    URL: globalThis.URL,
    lucide: { createIcons: () => {} },
    fetch: async () => ({ ok: true, json: async () => ({ version: '20260907.01' }) }),
    console: { log: () => {}, warn: () => {}, error: () => {} },
    setTimeout: (fn) => setTimeout(fn, 0),
    clearTimeout: (id) => clearTimeout(id)
  };

  vm.createContext(sandbox);
  // Execute the script inside sandbox with test export hook
  vm.runInContext(scriptCode + '\n;globalThis.__TEST_EXPORTS__ = { LineAccount, state, API, UI };', sandbox);

  const { LineAccount, state, API, UI } = sandbox.__TEST_EXPORTS__;
  assert(LineAccount, 'LineAccount object must be created');

  // Override API.postAction for tests
  API.postAction = async (payload) => {
    postedActions.push(payload);
    if (payload.action === 'getLineAccountStatus') {
      if (sandbox.mockStatusError) throw new Error(sandbox.mockStatusError);
      return {
        status: 'success',
        linked: Boolean(sandbox.mockLinked),
        lineDisplayName: sandbox.mockLinked ? (sandbox.mockDisplayName || 'Line User') : null
      };
    }
    if (payload.action === 'bindLineAccount') {
      if (payload.lineAccessToken === 'conflict_token') {
        const err = new Error('line_account_already_linked');
        err.code = 'line_account_already_linked';
        throw err;
      }
      return {
        status: 'success',
        linked: true,
        lineDisplayName: 'Newly Bound User'
      };
    }
    if (payload.action === 'unbindLineAccount') {
      return {
        status: 'success',
        linked: false,
        lineDisplayName: null
      };
    }
    return { status: 'success' };
  };

  UI.showToast = (msg, type) => toasts.push({ msg, type });

  // 1. AC1: Unlinked status rendering
  state.sessionToken = 'test-token';
  sandbox.mockLinked = false;
  await LineAccount.refreshStatus();
  assert.strictEqual(LineAccount.state.linked, false);
  assert.strictEqual(LineAccount.state.displayName, null);
  assert(elements.get('line-status-dot').classList.contains('hidden'), 'Dot must be hidden when unlinked');

  // 2. AC1: Linked status rendering with display name
  sandbox.mockLinked = true;
  sandbox.mockDisplayName = 'Somchai LINE';
  await LineAccount.refreshStatus();
  assert.strictEqual(LineAccount.state.linked, true);
  assert.strictEqual(LineAccount.state.displayName, 'Somchai LINE');
  assert(elements.get('line-status-dot').classList.contains('block'), 'Dot must be visible when linked');
  assert.strictEqual(elements.get('line-status-badge').textContent, 'Somchai LINE');

  // 3. Modal open / close
  LineAccount.openModal();
  assert(!elements.get('line-account-modal').classList.contains('hidden'), 'Modal must be open');
  assert(!elements.get('line-state-linked').classList.contains('hidden'), 'Linked section must be visible');
  assert(elements.get('line-state-unlinked').classList.contains('hidden'), 'Unlinked section must be hidden');
  assert.strictEqual(elements.get('line-linked-name').textContent, 'Somchai LINE');

  LineAccount.closeModal();
  assert(elements.get('line-account-modal').classList.contains('hidden'), 'Modal must be hidden after closeModal');

  // 4. AC4: Unbind flow
  await LineAccount.unbind();
  assert.strictEqual(LineAccount.state.linked, false);
  assert.strictEqual(LineAccount.state.displayName, null);
  assert(postedActions.some(a => a.action === 'unbindLineAccount'), 'unbindLineAccount action must have been posted');

  // 5. AC2 & AC5: Connect flow with mock LIFF SDK
  sandbox.window.liff = {
    init: async () => {},
    isLoggedIn: () => true,
    getAccessToken: () => 'test_access_token'
  };
  await LineAccount.connect();
  assert.strictEqual(LineAccount.state.linked, true);
  assert.strictEqual(LineAccount.state.displayName, 'Newly Bound User');

  // 6. AC5: Connect conflict error handling
  sandbox.window.liff.getAccessToken = () => 'conflict_token';
  await LineAccount.connect();
  assert(toasts.some(t => t.msg.includes('ผูกกับผู้ใช้งานอื่นอยู่แล้ว')), 'Conflict toast must be shown');

  // 7. AC5 / AC6: Callback intent validation - mismatch user is discarded
  sessionStorageMock.setItem('akra_line_link_user', 'different_user');
  state.currentUser = 'active_user';
  sandbox.window.location = new URL('https://akra-web.github.io/?code=oauth_code&state=123');
  toasts.length = 0;
  await LineAccount.checkCallbackIntent();
  assert(!toasts.some(t => t.msg.includes('กำลังยืนยัน')), 'Mismatched user callback must NOT proceed');

  // Callback intent validation - matching user proceeds
  sessionStorageMock.setItem('akra_line_link_user', 'active_user');
  sandbox.window.location = new URL('https://akra-web.github.io/?code=oauth_code&state=123');
  sandbox.window.liff.getAccessToken = () => 'test_access_token';
  await LineAccount.checkCallbackIntent();
  assert(toasts.some(t => t.msg.includes('กำลังยืนยัน')), 'Matching user callback must proceed');
});
