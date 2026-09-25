const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

test('Main CSP permits only its reviewed inline script and blocks inline handlers', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8').replace(/\r\n/g, '\n');
  const policy = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/)?.[1];
  assert.ok(policy, 'Main must set CSP before loading scripts');
  assert.match(policy, /script-src 'self' https:\/\/static\.line-scdn\.net/);
  assert.match(policy, /object-src 'none'/);
  assert.doesNotMatch(policy, /'unsafe-inline'|'unsafe-eval'|'unsafe-hashes'/);
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i, 'inline event handlers bypass the reviewed script hash');

  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
    .map(match => match[1]).filter(source => source.trim());
  assert.equal(scripts.length, 1, 'review each added inline script before allowing it');
  const hash = createHash('sha256').update(scripts[0], 'utf8').digest('base64');
  assert.ok(policy.includes(`'sha256-${hash}'`), 'CSP hash must match the exact inline script served to browsers');
});
