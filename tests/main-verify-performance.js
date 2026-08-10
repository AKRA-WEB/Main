const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'Code.gs'), 'utf8');

function createRuntime(sheetStub = {}) {
  let sheetOpenCount = 0;
  let lockWaitCount = 0;
  const cache = new Map();
  const removedCacheKeys = [];
  const context = vm.createContext({
    console,
    Date,
    JSON,
    String,
    Number,
    Array,
    Object,
    Math,
    SpreadsheetApp: {
      openById() {
        sheetOpenCount += 1;
        return sheetStub;
      }
    },
    CacheService: {
      getScriptCache() {
        return {
          get(key) { return cache.has(key) ? cache.get(key) : null; },
          put(key, value) { cache.set(key, String(value)); },
          remove(key) { removedCacheKeys.push(key); cache.delete(key); }
        };
      }
    },
    LockService: {
      getScriptLock() {
        return {
          waitLock() { lockWaitCount += 1; },
          releaseLock() {}
        };
      }
    },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput(text) {
        return {
          text,
          setMimeType() { return this; }
        };
      }
    }
  });
  vm.runInContext(source, context);
  return {
    context,
    getSheetOpenCount: () => sheetOpenCount,
    getLockWaitCount: () => lockWaitCount,
    getRemovedCacheKeys: () => [...removedCacheKeys],
    setCache(key, value) { cache.set(key, String(value)); }
  };
}

function callDoGet(runtime, parameter) {
  runtime.context.__event = { parameter };
  const output = vm.runInContext('doGet(__event)', runtime.context);
  return JSON.parse(output.text);
}

function callDoPost(runtime, payload) {
  runtime.context.__postEvent = { postData: { contents: JSON.stringify(payload) } };
  const output = vm.runInContext('doPost(__postEvent)', runtime.context);
  return JSON.parse(output.text);
}

const invalid = createRuntime();
const invalidResult = callDoGet(invalid, { action: 'verifyToken', token: 'not-a-jwt' });
assert.deepStrictEqual(invalidResult, { valid: false, reason: 'invalid_or_expired_token' });
assert.strictEqual(invalid.getSheetOpenCount(), 0, 'invalid token must be rejected before SpreadsheetApp.openById');

let userIdColumnReadCount = 0;
const userRow = ['U1', 'Alice', 'ADMIN', 'v1$user$2000$salt$hash'];
const userSheet = {
  getLastRow() { return 2; },
  getDataRange() { throw new Error('User fallback must not read the full data range'); },
  getRange(row, column, rowCount, columnCount) {
    if (row === 2 && column === 1 && rowCount === 1 && columnCount === 1) {
      return { getValues() { userIdColumnReadCount += 1; return [[userRow[0]]]; } };
    }
    assert.deepStrictEqual([row, column, rowCount, columnCount], [2, 1, 1, 4]);
    return { getValues: () => [[...userRow]] };
  }
};
const valid = createRuntime({
  getSheetByName(name) {
    return name === 'User' ? userSheet : null;
  }
});
let decodeCount = 0;
let validSnapshotReadCount = 0;
valid.context.verifyAndDecodeToken = () => {
  decodeCount += 1;
  return { id: 'U1', exp: Date.now() + 60000 };
};
valid.context.getPermConfig = () => ({ 'app-po': { createPO: ['ADMIN'] } });
valid.context.getAuthorizationSnapshot_ = () => {
  validSnapshotReadCount += 1;
  return { appConfig: [], permConfig: { 'app-po': { createPO: ['ADMIN'] } } };
};
const validResult = callDoGet(valid, { action: 'verifyToken', token: 'fixture.jwt.token', roles: 'ADMIN' });
assert.strictEqual(validResult.valid, true);
assert.strictEqual(validResult.user.id, 'U1');
assert.deepStrictEqual(validResult.user.perms, { 'app-po': ['createPO'] });
assert.strictEqual(validResult.serverTimings, undefined, 'default response must not expose timing metadata');
assert.strictEqual(valid.getSheetOpenCount(), 1, 'valid token should open the spreadsheet once');
assert.strictEqual(decodeCount, 1, 'valid token should be decoded once and reused for the fresh User lookup');
assert.strictEqual(validSnapshotReadCount, 1, 'one verify request must reuse one authorization snapshot for permissions and app access');
userRow[2] = 'WAREHOUSE';
const deniedResult = callDoGet(valid, { action: 'verifyToken', token: 'fixture.jwt.token', roles: 'ADMIN' });
assert.deepStrictEqual(deniedResult, { valid: false, reason: 'permission_denied' });
assert.strictEqual(userIdColumnReadCount, 1, 'warm verification should reuse the cached User row index');
userRow[2] = 'ADMIN';

const shiftedUserSheet = {
  getLastRow() { return 2; },
  getDataRange() { throw new Error('User fallback must not read the full data range'); },
  getRange(row, column, rowCount, columnCount) {
    if (row === 99) throw new Error('Range exceeds grid limits');
    if (row === 2 && column === 1 && rowCount === 1 && columnCount === 1) return { getValues: () => [['U3']] };
    if (row === 2 && column === 1 && rowCount === 1 && columnCount === 4) {
      return { getValues: () => [['U3', 'Shifted User', 'ADMIN', 'v1$user$2000$salt$hash']] };
    }
    throw new Error(`unexpected range ${row},${column},${rowCount},${columnCount}`);
  }
};
const shifted = createRuntime({
  getSheetByName(name) {
    return name === 'User' ? shiftedUserSheet : null;
  }
});
shifted.setCache('main_user_row_v1_U3', '99');
shifted.context.verifyAndDecodeToken = () => ({ id: 'U3', exp: Date.now() + 60000 });
shifted.context.getPermConfig = () => ({});
shifted.context.getAuthorizationSnapshot_ = () => ({ appConfig: [], permConfig: {} });
const shiftedResult = callDoGet(shifted, { action: 'verifyToken', token: 'fixture.jwt.token', roles: 'ADMIN' });
assert.strictEqual(shiftedResult.valid, true, 'stale out-of-range row cache must fall back to a fresh User scan');

const cashierRow = ['U2', 'Cashier User', 'Cashier', 'v1$user$2000$salt$hash'];
const cashierUserSheet = {
  getLastRow() { return 2; },
  getDataRange() { throw new Error('User fallback must not read the full data range'); },
  getRange(row, column, rowCount, columnCount) {
    if (row === 2 && column === 1 && rowCount === 1 && columnCount === 1) return { getValues: () => [[cashierRow[0]]] };
    return { getValues: () => [[...cashierRow]] };
  }
};
const cashier = createRuntime({
  getSheetByName(name) {
    return name === 'User' ? cashierUserSheet : null;
  }
});
cashier.context.verifyAndDecodeToken = () => ({ id: 'U2', exp: Date.now() + 60000 });
cashier.context.getPermConfig = () => ({ 'app-po': { createPO: ['Cashier'] } });
cashier.context.getAppConfig = () => ([{ id: 'app-po', roles: ['Cashier'] }]);
cashier.context.getAuthorizationSnapshot_ = () => ({
  appConfig: [{ id: 'app-po', roles: ['Cashier'] }],
  permConfig: { 'app-po': { createPO: ['Cashier'] } }
});
const cashierAllowed = callDoGet(cashier, { action: 'verifyToken', token: 'fixture.jwt.token', appId: 'app-po' });
assert.strictEqual(cashierAllowed.valid, true, 'Cashier should enter PO when Main AppConfig allows it');

cashierRow[3] = 'v1$default$2000$salt$hash';
const passwordChangeDenied = callDoGet(cashier, { action: 'verifyToken', token: 'fixture.jwt.token', appId: 'app-po' });
assert.deepStrictEqual(
  passwordChangeDenied,
  { valid: false, reason: 'mandatory_password_change_required' },
  'appId verification must fail closed while the current User row requires a password change'
);
cashierRow[3] = 'v1$user$2000$salt$hash';

cashier.context.getAppConfig = () => ([{ id: 'app-po', roles: ['AKRA'] }]);
cashier.context.getAuthorizationSnapshot_ = () => ({
  appConfig: [{ id: 'app-po', roles: ['AKRA'] }],
  permConfig: { 'app-po': { createPO: ['Cashier'] } }
});
const cashierDenied = callDoGet(cashier, { action: 'verifyToken', token: 'fixture.jwt.token', appId: 'app-po' });
assert.deepStrictEqual(
  cashierDenied,
  { valid: false, reason: 'permission_denied' },
  'Cashier should be denied after Main AppConfig removes PO access'
);

const perfResult = callDoGet(valid, { action: 'verifyToken', token: 'fixture.jwt.token', roles: 'ADMIN', perf: '1' });
assert.strictEqual(perfResult.valid, true);
assert.deepStrictEqual(
  Object.keys(perfResult.serverTimings).sort(),
  ['authorizationSnapshot', 'openSpreadsheet', 'permissionBuild', 'tokenValidation', 'total', 'userLookup'].sort()
);
assert(Object.values(perfResult.serverTimings).every(value => Number.isFinite(value) && value >= 0));

const invalidPerf = createRuntime();
const invalidPerfResult = callDoGet(invalidPerf, { action: 'verifyToken', token: 'bad-token', perf: '1' });
assert.strictEqual(invalidPerfResult.valid, false);
assert.deepStrictEqual(Object.keys(invalidPerfResult.serverTimings).sort(), ['tokenValidation', 'total'].sort());
assert.strictEqual(invalidPerf.getSheetOpenCount(), 0);

const invalidRefresh = createRuntime({ getSheetByName() { return null; } });
invalidRefresh.context.verifyAndDecodeToken = () => null;
const invalidRefreshResult = callDoPost(invalidRefresh, { action: 'refreshSession', token: 'bad-token', perf: true });
assert.strictEqual(invalidRefreshResult.status, 'error');
assert.strictEqual(invalidRefreshResult.message, 'invalid_or_expired_token');
assert.deepStrictEqual(Object.keys(invalidRefreshResult.serverTimings).sort(), ['tokenValidation', 'total'].sort());
assert.strictEqual(invalidRefresh.getSheetOpenCount(), 0, 'invalid refresh token must be rejected before SpreadsheetApp.openById');

const refreshUserSheet = {
  getLastRow() { return 2; },
  getRange(row, column, rowCount, columnCount) {
    if (row === 2 && column === 1 && rowCount === 1 && columnCount === 1) return { getValues: () => [['U1']] };
    return { getValues: () => [['U1', 'Alice', 'ADMIN', 'v1$user$2000$salt$hash']] };
  }
};
const validRefresh = createRuntime({ getSheetByName(name) { return name === 'User' ? refreshUserSheet : null; } });
validRefresh.context.verifyAndDecodeToken = () => ({ id: 'U1', exp: Date.now() + 60000 });
let refreshSnapshotReadCount = 0;
validRefresh.context.getAuthorizationSnapshot_ = () => {
  refreshSnapshotReadCount += 1;
  return {
    appConfig: [{ id: 'app-po', roles: ['ADMIN'] }],
    permConfig: { 'app-po': { createPO: ['ADMIN'] } }
  };
};
validRefresh.context.generateToken = () => 'refreshed-token';
const validRefreshResult = callDoPost(validRefresh, { action: 'refreshSession', token: 'fixture.jwt.token', perf: true });
assert.strictEqual(validRefreshResult.status, 'success');
assert.strictEqual(validRefresh.getSheetOpenCount(), 1, 'valid refresh should open the spreadsheet once');
assert.strictEqual(refreshSnapshotReadCount, 1, 'one refresh request must reuse one authorization snapshot for permissions and response config');
assert.deepStrictEqual(
  Object.keys(validRefreshResult.serverTimings).sort(),
  ['authorizationSnapshot', 'openSpreadsheet', 'permissionBuild', 'tokenGeneration', 'tokenValidation', 'total', 'userLookup'].sort(),
  'refresh diagnostics must expose duration-only phase timings when opted in'
);
assert(source.includes('function getAuthorizationSnapshot_'), 'Main must load AppConfig and PermConfig through one bounded authorization snapshot');

let appConfigReads = 0;
let permConfigReads = 0;
const snapshotRuntime = createRuntime({
  getSheetByName(name) {
    if (name === 'AppConfig') return { getDataRange: () => ({ getValues: () => {
      appConfigReads += 1;
      return [['AppID', 'Name', 'Icon', 'URL', 'Roles'], ['app-po', 'PO', 'box', 'https://akra-web.github.io/PO/', 'ADMIN,Cashier']];
    } }) };
    if (name === 'PermConfig') return { getDataRange: () => ({ getValues: () => {
      permConfigReads += 1;
      return [['AppID', 'PermKey', 'ADMIN', 'Cashier'], ['app-po', 'createPO', true, true]];
    } }) };
    return null;
  }
});
const snapshot = snapshotRuntime.context.getAuthorizationSnapshot_(snapshotRuntime.context.SpreadsheetApp.openById('fixture'));
assert.strictEqual(snapshot.appConfig[0].id, 'app-po');
assert.deepStrictEqual(JSON.parse(JSON.stringify(snapshot.permConfig)), { 'app-po': { createPO: ['ADMIN', 'Cashier'] } });
snapshotRuntime.context.getAppConfig(snapshotRuntime.context.SpreadsheetApp.openById('fixture'));
snapshotRuntime.context.getPermConfig(snapshotRuntime.context.SpreadsheetApp.openById('fixture'));
assert.strictEqual(appConfigReads, 1, 'AppConfig should be read once per combined cache miss');
assert.strictEqual(permConfigReads, 1, 'PermConfig should be read once per combined cache miss');
assert.strictEqual(snapshotRuntime.getLockWaitCount(), 1, 'combined authorization cache miss should use one script lock');

assert.strictEqual(typeof valid.context.invalidateUserRowCache_, 'function', 'Main must expose one bounded User row-cache invalidation helper');
valid.context.invalidateUserRowCache_('U1');
assert(valid.getRemovedCacheKeys().includes('main_user_row_v1_U1'), 'User row-cache invalidation must remove the affected identifier');
const userMutationStart = source.indexOf('if (data.action === "saveUser" || data.action === "deleteUser")');
const userMutationEnd = source.indexOf('// 4. เปลี่ยนรหัสผ่าน', userMutationStart);
assert((source.slice(userMutationStart, userMutationEnd).match(/invalidateUserRowCache_\(/g) || []).length >= 2, 'saveUser and deleteUser must invalidate affected row-index state');

console.log('PASS main-verify-performance: verifyToken contracts, decode reuse, and opt-in timing metadata pass');
