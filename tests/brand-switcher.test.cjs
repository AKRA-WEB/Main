const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../js/akra-shell-bridge.js'), 'utf8');
const catalog = source.match(/const APP_SWITCHER_CATALOG = Object\.freeze\(([\s\S]*?)\);/)[0];
const start = source.indexOf('    function switcherEntries()');
const end = source.indexOf('    function ensureSwitcherStyles()', start);
function entries(user, cached) {
  const context = vm.createContext({
    standaloneUser: null, standaloneAppId: 'app-kpi',
    switcherStorageJson: key => key === 'akra_user_data' ? user : cached
  });
  vm.runInContext(catalog + '\n' + source.slice(start, end) + '\nthis.result = switcherEntries();', context);
  return JSON.parse(JSON.stringify(context.result));
}
const cached = [
  { id: 'app-kpi', name: 'KPI Tracker', roles: ['AKRA'] },
  { id: 'app-gr', name: 'ตรวจรับเข้าสินค้า (GR)', roles: ['AKRA'], isActive: false }
];
test('signed app assignments keep canonical labels despite a pre-rename server/cache catalog', () => {
  const result = entries({ roles: ['AKRA'], apps: ['app-kpi', 'app-gr'] }, cached);
  assert.equal(result.length, 1);
  assert.equal(result[0].label, 'งานและทีม');
  assert.equal(result[0].path, '/KPITRACKER/');
});
test('legacy role catalog keeps canonical labels and still denies unassigned or inactive modules', () => {
  assert.deepEqual(entries({ roles: ['TRD'] }, cached), []);
  const result = entries({ roles: ['AKRA'] }, cached);
  assert.equal(result.length, 1);
  assert.equal(result[0].label, 'งานและทีม');
  assert.equal(result[0].id, 'app-kpi');
});
