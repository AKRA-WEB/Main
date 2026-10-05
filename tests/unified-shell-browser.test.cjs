const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const MAIN_ROOT = path.resolve(__dirname, '..');
const WORKTREE_ROOT = path.resolve(MAIN_ROOT, '..');
const WORKSPACE_ROOT = path.resolve(WORKTREE_ROOT, '..', '..');
const FIXTURE_SERVER = path.join(MAIN_ROOT, 'tests', 'shell-fixture-server.cjs');
const CANDIDATE_VERSION = JSON.parse(fs.readFileSync(path.join(MAIN_ROOT, 'version.json'), 'utf8')).version;
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BROWSER = process.env.SHELL_BROWSER_EXECUTABLE || process.argv[2] || CHROME;
const MODULES = [
  ['app-w5', '/AKRA/'],
  ['app-trd', '/TRDAKRA/'],
  ['app-gr', '/GR/'],
  ['app-pr', '/PR/'],
  ['app-pick', '/Picking/'],
  ['app-tracking', '/TrackingPO/'],
  ['app-damage', '/Returnitem/'],
  ['app-kpi', '/KPITRACKER/'],
  ['app-manual', '/SOP/'],
  ['app-evaluation', '/Evaluation/']
];

function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function browserContentPages(targets) {
  return targets.filter(target => target.type === 'page' && !/^(?:chrome|edge|devtools):\/\//i.test(target.url));
}

function httpJson(port, pathname) {
  return new Promise((resolve, reject) => {
    const request = http.get({ hostname: '127.0.0.1', port, path: pathname }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => {
        try { resolve({ status: response.statusCode, body: JSON.parse(body || '{}') }); }
        catch (error) { reject(error); }
      });
    });
    request.on('error', reject);
  });
}

function httpForm(port, pathname, body) {
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port, path: pathname, method: 'POST', headers: {
      'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body),
      'Origin': `http://127.0.0.1:${port}`
    }}, response => {
      response.resume();
      response.on('end', () => resolve({ status: response.statusCode }));
    });
    request.on('error', reject);
    request.end(body);
  });
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function waitFor(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) { lastError = error; }
    await delay(100);
  }
  throw new Error(`${label} timeout${lastError ? `: ${lastError.message}` : ''}`);
}

class CdpClient {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
    this.opened = new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, { once: true });
      this.socket.addEventListener('error', reject, { once: true });
    });
    this.socket.addEventListener('message', event => {
      const message = JSON.parse(String(event.data));
      if (message.method === 'Page.javascriptDialogOpening') {
        this.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
        return;
      }
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message || 'cdp_error'));
      else pending.resolve(message.result || {});
    });
  }

  async send(method, params = {}) {
    await this.opened;
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || 'browser_evaluation_failed');
    }
    return result.result?.value;
  }

  close() { try { this.socket.close(); } catch (_) {} }
}

async function startProcess(command, args, options) {
  const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk.toString(); });
  child.stderr.on('data', chunk => { output += chunk.toString(); });
  child.startedOutput = () => output;
  return child;
}

function terminateProcessTree(child) {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } else {
    try { child.kill('SIGTERM'); } catch (_) {}
  }
}

async function main() {
  assert.equal(fs.existsSync(BROWSER), true, `Chromium browser executable is required: ${BROWSER}`);
  const readOnlyProfile = process.env.SHELL_READ_ONLY_PROFILE === '1';
  const fixturePort = await freePort();
  const debugPort = await freePort();
  const origin = `http://127.0.0.1:${fixturePort}`;
  const fixture = await startProcess(process.execPath, [FIXTURE_SERVER, '--identity-auth', '--real-modules'], {
    cwd: MAIN_ROOT,
    env: {
      ...process.env,
      SHELL_TEST_PORT: String(fixturePort),
      NODE_PATH: [path.join(WORKTREE_ROOT, 'database', 'node_modules'), path.join(WORKSPACE_ROOT, 'database', 'node_modules'), process.env.NODE_PATH || ''].filter(Boolean).join(path.delimiter)
    }
  });
  let profile;
  let chrome;
  let cdp;
  let connectivity = null;
  let fileWorkflows = null;
  let uncertainW5Outcome = null;
  try {
    await waitFor(async () => {
      try { return (await httpJson(fixturePort, '/__fixture/status')).status === 200; }
      catch (_) { return false; }
    }, 20000, 'fixture server');
    profile = fs.mkdtempSync(path.join(os.tmpdir(), 'akra-shell-cdp-'));
    const downloadDirectory = path.join(profile, 'downloads');
    fs.mkdirSync(downloadDirectory);
    chrome = await startProcess(BROWSER, [
      '--headless=new', '--disable-gpu', '--disable-extensions', '--no-first-run',
      '--no-default-browser-check', '--remote-allow-origins=*',
      `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`,
      '--window-size=1280,900', 'about:blank'
    ], { cwd: MAIN_ROOT });
    await waitFor(async () => {
      const response = await httpJson(debugPort, '/json');
      return response.status === 200 && response.body.some(target => target.type === 'page');
    }, 15000, 'Chrome DevTools page');
    const targets = (await httpJson(debugPort, '/json')).body;
    const pageTarget = browserContentPages(targets)[0];
    assert.ok(pageTarget, 'browser did not expose a content page target');
    cdp = new CdpClient(pageTarget.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDirectory });
    await cdp.send('Page.navigate', { url: `${origin}/Main/` });
    await waitFor(() => cdp.evaluate("document.readyState === 'complete'"), 15000, 'Main document');
    await waitFor(() => cdp.evaluate("!!document.getElementById('login-form')"), 15000, 'Main login form');
    await cdp.evaluate(`(() => {
      const username = document.getElementById('username-input');
      const password = document.getElementById('password-input');
      username.value = 'fixture-user';
      password.value = 'fixture-password';
      document.getElementById('login-form').requestSubmit();
      return true;
    })()`);
    await waitFor(() => cdp.evaluate(`(() => {
      const section = document.getElementById('dashboard-section');
      return !!section && !section.hidden && document.querySelectorAll('#app-grid button').length === 10;
    })()`), 20000, 'Main authenticated dashboard');
    const pwaAssets = await cdp.evaluate(`(async () => {
      const manifestLink = document.querySelector('link[rel="manifest"]');
      if (!manifestLink) return { ok: false, reason: 'manifest link missing' };
      const response = await fetch(manifestLink.href, { cache: 'no-store' });
      const manifest = await response.json();
      const icons = await Promise.all((manifest.icons || []).map(async icon => {
        const iconUrl = new URL(icon.src, response.url);
        const iconResponse = await fetch(iconUrl, { cache: 'no-store' });
        const bytes = new Uint8Array(await iconResponse.arrayBuffer());
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        return {
          src: icon.src,
          sizes: icon.sizes,
          purpose: icon.purpose,
          status: iconResponse.status,
          contentType: iconResponse.headers.get('content-type') || '',
          pngSignature: bytes.length >= 24 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value),
          width: bytes.length >= 24 ? view.getUint32(16) : 0,
          height: bytes.length >= 24 ? view.getUint32(20) : 0
        };
      }));
      return {
        ok: response.ok,
        status: response.status,
        contentType: response.headers.get('content-type') || '',
        id: manifest.id,
        startUrl: manifest.start_url,
        scope: manifest.scope,
        display: manifest.display,
        icons
      };
    })()`);
    assert.equal(pwaAssets.ok, true, `manifest request failed: ${JSON.stringify(pwaAssets)}`);
    assert.equal(pwaAssets.status, 200);
    assert.match(pwaAssets.contentType, /application\/manifest\+json/i);
    assert.deepEqual([pwaAssets.id, pwaAssets.startUrl, pwaAssets.scope, pwaAssets.display], ['/Main/', '/Main/', '/Main/', 'standalone']);
    assert.equal(pwaAssets.icons.length, 3, 'manifest icon set is incomplete');
    for (const icon of pwaAssets.icons) {
      assert.equal(icon.status, 200, `${icon.src} HTTP status`);
      assert.match(icon.contentType, /image\/png/i, `${icon.src} MIME type`);
      assert.equal(icon.pngSignature, true, `${icon.src} PNG signature`);
      assert.equal(icon.width, Number.parseInt(icon.sizes, 10), `${icon.src} width`);
      assert.equal(icon.height, Number.parseInt(icon.sizes, 10), `${icon.src} height`);
    }

    await cdp.send('Network.enable');
    const initiallyOnline = await cdp.evaluate(`(() => {
      window.__akraConnectivityEvents = [];
      window.addEventListener('offline', () => window.__akraConnectivityEvents.push('offline'));
      window.addEventListener('online', () => window.__akraConnectivityEvents.push('online'));
      return navigator.onLine;
    })()`);
    assert.equal(initiallyOnline, true, 'fixture Chrome should begin online');
    await cdp.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
    let offlineApplied = true;
    let offlineProbe;
    try {
      await waitFor(() => cdp.evaluate('navigator.onLine === false'), 5000, 'Chrome offline transition');
      offlineProbe = await cdp.evaluate(`(async () => {
        try {
          const response = await fetch('/Main/version.json?connectivity=offline-' + Date.now(), { cache: 'no-store' });
          return { online: navigator.onLine, ok: response.ok };
        } catch (error) {
          return { online: navigator.onLine, ok: false, error: error.name };
        }
      })()`);
      assert.equal(offlineProbe.online, false, 'Chrome did not report the offline state');
      assert.equal(offlineProbe.ok, false, 'a network fetch unexpectedly succeeded while offline');
    } finally {
      if (offlineApplied) {
        await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
        offlineApplied = false;
      }
    }
    await waitFor(() => cdp.evaluate('navigator.onLine === true'), 5000, 'Chrome online recovery');
    const reconnectProbe = await cdp.evaluate(`(async () => {
      const response = await fetch('/Main/version.json?connectivity=reconnected-' + Date.now(), { cache: 'no-store' });
      const body = await response.json();
      return { online: navigator.onLine, status: response.status, hasVersion: typeof body.version === 'string' };
    })()`);
    assert.equal(reconnectProbe.online, true, 'Chrome did not report reconnection');
    assert.equal(reconnectProbe.status, 200, 'the fixture endpoint did not recover after reconnection');
    assert.equal(reconnectProbe.hasVersion, true, 'the recovered version response was malformed');
    await cdp.evaluate("window.AkraShell.open('app-w5', { force: true })");
    await waitFor(() => cdp.evaluate(`(() => {
      const frame = document.getElementById('shell-module-frame');
      const child = frame?.contentDocument;
      return !!child && !frame.hidden && new URL(frame.src).pathname === '/AKRA/'
        && !child.getElementById('app')?.classList.contains('hidden')
        && child.body.innerText.includes('สินค้าทดสอบแยกบัญชี W5');
    })()`), 20000, 'W5 offline mutation fixture ready');
    const w5WritesBeforeOffline = (await httpJson(fixturePort, '/__fixture/status')).body.w5AdjustmentWrites;
    await cdp.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
    let offlineMutationNetworkApplied = true;
    let offlineMutation;
    try {
      await waitFor(() => cdp.evaluate(`document.getElementById('shell-module-frame')?.contentWindow?.navigator.onLine === false`), 5000, 'W5 iframe offline transition');
      offlineMutation = await cdp.evaluate(`(async () => {
        const frame = document.getElementById('shell-module-frame');
        const child = frame.contentDocument;
        const manage = [...child.querySelectorAll('nav button')].find(button => button.textContent.trim() === 'จัดการ' && button.offsetParent !== null);
        manage?.click();
        const deadline = Date.now() + 5000;
        let row;
        let adjust;
        while (Date.now() < deadline) {
          row = [...child.querySelectorAll('li')].find(item => item.textContent.includes('สินค้าทดสอบแยกบัญชี W5'));
        adjust = [...child.querySelectorAll('button[title="ปรับสต็อก"]')].find(button => button.offsetParent !== null && button.closest('li')?.textContent.includes('สินค้าทดสอบแยกบัญชี W5'));
          if (row && adjust) break;
          await new Promise(resolve => setTimeout(resolve, 80));
        }
        if (!row || !adjust) return {
          ok: false,
          reason: 'W5 adjustment row missing',
          nav: [...child.querySelectorAll('nav button')].map(button => button.textContent.trim()),
          rows: child.querySelectorAll('li').length,
          body: child.body.innerText.slice(0, 700)
        };
        adjust.click();
        const editorDeadline = Date.now() + 5000;
        let input;
        let save;
        while (Date.now() < editorDeadline) {
          input = [...child.querySelectorAll('input[type="number"]')].find(element => element.value === '12' && element.offsetParent !== null);
          save = [...child.querySelectorAll('button')].find(button => button.textContent.trim() === 'บันทึก' && button.offsetParent !== null);
          if (input && save && !save.disabled) break;
          await new Promise(resolve => setTimeout(resolve, 60));
        }
        if (!input || !save) return {
          ok: false,
          reason: 'W5 adjustment editor missing',
          inputs: [...child.querySelectorAll('input[type="number"]')].map(element => ({ value: element.value, visible: !!element.offsetParent })),
          buttons: [...child.querySelectorAll('button')].filter(button => button.offsetParent !== null).map(button => button.textContent.trim()).slice(-12),
          body: child.body.innerText.slice(-500)
        };
        if (save.disabled) return { ok: false, reason: 'W5 adjustment editor save action remained disabled while offline' };
        input.value = '13';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise(resolve => setTimeout(resolve, 100));
        const saveEnabledBefore = !save.disabled;
        save.click();
        const failedDeadline = Date.now() + 8000;
        while (Date.now() < failedDeadline
          && !child.body.innerText.includes('ไม่มีการเชื่อมต่ออินเทอร์เน็ต')
          && !child.body.innerText.includes('ตรวจสอบผลการบันทึก')
          && !child.body.innerText.includes('เกิดข้อผิดพลาดในการเชื่อมต่อเซิร์ฟเวอร์')) {
          await new Promise(resolve => setTimeout(resolve, 80));
        }
        return {
          ok: child.body.innerText.includes('ไม่มีการเชื่อมต่ออินเทอร์เน็ต') || child.body.innerText.includes('ตรวจสอบผลการบันทึก') || child.body.innerText.includes('เกิดข้อผิดพลาดในการเชื่อมต่อเซิร์ฟเวอร์'),
          online: child.defaultView.navigator.onLine,
          notSentMessage: child.body.innerText.includes('ไม่มีการเชื่อมต่ออินเทอร์เน็ต'),
          uncertainResultMessage: child.body.innerText.includes('ตรวจสอบยอดปัจจุบันก่อนลองบันทึกซ้ำ'),
          alertText: child.body.innerText.includes('ไม่มีการเชื่อมต่ออินเทอร์เน็ต') || child.body.innerText.includes('ตรวจสอบผลการบันทึก') || child.body.innerText.includes('เกิดข้อผิดพลาดในการเชื่อมต่อเซิร์ฟเวอร์'),
          saveEnabledBefore,
          saveDisabledAfter: save.disabled,
          bodyTail: child.body.innerText.slice(-600),
          work: child.defaultView.AkraModule?.getWorkState?.() || null,
          rowText: row.textContent,
          draftValue: input.value,
          dialogVisible: !!input.offsetParent
        };
      })()`);
      assert.equal(offlineMutation.ok, true, `W5 did not show a failed-connection result while offline: ${JSON.stringify(offlineMutation)}`);
      assert.equal(offlineMutation.online, false, 'W5 iframe did not see the offline state');
      assert.equal(offlineMutation.alertText, true, 'W5 did not explain the offline adjustment failure');
      assert.match(offlineMutation.rowText, /12/, 'failed offline save changed the displayed stock');
      assert.equal(offlineMutation.draftValue, '13', 'failed offline save discarded the pending value');
      assert.equal(offlineMutation.dialogVisible, true, 'failed offline save closed the editor');
      await delay(300);
      assert.equal((await httpJson(fixturePort, '/__fixture/status')).body.w5AdjustmentWrites, w5WritesBeforeOffline, 'offline save reached the fixture mutation handler');
    } finally {
      if (offlineMutationNetworkApplied) {
        await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
        offlineMutationNetworkApplied = false;
      }
    }
    await waitFor(() => cdp.evaluate(`document.getElementById('shell-module-frame')?.contentWindow?.navigator.onLine === true`), 5000, 'W5 iframe online recovery');
    await delay(400);
    const w5AfterReconnect = await cdp.evaluate(`(() => {
      const child = document.getElementById('shell-module-frame')?.contentDocument;
      const input = [...(child?.querySelectorAll('input[type="number"]') || [])].find(element => element.value === '13');
      return {
        dialogVisible: !!input?.offsetParent,
        draftValue: input?.value || '',
        rowText: [...(child?.querySelectorAll('li') || [])].find(item => item.textContent.includes('สินค้าทดสอบแยกบัญชี W5'))?.textContent || '',
        connectionErrorVisible: child?.body?.innerText.includes('ไม่มีการเชื่อมต่ออินเทอร์เน็ต') || child?.body?.innerText.includes('ตรวจสอบผลการบันทึก') || child?.body?.innerText.includes('เกิดข้อผิดพลาดในการเชื่อมต่อเซิร์ฟเวอร์') || false
      };
    })()`);
    assert.equal(w5AfterReconnect.dialogVisible, true, 'reconnect discarded the failed offline edit');
    assert.equal(w5AfterReconnect.draftValue, '13', 'reconnect changed the retained offline value');
    assert.match(w5AfterReconnect.rowText, /12/, 'reconnect incorrectly showed the unsaved stock as committed');
    assert.equal((await httpJson(fixturePort, '/__fixture/status')).body.w5AdjustmentWrites, w5WritesBeforeOffline, 'reconnect replayed the failed offline mutation');
    await cdp.evaluate(`(() => {
      const child = document.getElementById('shell-module-frame').contentDocument;
      [...child.querySelectorAll('button')].find(button => button.textContent.trim() === 'ตกลง' && button.offsetParent !== null)?.click();
      [...child.querySelectorAll('button')].find(button => button.textContent.trim() === 'ยกเลิก' && button.offsetParent !== null)?.click();
      return true;
    })()`);
    const connectivityEvents = await cdp.evaluate('window.__akraConnectivityEvents.slice()');
    assert.ok(connectivityEvents.includes('offline'), 'Chrome did not dispatch the offline event');
    assert.ok(connectivityEvents.includes('online'), 'Chrome did not dispatch the online event');
    connectivity = { initiallyOnline, offline: offlineProbe, reconnect: reconnectProbe, mutation: { ...offlineMutation, afterReconnect: w5AfterReconnect, fixtureWrites: w5WritesBeforeOffline }, events: connectivityEvents };

    if (!readOnlyProfile) {
    const adminPermissionWorkflow = await cdp.evaluate(`(async () => {
      const admin = document.getElementById('admin-btn');
      if (!admin || admin.classList.contains('hidden')) return { ok: false, reason: 'Main admin control missing' };
      admin.click();
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        const list = document.getElementById('interactive-user-list');
        const user = [...(list?.querySelectorAll('button') || [])].find(button => button.textContent.includes('other'));
        if (user) {
          user.click();
          await new Promise(resolve => setTimeout(resolve, 120));
          const form = document.getElementById('interactive-form');
          if (!form || form.classList.contains('hidden')) return { ok: false, reason: 'Main user profile editor did not open' };
          const permission = [...document.querySelectorAll('#user-permissions-editor input[data-permission-key]')]
            .find(input => input.getAttribute('aria-label')?.includes('other') && input.getAttribute('aria-label')?.includes('recordStock'));
          const save = document.getElementById('save-user-permissions-btn');
          if (!permission || !save) return { ok: false, reason: 'Main individual permission editor controls missing' };
          if (!permission.checked) return { ok: false, reason: 'Main fixture direct permission was not loaded as granted' };
          permission.click();
          if (save.disabled) return { ok: false, reason: 'Main individual permission save did not become enabled' };
          save.click();
          return { ok: true, target: 'other', permission: 'app-w5:recordStock' };
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      return { ok: false, reason: 'Main admin data did not render the target user',
        sectionHidden: document.getElementById('admin-section')?.hidden,
        listText: document.getElementById('interactive-user-list')?.textContent?.slice(0, 500),
        userCount: document.getElementById('user-count')?.textContent,
        loadStatus: document.getElementById('authorization-load-status')?.textContent,
        profileStatus: document.getElementById('user-profile-status')?.textContent };
    })()`);
    assert.equal(adminPermissionWorkflow.ok, true, JSON.stringify(adminPermissionWorkflow));
    await waitFor(() => httpJson(fixturePort, '/__fixture/status').then(result => result.body.permissionWrites === 1), 20000, 'Main individual permission write');
    try {
      await waitFor(() => cdp.evaluate(`(() => {
        const permission = [...document.querySelectorAll('#user-permissions-editor input[data-permission-key]')]
          .find(input => input.getAttribute('aria-label')?.includes('other') && input.getAttribute('aria-label')?.includes('recordStock'));
        const save = document.getElementById('save-user-permissions-btn');
        return !!permission && permission.checked === false && !!save && save.disabled === true
          && document.getElementById('user-permissions-status')?.textContent.includes('บันทึกสิทธิ์เฉพาะบุคคลแล้ว');
      })()`), 20000, 'Main individual permission reload');
    } catch (error) {
      const permissionState = await cdp.evaluate(`(() => ({
        sectionHidden: document.getElementById('admin-section')?.hidden,
        editorHidden: document.getElementById('interactive-form')?.classList.contains('hidden'),
        editorId: document.getElementById('editor-id')?.value,
        inputs: [...document.querySelectorAll('#user-permissions-editor input[data-permission-key]')].map(input => ({ label: input.getAttribute('aria-label'), checked: input.checked, disabled: input.disabled })),
        saveDisabled: document.getElementById('save-user-permissions-btn')?.disabled,
        status: document.getElementById('user-permissions-status')?.textContent,
        loadStatus: document.getElementById('authorization-load-status')?.textContent
      }))()`);
      throw new Error(`Main individual permission reload timeout: ${JSON.stringify({ permissionState, cause: error.message })}`);
    }
    await cdp.evaluate("document.getElementById('back-to-dash-btn').click()");
    await waitFor(() => cdp.evaluate(`(() => {
      const section = document.getElementById('dashboard-section');
      return !!section && !section.hidden;
    })()`), 20000, 'Main dashboard after permission workflow');
    }

    let refreshFailure = null;
    if (!readOnlyProfile) {
      await cdp.evaluate("window.AkraShell.open('app-w5', { force: true })");
      try {
        await waitFor(() => cdp.evaluate(`(() => {
          const frame = document.getElementById('shell-module-frame');
          return !!frame && !frame.hidden && new URL(frame.src).pathname === '/AKRA/';
        })()`), 20000, 'shell refresh-failure seed module');
      } catch (error) {
        const shellState = await cdp.evaluate(`(() => ({
          hash: location.hash,
          dashboardHidden: document.getElementById('dashboard-section')?.hidden,
          shellHidden: document.getElementById('unified-shell')?.hidden,
          frame: document.getElementById('shell-module-frame') && { hidden: document.getElementById('shell-module-frame').hidden, src: document.getElementById('shell-module-frame').src },
          status: document.getElementById('shell-status')?.textContent,
          retryHidden: document.getElementById('shell-retry')?.hidden,
          token: !!localStorage.getItem('akra_session_token'),
          user: (() => { try { return JSON.parse(localStorage.getItem('akra_user_data') || '{}'); } catch (_) { return null; } })(),
          appConfig: (() => { try { return JSON.parse(localStorage.getItem('akra_app_config') || '[]').map(app => ({ id: app.id, roles: app.roles, url: app.url })); } catch (_) { return null; } })(),
          appButtons: [...document.querySelectorAll('#app-grid button')].map(button => button.textContent.trim()).slice(0, 12)
        }))()`);
        throw new Error(`shell refresh-failure seed module timeout: ${JSON.stringify({ shellState, cause: error.message })}`);
      }
      assert.equal((await httpForm(fixturePort, '/__fixture/main-refresh', 'mode=fail')).status, 303);
      await cdp.send('Page.reload', { ignoreCache: true });
      await waitFor(() => cdp.evaluate(`(() => document.readyState === 'complete'
        && !!document.getElementById('login-form')
        && !document.getElementById('login-section')?.classList.contains('hidden'))()`), 20000, 'Main refresh failure login page');
      refreshFailure = await cdp.evaluate(`(() => ({
        loginVisible: !document.getElementById('login-section')?.classList.contains('hidden'),
        dashboardVisible: !document.getElementById('dashboard-section')?.classList.contains('hidden'),
        shellVisible: !document.getElementById('unified-shell')?.hidden,
        frameCount: document.querySelectorAll('#shell-frame-host iframe').length,
        storedToken: !!localStorage.getItem('akra_session_token')
      }))()`);
      assert.deepEqual(refreshFailure, { loginVisible: true, dashboardVisible: false, shellVisible: false, frameCount: 0, storedToken: true }, 'failed refresh exposed cached shell/private page');
      assert.equal((await httpForm(fixturePort, '/__fixture/main-refresh', 'mode=normal')).status, 303);
      await cdp.send('Page.reload', { ignoreCache: true });
      await waitFor(() => cdp.evaluate(`(() => {
        const section = document.getElementById('dashboard-section');
        return !!section && !section.classList.contains('hidden') && document.querySelectorAll('#app-grid button').length === 10;
      })()`), 20000, 'Main refresh recovery dashboard');
    }

    await cdp.evaluate("window.AkraShell.open('app-w5', { force: true })");
    await waitFor(() => cdp.evaluate(`(() => {
      const frame = document.getElementById('shell-module-frame');
      return !!frame && !frame.hidden && new URL(frame.src).pathname === '/AKRA/';
    })()`), 20000, 'shell history seed module');
    const backState = await cdp.evaluate(`(async () => {
      window.history.back();
      await new Promise(resolve => setTimeout(resolve, 180));
      const frame = document.getElementById('shell-module-frame');
      return {
        hash: window.location.hash,
        shellHidden: document.getElementById('unified-shell')?.hidden,
        framePath: frame ? new URL(frame.src).pathname : null
      };
    })()`);
    assert.equal(backState.hash, '#/', 'browser Back did not restore the Main route');
    assert.equal(backState.shellHidden, true, 'browser Back left the unified shell visible');
    assert.equal(backState.framePath, null, 'browser Back retained the child iframe');
    await cdp.evaluate('window.history.forward()');
    try {
      await waitFor(() => cdp.evaluate(`(() => {
        const frame = document.getElementById('shell-module-frame');
        return !!frame && !frame.hidden && new URL(frame.src).pathname === '/AKRA/';
      })()`), 20000, 'shell history forward module');
    } catch (error) {
      const snapshot = await cdp.evaluate(`(() => {
        const frame = document.getElementById('shell-module-frame');
        return {
          hash: window.location.hash,
          shellHidden: document.getElementById('unified-shell')?.hidden,
          frame: frame && { hidden: frame.hidden, src: frame.src },
          status: document.getElementById('shell-status')?.innerText,
          retryHidden: document.getElementById('shell-retry')?.hidden,
          dashboardHidden: document.getElementById('dashboard-section')?.hidden
        };
      })()`);
      throw new Error(`shell history forward timeout: ${JSON.stringify({ snapshot, cause: error.message })}`);
    }

    const guardState = await cdp.evaluate(`(async () => {
      const frame = document.getElementById('shell-module-frame');
      const child = frame.contentWindow;
      window.confirm = () => false;
      child.AkraModule.markDirty();
      await new Promise(resolve => setTimeout(resolve, 80));
      const before = { hash: window.location.hash, path: new URL(frame.src).pathname };
      const opened = window.AkraShell.open('app-trd');
      const after = {
        hash: window.location.hash,
        path: document.getElementById('shell-module-frame') ? new URL(document.getElementById('shell-module-frame').src).pathname : null,
        tabCount: document.querySelectorAll('#shell-frame-host iframe').length
      };
      child.AkraModule.markSaved();
      window.confirm = () => true;
      await new Promise(resolve => setTimeout(resolve, 80));
      return { opened, before, after };
    })()`);
    assert.equal(guardState.opened, false, 'dirty child allowed an unconfirmed shell switch');
    assert.deepEqual(guardState.after, { hash: guardState.before.hash, path: guardState.before.path, tabCount: 1 }, 'dirty cancellation did not preserve the active child');

    if (readOnlyProfile) {
      await cdp.evaluate("window.AkraShell.open('app-pick', { force: true })");
      try {
        await waitFor(() => cdp.evaluate(`(() => {
          const frame = document.getElementById('shell-module-frame');
          const child = frame?.contentDocument;
          return !!child && !child.getElementById('app-shell')?.classList.contains('hidden')
            && child.getElementById('data-loading')?.classList.contains('hidden')
            && child.getElementById('tab-new')?.disabled === true
            && child.getElementById('pane-new')?.classList.contains('hidden')
            && !child.getElementById('pane-history')?.classList.contains('hidden')
            && child.getElementById('submit-btn')?.disabled === true;
        })()`), 20000, 'Picking read-only permission state');
      } catch (error) {
        const fixtureStatus = (await httpJson(fixturePort, '/__fixture/status')).body;
        const snapshot = await cdp.evaluate(`(() => {
          const frame = document.getElementById('shell-module-frame');
          const child = frame?.contentDocument;
          const win = frame?.contentWindow;
          return {
            framePath: frame && new URL(frame.src).pathname,
            appShell: child?.getElementById('app-shell')?.className,
            loading: child?.getElementById('data-loading')?.className,
            tabNew: child?.getElementById('tab-new') && { disabled: child.getElementById('tab-new').disabled, className: child.getElementById('tab-new').className },
            paneNew: child?.getElementById('pane-new')?.className,
            paneHistory: child?.getElementById('pane-history')?.className,
            submit: child?.getElementById('submit-btn') && { disabled: child.getElementById('submit-btn').disabled, className: child.getElementById('submit-btn').className },
            formStatus: child?.getElementById('form-status')?.innerText,
            bodyText: child?.body?.innerText?.slice(0, 900),
            moduleApi: typeof win?.AkraSupabasePicking
          };
        })()`);
        throw new Error(`Picking read-only timeout: ${JSON.stringify({ fixtureStatus, snapshot, cause: error.message })}`);
      }
      const pickingState = await cdp.evaluate(`(() => {
        const child = document.getElementById('shell-module-frame').contentDocument;
        return {
          createTabDisabled: child.getElementById('tab-new')?.disabled,
          createPaneHidden: child.getElementById('pane-new')?.classList.contains('hidden'),
          historyVisible: !child.getElementById('pane-history')?.classList.contains('hidden'),
          submitDisabled: child.getElementById('submit-btn')?.disabled
        };
      })()`);

      await cdp.evaluate("window.AkraShell.open('app-kpi', { force: true })");
      await waitFor(() => cdp.evaluate(`(() => {
        const frame = document.getElementById('shell-module-frame');
        const child = frame?.contentDocument;
        return !!child && child.body.classList.contains('kpi-session-ready')
          && typeof frame.contentWindow?.selectBranch === 'function';
      })()`), 20000, 'KPI read-only authenticated session');
      await cdp.evaluate(`document.getElementById('shell-module-frame').contentWindow.selectBranch('AKRA')`);
      await waitFor(() => cdp.evaluate(`(() => {
        const frame = document.getElementById('shell-module-frame');
        const child = frame?.contentDocument;
        const win = frame?.contentWindow;
        return !!child && !child.getElementById('app-content')?.classList.contains('hidden')
          && typeof win.canRecordOwnWorkload === 'function'
          && win.canRecordOwnWorkload() === false
          && child.getElementById('btn-save-workload')?.disabled === true;
      })()`), 20000, 'KPI read-only permission state');
      const kpiState = await cdp.evaluate(`(() => {
        const frame = document.getElementById('shell-module-frame');
        const child = frame.contentDocument;
        const win = frame.contentWindow;
        return {
          canRecord: win.canRecordOwnWorkload(),
          saveDisabled: child.getElementById('btn-save-workload')?.disabled,
          clearDisabled: child.getElementById('btn-clear-workload')?.disabled
        };
      })()`);
      const fixtureStatus = (await httpJson(fixturePort, '/__fixture/status')).body;
      assert.equal(fixtureStatus.pickingBills, 0, 'read-only Picking produced a write');
      assert.equal(fixtureStatus.kpiWorkloadAttempts, 0, 'read-only KPI reached a mutation boundary');
      assert.equal(browserContentPages((await httpJson(debugPort, '/json')).body).length, 1, 'read-only profile content tab count');
      console.log(JSON.stringify({ status: 'pass', profile: 'read-only', tabCount: 1, pwaAssets, picking: pickingState, kpi: kpiState, fixtureStatus }));
      return;
    }

    const records = [];
    for (const [id, expectedPath] of MODULES) {
      await cdp.evaluate(`window.AkraShell.open(${JSON.stringify(id)})`);
      const loaded = await waitFor(() => cdp.evaluate(`(() => {
        const frame = document.getElementById('shell-module-frame');
        const body = frame?.contentDocument?.body;
        return !!frame && !frame.hidden && !!body && body.innerText.trim().length > 0;
      })()`), 20000, `${id} desktop module`);
      assert.equal(loaded, true);
      const details = await cdp.evaluate(`(() => {
        const frame = document.getElementById('shell-module-frame');
        const child = frame.contentDocument;
        return {
          path: new URL(frame.src).pathname,
          text: child.body.innerText.trim().slice(0, 240),
          shellOverflow: document.documentElement.scrollWidth > window.innerWidth,
          childOverflow: child.documentElement.scrollWidth > child.documentElement.clientWidth + 1
        };
      })()`);
      assert.equal(details.path, expectedPath, `${id} desktop path`);
      assert.equal(details.shellOverflow, false, `${id} desktop shell overflow`);
      assert.equal(details.childOverflow, false, `${id} desktop child overflow`);
      records.push({ id, viewport: 'desktop', path: details.path, text: details.text });
      const desktopPages = browserContentPages((await httpJson(debugPort, '/json')).body);
      assert.equal(desktopPages.length, 1, `${id} desktop tab count: ${JSON.stringify(desktopPages.map(target => ({ title: target.title, url: target.url })))}`);
      if (id === 'app-manual') {
        const sopFilesBefore = new Set(fs.readdirSync(downloadDirectory));
        const sopWorkflow = await cdp.evaluate(`(async () => {
          const frame = document.getElementById('shell-module-frame');
          const child = frame.contentDocument;
          const openGuide = child.querySelector('[data-select-guide]');
          if (!openGuide) return { ok: false, reason: 'SOP guide selector missing' };
          openGuide.click();
          const deadline = Date.now() + 5000;
          while (Date.now() < deadline) {
            const modal = child.querySelector('[data-modal]');
            const image = child.querySelector('[data-modal-preview] img');
            const download = child.querySelector('[data-modal-download]');
            if (modal && !modal.hidden && image && download?.getAttribute('href')) {
              const zoom = child.querySelector('[data-modal-zoom]');
              if (zoom && !zoom.hidden) zoom.click();
              const result = {
                ok: true,
                modalVisible: !modal.hidden,
                images: child.querySelectorAll('[data-modal-preview] img').length,
                assets: child.querySelectorAll('[data-modal-assets] [data-preview-asset]').length,
                downloadHref: download.getAttribute('href'),
                zoomed: modal.classList.contains('modal--zoomed')
              };
              download.click();
              return result;
            }
            await new Promise(resolve => setTimeout(resolve, 100));
          }
          return {
            ok: false,
            reason: 'SOP reader did not load fixture asset',
            modal: child.querySelector('[data-modal]')?.className,
            body: child.body.innerText.slice(0, 500)
          };
        })()`);
        assert.equal(sopWorkflow.ok, true, sopWorkflow.reason || 'SOP workflow failed');
        assert.equal(sopWorkflow.modalVisible, true, 'SOP reader modal was not visible');
        assert.ok(sopWorkflow.images > 0, 'SOP reader did not render an image');
        assert.ok(sopWorkflow.assets >= 2, 'SOP reader did not render all fixture assets');
        assert.match(sopWorkflow.downloadHref, /__fixture\/sop-file\.svg/);
        assert.equal(sopWorkflow.zoomed, true, 'SOP reader zoom did not activate');
        await waitFor(() => cdp.evaluate(`(() => document.getElementById('shell-module-frame')?.contentDocument?.querySelector('[data-modal-message]')?.textContent.includes('ดาวน์โหลดพร้อมแล้ว'))()`), 10000, 'SOP download completion notice');
        const sopFiles = await waitFor(() => {
          const files = fs.readdirSync(downloadDirectory).filter(name => !name.endsWith('.crdownload') && !sopFilesBefore.has(name));
          return files.length ? files : false;
        }, 10000, 'SOP browser download');
        const sopFilePath = path.join(downloadDirectory, sopFiles[0]);
        const sopFileBody = fs.readFileSync(sopFilePath, 'utf8');
        assert.ok(sopFileBody.includes('SOP FIXTURE'), 'SOP download was not the expected fixture page');
        await cdp.evaluate("document.getElementById('shell-module-frame')?.contentDocument?.querySelector('[data-close-modal]')?.click()");
        fileWorkflows = { sopDownload: { fileName: sopFiles[0], bytes: fs.statSync(sopFilePath).size } };
        const sopMutationWorkflow = await cdp.evaluate(`(async () => {
          const frame = document.getElementById('shell-module-frame');
          const child = frame.contentDocument;
          const adminOpen = child.querySelector('[data-admin-open]');
          if (!adminOpen || adminOpen.hidden) return { ok: false, reason: 'SOP admin control missing' };
          adminOpen.click();
          const consoleDeadline = Date.now() + 5000;
          while (Date.now() < consoleDeadline) {
            if (!child.querySelector('[data-admin-console]')?.hidden && child.querySelector('[data-admin-list]')?.textContent.includes('คู่มือทดสอบการแยกบัญชี')) break;
            await new Promise(resolve => setTimeout(resolve, 100));
          }
          const pagesButton = child.querySelector('[data-admin-pages="sop-fixture"]');
          if (!pagesButton) return { ok: false, reason: 'SOP page-management action missing' };
          pagesButton.click();
          const editorDeadline = Date.now() + 5000;
          while (Date.now() < editorDeadline && !child.querySelector('[data-page-editor]')?.open) await new Promise(resolve => setTimeout(resolve, 100));
          const input = child.querySelector('[data-page-name="0"]');
          const save = child.querySelector('[data-page-save]');
          if (!input || !save) return { ok: false, reason: 'SOP page editor controls missing' };
          input.value = input.value + ' ปรับปรุง';
          input.dispatchEvent(new Event('input', { bubbles: true }));
          save.click();
          return { ok: true };
        })()`);
        assert.equal(sopMutationWorkflow.ok, true, sopMutationWorkflow.reason || 'SOP page-management mutation workflow failed');
        await waitFor(() => httpJson(fixturePort, '/__fixture/status').then(result => result.body.sopMutationWrites === 1), 20000, 'SOP page-management write');
        await waitFor(() => cdp.evaluate(`(() => {
          const state = document.getElementById('shell-module-frame')?.contentWindow?.AkraModule?.getWorkState?.();
          return !!state && state.dirty === false && state.busy === false;
        })()`), 20000, 'SOP mutation clean state');
      }
      if (id === 'app-trd') {
        const trdMutationWorkflow = await cdp.evaluate(`(async () => {
          const frame = document.getElementById('shell-module-frame');
          const child = frame.contentDocument;
          const surveyButton = [...child.querySelectorAll('button')]
            .find(button => button.textContent.includes('สำรวจสต็อก') && button.offsetParent !== null);
          if (!surveyButton) return { ok: false, reason: 'TRD stock survey action missing' };
          surveyButton.click();
          const zoneDeadline = Date.now() + 5000;
          let zone = null;
          while (Date.now() < zoneDeadline) {
            zone = [...child.querySelectorAll('button')]
              .find(button => button.textContent.includes('โซน A') && button.offsetParent !== null);
            if (zone) break;
            await new Promise(resolve => setTimeout(resolve, 100));
          }
          if (!zone) return { ok: false, reason: 'TRD stock survey zone missing', body: child.body.innerText.slice(0, 800) };
          zone.click();
          const productDeadline = Date.now() + 5000;
          let productHeader = null;
          while (Date.now() < productDeadline) {
            const product = [...child.querySelectorAll('#check-stock-list h4')]
              .find(element => element.textContent.includes('สินค้า TRD ทดสอบแยกบัญชี'));
            productHeader = product?.closest('[onclick]') || null;
            if (productHeader) break;
            await new Promise(resolve => setTimeout(resolve, 100));
          }
          if (!productHeader) return { ok: false, reason: 'TRD stock survey product missing' };
          productHeader.click();
          await new Promise(resolve => setTimeout(resolve, 80));
          const input = child.querySelector('#check-stock-list input[type="number"]');
          const submit = [...child.querySelectorAll('button')]
            .find(button => button.textContent.includes('ส่งใบรายงานตรวจเช็ค') && button.offsetParent !== null);
          if (!input || !submit) return { ok: false, reason: 'TRD stock survey form controls missing' };
          input.value = '1';
          input.dispatchEvent(new Event('input', { bubbles: true }));
          child.alert = () => {};
          submit.click();
          return { ok: true, zone: 'A', product: 'สินค้า TRD ทดสอบแยกบัญชี' };
        })()`);
        assert.equal(trdMutationWorkflow.ok, true, trdMutationWorkflow.reason || 'TRD stock survey mutation workflow failed');
        await waitFor(() => httpJson(fixturePort, '/__fixture/status').then(result => result.body.trdMutationWrites === 1 && result.body.trdSurveyWrites === 1), 20000, 'TRD stock survey writes');
        await waitFor(() => cdp.evaluate(`(() => {
          const child = document.getElementById('shell-module-frame')?.contentWindow;
          const state = child?.AkraModule?.getWorkState?.();
          return !!state && state.dirty === false && state.busy === false;
        })()`), 20000, 'TRD stock survey clean state');
        const trdWorkflow = await cdp.evaluate(`(async () => {
          const frame = document.getElementById('shell-module-frame');
          const child = frame.contentDocument;
          const analyticsNav = [...document.querySelectorAll('button')]
            .find(button => button.textContent.includes('Analytics') && button.offsetParent !== null);
          if (!analyticsNav) return { ok: false, reason: 'visible Main shell TRD Analytics navigation missing' };
          analyticsNav.click();
          const deadline = Date.now() + 5000;
          while (Date.now() < deadline) {
            const report = child.querySelector('.trd-report');
            if (report && report.textContent.includes('Analytics')) {
              return {
                ok: true,
                reportVisible: report.offsetParent !== null,
                hasCalendarView: report.textContent.includes('ปฏิทิน'),
                hasProductDetails: report.textContent.includes('สินค้าเชิงลึก')
              };
            }
            await new Promise(resolve => setTimeout(resolve, 100));
          }
          return { ok: false, reason: 'TRD Analytics view did not render', body: child.body.innerText.slice(0, 500) };
        })()`);
        assert.equal(trdWorkflow.ok, true, trdWorkflow.reason || 'TRD workflow failed');
        assert.equal(trdWorkflow.reportVisible, true, 'TRD Analytics view was not visible');
        assert.equal(trdWorkflow.hasCalendarView, true, 'TRD Analytics calendar view did not render');
        assert.equal(trdWorkflow.hasProductDetails, true, 'TRD Analytics product-details view did not render');
      }
      if (id === 'app-damage') {
        const returnitemWorkflow = await cdp.evaluate(`(async () => {
          const frame = document.getElementById('shell-module-frame');
          const child = frame.contentDocument;
          const dashboard = child.querySelector('[data-tab="DASHBOARD"]');
          const addReturn = child.querySelector('[data-tab="ADD_RET"]');
          const returnsView = child.querySelector('[data-dashview="returns"]');
          if (!dashboard || !addReturn || !returnsView) return { ok: false, reason: 'Returnitem workflow controls missing' };
          dashboard.click();
          returnsView.click();
          await new Promise(resolve => setTimeout(resolve, 120));
          const list = child.getElementById('dash-list-returns');
          const hasFixtureReturn = list?.textContent.includes('สินค้ารับคืนทดสอบแยกบัญชี');
          addReturn.click();
          await new Promise(resolve => setTimeout(resolve, 100));
          const search = child.getElementById('ret_search');
          const source = child.getElementById('ret_source');
          const quantity = child.getElementById('ret_qty');
          const form = child.getElementById('retForm');
          if (!search || !source || !quantity || !form) return { ok: false, reason: 'Returnitem intake form fields missing' };
          search.value = 'สินค้ารับคืนทดสอบแยกบัญชี';
          search.dispatchEvent(new Event('input', { bubbles: true }));
          let option = null;
          const searchDeadline = Date.now() + 5000;
          while (Date.now() < searchDeadline) {
            option = child.querySelector('#ret_list .combo-option');
            if (option) break;
            await new Promise(resolve => setTimeout(resolve, 100));
          }
          if (!option) return { ok: false, reason: 'Returnitem product search result missing' };
          option.click();
          source.value = 'ออนไลน์ (Shopee)';
          source.dispatchEvent(new Event('change', { bubbles: true }));
          quantity.value = '1';
          quantity.dispatchEvent(new Event('input', { bubbles: true }));
          form.requestSubmit();
          return {
            ok: true,
            returnsViewActive: child.getElementById('dash-view-returns')?.classList.contains('active'),
            hasFixtureReturn,
            intakeFormVisible: child.getElementById('tab-ADD_RET')?.classList.contains('active')
              && !child.getElementById('retForm')?.hidden,
            selectedSku: child.getElementById('ret_sku')?.value,
            submittedQty: quantity.value
          };
        })()`);
        assert.equal(returnitemWorkflow.ok, true, returnitemWorkflow.reason || 'Returnitem workflow failed');
        assert.equal(returnitemWorkflow.returnsViewActive, true, 'Returnitem returns history view did not activate');
        assert.equal(returnitemWorkflow.hasFixtureReturn, true, 'Returnitem fixture return did not render in history');
        assert.equal(returnitemWorkflow.intakeFormVisible, true, 'Returnitem intake form did not activate');
        assert.equal(returnitemWorkflow.selectedSku, 'FIX-001', 'Returnitem product search did not populate SKU');
        assert.equal(returnitemWorkflow.submittedQty, '1', 'Returnitem intake quantity was not submitted');
        await waitFor(() => httpJson(fixturePort, '/__fixture/status').then(result => result.body.returnitemWrites === 1), 20000, 'Returnitem intake workflow write');
        await waitFor(() => cdp.evaluate(`(() => {
          const frame = document.getElementById('shell-module-frame');
          const state = frame?.contentWindow?.AkraModule?.getWorkState?.();
          return !!state && state.dirty === false && state.busy === false;
        })()`), 20000, 'Returnitem shell mutation completion');
        const returnitemShellState = await cdp.evaluate(`(() => {
          const frame = document.getElementById('shell-module-frame');
          return frame?.contentWindow?.AkraModule?.getWorkState?.() || null;
        })()`);
        assert.deepEqual(returnitemShellState, { dirty: false, busy: false }, 'Returnitem save did not clear shell pending state');
      }
      if (id === 'app-evaluation') {
        const evaluationWorkflow = await cdp.evaluate(`(async () => {
          const frame = document.getElementById('shell-module-frame');
          const child = frame.contentDocument;
          const win = frame.contentWindow;
          const openEditor = child.getElementById('btnOpenEditor');
          const employeeInput = child.getElementById('editEmpName');
          if (!openEditor || !employeeInput || child.getElementById('evaluation-access')?.hidden !== true) {
            return { ok: false, reason: 'Evaluation editor or access state missing' };
          }
          openEditor.click();
          employeeInput.value = 'พนักงานประเมินใน Shell';
          employeeInput.dispatchEvent(new Event('input', { bubbles: true }));
          await new Promise(resolve => setTimeout(resolve, 320));
          const storageKey = win.EvaluationSession.key('AKRA_EVAL_CURRENT_STATE');
          const saved = JSON.parse(child.defaultView.localStorage.getItem(storageKey) || '{}');
          let printed = 0;
          const previousPrint = child.defaultView.print;
          child.defaultView.print = () => { printed += 1; };
          child.getElementById('btnPrint').click();
          win.exportJSONTemplate();
          child.defaultView.print = previousPrint;
          return {
            ok: true,
            editorVisible: !child.getElementById('editorSidebar')?.classList.contains('collapsed'),
            previewName: child.getElementById('viewEmpName')?.textContent.includes('พนักงานประเมินใน Shell'),
            autosavedName: saved.empName === 'พนักงานประเมินใน Shell',
            printed
          };
        })()`);
        assert.equal(evaluationWorkflow.ok, true, evaluationWorkflow.reason || 'Evaluation workflow failed');
        assert.equal(evaluationWorkflow.editorVisible, true, 'Evaluation editor did not open');
        assert.equal(evaluationWorkflow.previewName, true, 'Evaluation preview did not sync employee name');
        assert.equal(evaluationWorkflow.autosavedName, true, 'Evaluation local autosave did not persist employee name');
        assert.equal(evaluationWorkflow.printed, 1, 'Evaluation print action did not call window.print');
        const evaluationFiles = await waitFor(() => {
          const files = fs.readdirSync(downloadDirectory).filter(name => /^Evaluation_Form_.*\.json$/i.test(name) && !name.endsWith('.crdownload'));
          return files.length ? files : false;
        }, 10000, 'Evaluation JSON browser download');
        const evaluationFilePath = path.join(downloadDirectory, evaluationFiles[0]);
        const exportedEvaluation = JSON.parse(fs.readFileSync(evaluationFilePath, 'utf8'));
        assert.equal(exportedEvaluation.empName, 'พนักงานประเมินใน Shell', 'Evaluation export did not contain the current saved form');
        const importedName = 'ทดสอบนำเข้า JSON ใน Chrome';
        const importFixturePath = path.join(downloadDirectory, 'evaluation-import-check.json');
        fs.writeFileSync(importFixturePath, JSON.stringify({ ...exportedEvaluation, empName: importedName }));
        await cdp.send('DOM.enable');
        const importInput = await cdp.send('Runtime.evaluate', {
          expression: "document.getElementById('shell-module-frame').contentWindow.document.getElementById('btnImportJSON')",
          returnByValue: false
        });
        assert.ok(importInput.result?.objectId, 'Evaluation JSON file input was not available');
        const importInputNode = await cdp.send('DOM.describeNode', { objectId: importInput.result.objectId });
        await cdp.send('DOM.setFileInputFiles', { files: [importFixturePath], backendNodeId: importInputNode.node.backendNodeId });
        const selectedImport = await cdp.evaluate(`(() => {
          const input = document.getElementById('shell-module-frame').contentWindow.document.getElementById('btnImportJSON');
          input.dispatchEvent(new Event('change', { bubbles: true }));
          return { count: input.files.length, name: input.files[0]?.name || '' };
        })()`);
        assert.equal(selectedImport.count, 1, 'Evaluation JSON file was not selected through the browser file input');
        await waitFor(() => cdp.evaluate(`(() => {
          const child = document.getElementById('shell-module-frame').contentDocument;
          return child.getElementById('viewEmpName')?.textContent === ${JSON.stringify(importedName)};
        })()`), 10000, 'Evaluation JSON import');
        const printedPdf = await cdp.send('Page.printToPDF', { printBackground: true, preferCSSPageSize: true, transferMode: 'ReturnAsBase64' });
        const pdfBytes = Buffer.from(printedPdf.data || '', 'base64');
        assert.ok(pdfBytes.subarray(0, 5).equals(Buffer.from('%PDF-')), 'Chrome print renderer did not produce a PDF');
        assert.ok(pdfBytes.length > 5000, `Chrome print PDF unexpectedly small: ${pdfBytes.length} bytes`);
        assert.match(pdfBytes.toString('latin1'), /\/Type\s*\/Page\b/, 'Chrome print PDF contains no page object');
        fileWorkflows = {
          ...fileWorkflows,
          evaluationJsonDownload: { fileName: evaluationFiles[0], bytes: fs.statSync(evaluationFilePath).size, empName: exportedEvaluation.empName },
          evaluationJsonImport: { inputName: selectedImport.name, importedName },
          evaluationPrintPdf: { bytes: pdfBytes.length, pageObjects: (pdfBytes.toString('latin1').match(/\/Type\s*\/Page\b/g) || []).length }
        };
      }
    }

    await cdp.evaluate("window.AkraShell.open('app-pr', { force: true })");
    await waitFor(() => cdp.evaluate(`(() => {
      const frame = document.getElementById('shell-module-frame');
      const child = frame?.contentDocument;
      const win = frame?.contentWindow;
      return !!child && !child.getElementById('app-content')?.classList.contains('hidden')
        && !!win?.appSession?.id && win.AkraPR?.can(win.appSession, 'createPR') === true
        && Array.isArray(win.appData?.products) && win.appData.products.length > 0;
    })()`), 20000, 'PR authenticated data-ready form');
    const prWorkflow = await cdp.evaluate(`(async () => {
      const frame = document.getElementById('shell-module-frame');
      const child = frame.contentDocument;
      const productInput = child.querySelector('.p-product-input');
      productInput.value = 'สินค้า';
      productInput.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(resolve => setTimeout(resolve, 80));
      const option = [...child.querySelectorAll('.suggestion-box li')].find(node => node.textContent.includes('สินค้าจำลอง PR'));
      if (!option) return { ok: false, reason: 'PR product suggestion missing after data-ready state' };
      option.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      const quantity = child.querySelector('.p-qty-input');
      quantity.value = '2';
      quantity.dispatchEvent(new Event('input', { bubbles: true }));
      const warehouse = child.getElementById('pr-warehouse');
      if (!warehouse.value) warehouse.value = [...warehouse.options].find(option => option.value)?.value || '';
      child.getElementById('btn-submit-pr').click();
      return { ok: true };
    })()`);
    assert.equal(prWorkflow.ok, true, prWorkflow.reason || 'PR workflow did not start');
    try {
      await waitFor(() => httpJson(fixturePort, '/__fixture/status').then(result => result.body.prWrites > 0), 20000, 'PR workflow write');
    } catch (error) {
      const fixtureStatus = (await httpJson(fixturePort, '/__fixture/status')).body;
      const snapshot = await cdp.evaluate(`(() => {
        const frame = document.getElementById('shell-module-frame');
        const child = frame.contentDocument;
        const win = frame.contentWindow;
        return {
          appSession: win.appSession && { id: win.appSession.id, identityId: win.appSession.identityId },
          canCreate: win.AkraPR?.can(win.appSession, 'createPR'),
          productCount: win.appData?.products?.length,
          product: child.querySelector('.p-product-input')?.value,
          sku: child.querySelector('.p-sku-input')?.value,
          quantity: child.querySelector('.p-qty-input')?.value,
          warehouse: child.getElementById('pr-warehouse')?.value,
          buttonDisabled: child.getElementById('btn-submit-pr')?.disabled,
          loader: child.getElementById('data-loader')?.className,
          toast: child.getElementById('toast-container')?.innerText,
          bodyText: child.body.innerText.slice(0, 800)
        };
      })()`);
      throw new Error(`PR workflow write timeout: ${JSON.stringify({ fixtureStatus, snapshot, cause: error.message })}`);
    }
    await waitFor(() => cdp.evaluate(`(() => {
      const state = document.getElementById('shell-module-frame')?.contentWindow?.AkraModule?.getWorkState?.();
      return !!state && state.dirty === false && state.busy === false;
    })()`), 20000, 'PR mutation clean state');

    await cdp.evaluate("window.AkraShell.open('app-tracking', { force: true })");
    await waitFor(() => cdp.evaluate(`(() => {
      const frame = document.getElementById('shell-module-frame');
      const child = frame?.contentDocument;
      const win = frame?.contentWindow;
      return !!child && !child.getElementById('app-content')?.classList.contains('hidden')
        && Array.isArray(win?.appData?.prList)
        && win.appData.prList.some(pr => pr.prNumber === 'PR-FIXTURE-0001')
        && !!child.querySelector('#pr-container .btn-success');
    })()`), 20000, 'PO PR approval data-ready form');
    const poWorkflow = await cdp.evaluate(`(async () => {
      const frame = document.getElementById('shell-module-frame');
      const child = frame.contentDocument;
      const win = frame.contentWindow;
      const approve = child.querySelector('#pr-container .btn-success');
      if (!approve) return { ok: false, reason: 'PO approval action missing' };
      approve.click();
      await new Promise(resolve => setTimeout(resolve, 80));
      const form = child.getElementById('form-create-po');
      const warehouse = child.getElementById('create-po-warehouse');
      const product = child.querySelector('#create-po-items-container .c-product');
      const quantity = child.querySelector('#create-po-items-container .c-qty');
      if (!form || child.getElementById('modal-create-po')?.classList.contains('hidden')) return { ok: false, reason: 'PO approval form did not open' };
      child.getElementById('create-po-vendor').value = 'Vendor Fixture';
      warehouse.value = 'W5';
      if (product) product.value = 'สินค้า workflow ข้ามแอป';
      if (quantity) quantity.value = '2';
      form.requestSubmit();
      return { ok: true, appPath: new URL(frame.src).pathname, canApprove: win.AkraPR?.can(win.appSession, 'approvePR') };
    })()`);
    assert.equal(poWorkflow.ok, true, poWorkflow.reason || 'PO workflow did not start');
    await waitFor(() => httpJson(fixturePort, '/__fixture/status').then(result => result.body.poWrites > 0), 20000, 'PO workflow write');
    await waitFor(() => cdp.evaluate(`(() => {
      const state = document.getElementById('shell-module-frame')?.contentWindow?.AkraModule?.getWorkState?.();
      return !!state && state.dirty === false && state.busy === false;
    })()`), 20000, 'PO mutation clean state');
    await cdp.evaluate(`document.getElementById('shell-module-frame').contentWindow.loadInitialData(true)`);
    await waitFor(() => cdp.evaluate(`(() => {
      const frame = document.getElementById('shell-module-frame');
      const win = frame?.contentWindow;
      return Array.isArray(win?.appData?.pendingPOs) && win.appData.pendingPOs.some(item => item.poNumber === 'PO-FIXTURE-0001');
    })()`), 20000, 'PO created bill reload');

    await cdp.evaluate("window.AkraShell.open('app-gr', { force: true })");
    await waitFor(() => cdp.evaluate(`(() => {
      const frame = document.getElementById('shell-module-frame');
      const child = frame?.contentDocument;
      return !!child && !child.getElementById('app-content')?.classList.contains('hidden')
        && child.getElementById('po-list-container')?.innerText.includes('PO-FIXTURE-0001');
    })()`), 20000, 'GR pending PO data-ready list');
    const grReview = await cdp.evaluate(`(async () => {
      const frame = document.getElementById('shell-module-frame');
      const child = frame.contentDocument;
      const win = frame.contentWindow;
      win.openReceivingDetail(0);
      await new Promise(resolve => setTimeout(resolve, 80));
      const ata = child.getElementById('r-ata');
      const receiver = child.getElementById('r-receiver');
      const qty = child.querySelector('.po-item-row .po-qty');
      const floor = child.querySelector('.po-item-row .po-loc-floor');
      if (!ata || !receiver || !qty || !floor) return { ok: false, reason: 'GR receiving form did not open' };
      ata.value = '2026-09-19';
      receiver.value = 'ผู้รับทดสอบ';
      qty.value = '2';
      const expiry = child.querySelector('.po-item-row .po-exp');
      const oldStock = child.querySelector('.po-item-row .po-old-stock');
      if (expiry) expiry.value = '31/12/2026';
      if (oldStock) oldStock.value = '0';
      floor.value = [...floor.options].find(option => option.value)?.value || '';
      child.getElementById('btn-review').click();
      return { ok: true, path: new URL(frame.src).pathname };
    })()`);
    assert.equal(grReview.ok, true, grReview.reason || 'GR review workflow did not start');
    await waitFor(() => httpJson(fixturePort, '/__fixture/status').then(result => result.body.grReviewWrites > 0), 20000, 'GR review workflow write');
    await waitFor(() => cdp.evaluate(`(() => {
      const state = document.getElementById('shell-module-frame')?.contentWindow?.AkraModule?.getWorkState?.();
      return !!state && state.dirty === false && state.busy === false;
    })()`), 20000, 'GR review mutation clean state');
    await cdp.evaluate(`document.getElementById('shell-module-frame').contentWindow.openReceiving(true)`);
    await waitFor(() => cdp.evaluate(`(() => document.getElementById('shell-module-frame')?.contentDocument?.getElementById('po-list-container')?.innerText.includes('PO-FIXTURE-0001'))()`), 20000, 'GR review reload');
    const grComplete = await cdp.evaluate(`(async () => {
      const frame = document.getElementById('shell-module-frame');
      const child = frame.contentDocument;
      const win = frame.contentWindow;
      const group = win.groupedPOs?.find(item => item.poNumber === 'PO-FIXTURE-0001');
      if (!group) return { ok: false, reason: 'GR pending-review group missing' };
      win.openReceivingDetail(group.index);
      await new Promise(resolve => setTimeout(resolve, 80));
      const button = child.getElementById('btn-confirm-receive');
      if (!button || button.classList.contains('hidden')) return { ok: false, reason: 'GR completion action missing' };
      button.click();
      return { ok: true };
    })()`);
    assert.equal(grComplete.ok, true, grComplete.reason || 'GR completion workflow did not start');
    await waitFor(() => httpJson(fixturePort, '/__fixture/status').then(result => result.body.grCompletedWrites > 0), 20000, 'GR completed workflow write');
    await waitFor(() => cdp.evaluate(`(() => {
      const state = document.getElementById('shell-module-frame')?.contentWindow?.AkraModule?.getWorkState?.();
      return !!state && state.dirty === false && state.busy === false;
    })()`), 20000, 'GR completion clean state');

    await cdp.evaluate("window.AkraShell.open('app-w5', { force: true })");
    try {
      await waitFor(() => cdp.evaluate(`(() => {
        const frame = document.getElementById('shell-module-frame');
        const child = frame?.contentDocument;
        return !!child && !child.getElementById('app')?.classList.contains('hidden')
          && child.body.innerText.includes('สินค้าจำลอง PR');
      })()`), 20000, 'W5 workflow stock read');
    } catch (error) {
      const fixtureStatus = (await httpJson(fixturePort, '/__fixture/status')).body;
      const snapshot = await cdp.evaluate(`(() => {
        const frame = document.getElementById('shell-module-frame');
        const child = frame?.contentDocument;
        const win = frame?.contentWindow;
        return { framePath: frame && new URL(frame.src).pathname, bodyClass: child?.body?.className, appClass: child?.getElementById('app')?.className, body: child?.body?.innerText?.slice(0, 1200), data: win?.appData || win?.state || null };
      })()`);
      throw new Error(`W5 workflow stock timeout: ${JSON.stringify({ fixtureStatus, snapshot, cause: error.message })}`);
    }
    const workflowStatus = (await httpJson(fixturePort, '/__fixture/status')).body;
    assert.equal(workflowStatus.workflowStock, 2, 'W5 did not receive the completed GR quantity');
    const w5Workflow = await cdp.evaluate(`(async () => {
      const frame = document.getElementById('shell-module-frame');
      const child = frame.contentDocument;
      const manageTab = [...child.querySelectorAll('nav button')]
        .find(button => button.textContent.trim() === 'จัดการ');
      if (!manageTab) return { ok: false, reason: 'W5 manage tab missing for ADMIN profile' };
      manageTab.click();
      await new Promise(resolve => setTimeout(resolve, 120));
      const productRow = [...child.querySelectorAll('li')]
        .find(row => row.textContent.includes('สินค้าทดสอบแยกบัญชี W5'));
      const adjustButton = [...child.querySelectorAll('button[title="ปรับสต็อก"]')]
        .find(button => button.closest('li')?.textContent.includes('สินค้าทดสอบแยกบัญชี W5'));
      if (!adjustButton) return {
        ok: false,
        reason: 'W5 stock adjustment action missing; rows=' + child.querySelectorAll('li').length
          + '; titles=' + [...child.querySelectorAll('button[title]')].map(button => button.getAttribute('title')).join('|')
          + '; body=' + child.body.innerText.slice(0, 900)
          + '; row=' + (productRow?.outerHTML || 'missing')
      };
      adjustButton.click();
      await new Promise(resolve => setTimeout(resolve, 80));
      const input = [...child.querySelectorAll('input[type="number"]')]
        .find(element => element.value === '12');
      const save = [...child.querySelectorAll('button')]
        .find(button => button.textContent.trim() === 'บันทึก' && button.offsetParent !== null);
      if (!input || !save) return { ok: false, reason: 'W5 stock adjustment modal did not open' };
      input.value = '14';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      save.click();
      await new Promise(resolve => setTimeout(resolve, 120));
      return {
        ok: true,
        manageVisible: [...child.querySelectorAll('section')].some(section => section.textContent.includes('จัดการรายการสินค้าคลัง') && section.offsetParent !== null),
        updatedRow: productRow.textContent.includes('14')
      };
    })()`);
    assert.equal(w5Workflow.ok, true, w5Workflow.reason || 'W5 adjustment workflow did not start');
    assert.equal(w5Workflow.manageVisible, true, 'W5 manage view was not visible');
    await waitFor(() => httpJson(fixturePort, '/__fixture/status').then(result => result.body.w5AdjustmentWrites === 1), 20000, 'W5 stock adjustment write');
    const adjustedW5Status = (await httpJson(fixturePort, '/__fixture/status')).body;
    assert.equal(adjustedW5Status.w5AdjustedStock, 14, 'W5 adjustment did not reach the fixture boundary');
    assert.equal(w5Workflow.updatedRow, true, 'W5 adjusted stock did not render in the active UI');
    await waitFor(() => cdp.evaluate(`(() => {
      const state = document.getElementById('shell-module-frame')?.contentWindow?.AkraModule?.getWorkState?.();
      return !!state && state.dirty === false && state.busy === false;
    })()`), 20000, 'W5 mutation clean state');

    const holdW5Reply = await httpForm(fixturePort, '/__fixture/w5-adjustment-control', 'mode=hold-after-commit');
    assert.equal(holdW5Reply.status, 200, 'W5 lost-reply fixture could not be armed');
    let uncertainNetworkApplied = false;
    try {
      const uncertainAttempt = await cdp.evaluate(`(async () => {
        const child = document.getElementById('shell-module-frame')?.contentDocument;
        const adjust = [...(child?.querySelectorAll('button[title="ปรับสต็อก"]') || [])]
          .find(button => button.offsetParent !== null && button.closest('li')?.textContent.includes('สินค้าทดสอบแยกบัญชี W5'));
        if (!child || !adjust) return { ok: false, reason: 'W5 adjustment action missing for lost-reply fixture' };
        adjust.click();
        const deadline = Date.now() + 5000;
        let input;
        let save;
        while (Date.now() < deadline) {
          input = [...child.querySelectorAll('input[type="number"]')].find(element => element.value === '14' && element.offsetParent !== null);
          save = [...child.querySelectorAll('button')].find(button => button.textContent.trim() === 'บันทึก' && button.offsetParent !== null);
          if (input && save && !save.disabled) break;
          await new Promise(resolve => setTimeout(resolve, 60));
        }
        if (!input || !save || save.disabled) return { ok: false, reason: 'W5 adjustment editor was not ready for the lost-reply fixture', saveDisabled: save?.disabled ?? null };
        input.value = '15';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise(resolve => setTimeout(resolve, 100));
        save.click();
        return { ok: true, draftValue: input.value, saveDisabled: save.disabled };
      })()`);
      assert.equal(uncertainAttempt.ok, true, uncertainAttempt.reason || 'W5 lost-reply mutation did not start');
      try {
        await waitFor(() => httpJson(fixturePort, '/__fixture/status').then(result =>
          result.body.w5AdjustmentWrites === 2 && result.body.w5AdjustedStock === 15 && result.body.w5AdjustmentPending === 1
        ), 10000, 'W5 server commit before reply loss');
      } catch (error) {
        const fixtureState = (await httpJson(fixturePort, '/__fixture/status')).body;
        const browserState = await cdp.evaluate(`(() => {
          const child = document.getElementById('shell-module-frame')?.contentDocument;
          const input = [...(child?.querySelectorAll('input[type="number"]') || [])].find(element => element.offsetParent !== null);
          return { body: child?.body?.innerText?.slice(-600) || '', input: input?.value || '', visible: !!input?.offsetParent };
        })()`);
        throw new Error(`W5 server commit before reply loss timeout: ${JSON.stringify({ fixtureState, browserState, uncertainAttempt, cause: error.message })}`);
      }
      const releaseW5Reply = await httpForm(fixturePort, '/__fixture/w5-adjustment-control', 'mode=normal');
      assert.equal(releaseW5Reply.status, 200, 'W5 held response could not be released');
      try {
        await waitFor(() => cdp.evaluate(`document.getElementById('shell-module-frame')?.contentDocument?.body?.innerText.includes('ตรวจสอบผลการบันทึก')`), 10000, 'W5 lost-reply uncertainty notice');
      } catch (error) {
        const fixtureState = (await httpJson(fixturePort, '/__fixture/status')).body;
        const browserState = await cdp.evaluate(`(() => {
          const child = document.getElementById('shell-module-frame')?.contentDocument;
          const input = [...(child?.querySelectorAll('input[type="number"]') || [])].find(element => element.offsetParent !== null);
          return { online: child?.defaultView?.navigator.onLine, body: child?.body?.innerText?.slice(-800) || '', input: input?.value || '', saveDisabled: [...(child?.querySelectorAll('button') || [])].find(button => button.textContent.trim() === 'บันทึก' && button.offsetParent !== null)?.disabled ?? null };
        })()`);
        throw new Error(`W5 lost-reply uncertainty notice timeout: ${JSON.stringify({ fixtureState, browserState, cause: error.message })}`);
      }
      uncertainW5Outcome = await cdp.evaluate(`(() => {
        const child = document.getElementById('shell-module-frame')?.contentDocument;
        const input = [...(child?.querySelectorAll('input[type="number"]') || [])].find(element => element.value === '15' && element.offsetParent !== null);
        const row = [...(child?.querySelectorAll('li') || [])].find(item => item.textContent.includes('สินค้าทดสอบแยกบัญชี W5'));
        return { body: child?.body?.innerText || '', draftValue: input?.value || '', dialogVisible: !!input?.offsetParent, rowText: row?.textContent || '' };
      })()`);
      assert.equal(uncertainW5Outcome.dialogVisible, true, 'lost-reply result discarded the W5 draft');
      assert.equal(uncertainW5Outcome.draftValue, '15', 'lost-reply result changed the W5 draft');
      assert.match(uncertainW5Outcome.rowText, /14/, 'W5 UI claimed the uncertain result was saved before a read-back');
      assert.match(uncertainW5Outcome.body, /ตรวจสอบยอดปัจจุบันก่อนลองบันทึกซ้ำ/, 'W5 did not tell the user to verify the current value before retrying an uncertain save');
      await cdp.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
      uncertainNetworkApplied = true;
      await waitFor(() => cdp.evaluate(`document.getElementById('shell-module-frame')?.contentWindow?.navigator.onLine === false`), 5000, 'W5 post-failure offline transition');
      await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
      uncertainNetworkApplied = false;
      await waitFor(() => cdp.evaluate(`document.getElementById('shell-module-frame')?.contentWindow?.navigator.onLine === true`), 5000, 'W5 post-failure reconnect');
    } finally {
      await httpForm(fixturePort, '/__fixture/w5-adjustment-control', 'mode=normal');
      if (uncertainNetworkApplied) {
        await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
      }
    }
    await waitFor(() => cdp.evaluate(`document.getElementById('shell-module-frame')?.contentWindow?.navigator.onLine === true`), 5000, 'W5 lost-reply reconnect');
    await delay(300);
    const committedW5Outcome = (await httpJson(fixturePort, '/__fixture/status')).body;
    assert.equal(committedW5Outcome.w5AdjustedStock, 15, 'W5 server did not retain the committed value after reply loss');
    assert.equal(committedW5Outcome.w5AdjustmentWrites, 2, 'W5 retried the uncertain mutation automatically');
    assert.equal(committedW5Outcome.w5AdjustmentPending, 0, 'W5 lost-reply fixture left a response held');
    const w5ReadsBeforeReconcile = committedW5Outcome.w5Reads;
    const reconcileStarted = await cdp.evaluate(`(() => {
      const child = document.getElementById('shell-module-frame')?.contentDocument;
      if (!child) return false;
      [...child.querySelectorAll('button')].find(button => button.textContent.trim() === 'ตกลง' && button.offsetParent !== null)?.click();
      [...child.querySelectorAll('button')].find(button => button.textContent.trim() === 'ยกเลิก' && button.offsetParent !== null)?.click();
      const dashboard = [...child.querySelectorAll('nav button')].find(button => button.textContent.includes('แดชบอร์ด') && button.offsetParent !== null);
      dashboard?.click();
      return !!dashboard;
    })()`);
    assert.equal(reconcileStarted, true, 'W5 current stock could not be checked after the uncertain result');
    await waitFor(async () => {
      const status = await httpJson(fixturePort, '/__fixture/status');
      const state = await cdp.evaluate(`(() => {
        const child = document.getElementById('shell-module-frame')?.contentDocument;
        const row = [...(child?.querySelectorAll('li') || [])].find(item => item.textContent.includes('สินค้าทดสอบแยกบัญชี W5'));
        return { rowText: row?.textContent || '' };
      })()`);
      return status.body.w5Reads > w5ReadsBeforeReconcile && /15/.test(state.rowText) ? state : false;
    }, 10000, 'W5 uncertain result server read-back visible in UI');
    const reconciledW5 = await cdp.evaluate(`(() => {
      const child = document.getElementById('shell-module-frame')?.contentDocument;
      const row = [...(child?.querySelectorAll('li') || [])].find(item => item.textContent.includes('สินค้าทดสอบแยกบัญชี W5'));
      return { rowText: row?.textContent || '', work: child?.defaultView?.AkraModule?.getWorkState?.() || null };
    })()`);
    assert.match(reconciledW5.rowText, /15/, `W5 read-back did not show the committed server value: ${JSON.stringify(reconciledW5)}`);
    assert.equal((await httpJson(fixturePort, '/__fixture/status')).body.w5AdjustmentWrites, 2, 'W5 read-back caused a duplicate mutation');

    assert.equal(browserContentPages((await httpJson(debugPort, '/json')).body).length, 1, 'purchasing workflow opened another tab');

    await cdp.evaluate("window.AkraShell.open('app-pick', { force: true })");
    await waitFor(() => cdp.evaluate(`(() => {
      const frame = document.getElementById('shell-module-frame');
      const child = frame?.contentDocument;
      return !!child && !child.getElementById('app-shell')?.classList.contains('hidden')
        && child.getElementById('data-loading')?.classList.contains('hidden')
        && child.getElementById('form-status')?.textContent === 'พร้อมทำรายการ'
        && child.getElementById('staff-select')?.options.length > 1
        && child.getElementById('submit-btn')?.disabled === false;
    })()`), 20000, 'Picking authenticated data-ready form');
    const pickingWorkflow = await cdp.evaluate(`(async () => {
      const frame = document.getElementById('shell-module-frame');
      const child = frame.contentDocument;
      const productInput = child.querySelector('#item-rows .row-name');
      productInput.value = 'สินค้า';
      productInput.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(resolve => setTimeout(resolve, 80));
      const option = [...child.querySelectorAll('.autocomplete-option')].find(node => node.textContent.includes('สินค้าจำลอง Picking'));
      if (!option) return { ok: false, reason: 'Picking product suggestion missing after data-ready state' };
      option.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      option.click();
      const quantity = child.querySelector('#item-rows .row-qty');
      quantity.value = '2';
      quantity.dispatchEvent(new Event('input', { bubbles: true }));
      const staff = child.getElementById('staff-select');
      staff.value = '10000000-0000-4000-8000-000000000001';
      staff.dispatchEvent(new Event('change', { bubbles: true }));
      const submit = child.getElementById('submit-btn');
      if (!submit || submit.disabled) return { ok: false, reason: 'Picking submit button remained disabled' };
      submit.click();
      return { ok: true };
    })()`);
    assert.equal(pickingWorkflow.ok, true, pickingWorkflow.reason || 'Picking workflow did not start');
    try {
      await waitFor(() => httpJson(fixturePort, '/__fixture/status').then(result => result.body.pickingBills > 0), 20000, 'Picking workflow write');
    } catch (error) {
      const fixtureStatus = (await httpJson(fixturePort, '/__fixture/status')).body;
      const snapshot = await cdp.evaluate(`(() => {
        const frame = document.getElementById('shell-module-frame');
        const child = frame.contentDocument;
        const win = frame.contentWindow;
        return {
          session: win.state?.session && { id: win.state.session.id, identityId: win.state.session.identityId },
          canCreate: win.pickingClient?.can('createRequisition'),
          products: win.state?.products?.length,
          staff: win.state?.staff?.length,
          product: child.querySelector('#item-rows .row-name')?.value,
          quantity: child.querySelector('#item-rows .row-qty')?.value,
          assignee: child.getElementById('staff-select')?.value,
          buttonDisabled: child.getElementById('submit-btn')?.disabled,
          formStatus: child.getElementById('form-status')?.innerText,
          toast: child.getElementById('toast-container')?.innerText
        };
      })()`);
      throw new Error(`Picking workflow write timeout: ${JSON.stringify({ fixtureStatus, snapshot, cause: error.message })}`);
    }
    await waitFor(() => cdp.evaluate(`(() => {
      const state = document.getElementById('shell-module-frame')?.contentWindow?.AkraModule?.getWorkState?.();
      return !!state && state.dirty === false && state.busy === false;
    })()`), 20000, 'Picking mutation clean state');

    await cdp.evaluate("window.AkraShell.open('app-kpi', { force: true })");
    await waitFor(() => cdp.evaluate(`(() => {
      const frame = document.getElementById('shell-module-frame');
      const child = frame?.contentDocument;
      return !!child && child.body.classList.contains('kpi-session-ready')
        && typeof frame.contentWindow?.selectBranch === 'function';
    })()`), 20000, 'KPI authenticated branch selector');
    await cdp.evaluate(`document.getElementById('shell-module-frame').contentWindow.selectBranch('AKRA')`);
    try {
      await waitFor(() => cdp.evaluate(`(() => {
        const frame = document.getElementById('shell-module-frame');
        const child = frame?.contentDocument;
        const win = frame?.contentWindow;
        return !!child && document.body.contains(frame)
          && child.body.classList.contains('kpi-session-ready')
          && !child.getElementById('app-content')?.classList.contains('hidden')
          && !!win?.getKpiSessionToken?.()
          && child.getElementById('header-branch-name')?.textContent === 'AKRA'
          && typeof win.canRecordOwnWorkload === 'function'
          && win.canRecordOwnWorkload() === true
          && Array.isArray(win.getAkraWorkloadValues?.())
          && win.getAkraWorkloadValues().length > 0;
      })()`), 20000, 'KPI authenticated workload-ready form');
    } catch (error) {
      const fixtureStatus = (await httpJson(fixturePort, '/__fixture/status')).body;
      const snapshot = await cdp.evaluate(`(() => {
        const frame = document.getElementById('shell-module-frame');
        const child = frame?.contentDocument;
        const win = frame?.contentWindow;
        return {
          framePath: frame && new URL(frame.src).pathname,
          bodyClass: child?.body?.className,
          sessionReady: child?.getElementById('kpi-session-status')?.hidden,
          sessionMessage: child?.getElementById('kpi-session-message')?.innerText,
          appHidden: child?.getElementById('app-content')?.className,
          headerBranch: child?.getElementById('header-branch-name')?.innerText,
          token: !!win?.getKpiSessionToken?.(),
          owner: win?.getKpiSessionOwner?.()?.user && { id: win.getKpiSessionOwner().user.id, username: win.getKpiSessionOwner().user.username },
          canRecordType: typeof win?.canRecordOwnWorkload,
          canRecord: typeof win?.canRecordOwnWorkload === 'function' ? win.canRecordOwnWorkload() : null,
          workloadType: typeof win?.getAkraWorkloadValues,
          workload: typeof win?.getAkraWorkloadValues === 'function' ? win.getAkraWorkloadValues() : null,
          bodyText: child?.body?.innerText?.slice(0, 1000)
        };
      })()`);
      throw new Error(`KPI workload-ready timeout: ${JSON.stringify({ fixtureStatus, snapshot, cause: error.message })}`);
    }
    const kpiWorkflow = await cdp.evaluate(`(async () => {
      const frame = document.getElementById('shell-module-frame');
      const win = frame.contentWindow;
      const date = win.getTodayBangkokDateStr();
      const workload = win.getAkraWorkloadValues();
      await win.executeSaveWorkload(workload, date);
      return { date, employeeUid: workload[0]?.employeeUid, capacity: workload[0]?.capacity };
    })()`);
    assert.equal(typeof kpiWorkflow.date, 'string');
    assert.equal(kpiWorkflow.employeeUid, 'fixture-user');
    assert.equal(kpiWorkflow.capacity, 10);
    await waitFor(() => httpJson(fixturePort, '/__fixture/status').then(result => result.body.kpiWorkloadWrites > 0), 20000, 'KPI workload workflow write');
    await waitFor(() => cdp.evaluate(`(() => {
      const state = document.getElementById('shell-module-frame')?.contentWindow?.AkraModule?.getWorkState?.();
      return !!state && state.dirty === false && state.busy === false;
    })()`), 20000, 'KPI mutation clean state');

    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
    for (const [id, expectedPath] of MODULES) {
      await cdp.evaluate(`window.AkraShell.open(${JSON.stringify(id)})`);
      const loaded = await waitFor(() => cdp.evaluate(`(() => {
        const frame = document.getElementById('shell-module-frame');
        return !!frame && !frame.hidden && !!frame.contentDocument?.body && frame.contentDocument.body.innerText.trim().length > 0;
      })()`), 20000, `${id} mobile module`);
      assert.equal(loaded, true);
      const details = await cdp.evaluate(`(() => {
        const frame = document.getElementById('shell-module-frame');
        const child = frame.contentDocument;
        return {
          width: window.innerWidth,
          path: new URL(frame.src).pathname,
          shellOverflow: document.documentElement.scrollWidth > window.innerWidth,
          childOverflow: child.documentElement.scrollWidth > child.documentElement.clientWidth + 1
        };
      })()`);
      assert.equal(details.width, 390);
      assert.equal(details.path, expectedPath, `${id} mobile path`);
      assert.equal(details.shellOverflow, false, `${id} mobile shell overflow`);
      assert.equal(details.childOverflow, false, `${id} mobile child overflow`);
      records.push({ id, viewport: 'mobile-390', path: details.path });
      assert.equal(browserContentPages((await httpJson(debugPort, '/json')).body).length, 1, `${id} mobile tab count`);
    }
    let updateRecovery = null;
    if (!readOnlyProfile) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
      await cdp.evaluate("window.AkraShell.open('app-w5', { force: true })");
      await waitFor(() => cdp.evaluate('(() => { const frame = document.getElementById("shell-module-frame"); return !!frame && !frame.hidden && new URL(frame.src).pathname === "/AKRA/"; })()'), 20000, 'version update seed module');
      const initialVersion = await cdp.evaluate('CURRENT_VERSION');
      const originalHash = await cdp.evaluate('window.location.hash');
      assert.equal(initialVersion, CANDIDATE_VERSION, 'candidate version changed unexpectedly');
      const cleanState = await cdp.evaluate('window.AkraShell.getWorkState()');
      assert.deepEqual(cleanState, { dirty: false, busy: false, unknown: false }, 'version update did not start from a clean child state');

      const setMainVersion = async version => cdp.evaluate(
        '(async () => { const response = await fetch("/__fixture/version-control", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ repo: "Main", version: '
          + JSON.stringify(version)
          + ' }) }); return { status: response.status, body: await response.json() }; })()'
      );
      const waitForLoadedVersion = async (version, label) => waitFor(async () => {
        try {
          return await cdp.evaluate(
            '(() => { const frame = document.getElementById("shell-module-frame"); const route = frame ? new URL(frame.src).pathname : null; const targetVersion = '
              + JSON.stringify(version)
              + '; const targetHash = '
              + JSON.stringify(originalHash)
              + '; const ready = document.readyState === "complete" && CURRENT_VERSION === targetVersion && window.location.hash === targetHash && !!frame && !frame.hidden && route === "/AKRA/" && !document.getElementById("avg-banner"); return ready ? { version: CURRENT_VERSION, hash: window.location.hash, route, sessionToken: !!localStorage.getItem("akra_session_token") } : null; })()'
          );
        } catch (_) { return null; }
      }, 20000, label);

      const manageOpened = await cdp.evaluate('(() => { const child = document.getElementById("shell-module-frame")?.contentDocument; const button = child && [...child.querySelectorAll("nav button")].find(node => node.textContent.trim() === "จัดการ" && node.offsetParent !== null); if (!button) return false; button.click(); return true; })()');
      assert.equal(manageOpened, true, 'W5 management view was unavailable for the update draft');
      const findW5AdjustmentButton = '(() => { const child = document.getElementById("shell-module-frame")?.contentDocument; return !!child && [...child.querySelectorAll("button")].some(button => button.title === "ปรับสต็อก" && button.closest("li")?.textContent.includes("สินค้าทดสอบแยกบัญชี W5") && button.offsetParent !== null); })()';
      await waitFor(() => cdp.evaluate(findW5AdjustmentButton), 10000, 'W5 update draft row');
      const adjustmentOpened = await cdp.evaluate('(() => { const child = document.getElementById("shell-module-frame")?.contentDocument; const button = child && [...child.querySelectorAll("button")].find(node => node.title === "ปรับสต็อก" && node.closest("li")?.textContent.includes("สินค้าทดสอบแยกบัญชี W5") && node.offsetParent !== null); if (!button) return false; button.click(); return true; })()');
      assert.equal(adjustmentOpened, true, 'W5 stock draft form did not open');
      await waitFor(() => cdp.evaluate('(() => { const child = document.getElementById("shell-module-frame")?.contentDocument; return !!child && [...child.querySelectorAll("input[type=number]")].some(input => input.offsetParent !== null && input.value === "15"); })()'), 5000, 'W5 update draft form');
      await cdp.evaluate('document.getElementById("shell-module-frame").contentWindow.AkraModule.markSaved()');
      await waitFor(() => cdp.evaluate('JSON.stringify(window.AkraShell.getWorkState()) === JSON.stringify({dirty:false,busy:false,unknown:false})'), 5000, 'clean W5 draft baseline');
      const dirtyDraft = await cdp.evaluate('(() => { const frame = document.getElementById("shell-module-frame"); const child = frame?.contentDocument; const input = child && [...child.querySelectorAll("input[type=number]")].find(node => node.offsetParent !== null); if (!input) return null; input.focus(); input.value = "16"; input.dispatchEvent(new Event("input", { bubbles: true })); return { value: input.value, visible: input.offsetParent !== null, reportedDirty: window.AkraShell.getWorkState().dirty }; })()');
      assert.deepEqual(dirtyDraft, { value: '16', visible: true, reportedDirty: true }, 'real W5 form input was not reported as dirty to the Main update guard');
      const [versionDate, versionSequence] = CANDIDATE_VERSION.split('.');
      const firstVersion = versionDate + '.' + String(Number(versionSequence) + 1).padStart(2, '0');
      const firstOverride = await setMainVersion(firstVersion);
      assert.equal(firstOverride.status, 200);
      assert.equal(firstOverride.body.version, firstVersion);
      assert.equal(await cdp.evaluate('AppVersionGuard.check()'), false, 'new version did not mark the page stale');
      await waitFor(() => cdp.evaluate('!!document.getElementById("avg-banner")'), 5000, 'first update notice');
      const originalUrl = await cdp.evaluate('window.location.href');
      await cdp.evaluate('window.confirm = () => false; document.querySelector("#avg-banner button").click()');
      await delay(150);
      const cancelledUpdate = await cdp.evaluate('(() => { const frame = document.getElementById("shell-module-frame"); const child = frame?.contentDocument; const input = child && [...child.querySelectorAll("input[type=number]")].find(node => node.offsetParent !== null); return { href: window.location.href, work: window.AkraShell.getWorkState(), bannerVisible: !!document.getElementById("avg-banner"), draftValue: input?.value || null }; })()');
      assert.equal(cancelledUpdate.href, originalUrl, 'cancelling a dirty update navigated away');
      assert.equal(cancelledUpdate.work.dirty, true, 'cancelling a dirty update discarded the child draft');
      assert.equal(cancelledUpdate.bannerVisible, true, 'cancelling a dirty update hid the update notice');
      assert.equal(cancelledUpdate.draftValue, dirtyDraft.value, 'cancelling a dirty update changed the visible W5 value');

      const adjustmentCancelled = await cdp.evaluate('(() => { const child = document.getElementById("shell-module-frame")?.contentDocument; const button = child && [...child.querySelectorAll("button")].find(node => node.textContent.trim() === "ยกเลิก" && node.offsetParent !== null); if (!button) return false; button.click(); return true; })()');
      assert.equal(adjustmentCancelled, true, 'W5 update draft could not be explicitly discarded');
      await waitFor(() => cdp.evaluate('(() => { const child = document.getElementById("shell-module-frame")?.contentDocument; return !child || ![...child.querySelectorAll("input[type=number]")].some(input => input.offsetParent !== null); })()'), 5000, 'W5 update draft dismissal');
      await cdp.evaluate('document.getElementById("shell-module-frame").contentWindow.AkraModule.markSaved(); window.confirm = () => true');
      assert.deepEqual(await cdp.evaluate('window.AkraShell.getWorkState()'), { dirty: false, busy: false, unknown: false }, 'version update was not clean after saving the fixture draft');
      await cdp.evaluate('document.querySelector("#avg-banner button").click()');
      const firstReload = await waitForLoadedVersion(firstVersion, 'first version reload');
      assert.equal(firstReload.hash, originalHash, 'first update changed the active route');
      assert.equal(firstReload.route, '/AKRA/');
      assert.equal(firstReload.sessionToken, true, 'first update lost the current session token');

      const recoveryVersion = versionDate + '.' + String(Number(versionSequence) + 2).padStart(2, '0');
      const recoveryOverride = await setMainVersion(recoveryVersion);
      assert.equal(recoveryOverride.status, 200);
      assert.equal(recoveryOverride.body.version, recoveryVersion);
      assert.equal(await cdp.evaluate('AppVersionGuard.check()'), false, 'recovery version did not mark the page stale');
      await waitFor(() => cdp.evaluate('!!document.getElementById("avg-banner")'), 5000, 'recovery update notice');
      await cdp.evaluate('document.querySelector("#avg-banner button").click()');
      const recoveryReload = await waitForLoadedVersion(recoveryVersion, 'recovery version reload');
      assert.equal(recoveryReload.hash, originalHash, 'recovery update changed the active route');
      assert.equal(recoveryReload.route, '/AKRA/');
      assert.equal(recoveryReload.sessionToken, true, 'recovery update lost the current session token');
      updateRecovery = {
        initialVersion,
        transitions: [firstReload.version, recoveryReload.version],
        cancelledDirtyDraftRetained: cancelledUpdate.work.dirty && cancelledUpdate.draftValue === dirtyDraft.value,
        dirtyDraftValue: cancelledUpdate.draftValue,
        routePreserved: recoveryReload.hash === originalHash,
        sessionRetained: recoveryReload.sessionToken
      };
    }

    const fixtureStatus = (await httpJson(fixturePort, '/__fixture/status')).body;
    const requiredReads = {
      w5Reads: fixtureStatus.w5Reads,
      trdReads: fixtureStatus.trdReads,
      trdMutationWrites: fixtureStatus.trdMutationWrites,
      trdSurveyWrites: fixtureStatus.trdSurveyWrites,
      purchasingReads: fixtureStatus.purchasingReads,
      returnitemReads: fixtureStatus.returnitemReads,
      kpiReads: fixtureStatus.kpiReads,
      pickReads: fixtureStatus.pickReads,
      prReads: fixtureStatus.prReads,
      sopReads: fixtureStatus.sopReads
    };
    for (const [name, count] of Object.entries(requiredReads)) {
      assert.ok(count > 0, `${name} did not observe a real module API read`);
    }
    assert.ok(requiredReads.purchasingReads >= 2, 'PO and GR did not both reach their purchasing APIs');
    const writes = {
      prWrites: fixtureStatus.prWrites,
      pickingBills: fixtureStatus.pickingBills,
      kpiWorkloadWrites: fixtureStatus.kpiWorkloadWrites,
      w5AdjustmentWrites: fixtureStatus.w5AdjustmentWrites,
      returnitemWrites: fixtureStatus.returnitemWrites
    };
    assert.ok(writes.prWrites > 0, 'PR UI workflow did not produce a fixture write');
    assert.ok(writes.pickingBills > 0, 'Picking UI workflow did not produce a fixture write');
    assert.ok(writes.kpiWorkloadWrites > 0, 'KPI workload workflow did not produce a fixture write');
    assert.equal(writes.w5AdjustmentWrites, 2, 'W5 UI workflows did not produce one successful write and one uncertain committed write');
    assert.equal(writes.returnitemWrites, 1, 'Returnitem UI workflow did not produce an intake write');
    assert.equal(fixtureStatus.sopMutationWrites, 1, 'SOP page-management UI workflow did not produce a fixture write');
    assert.equal(fixtureStatus.trdMutationWrites, 1, 'TRD stock survey did not produce an inventory mutation write');
    assert.equal(fixtureStatus.trdSurveyWrites, 1, 'TRD stock survey did not produce a survey log write');
    const purchasingWorkflow = { poWrites: fixtureStatus.poWrites, grReviewWrites: fixtureStatus.grReviewWrites, grCompletedWrites: fixtureStatus.grCompletedWrites, workflowStock: fixtureStatus.workflowStock };
    assert.equal(purchasingWorkflow.poWrites, 1, 'PO UI workflow did not produce a fixture write');
    assert.equal(purchasingWorkflow.grReviewWrites, 1, 'GR review UI workflow did not produce a fixture write');
    assert.equal(purchasingWorkflow.grCompletedWrites, 1, 'GR completion UI workflow did not produce a fixture write');
    assert.equal(purchasingWorkflow.workflowStock, 2, 'completed GR did not reach the W5 fixture stock');
    console.log(JSON.stringify({ status: 'pass', modules: MODULES.length, records: records.length, tabCount: 1, viewports: ['desktop-1280', 'mobile-390'], pwaAssets, connectivity, uncertainW5Outcome: uncertainW5Outcome && { draftValue: uncertainW5Outcome.draftValue, dialogVisible: uncertainW5Outcome.dialogVisible, rowText: uncertainW5Outcome.rowText }, fileWorkflows, updateRecovery, requiredReads, writes, purchasingWorkflow, refreshFailure }));
  } finally {
    cdp?.close();
    terminateProcessTree(chrome);
    terminateProcessTree(fixture);
    try {
      if (profile) {
        const cleanupTarget = fs.realpathSync.native(profile);
        const tempRoot = fs.realpathSync.native(os.tmpdir());
        if (cleanupTarget.startsWith(tempRoot + path.sep) && path.basename(cleanupTarget).startsWith('akra-shell-cdp-')) {
          fs.rmSync(cleanupTarget, { recursive: true, force: true });
        }
      }
    } catch (_) {}
  }
}

if (process.env.SHELL_READ_ONLY_PROFILE === '1') {
  main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
} else {
  main().then(() => {
    const readOnly = spawnSync(process.execPath, [__filename], {
      cwd: MAIN_ROOT,
      env: { ...process.env, SHELL_READ_ONLY_PROFILE: '1', SHELL_BROWSER_EXECUTABLE: BROWSER },
      stdio: 'inherit',
      windowsHide: true
    });
    if (readOnly.error) throw readOnly.error;
    if (readOnly.status !== 0) throw new Error(`read-only browser profile failed with exit=${readOnly.status}`);
  }).catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
}
