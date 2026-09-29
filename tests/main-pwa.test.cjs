const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file));

function installRig(standalone = false) {
  const windowEvents = {};
  const buttonEvents = {};
  const button = { hidden: true, addEventListener: (name, fn) => { buttonEvents[name] = fn; } };
  const installHelp = { hidden: false };
  const elements = new Map([['main-pwa-install', button], ['main-pwa-install-help', installHelp]]);
  const warnings = [];
  const window = {
    navigator: { standalone },
    matchMedia: () => ({ matches: standalone }),
    addEventListener: (name, fn) => { windowEvents[name] = fn; }
  };
  vm.runInNewContext(read('js/main-pwa.js').toString(), {
    window, document: { getElementById: id => elements.get(id) || null }, console: { warn: (...args) => warnings.push(args) }
  });
  return { button, installHelp, buttonEvents, windowEvents, warnings };
}

function updateRig(version = '20260928.01') {
  const elements = new Map(), appended = [], replaced = [];
  const document = {
    body: { appendChild: node => appended.push(node) }, head: { appendChild() {} }, visibilityState: 'visible',
    getElementById: id => elements.get(id) || null,
    addEventListener() {},
    createElement(tag) {
      const handlers = {};
      return {
        tagName: tag, children: [], attrs: {},
        addEventListener: (name, fn) => { handlers[name] = fn; },
        appendChild(child) { this.children.push(child); },
        setAttribute(name, value) { this.attrs[name] = value; }, focus() {},
        get handlers() { return handlers; }
      };
    }
  };
  const location = new URL('https://example.test/Main/#/');
  location.replace = url => replaced.push(url);
  const window = { location, addEventListener() {}, confirm: () => true };
  const html = read('index.html').toString();
  const start = html.indexOf('const AppVersionGuard = (function () {');
  const marker = '\n        })();';
  const end = html.indexOf(marker, start);
  assert.ok(start >= 0 && end > start, 'AppVersionGuard block must be present');
  const script = html.slice(start, end + marker.length) + '\n;this.__guard = AppVersionGuard;';
  const context = vm.createContext({
    Date, URL, URLSearchParams, console: { warn() {} }, document,
    fetch: async () => ({ ok: true, json: async () => ({ version }) }),
    setInterval: () => 1, window
  });
  vm.runInContext(script, context);
  return { guard: context.__guard, appended, replaced, window };
}

function mainCredentialsDirty({ loginHidden = false, passwordModalHidden = true, username = '', password = '', rememberedId = '', rememberChecked = false, currentPassword = '', newPassword = '', confirmPassword = '' } = {}) {
  const html = read('index.html').toString();
  const helper = html.match(/function mainHasUnsavedCredentials\(\) \{[\s\S]*?\n        \}/)?.[0];
  assert.ok(helper, 'Main must expose its credential draft check as a testable helper');
  const fields = new Map([
    ['login-section', { classList: { contains: name => name === 'hidden' && loginHidden } }],
    ['change-password-modal', { classList: { contains: name => name === 'hidden' && passwordModalHidden } }],
    ['username-input', { value: username }],
    ['password-input', { value: password }],
    ['remember-id-checkbox', { value: 'on', checked: rememberChecked }],
    ['curr-pwd-input', { value: currentPassword }],
    ['new-pwd-input', { value: newPassword }],
    ['confirm-pwd-input', { value: confirmPassword }]
  ]);
  const context = vm.createContext({
    document: { getElementById: id => fields.get(id) },
    safeStorage: { getItem: key => key === 'akra_remember_id' ? rememberedId : null }
  });
  vm.runInContext(`${helper}; this.__check = mainHasUnsavedCredentials;`, context);
  return context.__check();
}

test('manifest has a stable standalone Main identity and real PNG icon sizes', () => {
  const manifest = JSON.parse(read('manifest.webmanifest').toString());
  assert.equal(manifest.id, '/Main/');
  assert.equal(manifest.start_url, '/Main/');
  assert.equal(manifest.scope, '/Main/');
  assert.equal(manifest.display, 'standalone');
  for (const icon of manifest.icons) {
    const image = read(icon.src);
    assert.deepEqual([...image.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.equal(image.readUInt32BE(16), Number.parseInt(icon.sizes, 10));
    assert.equal(image.readUInt32BE(20), Number.parseInt(icon.sizes, 10));
  }
  assert.ok(manifest.icons.some(icon => icon.sizes === '192x192' && icon.purpose === 'any'));
  assert.ok(manifest.icons.some(icon => icon.sizes === '512x512' && icon.purpose === 'any'));
  assert.ok(manifest.icons.some(icon => icon.purpose === 'maskable'));
});

test('manual install instructions remain available until a native prompt is offered', () => {
  const rig = installRig();
  assert.equal(rig.button.hidden, true);
  assert.equal(rig.installHelp.hidden, false);
  rig.windowEvents.beforeinstallprompt({ preventDefault() {} });
  assert.equal(rig.button.hidden, false);
  assert.equal(rig.installHelp.hidden, true);
});

test('install prompt is consumed once and both install paths hide after installation', async () => {
  const rig = installRig();
  assert.equal(rig.button.hidden, true);
  let prevented = false, prompts = 0;
  rig.windowEvents.beforeinstallprompt({
    preventDefault() { prevented = true; }, async prompt() { prompts += 1; },
    userChoice: Promise.resolve({ outcome: 'accepted' })
  });
  assert.equal(prevented, true);
  assert.equal(rig.button.hidden, false);
  await rig.buttonEvents.click();
  await rig.buttonEvents.click();
  assert.equal(prompts, 1);
  assert.equal(rig.button.hidden, true);
  assert.equal(rig.installHelp.hidden, true);
  const alreadyInstalled = installRig(true);
  assert.equal(alreadyInstalled.button.hidden, true);
  assert.equal(alreadyInstalled.installHelp.hidden, true);
  alreadyInstalled.windowEvents.appinstalled();
  alreadyInstalled.windowEvents.beforeinstallprompt({ preventDefault() {} });
  assert.equal(alreadyInstalled.button.hidden, true);
});

test('dismissed or unavailable install prompts do not block use of the site', async () => {
  const dismissed = installRig();
  dismissed.windowEvents.beforeinstallprompt({
    preventDefault() {}, async prompt() {}, userChoice: Promise.resolve({ outcome: 'dismissed' })
  });
  await dismissed.buttonEvents.click();
  assert.equal(dismissed.button.hidden, true);
  assert.equal(dismissed.installHelp.hidden, false);

  const unavailable = installRig();
  unavailable.windowEvents.beforeinstallprompt({ preventDefault() {}, async prompt() { throw Error('unavailable'); } });
  await unavailable.buttonEvents.click();
  assert.equal(unavailable.button.hidden, true);
  assert.equal(unavailable.installHelp.hidden, false);
  assert.equal(unavailable.warnings.length, 1);
});

test('update waits while a save is busy or work state is unknown', async () => {
  for (const state of [{ busy: true }, { busy: false, unknown: true }]) {
    const rig = updateRig();
    let notices = 0;
    rig.guard.start({ current: '20260925.01', workState: () => state, notify: () => notices++ });
    assert.equal(await rig.guard.check(), false);
    assert.equal(rig.guard.reloadNow(), false);
    assert.equal(rig.replaced.length, 0);
    assert.equal(notices, 1);
  }
});

test('canceling a dirty update preserves the draft; confirmed discard reloads once', async () => {
  const rig = updateRig();
  let answer = false, confirms = 0;
  rig.window.confirm = () => { confirms += 1; return answer; };
  rig.guard.start({ current: '20260925.01', workState: () => ({ dirty: true, busy: false }) });
  assert.equal(await rig.guard.check(), false);
  assert.equal(rig.guard.reloadNow(), false);
  assert.equal(rig.replaced.length, 0);
  assert.equal(confirms, 1);
  answer = true;
  assert.equal(rig.guard.reloadNow(), true);
  assert.equal(rig.replaced.length, 1);
  assert.match(rig.replaced[0], /update=/);
  assert.match(rig.replaced[0], /#\/$/);
});

test('new-version banner delegates to guarded reload', async () => {
  const rig = updateRig();
  rig.guard.start({ current: '20260925.01', workState: () => ({ dirty: false, busy: false }) });
  assert.equal(await rig.guard.check(), false);
  const banner = rig.appended.find(node => node.id === 'avg-banner');
  assert.ok(banner);
  assert.match(banner.children[0].textContent, /เวอร์ชันใหม่/);
  banner.children[1].handlers.click();
  assert.equal(rig.replaced.length, 1);
});

test('credential update guard distinguishes remembered login preferences from drafts', () => {
  assert.equal(mainCredentialsDirty(), false);
  assert.equal(mainCredentialsDirty({ username: '250001', rememberedId: '250001', rememberChecked: true }), false);
  assert.equal(mainCredentialsDirty({ username: '250001' }), true);
  assert.equal(mainCredentialsDirty({ password: 'fixture-password' }), true);
  assert.equal(mainCredentialsDirty({ username: '250001', rememberedId: '250001' }), true);
  assert.equal(mainCredentialsDirty({ rememberChecked: true }), true);
  assert.equal(mainCredentialsDirty({ loginHidden: true, passwordModalHidden: false, newPassword: 'fixture-password' }), true);
  assert.equal(mainCredentialsDirty({ loginHidden: true, passwordModalHidden: false, confirmPassword: 'fixture-password' }), true);
  assert.equal(mainCredentialsDirty({ loginHidden: true, passwordModalHidden: false, currentPassword: 'fixture-password' }), true);
  assert.equal(mainCredentialsDirty({ loginHidden: true, currentPassword: 'fixture-password' }), false);
});
