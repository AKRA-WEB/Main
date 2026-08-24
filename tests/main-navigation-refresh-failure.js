const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const appStart = html.indexOf('const App = {');
const appEnd = html.indexOf('\n        const AKRA_SSO = {', appStart);
const ssoStart = appEnd + 1;
const ssoEnd = html.indexOf('\n        };', ssoStart) + '\n        };'.length;
assert.ok(appStart >= 0 && appEnd > appStart && ssoEnd > ssoStart, 'Main navigation runtime must be extractable');

const openedUrls = [];
const toasts = [];
const popup = {
  closed: false,
  close() { this.closed = true; }
};
const context = vm.createContext({
  URL,
  state: {
    sessionToken: 'stale-token',
    sessionEpoch: 1,
    sessionRefreshPending: true,
    sessionRefreshFailed: false,
    pendingNavigation: { type: 'app', appId: 'app-tracking', sessionEpoch: 1, popup },
    mustChangePassword: false,
    currentUser: 'Fixture User'
  },
  UI: {
    showToast(message) { toasts.push(message); },
    switchSection() {}
  },
  API: { sendLog() {} },
  safeAppUrl: url => url,
  window: {
    open(url) { openedUrls.push(url); },
    location: { assign(url) { openedUrls.push(url); } }
  }
});

vm.runInContext(`${html.slice(appStart, appEnd)}\n${html.slice(ssoStart, ssoEnd)}; globalThis.AppUnderTest = App; globalThis.SsoUnderTest = AKRA_SSO;`, context);

vm.runInContext("AppUnderTest.handleSessionRefreshFailure('refresh failed')", context);
assert.equal(context.state.sessionRefreshPending, false, 'failed refresh must leave no refresh marked in flight');
assert.equal(context.state.sessionRefreshFailed, true, 'failed refresh must block child-app navigation until reload');
assert.equal(context.state.pendingNavigation, null, 'failed refresh must cancel queued navigation');
assert.equal(popup.closed, true, 'failed refresh must close its waiting popup');

vm.runInContext("SsoUnderTest.openApp('https://example.test/po', 'app-tracking')", context);
assert.equal(openedUrls.length, 0, 'a cached stale token must never launch an app after refresh failure');
assert.match(toasts.at(-1), /รีโหลดหน้า Main/, 'blocked navigation must give an actionable reload instruction');

context.state.sessionRefreshFailed = false;
context.state.sessionToken = 'fresh-token';
vm.runInContext("SsoUnderTest.openApp('https://example.test/po', 'app-tracking')", context);
assert.equal(new URL(openedUrls[0]).searchParams.get('sso'), 'fresh-token', 'navigation may resume with a refreshed token after reload/success');

console.log('PASS main-navigation-refresh-failure: failed refresh cancels and blocks stale-token app launches');
