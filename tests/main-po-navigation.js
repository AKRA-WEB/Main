const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { performance } = require('perf_hooks');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const openStart = html.indexOf('openApp: function(');
const openEnd = html.indexOf('\n        };', openStart);
const openSource = html.slice(openStart, openEnd);

assert(openStart >= 0, 'Main must define app navigation');
assert(
  openSource.includes("appId !== 'app-po' && App.queueNavigationIfRefreshing"),
  'PO navigation must not wait for the redundant Main session refresh'
);

const objectStart = html.indexOf('const AKRA_SSO = {');
const objectEnd = html.indexOf('\n        };', objectStart) + '\n        };'.length;
const openedUrls = [];
const context = vm.createContext({
  URL,
  state: { sessionToken: 'fixture-token', mustChangePassword: false, currentUser: 'Fixture User' },
  App: {
    handleLogout() { throw new Error('unexpected logout'); },
    queueNavigationIfRefreshing() { throw new Error('PO must not enter the refresh queue'); },
    openChangePasswordModal() { throw new Error('unexpected password modal'); }
  },
  UI: { showToast() { throw new Error('unexpected toast'); } },
  API: { sendLog() {} },
  safeAppUrl: url => url,
  window: { open(url) { openedUrls.push(url); } }
});
vm.runInContext(`${html.slice(objectStart, objectEnd)}; globalThis.openPO = () => AKRA_SSO.openApp('https://akra-web.github.io/PO/', 'app-po');`, context);

const samples = [];
for (let i = 0; i < 20; i += 1) {
  const startedAt = performance.now();
  vm.runInContext('openPO()', context);
  samples.push(performance.now() - startedAt);
}
samples.sort((a, b) => a - b);
const p95 = samples[Math.ceil(samples.length * 0.95) - 1];
assert.strictEqual(openedUrls.length, 20, 'every PO click must navigate while Main refresh is pending');
assert(p95 < 100, `controlled PO click-to-navigation p95 must be <100 ms; received ${p95.toFixed(2)} ms`);

console.log(`PASS main-po-navigation: controlled click-to-navigation p95 ${p95.toFixed(2)} ms`);
