const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'Code.gs'), 'utf8');

function createRuntime(sheetStub = {}) {
  let sheetOpenCount = 0;
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
  return { context, getSheetOpenCount: () => sheetOpenCount };
}

function callDoGet(runtime, parameter) {
  runtime.context.__event = { parameter };
  const output = vm.runInContext('doGet(__event)', runtime.context);
  return JSON.parse(output.text);
}

const invalid = createRuntime();
const invalidResult = callDoGet(invalid, { action: 'verifyToken', token: 'not-a-jwt' });
assert.deepStrictEqual(invalidResult, { valid: false, reason: 'invalid_or_expired_token' });
assert.strictEqual(invalid.getSheetOpenCount(), 0, 'invalid token must be rejected before SpreadsheetApp.openById');

const userSheet = {
  getDataRange() {
    return {
      getValues() {
        return [
          ['ID', 'Name', 'Roles', 'Password'],
          ['U1', 'Alice', 'ADMIN', 'v1$user$2000$salt$hash']
        ];
      }
    };
  }
};
const valid = createRuntime({
  getSheetByName(name) {
    return name === 'User' ? userSheet : null;
  }
});
let decodeCount = 0;
valid.context.verifyAndDecodeToken = () => {
  decodeCount += 1;
  return { id: 'U1', exp: Date.now() + 60000 };
};
valid.context.getPermConfig = () => ({ 'app-po': { createPO: ['ADMIN'] } });
const validResult = callDoGet(valid, { action: 'verifyToken', token: 'fixture.jwt.token', roles: 'ADMIN' });
assert.strictEqual(validResult.valid, true);
assert.strictEqual(validResult.user.id, 'U1');
assert.deepStrictEqual(validResult.user.perms, { 'app-po': ['createPO'] });
assert.strictEqual(validResult.serverTimings, undefined, 'default response must not expose timing metadata');
assert.strictEqual(valid.getSheetOpenCount(), 1, 'valid token should open the spreadsheet once');
assert.strictEqual(decodeCount, 1, 'valid token should be decoded once and reused for the fresh User lookup');
const deniedResult = callDoGet(valid, { action: 'verifyToken', token: 'fixture.jwt.token', roles: 'WAREHOUSE' });
assert.deepStrictEqual(deniedResult, { valid: false, reason: 'permission_denied' });

const perfResult = callDoGet(valid, { action: 'verifyToken', token: 'fixture.jwt.token', roles: 'ADMIN', perf: '1' });
assert.strictEqual(perfResult.valid, true);
assert.deepStrictEqual(
  Object.keys(perfResult.serverTimings).sort(),
  ['freshUserAndPerms', 'openSpreadsheet', 'tokenValidation', 'total'].sort()
);
assert(Object.values(perfResult.serverTimings).every(value => Number.isFinite(value) && value >= 0));

const invalidPerf = createRuntime();
const invalidPerfResult = callDoGet(invalidPerf, { action: 'verifyToken', token: 'bad-token', perf: '1' });
assert.strictEqual(invalidPerfResult.valid, false);
assert.deepStrictEqual(Object.keys(invalidPerfResult.serverTimings).sort(), ['tokenValidation', 'total'].sort());
assert.strictEqual(invalidPerf.getSheetOpenCount(), 0);

console.log('PASS main-verify-performance: verifyToken contracts, decode reuse, and opt-in timing metadata pass');
