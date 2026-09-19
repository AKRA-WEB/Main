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
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
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
  assert.equal(fs.existsSync(CHROME), true, `Chrome executable is required: ${CHROME}`);
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
  try {
    await waitFor(async () => {
      try { return (await httpJson(fixturePort, '/__fixture/status')).status === 200; }
      catch (_) { return false; }
    }, 20000, 'fixture server');
    profile = fs.mkdtempSync(path.join(os.tmpdir(), 'akra-shell-cdp-'));
    chrome = await startProcess(CHROME, [
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
    const pageTarget = targets.find(target => target.type === 'page');
    cdp = new CdpClient(pageTarget.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
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
      assert.equal((await httpJson(debugPort, '/json')).body.filter(target => target.type === 'page').length, 1, 'read-only profile tab count');
      console.log(JSON.stringify({ status: 'pass', profile: 'read-only', tabCount: 1, picking: pickingState, kpi: kpiState, fixtureStatus }));
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
      assert.equal((await httpJson(debugPort, '/json')).body.filter(target => target.type === 'page').length, 1, `${id} desktop tab count`);
      if (id === 'app-manual') {
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
              child.querySelector('[data-close-modal]')?.click();
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
          const dashboardTab = [...child.querySelectorAll('.trd-module-tab')]
            .find(button => button.textContent.includes('Analytics'));
          if (!dashboardTab) return { ok: false, reason: 'TRD Analytics tab missing' };
          dashboardTab.click();
          const deadline = Date.now() + 5000;
          while (Date.now() < deadline) {
            const report = child.querySelector('.trd-report');
            if (report && report.textContent.includes('Analytics')) {
              return {
                ok: true,
                reportVisible: report.offsetParent !== null,
                hasSummary: report.textContent.includes('สรุป') || report.textContent.includes('Survey')
              };
            }
            await new Promise(resolve => setTimeout(resolve, 100));
          }
          return { ok: false, reason: 'TRD Analytics view did not render', body: child.body.innerText.slice(0, 500) };
        })()`);
        assert.equal(trdWorkflow.ok, true, trdWorkflow.reason || 'TRD workflow failed');
        assert.equal(trdWorkflow.reportVisible, true, 'TRD Analytics view was not visible');
        assert.equal(trdWorkflow.hasSummary, true, 'TRD Analytics view did not render its report content');
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
          let download = null;
          const anchorProto = child.defaultView.HTMLAnchorElement.prototype;
          const previousAnchorClick = anchorProto.click;
          anchorProto.click = function () {
            download = { href: this.getAttribute('href'), name: this.getAttribute('download') };
          };
          win.exportJSONTemplate();
          anchorProto.click = previousAnchorClick;
          child.defaultView.print = previousPrint;
          return {
            ok: true,
            editorVisible: !child.getElementById('editorSidebar')?.classList.contains('collapsed'),
            previewName: child.getElementById('viewEmpName')?.textContent.includes('พนักงานประเมินใน Shell'),
            autosavedName: saved.empName === 'พนักงานประเมินใน Shell',
            printed,
            exportHref: download?.href || '',
            exportName: download?.name || ''
          };
        })()`);
        assert.equal(evaluationWorkflow.ok, true, evaluationWorkflow.reason || 'Evaluation workflow failed');
        assert.equal(evaluationWorkflow.editorVisible, true, 'Evaluation editor did not open');
        assert.equal(evaluationWorkflow.previewName, true, 'Evaluation preview did not sync employee name');
        assert.equal(evaluationWorkflow.autosavedName, true, 'Evaluation local autosave did not persist employee name');
        assert.equal(evaluationWorkflow.printed, 1, 'Evaluation print action did not call window.print');
        assert.match(evaluationWorkflow.exportHref, /^data:text\/json/);
        assert.match(evaluationWorkflow.exportName, /^Evaluation_Form_/);
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
    assert.equal((await httpJson(debugPort, '/json')).body.filter(target => target.type === 'page').length, 1, 'purchasing workflow opened another tab');

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
      assert.equal((await httpJson(debugPort, '/json')).body.filter(target => target.type === 'page').length, 1, `${id} mobile tab count`);
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
    assert.equal(writes.w5AdjustmentWrites, 1, 'W5 UI workflow did not produce a stock adjustment write');
    assert.equal(writes.returnitemWrites, 1, 'Returnitem UI workflow did not produce an intake write');
    assert.equal(fixtureStatus.sopMutationWrites, 1, 'SOP page-management UI workflow did not produce a fixture write');
    assert.equal(fixtureStatus.trdMutationWrites, 1, 'TRD stock survey did not produce an inventory mutation write');
    assert.equal(fixtureStatus.trdSurveyWrites, 1, 'TRD stock survey did not produce a survey log write');
    const purchasingWorkflow = { poWrites: fixtureStatus.poWrites, grReviewWrites: fixtureStatus.grReviewWrites, grCompletedWrites: fixtureStatus.grCompletedWrites, workflowStock: fixtureStatus.workflowStock };
    assert.equal(purchasingWorkflow.poWrites, 1, 'PO UI workflow did not produce a fixture write');
    assert.equal(purchasingWorkflow.grReviewWrites, 1, 'GR review UI workflow did not produce a fixture write');
    assert.equal(purchasingWorkflow.grCompletedWrites, 1, 'GR completion UI workflow did not produce a fixture write');
    assert.equal(purchasingWorkflow.workflowStock, 2, 'completed GR did not reach the W5 fixture stock');
    console.log(JSON.stringify({ status: 'pass', modules: MODULES.length, records: records.length, tabCount: 1, viewports: ['desktop-1280', 'mobile-390'], requiredReads, writes, purchasingWorkflow, refreshFailure }));
  } finally {
    cdp?.close();
    terminateProcessTree(chrome);
    terminateProcessTree(fixture);
    try { if (profile) fs.rmSync(profile, { recursive: true, force: true }); } catch (_) {}
  }
}

if (process.env.SHELL_READ_ONLY_PROFILE === '1') {
  main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
} else {
  main().then(() => {
    const readOnly = spawnSync(process.execPath, [__filename], {
      cwd: MAIN_ROOT,
      env: { ...process.env, SHELL_READ_ONLY_PROFILE: '1' },
      stdio: 'inherit',
      windowsHide: true
    });
    if (readOnly.error) throw readOnly.error;
    if (readOnly.status !== 0) throw new Error(`read-only browser profile failed with exit=${readOnly.status}`);
  }).catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
}
