// Fake clock/events and synthetic JWTs only. No network or database access.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
function fixture() {
    let now = 1800000000000, serial = 0, busy = false, expired = 0, warnings = 0;
    const timers = new Map(), events = {};
    const target = scope => ({ addEventListener(name, fn) { (events[scope + name] ||= new Set()).add(fn); },
        removeEventListener(name, fn) { events[scope + name]?.delete(fn); } });
    const document = {...target('doc:'), hidden: false};
    const window = target('win:');
    const context = vm.createContext({window, document, atob: s => Buffer.from(s, 'base64').toString('binary'),
        Date: {now: () => now}, setTimeout(fn, delay) { timers.set(++serial, {fn, at: now + delay}); return serial; }, clearTimeout(id) { timers.delete(id); }});
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/session-expiry.js'), 'utf8'), context);
    const token = exp => 'e30.' + Buffer.from(JSON.stringify({exp})).toString('base64url') + '.fixture';
    let current = token(now + 600000);
    const watcher = window.AkraSessionExpiry.watch({getToken: () => current, isBusy: () => busy,
        onExpire: () => expired++, onWarning: () => warnings++});
    return {api: window.AkraSessionExpiry, watcher, token, timers, events, document,
        setToken: value => current = value, setBusy: value => busy = value,
        advance(ms) { now += ms; }, fire(name) { for (const fn of events[name] || []) fn(); },
        drain() { for (const [id, t] of [...timers]) if (t.at <= now) {timers.delete(id); t.fn();} },
        get now() {return now;}, get expired() {return expired;}, get warnings() {return warnings;} };
}
test('warns before expiry, expires automatically at boundary without refresh and retires listeners', () => {
    const f = fixture(); f.advance(300000); f.drain(); assert.equal(f.warnings, 1);
    f.watcher.check(); assert.equal(f.warnings, 1);
    f.advance(300000); f.drain(); assert.equal(f.expired, 1); assert.equal(f.timers.size, 0);
    f.fire('win:focus'); assert.equal(f.expired, 1);
});
test('seconds and milliseconds are supported; already expired/malformed tokens cannot pass', () => {
    const f = fixture();
    assert.equal(f.api.isExpired(f.token(f.now / 1000)), true);
    assert.equal(f.api.isExpired(f.token(f.now + 1)), false);
    for (const exp of [null, 'invalid', 0, -1]) assert.equal(f.api.isExpired(f.token(exp)), true);
    assert.equal(f.api.isExpired('broken'), true); f.watcher.stop();
});
for (const event of ['win:focus', 'win:pageshow', 'doc:visibilitychange']) test('sleep/resume catches expiry immediately on ' + event, () => {
    const f = fixture(); f.advance(700000); f.fire(event); assert.equal(f.expired, 1);
});
test('pending mutations settle before retirement; no operation is retried', () => {
    const f = fixture(); f.setBusy(true); f.advance(700000); assert.equal(f.watcher.check(), false);
    assert.equal(f.expired, 0); f.setBusy(false); f.advance(1000); f.drain(); assert.equal(f.expired, 1);
});
test('replacement token is re-read; old deadline cannot expire the new session', () => {
    const f = fixture(); f.advance(590000); f.setToken(f.token(f.now + 900000)); f.advance(10001);
    f.drain(); assert.equal(f.expired, 0); assert.equal(f.watcher.check(), true); f.watcher.stop();
});
test('stopped watcher never acts or schedules again', () => {
    const f = fixture(); f.watcher.stop(); f.advance(700000); f.watcher.check(); f.fire('win:focus');
    assert.equal(f.expired, 0); assert.equal(f.timers.size, 0);
});

test('72h policy uses token expiry;48h never retires a72h session', () => {
    const f=fixture(),hour=3600000;
    f.setToken(f.token(f.now+72*hour)); f.watcher.check();
    f.advance(48*hour); f.fire('win:focus'); assert.equal(f.expired,0);
    f.advance(24*hour); f.fire('win:focus'); assert.equal(f.expired,1);
});
