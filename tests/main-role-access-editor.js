const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const gas = fs.readFileSync(path.join(__dirname, '..', 'Code.gs'), 'utf8');

assert(html.includes('id="role-access-selector"'), 'admin UI must offer a role-focused selector');
assert(html.includes('id="role-access-editor"'), 'admin UI must show app entry and action permissions together');
assert(html.includes('saveRoleAccess: async () =>'), 'admin UI must offer one save operation for role access');
assert(html.includes('authorizationLoaded: false'), 'authorization editing must start disabled until authoritative data loads');
assert(html.includes('"app-po": "app-tracking"'), 'Main client dependency map must attach PO permissions to the registered TrackingPO app');

const fetchStart = html.indexOf('fetchAdminData: async (force = false) =>');
const fetchEnd = html.indexOf('\n            init: () =>', fetchStart);
const fetchSource = html.slice(fetchStart, fetchEnd);
assert(fetchSource.includes('Array.isArray(data.appConfig)'), 'Admin load must require authoritative AppConfig');
assert(fetchSource.includes('state.authorizationLoaded = true'), 'Admin load must enable editing only after authoritative success');
assert(fetchSource.includes('state.authorizationLoaded = false'), 'pending or failed Admin loads must keep authorization editing disabled');
assert(fetchSource.includes('state.authorizationSaving && !force'), 'external Admin refresh must not race an in-flight authorization save');
assert(html.includes("'refresh-data-btn', 'role-access-selector'"), 'the global authorization save gate must disable manual refresh');
const refreshClickStart = html.indexOf("document.getElementById('refresh-data-btn').addEventListener('click'");
const refreshClickEnd = html.indexOf('\n                });', refreshClickStart);
assert(html.slice(refreshClickStart, refreshClickEnd).includes('loadedFromServer === null'), 'a cancelled or obsolete Admin reload must not be reported as a server failure');

const sharedSaveStart = html.indexOf('saveAuthorizationChanges: async (button, successMessage, logDetails) =>');
const sharedSaveEnd = html.indexOf('\n            saveRoleAccess:', sharedSaveStart);
const sharedSaveSource = html.slice(sharedSaveStart, sharedSaveEnd);
assert(sharedSaveStart >= 0 && sharedSaveEnd > sharedSaveStart, 'authorization editor must use one shared save flow');
assert(sharedSaveSource.includes('action: "saveAuthorizationConfig"'), 'shared save must use one authorization request');
assert(!sharedSaveSource.includes('Promise.all'), 'shared save must not split one logical save across requests');
assert(sharedSaveSource.includes('requireAuthorizationReady'), 'shared save must reject pending or failed authorization loads');
assert(sharedSaveSource.includes('authorizationRevision'), 'shared save must include the authoritative revision');

const appMatrixStart = html.indexOf('renderAppMatrix: () =>');
const appMatrixEnd = html.indexOf('\n            toggleMatrixRole:', appMatrixStart);
const appMatrixSource = html.slice(appMatrixStart, appMatrixEnd);
assert(appMatrixSource.includes("authorizationControlLabel('app'"), 'every advanced app-access switch must have a specific accessible name');
assert(appMatrixSource.includes('authorization-switch'), 'advanced app-access switches must opt into the shared focus treatment');

const permMatrixStart = html.indexOf('renderPermMatrix: () =>');
const permMatrixEnd = html.indexOf('\n            togglePermRole:', permMatrixStart);
const permMatrixSource = html.slice(permMatrixStart, permMatrixEnd);
assert(permMatrixSource.includes("authorizationControlLabel('permission'"), 'every advanced permission switch must have a specific accessible name');
assert(permMatrixSource.includes('authorization-switch'), 'advanced permission switches must opt into the shared focus treatment');
assert(
  html.includes('.authorization-switch:focus-visible + .authorization-switch-track'),
  'authorization switches must expose a visible native focus indicator without relying on absent Tailwind utilities'
);

const labelHelperStart = html.indexOf('function authorizationControlLabel(');
const labelHelperEnd = html.indexOf('\n        function safeAppUrl', labelHelperStart);
assert(labelHelperStart >= 0 && labelHelperEnd > labelHelperStart, 'authorization controls must share one accessible-label helper');
const labelClient = vm.createContext({
  String,
  safeIdentifier(value, fallback = '') {
    const text = String(value ?? '').trim();
    return /^[A-Za-z0-9_-]{1,80}$/.test(text) ? text : fallback;
  }
});
vm.runInContext(`${html.slice(labelHelperStart, labelHelperEnd)}; globalThis.authorizationControlLabel = authorizationControlLabel;`, labelClient);
const duplicateNameApps = [
  { id: 'app-po', name: 'Operations' },
  { id: 'app-gr', name: 'Operations' }
];
const duplicateLabelRoles = [
  { val: 'SUPERVISOR', label: 'หัวหน้างาน' },
  { val: 'APPROVER', label: 'หัวหน้างาน' }
];
const appAccessLabels = duplicateNameApps.flatMap(app => duplicateLabelRoles.map(role => (
  labelClient.authorizationControlLabel('app', app, null, role)
)));
assert.strictEqual(new Set(appAccessLabels).size, appAccessLabels.length, 'app-access labels must stay unique when app and role display names repeat');
const permissionLabels = duplicateNameApps.map(app => labelClient.authorizationControlLabel(
  'permission', app, { key: 'approve', label: 'อนุมัติ' }, duplicateLabelRoles[0]
));
assert.strictEqual(new Set(permissionLabels).size, permissionLabels.length, 'permission labels must stay unique across app namespaces');
assert(permissionLabels[0].includes('app-po:approve') && permissionLabels[0].includes('SUPERVISOR'), 'permission labels must expose stable app, permission, and role context');

const adminDataStart = gas.indexOf('function buildAdminData(');
const adminDataEnd = gas.indexOf('\n// ============================================================', adminDataStart);
const adminDataSource = gas.slice(adminDataStart, adminDataEnd);
assert(adminDataSource.includes('appConfig: appConfigData'), 'Admin data must return authoritative AppConfig');
assert(adminDataSource.includes('authorizationRevision:'), 'Admin data must return the matching authorization revision');

const lockEvents = [];
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
  Utilities: {
    DigestAlgorithm: { SHA_256: 'SHA_256' },
    Charset: { UTF_8: 'UTF_8' },
    computeDigest(_algorithm, value) { return Array.from(crypto.createHash('sha256').update(String(value)).digest()); },
    base64EncodeWebSafe(bytes) { return Buffer.from(bytes).toString('base64url'); }
  },
  LockService: {
    getScriptLock() {
      return {
        waitLock() { lockEvents.push('wait'); },
        releaseLock() { lockEvents.push('release'); }
      };
    }
  },
  CacheService: {
    getScriptCache() {
      return {
        get() { return null; },
        put() {},
        remove(key) { removedCacheKeys.push(key); }
      };
    }
  },
  ContentService: {
    MimeType: { JSON: 'application/json' },
    createTextOutput(text) {
      return { text, setMimeType() { return this; } };
    }
  }
});
vm.runInContext(gas, context);
context.getRoleConfig = () => [{ val: 'ADMIN' }, { val: 'Cashier' }];

function cloneRows(rows) {
  return rows.map(row => [...row]);
}

function createSheet(initialRows, failWriteNumber = 0) {
  let rows = cloneRows(initialRows);
  let writeCount = 0;
  const failedWrites = Array.isArray(failWriteNumber) ? failWriteNumber : [failWriteNumber];
  return {
    getDataRange() { return { getValues: () => cloneRows(rows) }; },
    clearContents() { rows = []; },
    getRange() {
      return {
        setValues(nextRows) {
          writeCount += 1;
          if (failedWrites.includes(writeCount)) throw new Error('controlled_write_failure');
          rows = cloneRows(nextRows);
        }
      };
    },
    rows: () => cloneRows(rows)
  };
}

const oldAppRows = [
  ['AppID', 'Name', 'Icon', 'URL', 'Roles'],
  ['app-tracking', 'PO', 'box', 'https://akra-web.github.io/TrackingPO/', 'ADMIN']
];
const oldPermRows = [
  ['AppID', 'PermKey', 'ADMIN', 'Cashier'],
  ['app-po', 'createPO', true, false]
];
const oldRevision = context.authorizationRevisionForRows_(oldAppRows, oldPermRows);
const adminData = context.buildAdminData({
  getSheetByName(name) {
    if (name === 'User') return { getDataRange: () => ({ getValues: () => [['ID', 'Name', 'Roles'], ['U1', 'Admin', 'ADMIN']] }) };
    if (name === 'AppConfig') return { getDataRange: () => ({ getValues: () => cloneRows(oldAppRows) }) };
    if (name === 'PermConfig') return { getDataRange: () => ({ getValues: () => cloneRows(oldPermRows) }) };
    return null;
  }
});
assert.strictEqual(adminData.appConfig[0].id, 'app-tracking', 'Admin data must use authoritative AppConfig rows');
assert.strictEqual(adminData.authorizationRevision, oldRevision, 'Admin data revision must match the same authoritative matrices');
lockEvents.length = 0;
const appSheet = createSheet(oldAppRows);
const permSheet = createSheet(oldPermRows, 1);
const spreadsheet = {
  getSheetByName(name) { return name === 'AppConfig' ? appSheet : name === 'PermConfig' ? permSheet : null; },
  insertSheet() { throw new Error('unexpected insert'); }
};

assert.throws(
  () => context.saveAuthorizationConfig_(spreadsheet, [{
    id: 'app-tracking', name: 'PO', icon: 'box', url: 'https://akra-web.github.io/TrackingPO/', roles: ['Cashier']
  }], [{ appId: 'app-po', permKey: 'createPO', Cashier: true }], oldRevision),
  /controlled_write_failure/,
  'controlled second-sheet failure must surface to the caller'
);
assert.deepStrictEqual(appSheet.rows(), oldAppRows, 'partial failure must restore AppConfig');
assert.deepStrictEqual(permSheet.rows(), oldPermRows, 'partial failure must restore PermConfig');
assert.deepStrictEqual(lockEvents, ['wait', 'release'], 'unified save must use one script lock');
assert.deepStrictEqual(removedCacheKeys, [], 'failed save must keep existing authorization caches');

const rollbackFailureAppSheet = createSheet(oldAppRows);
const rollbackFailurePermSheet = createSheet(oldPermRows, [1, 2]);
assert.throws(
  () => context.saveAuthorizationConfig_({
    getSheetByName(name) { return name === 'AppConfig' ? rollbackFailureAppSheet : name === 'PermConfig' ? rollbackFailurePermSheet : null; },
    insertSheet() { throw new Error('unexpected insert'); }
  }, [{
    id: 'app-tracking', name: 'PO', icon: 'box', url: 'https://akra-web.github.io/TrackingPO/', roles: ['Cashier']
  }], [{ appId: 'app-po', permKey: 'createPO', Cashier: true }], oldRevision),
  /authorization_rollback_failed/,
  'rollback failure must surface a distinct authorization error'
);
assert.deepStrictEqual(
  removedCacheKeys.sort(),
  ['main_app_config_v1', 'main_authorization_config_v1', 'main_perm_config_v1'],
  'rollback failure must invalidate every authorization cache because persisted state may be partial'
);
assert((gas.match(/failAuthorizationRollback_\(\)/g) || []).length >= 4, 'unified and both legacy rollback paths must share cache-safe failure handling');
removedCacheKeys.length = 0;

const savedAppSheet = createSheet(oldAppRows);
const savedPermSheet = createSheet(oldPermRows);
const savedRevision = context.saveAuthorizationConfig_({
  getSheetByName(name) { return name === 'AppConfig' ? savedAppSheet : name === 'PermConfig' ? savedPermSheet : null; },
  insertSheet() { throw new Error('unexpected insert'); }
}, [{
  id: 'app-tracking', name: 'PO', icon: 'box', url: 'https://akra-web.github.io/TrackingPO/', roles: ['Cashier']
}], [{ appId: 'app-po', permKey: 'createPO', Cashier: true }], oldRevision);
assert(String(savedAppSheet.rows()[1][4]).split(',').includes('ADMIN'), 'successful unified save must persist ADMIN app access');
assert.strictEqual(savedPermSheet.rows()[1][3], true, 'successful unified save must persist action access');
assert.strictEqual(
  savedRevision,
  context.authorizationRevisionForRows_(savedAppSheet.rows(), savedPermSheet.rows()),
  'successful unified save must return the exact persisted authorization revision'
);
assert.deepStrictEqual(
  removedCacheKeys.sort(),
  ['main_app_config_v1', 'main_authorization_config_v1', 'main_perm_config_v1'],
  'successful unified save must invalidate both authorization caches'
);

function callLegacyRollbackFailure(action, appFailureWrites, permFailureWrites) {
  removedCacheKeys.length = 0;
  const legacyAppSheet = createSheet(oldAppRows, appFailureWrites);
  const legacyPermSheet = createSheet(oldPermRows, permFailureWrites);
  context.SpreadsheetApp = {
    openById() {
      return {
        getSheetByName(name) { return name === 'AppConfig' ? legacyAppSheet : name === 'PermConfig' ? legacyPermSheet : null; },
        insertSheet() { throw new Error('unexpected insert'); }
      };
    }
  };
  context.requireAdmin = () => ({ id: 'U1', roles: ['ADMIN'] });
  context.__event = {
    postData: {
      contents: JSON.stringify(action === 'saveAppConfig'
        ? {
            action,
            token: 'fixture-token',
            appConfig: [{ id: 'app-tracking', name: 'PO', icon: 'box', url: 'https://akra-web.github.io/TrackingPO/', roles: ['ADMIN'] }]
          }
        : {
            action,
            token: 'fixture-token',
            rows: [{ appId: 'app-po', permKey: 'createPO', ADMIN: true, Cashier: false }]
          })
    }
  };
  const output = vm.runInContext('doPost(__event)', context);
  const result = JSON.parse(output.text);
  assert(result.message.includes('authorization_rollback_failed'), `${action} must surface rollback failure`);
  assert.deepStrictEqual(
    removedCacheKeys.sort(),
    ['main_app_config_v1', 'main_authorization_config_v1', 'main_perm_config_v1'],
    `${action} rollback failure must invalidate every authorization cache`
  );
}

callLegacyRollbackFailure('saveAppConfig', [1, 2], 0);
callLegacyRollbackFailure('savePermConfig', 0, [1, 2]);

assert.throws(
  () => context.saveAuthorizationConfig_(spreadsheet, [], [], oldRevision),
  /incomplete_authorization_config/,
  'empty full-matrix submissions must not erase existing authorization rows'
);
assert.throws(
  () => context.saveAuthorizationConfig_(spreadsheet, [{
    id: 'app-tracking', name: 'PO', icon: 'box', url: 'https://akra-web.github.io/TrackingPO/', roles: ['Cashier']
  }], [{ appId: 'app-po', permKey: 'createPO', Cashier: true }], 'stale-revision'),
  /stale_authorization_config/,
  'stale full-matrix submissions must not overwrite newer authorization data'
);
assert.throws(
  () => context.assertAuthorizationKeysUnchanged_(oldAppRows, [oldAppRows[0]], [0]),
  /incomplete_authorization_config/,
  'legacy compatibility saves must not remove configured app identifiers'
);

const normalizedAppRows = vm.runInContext(`buildAppConfigRows_([{
  id: 'app-tracking', name: 'PO', icon: 'box', url: 'https://akra-web.github.io/TrackingPO/', roles: ['Cashier']
}])`, context);
assert(String(normalizedAppRows[1][4]).split(',').includes('ADMIN'), 'AppConfig must always retain ADMIN access');

const trackingAppRows = vm.runInContext(`buildAppConfigRows_([{
  id: 'app-tracking', name: 'PO', icon: 'box', url: 'https://akra-web.github.io/TrackingPO/', roles: ['Cashier']
}])`, context);
const trackingPermRows = [
  ['AppID', 'PermKey', 'ADMIN', 'Cashier'],
  ['app-po', 'createPO', true, true]
];
assert.strictEqual(context.requiredAppIdForPermission_('app-po'), 'app-tracking', 'PO permissions must resolve to the registered TrackingPO entry');
assert.doesNotThrow(
  () => context.validateAuthorizationRows_(trackingAppRows, trackingPermRows),
  'server validation must accept app-po permissions when app-tracking entry access is present'
);

assert.throws(
  () => context.validateAuthorizationRows_(
    normalizedAppRows.map(row => [...row.slice(0, 4), row === normalizedAppRows[0] ? row[4] : 'ADMIN']),
    [['AppID', 'PermKey', 'ADMIN', 'Cashier'], ['app-po', 'createPO', true, true]]
  ),
  /incoherent_authorization/,
  'action permission without required app access must be rejected server-side'
);

const reconcileStart = html.indexOf('function reconcileAuthorizationDependencies(');
const reconcileEnd = html.indexOf('\n        function authorizationControlLabel', reconcileStart);
assert(reconcileStart >= 0 && reconcileEnd > reconcileStart, 'legacy authorization must be reconciled before Admin can save it');
const reconcileClient = vm.createContext({ PERMISSION_APP_DEPENDENCIES: { 'app-po': 'app-tracking' } });
vm.runInContext(`${html.slice(reconcileStart, reconcileEnd)}; globalThis.reconcileAuthorizationDependencies = reconcileAuthorizationDependencies;`, reconcileClient);
const legacyApps = [{ id: 'app-tracking', roles: ['ADMIN'] }];
const legacyPerms = [{ appId: 'app-po', permKey: 'createPO', ADMIN: true, SUPERVISOR: true }];
const legacyRepairs = reconcileClient.reconcileAuthorizationDependencies(
  legacyApps,
  legacyPerms,
  [{ val: 'ADMIN' }, { val: 'SUPERVISOR' }]
);
assert.deepStrictEqual(legacyApps[0].roles, ['ADMIN', 'SUPERVISOR'], 'legacy action grants must retain the action and add required app access');
assert.strictEqual(legacyPerms[0].SUPERVISOR, true, 'legacy reconciliation must not revoke an existing action grant');
assert.strictEqual(legacyRepairs.length, 1, 'legacy reconciliation must report each app-access repair for review');

const dependencyStart = html.indexOf('getDependentPermissions:');
const dependencyEnd = html.indexOf('\n            saveRoleAccess:', dependencyStart);
const clientState = {
  authorizationLoaded: true,
  authorizationSaving: false,
  authorizationDirty: false,
  appConfig: [{ id: 'app-tracking', roles: ['ADMIN', 'Cashier'] }],
  permRows: [{ appId: 'app-po', permKey: 'createPO', ADMIN: true, Cashier: true }]
};
const confirmMessages = [];
let confirmResult = false;
const client = vm.createContext({
  state: clientState,
  PERMISSION_APP_DEPENDENCIES: { 'app-po': 'app-tracking' },
  document: { getElementById() { return null; } },
  confirm(message) { confirmMessages.push(message); return confirmResult; }
});
vm.runInContext(`const AdminInteractive = {
  ${html.slice(dependencyStart, dependencyEnd)}
  renderRoleAccessEditor() {}, renderAppMatrix() {}, renderPermMatrix() {}
}; globalThis.editor = AdminInteractive;`, client);
vm.runInContext(`editor.setAppRole('app-tracking', 'Cashier', false)`, client);
assert(clientState.appConfig[0].roles.includes('Cashier'), 'cancelled dependency confirmation must retain app access');
assert.strictEqual(clientState.permRows[0].Cashier, true, 'cancelled dependency confirmation must retain actions');
assert(confirmMessages[0].includes('createPO'), 'confirmation must name affected actions');

confirmResult = true;
vm.runInContext(`editor.setAppRole('app-tracking', 'Cashier', false)`, client);
assert(!clientState.appConfig[0].roles.includes('Cashier'), 'confirmed disable must remove app access');
assert.strictEqual(clientState.permRows[0].Cashier, false, 'confirmed disable must clear dependent actions');
assert.strictEqual(clientState.authorizationDirty, true, 'authorization changes must mark the editor dirty');

clientState.authorizationDirty = false;
clientState.authorizationSaving = true;
vm.runInContext(`editor.setAppRole('app-tracking', 'Cashier', true)`, client);
assert(!clientState.appConfig[0].roles.includes('Cashier'), 'app access must not mutate while an authorization save is in flight');
assert.strictEqual(clientState.authorizationDirty, false, 'blocked in-flight edits must not mark the editor dirty');
clientState.authorizationSaving = false;

const toggleStart = html.indexOf('togglePermRole:');
const toggleEnd = html.indexOf('\n            savePermConfig:', toggleStart);
clientState.appConfig[0].roles = ['ADMIN'];
vm.runInContext(`editor.togglePermRole = ({ ${html.slice(toggleStart, toggleEnd)} }).togglePermRole`, client);
vm.runInContext(`editor.togglePermRole('app-po', 'createPO', 'Cashier', true)`, client);
assert(clientState.appConfig[0].roles.includes('Cashier'), 'enabling an action must auto-enable required app access');

for (const methodName of ['saveRoleAccess', 'saveAppConfig', 'savePermConfig']) {
  const methodStart = html.indexOf(`${methodName}: async () =>`);
  const methodEnd = html.indexOf('\n            },', methodStart) + '\n            },'.length;
  assert(html.slice(methodStart, methodEnd).includes('saveAuthorizationChanges'), `${methodName} must delegate to the shared save flow`);
}

async function verifyLatestAdminLoadWins() {
  const deferredLoads = [];
  const discardConfirmMessages = [];
  const storageWrites = [];
  const adminToasts = [];
  let allowDirtyDiscard = true;
  const loadState = {
    users: {},
    appConfig: [],
    roleConfig: [],
    permRows: [],
    authorizationLoaded: true,
    authorizationSaving: false,
    authorizationDirty: false,
    authorizationRevision: 'initial-revision',
    sessionEpoch: 1,
    sessionToken: 'admin-session-token'
  };
  const loadingClassList = { add() {}, remove() {} };
  const loadClient = vm.createContext({
    console,
    state: loadState,
    PERMISSION_APP_DEPENDENCIES: { 'app-po': 'app-tracking' },
    API: {
      postAction() {
        return new Promise((resolve, reject) => deferredLoads.push({ resolve, reject }));
      }
    },
    UI: { showToast(message, type) { adminToasts.push([message, type]); }, switchSection() {} },
    safeStorage: {
      getItem() { return null; },
      setItem(key, value) { storageWrites.push([key, value]); }
    },
    CONFIG: { STORAGE_USER_DB: 'users', STORAGE_APP_CONFIG: 'apps' },
    document: {
      getElementById(id) {
        return id === 'list-loading-state' ? { classList: loadingClassList } : null;
      }
    },
    confirm(message) {
      discardConfirmMessages.push(message);
      return allowDirtyDiscard;
    }
  });
  vm.runInContext(`${html.slice(reconcileStart, reconcileEnd)};`, loadClient);
  vm.runInContext(`const AdminInteractive = {
    adminDataLoadEpoch: 0,
    syncAuthorizationControls() {}, renderUserList() {}, setupAppPreviewGrid() {},
    renderRoleAccessEditor() {}, renderAppMatrix() {}, renderPermMatrix() {},
    ${fetchSource}
  }; globalThis.editor = AdminInteractive;`, loadClient);

  const firstLoad = vm.runInContext('editor.fetchAdminData()', loadClient);
  const secondLoad = vm.runInContext('editor.fetchAdminData()', loadClient);
  const payload = (name, revision) => ({
    status: 'success',
    users: { U1: { name: 'Reviewer', roles: ['ADMIN'] } },
    appConfig: [{ id: 'app-tracking', name, roles: ['ADMIN'] }],
    roleConfig: [{ val: 'ADMIN' }, { val: 'Cashier' }],
    permRows: [{ appId: 'app-po', permKey: 'createPO', ADMIN: true, Cashier: true }],
    authorizationRevision: revision
  });

  deferredLoads[1].resolve(payload('newer response', 'newer-revision'));
  await secondLoad;
  assert(loadState.appConfig[0].roles.includes('Cashier'), 'authoritative legacy data must gain required app access before the Admin saves');
  assert.strictEqual(loadState.authorizationDirty, true, 'a repaired legacy matrix must require explicit Admin review and save');
  assert(adminToasts.some(([message, type]) => type === 'warning' && message.includes('กรุณาตรวจสอบและบันทึก')), 'the Admin must be warned that legacy access was repaired but not yet saved');
  loadState.appConfig[0].roles = ['ADMIN'];
  loadState.authorizationDirty = true;
  deferredLoads[0].resolve(payload('older response', 'older-revision'));
  await firstLoad;

  assert.strictEqual(loadState.appConfig[0].name, 'newer response', 'an older Admin response must not replace the latest loaded matrix');
  assert.deepStrictEqual(loadState.appConfig[0].roles, ['ADMIN'], 'an older Admin response must not discard newer local authorization edits');
  assert.strictEqual(loadState.authorizationDirty, true, 'an ignored older response must not clear authorization dirty state');
  assert.strictEqual(loadState.authorizationRevision, 'newer-revision', 'an older Admin response must not restore its stale revision');

  allowDirtyDiscard = false;
  const loadCountBeforeCancelledRefresh = deferredLoads.length;
  const cancelledRefresh = vm.runInContext('editor.fetchAdminData()', loadClient);
  assert.strictEqual(deferredLoads.length, loadCountBeforeCancelledRefresh, 'a cancelled dirty reload must not start another Admin request');
  assert.strictEqual(await cancelledRefresh, null, 'a cancelled dirty reload must report a no-op rather than a server failure');
  assert(discardConfirmMessages.at(-1).includes('ยังไม่ได้บันทึก'), 'dirty reload confirmation must explain that unsaved authorization edits will be discarded');
  assert.strictEqual(loadState.authorizationDirty, true, 'a cancelled dirty reload must preserve dirty state');

  allowDirtyDiscard = true;
  loadState.authorizationDirty = false;
  const olderFailedLoad = vm.runInContext('editor.fetchAdminData()', loadClient);
  const latestSuccessfulLoad = vm.runInContext('editor.fetchAdminData()', loadClient);
  deferredLoads[3].resolve(payload('latest after failure', 'latest-after-failure-revision'));
  await latestSuccessfulLoad;
  deferredLoads[2].reject(new Error('controlled stale load failure'));
  await olderFailedLoad;
  assert.strictEqual(loadState.authorizationLoaded, true, 'an older failed request must not disable a newer successful Admin load');
  assert.strictEqual(loadState.appConfig[0].name, 'latest after failure', 'an older failed request must not replace the latest Admin state');
  assert.strictEqual(loadState.authorizationRevision, 'latest-after-failure-revision', 'an older failed request must not clear the latest revision');

  const priorSessionLoad = vm.runInContext('editor.fetchAdminData()', loadClient);
  loadState.sessionEpoch += 1;
  loadState.sessionToken = 'next-session-token';
  loadState.authorizationLoaded = false;
  loadState.authorizationRevision = null;
  loadState.appConfig = [{ id: 'app-tracking', name: 'next session state', roles: ['ADMIN'] }];
  const storageWriteCountBeforePriorSessionResponse = storageWrites.length;
  deferredLoads[4].resolve(payload('prior session response', 'prior-session-revision'));
  await priorSessionLoad;
  assert.strictEqual(loadState.authorizationLoaded, false, 'a prior-session Admin response must not re-enable authorization editing');
  assert.strictEqual(loadState.appConfig[0].name, 'next session state', 'a prior-session Admin response must not replace the next session state');
  assert.strictEqual(loadState.authorizationRevision, null, 'a prior-session Admin response must not restore its revision');
  assert.strictEqual(storageWrites.length, storageWriteCountBeforePriorSessionResponse, 'a prior-session Admin response must not repopulate cached Admin data');
}

async function verifySharedSaveGate() {
  let resolveSave;
  const requestSequence = [];
  const saveState = {
    authorizationLoaded: true,
    authorizationSaving: false,
    authorizationDirty: true,
    authorizationRevision: 'revision-1',
    appConfig: [{ id: 'app-tracking', roles: ['ADMIN', 'Cashier'] }],
    permRows: [{ appId: 'app-po', permKey: 'createPO', ADMIN: true, Cashier: true }],
    sessionToken: 'old-token'
  };
  const button = { innerHTML: 'Save', disabled: false };
  const saveClient = vm.createContext({
    state: saveState,
    __button: button,
    API: {
      postAction(payload) {
        requestSequence.push({ action: payload.action, token: saveState.sessionToken });
        if (payload.action === 'saveAuthorizationConfig') {
          return new Promise(resolve => { resolveSave = resolve; });
        }
        return Promise.resolve({ status: 'success' });
      },
      sendLog() { requestSequence.push({ action: 'log', token: saveState.sessionToken }); }
    },
    App: {
      async refreshSession() {
        requestSequence.push({ action: 'refreshSession', token: saveState.sessionToken });
        saveState.sessionToken = 'new-token';
        return true;
      }
    },
    UI: { showToast() {} },
    safeStorage: { setItem() {} },
    CONFIG: { STORAGE_APP_CONFIG: 'app-config' },
    lucide: { createIcons() {} }
  });
  vm.runInContext(`const AdminInteractive = {
    editingUserId: null,
    requireAuthorizationReady() { return true; },
    syncAuthorizationControls() {},
    handleAuthorizationSaveError() { throw new Error('unexpected save failure'); },
    renderRoleAccessEditor() {}, renderAppMatrix() {}, renderPermMatrix() {},
    setupAppPreviewGrid() {}, updateAppPreview() {},
    ${html.slice(sharedSaveStart, sharedSaveEnd)}
  }; globalThis.editor = AdminInteractive;`, saveClient);

  const pendingSave = vm.runInContext(`editor.saveAuthorizationChanges(__button, 'saved', 'log')`, saveClient);
  assert.strictEqual(saveState.authorizationSaving, true, 'shared save must lock the whole authorization editor before awaiting the request');
  resolveSave({ authorizationRevision: 'revision-2' });
  await pendingSave;
  assert.strictEqual(saveState.authorizationSaving, false, 'shared save must unlock the editor after completion');
  assert.strictEqual(saveState.authorizationDirty, false, 'successful shared save must clear dirty state');
  assert.strictEqual(saveState.authorizationRevision, 'revision-2', 'successful shared save must advance the authoritative revision');
  await saveClient.API.postAction({ action: 'getAdminData' });
  assert.deepStrictEqual(
    requestSequence,
    [
      { action: 'saveAuthorizationConfig', token: 'old-token' },
      { action: 'refreshSession', token: 'old-token' },
      { action: 'log', token: 'new-token' },
      { action: 'getAdminData', token: 'new-token' }
    ],
    'authorization save must refresh the JWT before logging or any follow-up Admin action'
  );
}

verifyLatestAdminLoadWins().then(verifySharedSaveGate).then(() => {
  console.log('PASS main-role-access-editor: Admin-load races, dirty reloads, unified save rollback, ADMIN, dependency, and in-flight save invariants pass');
}).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
