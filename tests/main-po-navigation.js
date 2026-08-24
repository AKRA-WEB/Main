const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const objectStart = html.indexOf('const AKRA_SSO = {');
const objectEnd = html.indexOf('\n        };', objectStart) + '\n        };'.length;
assert.ok(objectStart >= 0 && objectEnd > objectStart, 'Main must define app navigation');

let refreshPending = true;
let queuedAppId = null;
const openedUrls = [];
const popupUrls = [];
const popup = {
  closed: false,
  location: { replace(url) { popupUrls.push(url); } }
};
const context = vm.createContext({
  URL,
  state: { sessionToken: 'stale-token', mustChangePassword: false, currentUser: 'Fixture User' },
  App: {
    handleLogout() { throw new Error('unexpected logout'); },
    queueNavigationIfRefreshing(intent) {
      if (!refreshPending) return false;
      queuedAppId = intent.appId;
      return true;
    },
    openChangePasswordModal() { throw new Error('unexpected password modal'); }
  },
  UI: { showToast() { throw new Error('unexpected toast'); } },
  API: { sendLog() {} },
  safeAppUrl: url => url,
  window: {
    open(url) { openedUrls.push(url); },
    location: { assign(url) { openedUrls.push(url); } }
  }
});
vm.runInContext(`${html.slice(objectStart, objectEnd)}; globalThis.openPO = (queuedPopup, wasQueued) => AKRA_SSO.openApp('https://akra-web.github.io/TrackingPO/', 'app-tracking', queuedPopup, wasQueued);`, context);

vm.runInContext('openPO()', context);
assert.equal(queuedAppId, 'app-tracking', 'PO must enter the same refresh queue as every other app');
assert.equal(openedUrls.length, 0, 'PO must not open with a stale token while Main refresh is pending');

refreshPending = false;
context.state.sessionToken = 'fresh-token';
context.queuedPopup = popup;
vm.runInContext('openPO(queuedPopup, true)', context);
assert.equal(popupUrls.length, 1, 'queued PO navigation must reuse the waiting popup after refresh');
assert.equal(new URL(popupUrls[0]).searchParams.get('sso'), 'fresh-token', 'queued PO navigation must receive the refreshed token');
assert.equal(openedUrls.length, 0, 'queued navigation must not create a second tab');

console.log('PASS main-po-navigation: PO waits for Main refresh and opens with the refreshed SSO token');
