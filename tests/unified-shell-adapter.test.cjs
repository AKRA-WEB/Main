const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.resolve(__dirname, '../js/unified-shell.js'), 'utf8');
const expectedRules = [
  ['#trd-topbar', '.trd-topbar__actions'],
  ['.gr-topbar', ':scope > div > div > .space-x-2'],
  ['#app-content > nav', ':scope > div > div > div:last-child'],
  ['.returnitem-topbar', '.returnitem-topbar__actions'],
  ['.app-header', ':scope > div > div:last-child'],
  ['#app-shell > header', ':scope > div > div > div:last-child'],
  ['.w5-topbar', ':scope > .w5-topbar-inner'],
  ['.topbar', '.topbar-actions'],
  ['.top-nav', '.nav-controls']
];

for (const [header, action] of expectedRules) {
  assert.match(source, new RegExp(`header: '${escapeRegExp(header)}', action: '${escapeRegExp(action)}'`), `${header} must keep its paired action host`);
}

assert.match(source, /function embeddedActionHost\(header, rule\)/);
assert.match(source, /header\.querySelector\(rule\.action\)/);
assert.match(source, /data-akra-shell-action-group/);
assert.match(source, /createActionGroup: true/);
assert.match(source, /if \(element\.dataset\.akraShellAction\) return element\.dataset\.akraShellAction === type;/, 'injected actions must be recognized by type so the observer remains idempotent');
assert.doesNotMatch(source, /if \(element\.dataset\.akraShellAction\) return false;/, 'injected actions must not be ignored by duplicate detection');
assert.match(source, /function hideEmbeddedAction\(header, type, marker\)/, 'embedded child actions must be managed by the shell');
assert.match(source, /data-akra-shell-child-home/, 'embedded child home controls must be removed before the shell adds its own');
assert.match(source, /data-akra-shell-child-logout/, 'embedded child logout controls must be removed from layout and accessibility flow');
// Execute the actual adapter so renaming its loop variable cannot retire the
// contract: duplicate portal/logout controls leave layout and accessibility,
// page actions remain, and standalone/foreign/inactive documents stay intact.
const adapterFrom = source.indexOf('    const EMBEDDED_HEADER_RULES =');
const adapterTo = source.indexOf('    function init(options)', adapterFrom);
assert.ok(adapterFrom > 0 && adapterTo > adapterFrom, 'actual adapter boundaries must exist');
for (const [headerSelector, actionSelector] of expectedRules) {
  for (const mode of ['embedded', 'standalone', 'foreign', 'inactive']) {
    const origin = 'https://fixture.invalid', styles = [];
    function node() {
      return { children: [], dataset: {}, attrs: {}, hidden: false, tabIndex: 0, textContent: '', className: '', id: '',
        classList: { add() {} }, append(child) { this.children.push(child); }, prepend(child) { this.children.unshift(child); },
        setAttribute(key, value) { this.attrs[key] = String(value); }, getAttribute(key) { return this.attrs[key] || null; },
        addEventListener() {}, matches() { return false; }, querySelector() { return null; } };
    }
    const header = node(), host = node(), home = node(), logout = node(), pageAction = node();
    home.attrs.onclick = 'AkraModule.home()'; logout.id = 'logout-btn'; pageAction.textContent = 'Save draft';
    host.children = [home, logout, pageAction]; header.textContent = 'Page title';
    header.querySelector = selector => selector === actionSelector ? host : null;
    header.querySelectorAll = () => host.children;
    const doc = { location: { origin: mode === 'foreign' ? 'https://foreign.invalid' : origin },
      querySelector: selector => selector === headerSelector ? header : null, querySelectorAll: () => [],
      getElementById: id => styles.find(style => style.id === id), head: { appendChild: style => styles.push(style) },
      createElement: () => node() };
    header.ownerDocument = doc;
    const frame = { contentDocument: doc };
    const context = vm.createContext({ window: { location: { origin } },
      active: mode === 'standalone' ? null : { frame: mode === 'inactive' ? {} : frame },
      panel: { classList: { add() {} } } });
    new vm.Script(source.slice(adapterFrom, adapterTo), { filename: 'actual-unified-shell-header-adapter.js' }).runInContext(context);
    assert.equal(context.adaptEmbeddedHeader(frame), mode === 'embedded', `${headerSelector} ${mode}`);
    for (const control of [home, logout]) {
      assert.equal(control.hidden, mode === 'embedded');
      assert.equal(control.attrs['aria-hidden'], mode === 'embedded' ? 'true' : undefined);
      assert.equal(control.tabIndex, mode === 'embedded' ? -1 : 0);
    }
    assert.equal(pageAction.hidden, false); assert.equal(header.textContent, 'Page title');
    assert.equal(host.children.length, 3, 'adapter must not inject duplicate navigation');
    context.adaptEmbeddedHeader(frame);
    assert.equal(host.children.length, 3); assert.equal(styles.length, mode === 'embedded' ? 1 : 0);
  }
}
assert.match(source, /compactActions: true/);
assert.doesNotMatch(source, /ensureEmbeddedAction\(header, rule, 'logout'/, 'the shell must not inject a logout action into child apps');
assert.doesNotMatch(source, /const EMBEDDED_HEADER_SELECTORS/);
assert.doesNotMatch(source, /const EMBEDDED_ACTION_SELECTORS/);

console.log(`✔ unified shell adapter keeps ${expectedRules.length} header/action mappings scoped to their owning app`);

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
