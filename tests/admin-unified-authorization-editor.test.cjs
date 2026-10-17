const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

test('admin authorization has one unified settings tab and one save control', () => {
  assert.match(html, /id="tab-btn-apps"[\s\S]*?ตั้งค่าสิทธิ์/);
  assert.doesNotMatch(html, /id="tab-btn-perms"/);
  assert.doesNotMatch(html, /id="save-app-config-btn"/);
  assert.doesNotMatch(html, /id="save-perm-config-btn"/);
  assert.match(html, /id="save-role-access-btn"/);
});

test('unified role editor keeps app access and detailed actions together', () => {
  assert.match(html, /กำหนดการเห็นแอปและสิทธิ์ย่อยจากที่เดียว/);
  assert.match(html, /authorization-details/);
  assert.match(html, /เข้าแอป/);
  assert.match(html, /สิทธิ์ย่อย/);
  assert.match(html, /togglePermRole/);
  assert.doesNotMatch(html, /id="app-permission-matrix"/);
  assert.doesNotMatch(html, /id="perm-matrix-body"/);
});

test('admin tab controller only switches between users and unified authorization', () => {
  const start = html.indexOf('switchTab: (tabName) =>');
  const end = html.indexOf('\n            renderUserList:', start);
  assert.ok(start >= 0 && end > start, 'switchTab implementation must exist');
  const source = html.slice(start, end);
  assert.match(source, /\['users','apps'\]/);
  assert.doesNotMatch(source, /perms/);
  assert.doesNotMatch(source, /renderPermMatrix|renderAppMatrix/);
});

test('admin sidebar marks only the displayed tab as current', () => {
  const start = html.indexOf('switchTab: (tabName) =>');
  const end = html.indexOf('\n            renderUserList:', start);
  const nodes = new Map();
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { attrs: {}, classList: { toggle() {} }, setAttribute(key, value) { this.attrs[key] = value; }, removeAttribute(key) { delete this.attrs[key]; } });
    return nodes.get(id);
  };
  const switchTab = vm.runInNewContext('({' + html.slice(start, end) + '}).switchTab', { document: { getElementById: node }, AdminInteractive: { renderRoleAccessEditor() {} } });
  switchTab('apps');
  assert.equal(node('admin-sidebar-permissions').attrs['aria-current'], 'page');
  assert.equal(node('admin-sidebar-users').attrs['aria-current'], undefined);
  switchTab('users');
  assert.equal(node('admin-sidebar-users').attrs['aria-current'], 'page');
  assert.equal(node('admin-sidebar-permissions').attrs['aria-current'], undefined);
});
