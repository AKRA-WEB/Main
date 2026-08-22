const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const inlineScripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)];
inlineScripts.forEach((match, index) => {
  if (match[1].trim()) new vm.Script(match[1], { filename: `main-inline-${index}.js` });
});

function sourceBetween(start, end) {
  const startIndex = html.indexOf(start);
  const endIndex = html.indexOf(end, startIndex);
  if (startIndex < 0 || endIndex < 0) throw new Error(`Unable to extract runtime source: ${start}`);
  return html.slice(startIndex, endIndex);
}

const configSource = sourceBetween('const CONFIG = {', '\n        const CURRENT_VERSION');
const apiSource = sourceBetween('const API = {', '\n\n        const AdminInteractive');
const changePasswordSource = sourceBetween(
  'handleChangePassword: async (e) => {',
  '\n\n            handleLogout:'
);
const requests = [];
const context = vm.createContext({
  console,
  JSON,
  Error,
  AbortController,
  setTimeout,
  clearTimeout,
  AppVersionGuard: { blockIfStale: async () => false },
  state: { sessionToken: 'signed-session-token' },
  fetch: async (url, options) => {
    requests.push({ url: String(url), options });
    return Response.json({ status: 'success', token: 'new-token', user: { id: '250001' } });
  },
  Response
});
vm.runInContext(`${configSource}\n${apiSource}\nglobalThis.__api = API; globalThis.__config = CONFIG;`, context);

(async () => {
  const expectedUrl = 'https://hgxrrskztbpejirrdpbq.supabase.co/functions/v1/auth-api';
  assert.equal(context.__config.API_URL, expectedUrl);
  const result = await context.__api.postAction({ action: 'login', id: '250001', password: 'password' });
  assert.equal(result.status, 'success');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, expectedUrl);
  assert.equal(requests[0].options.method, 'POST');
  assert.equal(requests[0].options.headers['Content-Type'], 'text/plain;charset=utf-8');
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    action: 'login',
    id: '250001',
    password: 'password',
    token: 'signed-session-token'
  });

  context.fetch = async () => Response.json(
    { status: 'error', reason: 'invalid_password', message: 'invalid_password' },
    { status: 401 }
  );
  await assert.rejects(
    () => context.__api.postAction({ action: 'login', id: '250001', password: 'wrong' }),
    error => error && error.code === 'invalid_password'
  );

  const passwordInputs = {
    'curr-pwd-input': { value: 'current-password' },
    'new-pwd-input': { value: 'short-pass' },
    'confirm-pwd-input': { value: 'short-pass' },
    'submit-change-pwd-btn': { disabled: false },
    'submit-change-pwd-text': { innerHTML: '', innerText: '' }
  };
  const passwordCalls = [];
  const passwordToasts = [];
  const passwordContext = vm.createContext({
    document: { getElementById: id => passwordInputs[id] },
    state: { sessionEpoch: 1 },
    UI: { showToast: (message, type) => passwordToasts.push({ message, type }) },
    API: {
      async postAction(payload) {
        passwordCalls.push(payload);
        throw Object.assign(new Error('controlled-stop'), { code: 'controlled-stop' });
      }
    },
    safeStorage: { setItem() {} },
    CONFIG: {},
    lucide: { createIcons() {} }
  });
  vm.runInContext(`const App = { ${changePasswordSource} }; globalThis.__app = App;`, passwordContext);
  await passwordContext.__app.handleChangePassword({ preventDefault() {} });
  assert.equal(passwordCalls.length, 0, 'passwords shorter than 12 characters must be rejected before the API call');
  assert.match(passwordToasts.at(-1).message, /12/, 'short-password feedback must state the 12-character minimum');

  passwordInputs['new-pwd-input'].value = 'secure-passphrase';
  passwordInputs['confirm-pwd-input'].value = 'secure-passphrase';
  await passwordContext.__app.handleChangePassword({ preventDefault() {} });
  assert.equal(passwordCalls.length, 1, 'a password meeting the minimum must reach the protected API');
  console.log('PASS main-auth-edge-runtime: Supabase-only POST, session forwarding, password constraints, error contract, and inline syntax.');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
