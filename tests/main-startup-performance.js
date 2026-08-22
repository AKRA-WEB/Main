const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const version = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'version.json'), 'utf8')).version;
const lucideAsset = path.join(__dirname, '..', 'assets', 'lucide-0.468.0.min.js');

assert(html.includes(`const CURRENT_VERSION = "${version}"`), 'Main index.html and version.json must match');
assert(!html.includes('lucide@latest'), 'Main must not load an unpinned Lucide release');
assert(html.includes('src="assets/lucide-0.468.0.min.js" defer'), 'Main must defer its pinned same-origin Lucide asset');
assert(fs.existsSync(lucideAsset), 'the pinned Lucide asset must be tracked with Main');
const initStart = html.indexOf('init: async () =>');
const initEnd = html.indexOf('\n            handleLogin:', initStart);
const initSource = html.slice(initStart, initEnd);

assert(initStart >= 0, 'Main must define startup initialization');
assert(!initSource.includes('await checkAppVersion()'), 'cached UI must not wait for version.json');
assert(initSource.includes('setTimeout(checkAppVersion, 0)'), 'version checking must still run after cached UI renders');
assert(html.includes('rel="preconnect" href="https://hgxrrskztbpejirrdpbq.supabase.co"'), 'Main must preconnect its critical API origin');
assert(html.includes('media="print" onload="this.media=\'all\'"'), 'web fonts must not block Main first paint');
assert(/<script[^>]+src="assets\/lucide-0\.468\.0\.min\.js"[^>]+defer/.test(html), 'pinned Lucide must not block HTML parsing');

const inlineScripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)];
assert(inlineScripts.length > 0, 'Main index.html must contain an inline application script');
inlineScripts.forEach((match, index) => new vm.Script(match[1], { filename: `main-inline-${index}.js` }));

console.log('PASS main-startup-performance: cached Main UI is not gated by version network latency');
