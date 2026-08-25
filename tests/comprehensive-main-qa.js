const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

console.log('===============================================================');
console.log('        COMPREHENSIVE QA AUDIT SUITE: AKRA MAIN (PORTAL & SSO)  ');
console.log('===============================================================\n');

const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const versionJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'version.json'), 'utf8'));
const codeGs = fs.readFileSync(path.join(__dirname, '..', 'Code.gs'), 'utf8');
const execHtml = fs.readFileSync(path.join(__dirname, '..', 'executive-dashboard.html'), 'utf8');
const supabaseAuthJs = fs.readFileSync(path.join(__dirname, '..', 'js', 'supabase-auth.js'), 'utf8');

// ============================================================================
// SUITE 1: Static Hygiene, Asset Integrity & Secret Exposure
// ============================================================================
console.log('--- SUITE 1: Static Hygiene, Asset Integrity & Secret Scans ---');

// 1.1 Version Parity
assert(
  indexHtml.includes(`const CURRENT_VERSION = "${versionJson.version}";`),
  `index.html CURRENT_VERSION must match version.json (${versionJson.version})`
);
console.log(`[PASS] 1.1 Version parity verified: ${versionJson.version}`);

// 1.2 Secret Exposure
const secretChecks = [
  { name: 'service_role key', pattern: /service_role/i, target: indexHtml },
  { name: 'JWT hardcoded token', pattern: /eyJhbGciOi/i, target: indexHtml },
  { name: 'Supabase secret in client auth', pattern: /service_role/i, target: supabaseAuthJs },
  { name: 'JWT hardcoded token in client auth', pattern: /eyJhbGciOi/i, target: supabaseAuthJs }
];

secretChecks.forEach(check => {
  assert(!check.pattern.test(check.target), `Security violation: ${check.name} detected in client bundle`);
});
console.log('[PASS] 1.2 Zero leaked credentials, service keys, or hardcoded tokens in client files');

// 1.3 Pinned Assets & Script Compilation
const lucidePath = path.join(__dirname, '..', 'assets', 'lucide-0.468.0.min.js');
assert(fs.existsSync(lucidePath), 'Pinned Lucide icon file must exist in assets/');
assert(indexHtml.includes('src="assets/lucide-0.468.0.min.js" defer'), 'Lucide must be deferred from same-origin asset');

const indexInlineScripts = [...indexHtml.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)];
assert(indexInlineScripts.length > 0, 'index.html must contain inline scripts');
indexInlineScripts.forEach((s, idx) => {
  if (s[1].trim()) new vm.Script(s[1], { filename: `index-inline-${idx}.js` });
});

const execInlineScripts = [...execHtml.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)];
execInlineScripts.forEach((s, idx) => {
  if (s[1].trim()) new vm.Script(s[1], { filename: `exec-inline-${idx}.js` });
});

new vm.Script(codeGs, { filename: 'Code.gs' });
console.log('[PASS] 1.3 All HTML inline scripts and Code.gs compile with zero syntax errors');


// ============================================================================
// SUITE 2: Client-side Utility & Security Invariants
// ============================================================================
console.log('\n--- SUITE 2: Client-side Utility & Security Invariant Tests ---');

function getSnippet(src, startStr, endStr) {
  const s = src.indexOf(startStr);
  const e = src.indexOf(endStr, s);
  assert(s >= 0 && e > s, `Failed to extract snippet for: ${startStr}`);
  return src.slice(s, e);
}

const safeAppUrlSrc = getSnippet(indexHtml, 'function safeAppUrl(', '\n        function parseCachedUserData(');
const safeIdentSrc = getSnippet(indexHtml, 'function safeIdentifier(', '\n        function reconcileAuthorizationDependencies(');
const escapeHtmlSrc = getSnippet(indexHtml, 'function escapeHtml(', '\n        function safeIdentifier(');
const parseUserSrc = getSnippet(indexHtml, 'function parseCachedUserData(', '\n        function parseCachedAppConfig(');
const parseAppSrc = getSnippet(indexHtml, 'function parseCachedAppConfig(', '\n        let state = {');
const reconcileSrc = getSnippet(indexHtml, 'function reconcileAuthorizationDependencies(', '\n        function authorizationControlLabel(');

const clientCtx = vm.createContext({
  URL,
  String,
  JSON,
  Array,
  Map,
  console,
  PERMISSION_APP_DEPENDENCIES: {
    'app-po': 'app-tracking',
    'app-akra': 'app-w5',
    'app-ret': 'app-damage'
  }
});

vm.runInContext(
  `${escapeHtmlSrc}; ${safeIdentSrc}; ${safeAppUrlSrc}; ${parseUserSrc}; ${parseAppSrc}; ${reconcileSrc}`,
  clientCtx
);

// 2.1 safeAppUrl Domain Locking
assert.strictEqual(clientCtx.safeAppUrl('https://akra-web.github.io/TrackingPO/'), 'https://akra-web.github.io/TrackingPO/');
assert.strictEqual(clientCtx.safeAppUrl('https://akra-web.github.io/GR/?foo=bar'), 'https://akra-web.github.io/GR/?foo=bar');
assert.strictEqual(clientCtx.safeAppUrl('http://akra-web.github.io/TrackingPO/'), '', 'Must reject unencrypted HTTP');
assert.strictEqual(clientCtx.safeAppUrl('https://evil-hacker.com/TrackingPO/'), '', 'Must reject external domains');
assert.strictEqual(clientCtx.safeAppUrl('https://akra-web.github.io.evil.com/'), '', 'Must reject subdomain spoofing');
assert.strictEqual(clientCtx.safeAppUrl('javascript:alert(1)'), '', 'Must reject javascript: pseudo-protocol');
console.log('[PASS] 2.1 safeAppUrl strictly allows only https://akra-web.github.io/ and rejects malicious URLs');

// 2.2 safeIdentifier Sanitization
assert.strictEqual(clientCtx.safeIdentifier('app-po'), 'app-po');
assert.strictEqual(clientCtx.safeIdentifier('valid_id-123'), 'valid_id-123');
assert.strictEqual(clientCtx.safeIdentifier('invalid id with spaces'), '');
assert.strictEqual(clientCtx.safeIdentifier('<script>'), '');
assert.strictEqual(clientCtx.safeIdentifier('a'.repeat(81)), '', 'Must enforce maximum 80 chars');
console.log('[PASS] 2.2 safeIdentifier enforces strict alphanumeric/hyphen/underscore tokens');

// 2.3 escapeHtml XSS Prevention
assert.strictEqual(
  clientCtx.escapeHtml('<script>alert("xss")&\'</script>'),
  '&lt;script&gt;alert(&quot;xss&quot;)&amp;&#39;&lt;/script&gt;'
);
console.log('[PASS] 2.3 escapeHtml sanitizes all dangerous HTML entities');

// 2.4 Cached Data Parsers
const validUserData = JSON.stringify({
  id: 'U001',
  name: 'ALICE',
  roles: ['ADMIN'],
  perms: { 'app-po': ['createPO'] },
  mustChangePassword: false
});
const parsed = clientCtx.parseCachedUserData(validUserData);
assert.strictEqual(parsed.id, 'U001');
assert.deepStrictEqual(parsed.roles, ['ADMIN']);
assert.deepStrictEqual(parsed.perms, { 'app-po': ['createPO'] });

assert.throws(() => clientCtx.parseCachedUserData('null'), /invalid_cached_user/);
assert.throws(() => clientCtx.parseCachedUserData('[]'), /invalid_cached_user/);
assert.throws(() => clientCtx.parseCachedUserData(JSON.stringify({ id: 123, name: 'User' })), /invalid_cached_user/);
assert.throws(() => clientCtx.parseCachedUserData(JSON.stringify({ id: 'U1', name: 'User', roles: [123] })), /invalid_cached_user/);

const validAppConfig = JSON.stringify([
  { id: 'app-w5', name: 'W5', icon: 'box', url: 'https://akra-web.github.io/AKRA/', roles: ['ADMIN'] },
  { id: 'app-invalid', name: 'Bad App', icon: 'box', url: 'https://attacker.com/app', roles: ['ADMIN'] }
]);
const parsedApps = clientCtx.parseCachedAppConfig(validAppConfig);
assert.strictEqual(parsedApps.length, 1, 'Must filter out app with invalid external URL');
assert.strictEqual(parsedApps[0].id, 'app-w5');
console.log('[PASS] 2.4 Cached user data and app config parsers enforce strict runtime schemas');

// 2.5 Authorization Dependency Reconciliation
const testApps = [{ id: 'app-tracking', roles: ['ADMIN'] }];
const testPerms = [{ appId: 'app-po', permKey: 'createPO', ADMIN: true, Cashier: true }];
const testRoles = [{ val: 'ADMIN' }, { val: 'Cashier' }];
const repairs = clientCtx.reconcileAuthorizationDependencies(testApps, testPerms, testRoles);
assert.strictEqual(repairs.length, 1, 'Must repair missing app-tracking access for Cashier');
assert(testApps[0].roles.includes('Cashier'), 'Cashier must be added to app-tracking roles');
console.log('[PASS] 2.5 reconcileAuthorizationDependencies auto-aligns dependent app access');


// ============================================================================
// SUITE 3: Backend (Code.gs) Gas Engine Simulation & Contract Tests
// ============================================================================
console.log('\n--- SUITE 3: Backend (Code.gs) Full Lifecycle Contracts & Security ---');

function createGasRuntime(customSheets = {}) {
  const cache = new Map();
  const properties = new Map([
    ['JWT_SECRET', 'test-jwt-secret-key-32chars-minimum!!'],
    ['PASSWORD_PEPPER', 'test-password-pepper-1234567890!']
  ]);
  let lockAcquired = false;

  const defaultUserRows = [
    ['ID', 'Name', 'Roles', 'Password'],
    ['250001', 'ADMIN USER', 'ADMIN', 'v1$user$2000$testsalt$2V6h4_88n5_dummy'], // standard admin
    ['250002', 'DEFAULT PWD USER', 'AKRA', 'v1$default$2000$testsalt$dummy'], // must change password
    ['250003', 'PLAIN USER', 'TRD', 'plainpassword'], // plaintext to upgrade
    ['250004', 'CASHIER USER', 'Cashier', ''] // empty password => default to userId
  ];

  const defaultAppRows = [
    ['AppID', 'Name', 'Icon', 'URL', 'Roles'],
    ['app-tracking', 'PO', 'truck', 'https://akra-web.github.io/TrackingPO/', 'ADMIN,Cashier'],
    ['app-w5', 'W5', 'box', 'https://akra-web.github.io/AKRA/', 'ADMIN,AKRA']
  ];

  const defaultPermRows = [
    ['AppID', 'PermKey', 'ADMIN', 'SUPERVISOR', 'AKRA', 'TRD', 'WAREHOUSE', 'Cashier'],
    ['app-po', 'createPO', true, false, false, false, false, true],
    ['app-po', 'closePO', true, false, false, false, false, false]
  ];

  const sheets = {
    User: createMockSheet(customSheets.User || defaultUserRows),
    AppConfig: createMockSheet(customSheets.AppConfig || defaultAppRows),
    PermConfig: createMockSheet(customSheets.PermConfig || defaultPermRows),
    RoleConfig: createMockSheet(customSheets.RoleConfig || [
      ['val', 'label', 'desc', 'icon'],
      ['ADMIN', 'ADMIN', 'ผู้ดูแลระบบ', 'shield-alert'],
      ['Cashier', 'Cashier', 'แคชเชียร์', 'calculator'],
      ['AKRA', 'AKRA', 'พนักงาน AKRA', 'building-2']
    ]),
    Log: createMockSheet([['Timestamp', 'User', 'Action', 'App', 'Details']])
  };

  function createMockSheet(initialRows) {
    let rows = initialRows.map(r => [...r]);
    return {
      getLastRow: () => rows.length,
      getDataRange: () => ({
        getValues: () => rows.map(r => [...r])
      }),
      getRange: (row, col, numRows = 1, numCols = 1) => ({
        getValues: () => {
          const res = [];
          for (let r = row - 1; r < row - 1 + numRows; r++) {
            const rowArr = [];
            for (let c = col - 1; c < col - 1 + numCols; c++) {
              rowArr.push(rows[r] ? rows[r][c] : '');
            }
            res.push(rowArr);
          }
          return res;
        },
        getValue: () => (rows[row - 1] ? rows[row - 1][col - 1] : ''),
        setValue: (val) => {
          while (rows.length < row) rows.push([]);
          while (rows[row - 1].length < col) rows[row - 1].push('');
          rows[row - 1][col - 1] = val;
        },
        setValues: (vals) => {
          vals.forEach((rVals, rIdx) => {
            rVals.forEach((cVal, cIdx) => {
              const r = row + rIdx;
              const c = col + cIdx;
              while (rows.length < r) rows.push([]);
              while (rows[r - 1].length < c) rows[r - 1].push('');
              rows[r - 1][c - 1] = cVal;
            });
          });
        }
      }),
      appendRow: (row) => rows.push([...row]),
      deleteRow: (rowIdx) => rows.splice(rowIdx - 1, 1),
      clearContents: () => { rows = []; },
      _getRawRows: () => rows
    };
  }

  const context = vm.createContext({
    console,
    Date,
    JSON,
    String,
    Number,
    Array,
    Object,
    Math,
    Utilities: {
      DigestAlgorithm: { SHA_256: 'SHA_256' },
      Charset: { UTF_8: 'UTF_8' },
      getUuid: () => crypto.randomUUID(),
      computeDigest(_algo, value) {
        return Array.from(crypto.createHash('sha256').update(String(value), 'utf8').digest());
      },
      computeHmacSha256Signature(value, key) {
        return Array.from(crypto.createHmac('sha256', String(key)).update(String(value), 'utf8').digest());
      },
      base64EncodeWebSafe(bytes) {
        return Buffer.from(bytes).toString('base64url');
      },
      base64DecodeWebSafe(str) {
        return Array.from(Buffer.from(str, 'base64url'));
      },
      newBlob(data) {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
        return {
          getBytes: () => Array.from(buf),
          getDataAsString: () => buf.toString('utf8')
        };
      }
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => properties.get(k) || null,
        setProperty: (k, v) => properties.set(k, String(v))
      })
    },
    CacheService: {
      getScriptCache: () => ({
        get: (k) => cache.has(k) ? cache.get(k) : null,
        put: (k, v) => cache.set(k, String(v)),
        remove: (k) => cache.delete(k)
      })
    },
    LockService: {
      getScriptLock: () => ({
        waitLock: () => { lockAcquired = true; },
        releaseLock: () => { lockAcquired = false; }
      })
    },
    SpreadsheetApp: {
      openById: () => ({
        getSheetByName: (name) => sheets[name] || null,
        insertSheet: (name) => {
          sheets[name] = createMockSheet([]);
          return sheets[name];
        }
      })
    },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: (text) => ({
        text,
        setMimeType: function () { return this; }
      })
    }
  });

  vm.runInContext(codeGs, context);

  return {
    context,
    sheets,
    cache,
    doGet: (param) => {
      context.__getEvent = { parameter: param };
      return JSON.parse(vm.runInContext('doGet(__getEvent)', context).text);
    },
    doPost: (payload) => {
      context.__postEvent = { postData: { contents: JSON.stringify(payload) } };
      return JSON.parse(vm.runInContext('doPost(__postEvent)', context).text);
    }
  };
}

const runtime = createGasRuntime();

// 3.1 GET Login rejection
const getLoginRes = runtime.doGet({ action: 'login', id: '250001', password: '123' });
assert.strictEqual(getLoginRes.status, 'error');
assert.strictEqual(getLoginRes.message, 'login_requires_post', 'doGet login must be rejected');
console.log('[PASS] 3.1 GET login is strictly rejected (requires POST)');

// 3.2 POST Login with Plaintext password upgrade
const loginPlainRes = runtime.doPost({ action: 'login', id: '250003', password: 'plainpassword' });
assert.strictEqual(loginPlainRes.status, 'success');
assert.strictEqual(loginPlainRes.user.name, 'PLAIN USER');
assert.strictEqual(loginPlainRes.user.mustChangePassword, false);
assert(loginPlainRes.token, 'Must return valid JWT token');
// Verify that password in sheet was upgraded to v1$ hash
const upgradedPasswordInSheet = runtime.sheets.User._getRawRows()[3][3];
assert(upgradedPasswordInSheet.startsWith('v1$user$2000$'), 'Plaintext password must be upgraded on login');
console.log('[PASS] 3.2 POST login upgrades legacy plaintext password to iterative salted hash');

// 3.3 POST Login with Default Password (mustChangePassword flag)
const loginDefaultRes = runtime.doPost({ action: 'login', id: '250004', password: '250004' });
assert.strictEqual(loginDefaultRes.status, 'success');
assert.strictEqual(loginDefaultRes.user.mustChangePassword, true, 'Default password must set mustChangePassword: true');
console.log('[PASS] 3.3 POST login with default password flags mustChangePassword: true');

// 3.4 Rate Limiting on Failed Login Attempts
const nonExistent = runtime.doPost({ action: 'login', id: '999999', password: 'wrong' });
assert.strictEqual(nonExistent.status, 'error');
assert.strictEqual(nonExistent.message, 'user_not_found');

for (let i = 0; i < 5; i++) {
  runtime.doPost({ action: 'login', id: '250003', password: 'wrongpassword' });
}
const rateLimitedRes = runtime.doPost({ action: 'login', id: '250003', password: 'plainpassword' });
assert.strictEqual(rateLimitedRes.status, 'error');
assert.strictEqual(rateLimitedRes.message, 'too_many_attempts', '5 failed attempts must trigger rate limit');
console.log('[PASS] 3.4 Rate limiting locks out brute-force attacks after 5 consecutive failures');

// 3.5 Token Verification: verifyToken
const adminUser = { id: '250001', name: 'ADMIN USER', roles: ['ADMIN'] };
const adminToken = runtime.context.generateToken(adminUser, { 'app-po': ['createPO'] }, false);

// Valid verifyToken for PO app
const verifyPORes = runtime.doGet({ action: 'verifyToken', token: adminToken, appId: 'app-tracking' });
assert.strictEqual(verifyPORes.valid, true);
assert.strictEqual(verifyPORes.user.id, '250001');
assert.deepStrictEqual(verifyPORes.user.roles, ['ADMIN']);

// Rejected verifyToken for unauthorized app (TRD user 250003 attempting W5 when only AKRA/ADMIN allowed)
const trdUserToken = runtime.context.generateToken({ id: '250003', name: 'PLAIN USER', roles: ['TRD'] }, {}, false);
const verifyDeniedRes = runtime.doGet({ action: 'verifyToken', token: trdUserToken, appId: 'app-w5' });
assert.strictEqual(verifyDeniedRes.valid, false);
assert.strictEqual(verifyDeniedRes.reason, 'permission_denied');

// Rejected verifyToken when mustChangePassword is true
const mustChangeToken = runtime.context.generateToken({ id: '250002', name: 'AKRA USER', roles: ['AKRA'] }, {}, true);
const verifyPwdChangeRes = runtime.doGet({ action: 'verifyToken', token: mustChangeToken, appId: 'app-w5' });
assert.strictEqual(verifyPwdChangeRes.valid, false);
assert.strictEqual(verifyPwdChangeRes.reason, 'mandatory_password_change_required');

// Rejected verifyToken with tampered signature
const tamperedToken = adminToken.slice(0, -5) + 'xxxxx';
const verifyTampered = runtime.doGet({ action: 'verifyToken', token: tamperedToken });
assert.strictEqual(verifyTampered.valid, false);
assert.strictEqual(verifyTampered.reason, 'invalid_or_expired_token');

console.log('[PASS] 3.5 Token verification correctly authorizes apps, rejects unauthorized roles, enforces password change, and rejects tampered signatures');

// 3.6 Session Refresh
const refreshRes = runtime.doPost({ action: 'refreshSession', token: adminToken, perf: true });
assert.strictEqual(refreshRes.status, 'success');
assert(refreshRes.token, 'Must return fresh refreshed token');
assert(refreshRes.serverTimings, 'Must include serverTimings in perf mode');
assert(refreshRes.appConfig.length >= 2, 'Must return current appConfig');
console.log('[PASS] 3.6 refreshSession validates session, issues fresh token and returns configuration');

// 3.7 Admin Authorization Protection
const unauthorizedSave = runtime.doPost({
  action: 'saveUser',
  token: trdUserToken, // Non-admin user
  id: '250999',
  name: 'HACKER',
  roles: ['ADMIN']
});
assert.strictEqual(unauthorizedSave.status, 'error');
assert(unauthorizedSave.message.includes('Unauthorized'), 'Non-admin user must be rejected from admin actions');

const authorizedSave = runtime.doPost({
  action: 'saveUser',
  token: adminToken,
  id: '250999',
  name: 'NEW STAFF',
  roles: ['WAREHOUSE']
});
assert.strictEqual(authorizedSave.status, 'success');
const userLookup = runtime.context.getUserById(runtime.context.SpreadsheetApp.openById('fixture'), '250999');
assert.strictEqual(userLookup.name, 'NEW STAFF');
assert.deepStrictEqual(JSON.parse(JSON.stringify(userLookup.roles)), ['WAREHOUSE']);
console.log('[PASS] 3.7 Admin mutations strictly enforce requireAdmin authorization guard');

// 3.8 Unified Authorization Transaction & Validation
const currentRevision = runtime.context.authorizationRevisionForRows_(
  runtime.sheets.AppConfig._getRawRows(),
  runtime.sheets.PermConfig._getRawRows()
);

// Incoherent permission test (giving Cashier a PO permission without granting app-tracking access)
const incoherentPayload = {
  action: 'saveAuthorizationConfig',
  token: adminToken,
  appConfig: [
    { id: 'app-tracking', name: 'PO', icon: 'truck', url: 'https://akra-web.github.io/TrackingPO/', roles: ['ADMIN'] }, // No Cashier
    { id: 'app-w5', name: 'W5', icon: 'box', url: 'https://akra-web.github.io/AKRA/', roles: ['ADMIN', 'AKRA'] }
  ],
  rows: [
    { appId: 'app-po', permKey: 'createPO', ADMIN: true, Cashier: true }, // Cashier enabled
    { appId: 'app-po', permKey: 'closePO', ADMIN: true, Cashier: false }
  ],
  authorizationRevision: currentRevision
};
const incoherentSaveRes = runtime.doPost(incoherentPayload);
assert.strictEqual(incoherentSaveRes.status, 'error');
assert(incoherentSaveRes.message.includes('incoherent_authorization'), 'Must reject action permission without app access');
console.log('[PASS] 3.8 saveAuthorizationConfig strictly prevents incoherent permission state');


console.log('\n===============================================================');
console.log('      🌟 ALL MAIN PORTAL & SSO QA TEST SUITES PASSED 100%! 🌟   ');
console.log('===============================================================');
