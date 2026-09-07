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
  assert.strictEqual(indexVersion, '20260907.03', 'Version must be bumped to 20260907.03');
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
  state.currentUserId = 'active_user';
  state.currentUser = 'Active User';
  state.lifecycleMarker = 'marker-active';
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

  // 7. AC5 / AC6 & R1: Callback intent validation - mismatch user is discarded
  sessionStorageMock.setItem('akra_line_link_intent', JSON.stringify({
    userId: 'different_user',
    marker: 'marker-active',
    epoch: state.sessionEpoch,
    timestamp: Date.now()
  }));
  sandbox.window.location = new URL('https://akra-web.github.io/?code=oauth_code&state=123');
  toasts.length = 0;
  await LineAccount.checkCallbackIntent();
  assert(!toasts.some(t => t.msg.includes('กำลังยืนยัน')), 'Mismatched user callback must NOT proceed');

  // 8. R1 / M4: Expired intent (> 10 minutes) is rejected and discarded
  sessionStorageMock.setItem('akra_line_link_intent', JSON.stringify({
    userId: 'active_user',
    marker: 'marker-active',
    epoch: state.sessionEpoch,
    timestamp: Date.now() - (11 * 60 * 1000) // 11 mins ago
  }));
  toasts.length = 0;
  await LineAccount.checkCallbackIntent();
  assert(!toasts.some(t => t.msg.includes('กำลังยืนยัน')), 'Expired callback intent must NOT proceed');
  assert.strictEqual(sessionStorageMock.getItem('akra_line_link_intent'), null, 'Expired intent must be removed');

  // 9. R1 / M4: Callback intent validation - matching user preserves URL parameters until liff.init
  sessionStorageMock.setItem('akra_line_link_intent', JSON.stringify({
    userId: 'active_user',
    marker: 'marker-active',
    epoch: state.sessionEpoch,
    timestamp: Date.now()
  }));
  sandbox.window.location = new URL('https://akra-web.github.io/?code=oauth_code&state=123');
  let initUrlObserved = null;
  sandbox.window.liff = {
    init: async () => {
      // Must observe the search params still intact during liff.init!
      initUrlObserved = sandbox.window.location.search;
    },
    isLoggedIn: () => true,
    getAccessToken: () => 'test_access_token'
  };
  toasts.length = 0;
  await LineAccount.checkCallbackIntent();
  assert(toasts.some(t => t.msg.includes('กำลังยืนยัน')), 'Matching user callback must proceed');
  assert(initUrlObserved.includes('code='), 'OAuth code parameter must be intact when liff.init is called');

  // 10. S1 Regression: Account switch with same display name during SDK init must abort with 0 API calls
  {
    state.currentUserId = 'account-a';
    state.currentUser = 'Shared Display Name';
    state.sessionToken = 'session-a';
    state.sessionEpoch = 1;
    postedActions.length = 0;
    let initResolve;
    const initPromise = new Promise(r => { initResolve = r; });
    let enteredResolve;
    const enteredPromise = new Promise(r => { enteredResolve = r; });
    sandbox.window.liff = {
      init: () => {
        enteredResolve();
        return initPromise;
      },
      isLoggedIn: () => true,
      getAccessToken: () => 'line-token-a'
    };
    const connectPromise = LineAccount.connect();
    await enteredPromise;
    // Simulate account switch while liff.init is pending
    state.currentUserId = 'account-b';
    state.currentUser = 'Shared Display Name';
    state.sessionToken = 'session-b';
    state.sessionEpoch = 2;
    initResolve();
    await connectPromise;
    const bindCalls = postedActions.filter(a => a.action === 'bindLineAccount');
    assert.strictEqual(bindCalls.length, 0, 'Account switch during SDK init must NOT post bindLineAccount');
  }

  // 11. S2 Regression: Delayed status read must not overwrite state after unbind
  {
    state.currentUserId = 'account-b';
    state.currentUser = 'Shared Display Name';
    state.sessionToken = 'session-b';
    LineAccount.state.linked = true;
    LineAccount.state.displayName = 'Old Bound Account';
    let statusResolve;
    const statusPromise = new Promise(r => { statusResolve = r; });
    const originalPostAction = API.postAction;
    API.postAction = async (payload) => {
      if (payload.action === 'getLineAccountStatus') {
        return statusPromise;
      }
      return originalPostAction(payload);
    };
    const refreshPromise = LineAccount.refreshStatus();
    await LineAccount.unbind();
    assert.strictEqual(LineAccount.state.linked, false, 'Unbind should immediately set linked to false');
    // Now resolve the delayed status response with linked=true
    statusResolve({
      status: 'success',
      linked: true,
      lineDisplayName: 'Old Bound Account'
    });
    await refreshPromise;
    assert.strictEqual(LineAccount.state.linked, false, 'Delayed status response must NOT restore linked state after unbind');
    API.postAction = originalPostAction;
  }
});
