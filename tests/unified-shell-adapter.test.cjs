const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

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
assert.match(source, /function hideEmbeddedLogout\(header\)/, 'embedded child logout controls must be hidden');
assert.match(source, /data-akra-shell-child-logout/, 'embedded child logout controls must be removed from layout and accessibility flow');
assert.match(source, /hideEmbeddedLogout\(header\);/);
assert.doesNotMatch(source, /ensureEmbeddedAction\(header, rule, 'logout'/, 'the shell must not inject a logout action into child apps');
assert.doesNotMatch(source, /const EMBEDDED_HEADER_SELECTORS/);
assert.doesNotMatch(source, /const EMBEDDED_ACTION_SELECTORS/);

console.log(`✔ unified shell adapter keeps ${expectedRules.length} header/action mappings scoped to their owning app`);

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
