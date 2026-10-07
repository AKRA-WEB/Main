// Actual Main storage/session/login code and shared bridge, with synthetic native storage and network only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8').replace(/\r\n/g, '\n');
const bridge = fs.readFileSync(path.join(__dirname, '../js/akra-shell-bridge.js'), 'utf8');
const section = (startText, endText) => {
    const start = html.indexOf(startText), end = html.indexOf(endText, start + startText.length);
    assert(start >= 0 && end > start, 'actual Main source section is available');
    return html.slice(start, end);
};
const tick = () => new Promise(setImmediate);
const user = { id: 'fixture', name: 'Verified', roles: ['ADMIN'], perms: {},
    identityId: '10000000-0000-4000-8000-000000000011', sessionVersion: 2, authorizationRevision: 'current' };
const record = (token = 'saved-token', owner = user) => JSON.stringify({ version: 1, token,
    identityId: owner.identityId, sessionVersion: owner.sessionVersion, authorizationRevision: owner.authorizationRevision });
const signedOut = JSON.stringify({ version: 1, signedOut: true });
const otherUser = { ...user, identityId: '10000000-0000-4000-8000-000000000012' };

function rig(options = {}) {
    const native = new Map(options.entries || []), nodes = new Map(), events = {}, sections = [], views = [], toasts = [];
    native.set('private-draft:other-module', 'unrelated draft fixture');
    native.set('pending:other-module', 'uncertain mutation fixture');
    const faults = { quota: options.quotaAtBoot === true, read: false, remove: false };
    const node = id => {
        if (!nodes.has(id)) nodes.set(id, { value: '', checked: false, disabled: false, innerText: '', innerHTML: '',
            focus() {}, classList: { add() {}, remove() {}, toggle() {} }, querySelectorAll: () => [] });
        return nodes.get(id);
    };
    const localStorage = {
        getItem(key) { if (faults.read) throw Error('synthetic unreadable storage'); return native.get(key) ?? null; },
        setItem(key, value) {
            if (faults.quota) throw Object.assign(Error('synthetic quota'), { name: 'QuotaExceededError' });
            native.set(key, String(value));
        },
        removeItem(key) { if (faults.remove) throw Error('synthetic removal denied'); native.delete(key); },
        clear() { if (faults.remove) throw Error('synthetic clear denied'); native.clear(); }
    };
    const state = { sessionToken: null, sessionEpoch: 0, currentUser: null, currentUserId: null, currentRoles: [],
        currentPerms: {}, appConfig: [], mustChangePassword: false, pendingApiRequests: 0 };
    const availableStorage = options.storageUnavailable ? undefined : localStorage;
    const window = { localStorage: availableStorage, location: new URL('https://fixture.invalid/Main/'),
        addEventListener: (name, fn) => (events[name] ??= []).push(fn), AkraShell: { reset() {}, sync() {} } };
    window.parent = window;
    const context = vm.createContext({ window, localStorage: availableStorage, state, JSON, Date, URL, URLSearchParams, AbortController,
        document: { getElementById: node }, CONFIG: { STORAGE_SESSION: 'akra_session_token', STORAGE_USER_DATA: 'akra_user_data',
            STORAGE_USER_DB: 'akra_user_database', STORAGE_APP_CONFIG: 'akra_app_config', API_URL: 'https://fixture.invalid/auth-api' },
        sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} }, DEFAULT_APP_CONFIG: [],
        generateLifecycleMarker: () => 'fixture-marker', pwdModal: node('password-modal'), lucide: { createIcons() {} },
        setTimeout() {}, clearTimeout() {}, AppVersionGuard: { blockIfStale: async () => false },
        UI: { switchSection: id => sections.push(id), showToast: (...args) => toasts.push(args) },
        AdminInteractive: { userPermissionEditor: { reset() {} }, resetProfile() {} },
        LineAccount: { refreshStatus() {}, checkCallbackIntent() {}, updateHeaderButton() {}, closeModal() {} },
        API: { postAction: async () => ({ status: 'success', token: 'verified-token', user, appConfig: [] }) },
        fetch: async () => { throw Error('unexpected network request in isolated fixture'); } });
    const run = source => vm.runInContext(source, context);
    run(section('        const safeStorage = (function() {', '\n        const DEFAULT_APP_CONFIG =') + '\nthis.storage=safeStorage;');
    run(section('        const App = {', '        const AKRA_SSO = {') + '\nthis.app=App;');
    run(bridge);
    context.app.renderDashboard = () => views.push(state.currentUser);
    context.app.openChangePasswordModal = () => views.push('password');
    context.app.runPendingNavigation = () => {};
    run('this.startup=async()=>{' + section('                const savedToken = safeStorage.getItem(CONFIG.STORAGE_SESSION);',
        '\n            },\n\n            handleLogin:') + '};');
    const login = async () => {
        node('username-input').value = 'fixture'; node('password-input').value = 'fixture-password';
        return context.app.handleLogin({ preventDefault() {} });
    };
    const notify = async (key, details = {}) => { for (const listener of events.storage || []) await listener({ key, ...details }); };
    const assertUnrelated = () => {
        assert.equal(native.get('private-draft:other-module'), 'unrelated draft fixture');
        assert.equal(native.get('pending:other-module'), 'uncertain mutation fixture');
    };
    return { context, state, native, faults, node, views, sections, toasts, run, login, notify, assertUnrelated };
}

for (const quotaAtBoot of [true, false]) for (const oldRecord of [signedOut, record('old-token', otherUser)]) {
    test(`verified login succeeds with ${quotaAtBoot ? 'boot' : 'late'} quota and ${oldRecord === signedOut ? 'signed-out' : 'different-owner'} stored record`, async () => {
        const f = rig({ quotaAtBoot, entries: [['akra_main_session', oldRecord], ['akra_session_token', 'old-token']] });
        f.faults.quota = true;
        await f.login();
        assert.equal(f.state.currentUser, 'Verified');
        assert.equal(f.state.sessionToken, 'verified-token');
        assert.equal(f.context.storage.getItem('akra_session_token'), 'verified-token');
        assert.equal(f.native.has('akra_main_session'), false, 'only stale Main auth keys are removed when quota stays full');
        assert.equal(f.native.has('akra_session_token'), false);
        assert.equal(f.sections.at(-1), 'dashboard-section');
        assert.equal(f.views.length, 1);
        assert.equal(f.node('login-btn').disabled, false);
        assert.equal(f.node('password-input').value, '');
        f.assertUnrelated();
    });
}

test('quota at boot still reads and verifies an existing healthy signed session before rendering', async () => {
    const f = rig({ quotaAtBoot: true, entries: [['akra_session_token', 'saved-token'], ['akra_main_session', record()]] });
    let finish, calls = 0;
    f.context.API.postAction = () => { calls++; return new Promise(resolve => finish = resolve); };
    const pending = f.context.startup(); await tick();
    assert.equal(calls, 1); assert.equal(f.state.sessionToken, 'saved-token'); assert.equal(f.views.length, 0);
    finish({ status: 'success', token: 'verified-token', user, appConfig: [] }); await pending;
    assert.equal(f.sections.at(-1), 'dashboard-section'); assert.equal(f.views.length, 1);
    assert.equal(f.state.sessionToken, 'verified-token'); f.assertUnrelated();
});

test('fallback replaces stale native reads, preserves a removal tombstone and recovers after storage becomes writable', () => {
    const f = rig({ entries: [['akra_remember_id', 'older-id']] });
    f.faults.quota = true; f.faults.remove = true;
    f.context.storage.setItem('akra_remember_id', 'new-id');
    assert.equal(f.context.storage.getItem('akra_remember_id'), 'new-id');
    f.context.storage.removeItem('akra_remember_id');
    assert.equal(f.context.storage.getItem('akra_remember_id'), null);
    f.faults.quota = false; f.faults.remove = false;
    f.context.storage.setItem('akra_remember_id', 'recovered-id');
    assert.equal(f.context.storage.getItem('akra_remember_id'), 'recovered-id');
    assert.equal(f.native.get('akra_remember_id'), 'recovered-id');
    f.context.storage.removeItem('akra_remember_id');
    assert.equal(f.context.storage.getItem('akra_remember_id'), null); f.assertUnrelated();
});

test('delayed unchanged native events preserve a newer fallback and its removal tombstone', async () => {
    const f = rig({ entries: [['akra_remember_id', 'old-id']] }); f.faults.quota = true; f.faults.remove = true;
    f.context.storage.setItem('akra_remember_id', 'new-id');
    await f.notify('akra_remember_id', { oldValue: 'earlier-id', newValue: 'old-id' });
    assert.equal(f.context.storage.getItem('akra_remember_id'), 'new-id');
    f.context.storage.removeItem('akra_remember_id');
    await f.notify('akra_remember_id', { oldValue: 'earlier-id', newValue: 'old-id' });
    assert.equal(f.context.storage.getItem('akra_remember_id'), null);
    assert.equal(f.native.get('akra_remember_id'), 'old-id'); f.assertUnrelated();
});

test('unreadable native storage falls back locally and successful writes retire the older fallback', () => {
    const f = rig(); f.faults.read = true; f.faults.quota = true;
    f.context.storage.setItem('akra_remember_id', 'memory-id');
    assert.equal(f.context.storage.getItem('akra_remember_id'), 'memory-id');
    f.faults.read = false; f.faults.quota = false;
    f.context.storage.setItem('akra_remember_id', 'native-id');
    assert.equal(f.context.storage.getItem('akra_remember_id'), 'native-id');
    f.native.set('akra_remember_id', 'peer-id');
    assert.equal(f.context.storage.getItem('akra_remember_id'), 'peer-id'); f.assertUnrelated();
});

test('missing browser storage still supports a server-verified Main login in memory', async () => {
    const f = rig({ storageUnavailable: true });
    await f.login();
    assert.equal(f.state.sessionToken, 'verified-token'); assert.equal(f.views.length, 1);
    assert.equal(f.sections.at(-1), 'dashboard-section');
    assert.equal(f.context.storage.getItem('akra_session_token'), 'verified-token'); f.assertUnrelated();
});

test('quota fallback for a non-session key preserves its prior native value and unrelated private work', () => {
    const f = rig({ entries: [['akra_app_config', 'prior regenerable config fixture']] }); f.faults.quota = true;
    f.context.storage.setItem('akra_app_config', 'updated config fixture');
    assert.equal(f.context.storage.getItem('akra_app_config'), 'updated config fixture');
    assert.equal(f.native.get('akra_app_config'), 'prior regenerable config fixture'); f.assertUnrelated();
});

test('a newer native peer value wins over a prior failed-write fallback before its event arrives', () => {
    const f = rig({ entries: [['akra_session_token', 'original-token']] });
    f.faults.quota = true; f.context.storage.setItem('akra_session_token', 'memory-token');
    assert.equal(f.context.storage.getItem('akra_session_token'), 'memory-token');
    f.native.set('akra_session_token', 'peer-token');
    assert.equal(f.context.storage.getItem('akra_session_token'), 'peer-token'); f.assertUnrelated();
});

test('rejected credentials remain public and release the submit button under quota', async () => {
    const f = rig({ quotaAtBoot: true, entries: [['akra_main_session', signedOut]] });
    f.context.API.postAction = async () => { throw Object.assign(Error('invalid_credentials'), { code: 'invalid_credentials' }); };
    await f.login();
    assert.equal(f.state.sessionToken, null); assert.equal(f.views.length, 0);
    assert.equal(f.toasts.length, 1); assert.match(f.toasts[0][0], /รหัสพนักงานหรือรหัสผ่านไม่ถูกต้อง/);
    assert.equal(f.node('login-btn').disabled, false); f.assertUnrelated();
});

test('actual login API timeout releases submit and cannot adopt a late successful response', async () => {
    const f = rig({ quotaAtBoot: true, entries: [['akra_main_session', signedOut]] });
    let deadline, finishBody;
    f.context.setTimeout = callback => { deadline = callback; return 1; };
    f.context.fetch = async () => ({ ok: true, json: () => new Promise(resolve => finishBody = resolve) });
    f.run(section('        const API = {', '        const AdminInteractive = {') + '\nthis.actualAPI=API;');
    const pending = f.login(); await tick(); deadline(); await pending;
    assert.equal(f.node('login-btn').disabled, false); assert.equal(f.state.sessionToken, null);
    assert.equal(f.views.length, 0); assert.equal(f.toasts.length, 1);
    finishBody({ status: 'success', token: 'late-token', user, appConfig: [] }); await tick();
    assert.equal(f.state.sessionToken, null); assert.equal(f.views.length, 0); f.assertUnrelated();
});

test('pending login cannot replace a newer peer login before its event arrives, even under quota', async () => {
    const f = rig({ quotaAtBoot: true, entries: [['akra_main_session', signedOut]] });
    let finish; f.context.API.postAction = () => new Promise(resolve => finish = resolve);
    const pending = f.login(); await tick();
    f.native.set('akra_main_session', record('peer-token', otherUser)); f.native.set('akra_session_token', 'peer-token');
    finish({ status: 'success', token: 'obsolete-token', user, appConfig: [] }); await pending;
    assert.equal(f.state.sessionToken, null); assert.equal(f.views.length, 0);
    assert.equal(f.state.sessionEpoch, 0, 'superseded login never adopts then retires obsolete identity');
    assert.equal(f.native.get('akra_session_token'), 'peer-token'); assert.equal(f.node('login-btn').disabled, false);
    f.assertUnrelated();
});

for (const nextRecord of [signedOut, record('peer-token', otherUser)]) {
    test(`verified memory login retires on peer ${nextRecord === signedOut ? 'logout' : 'replacement'}`, async () => {
        const f = rig({ entries: [['akra_main_session', signedOut]] }); f.faults.quota = true;
        await f.login(); assert.equal(f.state.sessionToken, 'verified-token');
        f.native.set('akra_main_session', nextRecord);
        f.native.set('akra_session_token', nextRecord === signedOut ? 'older-token' : 'peer-token');
        await f.notify('akra_main_session');
        assert.equal(f.state.sessionToken, null); assert.equal(f.state.currentUser, null);
        assert.equal(f.sections.at(-1), 'login-section'); assert.equal(f.native.get('akra_main_session'), nextRecord);
        f.assertUnrelated();
    });
}

test('peer logout during a pending refresh cannot restore the former memory session', async () => {
    const f = rig({ entries: [['akra_main_session', signedOut]] }); f.faults.quota = true;
    await f.login(); assert.equal(f.state.sessionToken, 'verified-token');
    let finish; f.context.API.postAction = () => new Promise(resolve => finish = resolve);
    const pending = f.context.app.refreshSession(); await tick();
    f.native.set('akra_main_session', signedOut); f.native.delete('akra_session_token');
    await f.notify('akra_main_session');
    finish({ status: 'success', token: 'obsolete-refresh-token', user, appConfig: [] });
    assert.equal(await pending, false); assert.equal(f.state.sessionToken, null);
    assert.equal(f.native.get('akra_main_session'), signedOut); f.assertUnrelated();
});

test('delayed unchanged auth events cannot supersede a current memory-session refresh', async () => {
    const f = rig({ entries: [['akra_main_session', signedOut], ['akra_session_token', 'older-token']] }); f.faults.quota = true;
    await f.login(); assert.equal(f.state.sessionToken, 'verified-token');
    let finish; f.context.API.postAction = () => new Promise(resolve => finish = resolve);
    const pending = f.context.app.refreshSession(); await tick();
    await f.notify('akra_session_token', { oldValue: 'older-token', newValue: null });
    await f.notify('akra_main_session', { oldValue: signedOut, newValue: null });
    finish({ status: 'success', token: 'refreshed-token', user, appConfig: [] });
    assert.equal(await pending, true); assert.equal(f.state.sessionToken, 'refreshed-token');
    assert.equal(f.context.storage.getItem('akra_session_token'), 'refreshed-token');
    assert.equal(f.state.sessionEpoch, 1); assert.equal(f.native.has('akra_main_session'), false); f.assertUnrelated();
});

for (const initialNativeToken of ['saved-token', null]) {
    test(`accepted atomic peer refresh cannot hide later ${initialNativeToken === null ? 'token deletion' : 'token reversion'} to its initial native baseline`, async () => {
        const f = rig({ entries: initialNativeToken === null ? [['akra_main_session', signedOut]] :
            [['akra_main_session', record()], ['akra_session_token', initialNativeToken]] });
        if (initialNativeToken === null) { f.faults.quota = true; await f.login(); }
        else f.context.app.saveSession({ token: 'saved-token', user, appConfig: [] });
        f.context.fetch = async () => ({ ok: true, json: async () => ({ valid: true, user }) });
        f.native.set('akra_main_session', record('peer-refreshed-token'));
        await f.notify('akra_main_session');
        assert.equal(f.state.sessionToken, 'peer-refreshed-token', 'same owner token must first be verified');
        f.native.set('akra_session_token', 'peer-refreshed-token');
        await f.notify('akra_session_token');
        assert.equal(f.state.sessionToken, 'peer-refreshed-token', 'compatibility write is part of the accepted atomic refresh');
        if (initialNativeToken === null) f.native.delete('akra_session_token');
        else f.native.set('akra_session_token', initialNativeToken);
        await f.notify('akra_session_token');
        assert.equal(f.state.sessionToken, null); assert.equal(f.state.currentUser, null);
        assert.equal(f.native.get('akra_main_session'), record('peer-refreshed-token')); f.assertUnrelated();
    });
}

test('an unchanged-record notification cannot bless an unverified compatibility token before its own event arrives', async () => {
    const f = rig(); f.context.app.saveSession({ token: 'saved-token', user, appConfig: [] });
    const currentRecord = f.native.get('akra_main_session');
    f.native.set('akra_session_token', 'unverified-peer-token');
    await f.notify('akra_main_session', { oldValue: signedOut, newValue: currentRecord });
    await f.notify('akra_session_token', { oldValue: 'saved-token', newValue: 'unverified-peer-token' });
    assert.equal(f.state.sessionToken, null); assert.equal(f.state.currentUser, null);
    assert.equal(f.native.get('akra_session_token'), 'unverified-peer-token');
    assert.equal(f.native.get('akra_main_session'), currentRecord); f.assertUnrelated();
});
