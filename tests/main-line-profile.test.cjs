// Actual Main LINE controller in an isolated VM; no provider, browser, or live DB claim.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const start = html.indexOf('const LineAccount = {');
const source = html.slice(start, html.indexOf('window.LineAccount = LineAccount;', start)) + '\nglobalThis.subject = LineAccount;';
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return {promise, resolve, reject}; };
const token = id => 'fixture.' + Buffer.from(JSON.stringify({sessionId:id})).toString('base64url') + '.fixture';
function rig(shared = new Map()) {
    const calls = [], toasts = [], elements = new Map(), storage = new Map();
    for (const id of ['line-account-modal','line-modal-loading','line-state-linked','line-state-unlinked','line-modal-error','line-modal-error-msg','line-linked-name','line-profile-verified-at','line-profile-note','line-readiness-label','line-readiness-detail','line-profile-refresh-btn','line-profile-login-btn','line-connect-btn','line-unbind-btn']) {
        const classes = new Set(['hidden']);
        elements.set(id, {textContent:'', disabled:false, innerHTML:'', classList:{toggle:(name, force) => force ? classes.add(name) : classes.delete(name), contains:name => classes.has(name), remove:name => classes.delete(name), add:name => classes.add(name)}});
    }
    const ctx = {
        state:{currentUserId:'employee-a',identityId:'10000000-0000-4000-8000-000000000011',sessionVersion:1,sessionAuthorizationRevision:'revision-one',sessionToken:token('10000000-0000-4000-8000-000000000021'),sessionEpoch:1,lifecycleMarker:'login-a'},
        document:{getElementById:id => elements.get(id) || null, title:'Main'},
        window:{location:new URL('https://example.test/Main/'),liff:{init:async () => {},isLoggedIn:() => true,getAccessToken:() => 'synthetic-line'}},
        CONFIG:{LINE_LIFF_ID:'synthetic'},
        API:{postAction:async p => { calls.push(p); return status(); }},
        UI:{showToast:(message, type) => toasts.push({message, type})}, console:{error(){},warn(){}}, URL, confirm:() => true, lucide:{createIcons(){}},
        atob:value => Buffer.from(value, 'base64').toString('binary'),crypto:require('node:crypto').webcrypto,
        safeStorage:{getItem:k => shared.get(k) || null,setItem:(k,v) => shared.set(k,v),removeItem:k => shared.delete(k)},
        sessionStorage:{getItem:k => storage.get(k) || null,setItem:(k,v) => storage.set(k,v),removeItem:k => storage.delete(k)}
    };
    ctx.window.history = {replaceState:(_s,_t,url) => { ctx.window.location = new URL(url,ctx.window.location); }};
    vm.createContext(ctx); vm.runInContext(source,ctx,{filename:'Main-LineAccount-profile.js'});
    return {ctx, calls, toasts, elements, storage, shared, subject:ctx.subject};
}
const status = (overrides = {}) => ({status:'success',linked:true,lineDisplayName:'Cached employee',profileLastVerifiedAt:new Date().toISOString(),profileState:'verified',lastAttemptResult:'success',lineReadiness:{state:'unknown',reason:'provider_unverified',checkedAt:null},...overrides});
const seed = r => { r.subject.applyStatus(status()); r.subject.updateModalView(); };

test('legacy linked response keeps identity but cannot claim verified profile or group readiness', async () => {
    const r = rig();
    r.ctx.API.postAction = async () => ({status:'success',linked:true,lineDisplayName:'Old name'});
    await r.subject.refreshStatus();
    assert.equal(r.subject.state.linked,true);
    assert.equal(r.subject.state.displayName,'Old name');
    assert.equal(r.subject.state.profileState,'unverified');
    assert.equal(r.subject.state.profileLastVerifiedAt,null);
    assert.equal(r.subject.state.lineReadiness.state,'unknown');
    assert.match(r.elements.get('line-profile-verified-at').textContent,/ยังไม่ได้ตรวจสอบ/);
    assert.doesNotMatch(r.elements.get('line-readiness-label').textContent,/พร้อมรับงาน/);
});

test('opening the existing modal requests bounded server refresh and preserves cached linked content while waiting', async () => {
    const r = rig(), pending = deferred(); seed(r);
    r.ctx.API.postAction = p => { r.calls.push(p); return pending.promise; };
    r.subject.openModal();
    assert.equal(r.calls.length,1);
    assert.equal(r.calls[0].action,'getLineAccountStatus');
    assert.equal(r.calls[0].refreshIfStale,true);
    assert.equal(r.elements.get('line-account-modal').classList.contains('hidden'),false);
    assert.equal(r.elements.get('line-state-linked').classList.contains('hidden'),false);
    pending.resolve(status({lineDisplayName:'Changed name'}));
    await new Promise(setImmediate);
    assert.equal(r.elements.get('line-linked-name').textContent,'Changed name');
});

test('verified name and timestamp display as text; Login-only profile never implies group-ready', async () => {
    const r = rig(); seed(r);
    r.ctx.API.postAction = async p => { r.calls.push(p); return status({lineDisplayName:'<img onerror=malicious> changed',refreshApplied:true}); };
    await r.subject.refreshProfile();
    assert.deepEqual(JSON.parse(JSON.stringify(r.calls)),[{action:'refreshLineProfile'}]);
    assert.equal(r.elements.get('line-linked-name').textContent,'<img onerror=malicious> changed');
    assert.match(r.elements.get('line-profile-verified-at').textContent,/ตรวจสอบชื่อครั้งล่าสุด/);
    assert.equal(r.subject.state.lineReadiness.state,'unknown');
    assert.equal(r.elements.get('line-profile-refresh-btn').disabled,false);
});

for (const checkedAt of [null,'invalid',new Date(Date.now()-16*60*1000).toISOString(),new Date(Date.now()+60*1000).toISOString()]) {
    test(`ready without a valid recent group timestamp remains unknown (${checkedAt})`, () => {
        const r = rig(); r.subject.applyStatus(status({lineReadiness:{state:'ready',checkedAt}})); r.subject.updateModalView();
        assert.equal(r.subject.state.lineReadiness.state,'unknown');
        assert.doesNotMatch(r.elements.get('line-readiness-label').textContent,/พร้อมรับงาน/);
    });
}

test('server-evidenced group check is distinct and expires on subsequent rendering', () => {
    const r = rig(); r.subject.applyStatus(status({lineReadiness:{state:'ready',reason:'eligible',checkedAt:new Date().toISOString()}})); r.subject.updateModalView();
    assert.match(r.elements.get('line-readiness-label').textContent,/พร้อมรับงาน/);
    r.subject.state.lineReadiness.checkedAt = new Date(Date.now()-16*60*1000).toISOString();
    r.subject.updateModalView();
    assert.doesNotMatch(r.elements.get('line-readiness-label').textContent,/พร้อมรับงาน/);
});

for (const code of ['timeout','rate_limited','unavailable']) test(`provider ${code} preserves last-known name and last-success time, with safe stale/unknown copy`, async () => {
    const r = rig(); seed(r); const verifiedAt = r.subject.state.profileLastVerifiedAt;
    r.ctx.API.postAction = async () => { throw Object.assign(new Error('provider body secret fixture'),{code}); };
    await r.subject.refreshProfile();
    assert.equal(r.subject.state.linked,true);
    assert.equal(r.subject.state.displayName,'Cached employee');
    assert.equal(r.subject.state.profileLastVerifiedAt,verifiedAt);
    assert.equal(r.subject.state.profileState,'stale');
    assert.equal(r.subject.state.lineReadiness.state,'unknown');
    assert.doesNotMatch(r.elements.get('line-modal-error-msg').textContent,/secret/);
    assert.notEqual(r.elements.get('line-modal-error-msg').textContent,'');
});

test('404 membership result keeps the binding and cached name, shows failure, and claims no successful refresh', async () => {
    const r = rig(); seed(r); const verifiedAt = r.subject.state.profileLastVerifiedAt;
    r.ctx.API.postAction = async () => status({refreshApplied:false,profileLastVerifiedAt:verifiedAt,profileState:'stale',lastAttemptResult:'not_member',lineReadiness:{state:'unavailable',reason:'group_unverified',checkedAt:new Date().toISOString()}});
    await r.subject.refreshProfile();
    assert.equal(r.subject.state.linked,true);
    assert.equal(r.subject.state.displayName,'Cached employee');
    assert.equal(r.subject.state.profileLastVerifiedAt,verifiedAt);
    assert.equal(r.elements.get('line-profile-note').classList.contains('hidden'),false);
    assert.match(r.elements.get('line-profile-note').textContent,/ยังคงเดิม/);
    assert.equal(r.toasts.filter(t => t.type === 'success').length,0);
});

test('late status cannot overwrite a more recent manual profile refresh', async () => {
    const r = rig(), older = deferred(); seed(r);
    r.ctx.API.postAction = p => p.action === 'getLineAccountStatus' ? older.promise : Promise.resolve(status({lineDisplayName:'Latest name',refreshApplied:true}));
    const pending = r.subject.refreshStatus();
    await r.subject.refreshProfile();
    older.resolve(status({lineDisplayName:'Older name'})); await pending;
    assert.equal(r.subject.state.displayName,'Latest name');
    assert.equal(r.subject.state.loading,false);
});

test('profile operation serializes conflicting LINE writes and releases its control', async () => {
    const r = rig(), reply = deferred(); seed(r);
    r.ctx.API.postAction = p => { r.calls.push(p); return reply.promise; };
    const pending = r.subject.refreshProfile();
    await r.subject.unbind(); await r.subject.connect({refreshProfile:true}); await r.subject.refreshProfile();
    assert.deepEqual(r.calls.map(p => p.action),['refreshLineProfile']);
    reply.resolve(status({refreshApplied:true})); await pending;
    assert.equal(r.subject._inFlightOp,null);
    assert.equal(r.elements.get('line-profile-refresh-btn').disabled,false);
});

for (const change of ['uuid','device','logout']) test(`late profile response after ${change} cannot repaint the new session`, async () => {
    const r = rig(), reply = deferred(); seed(r); r.ctx.API.postAction = () => reply.promise;
    const pending = r.subject.refreshProfile();
    r.subject.resetOperations();
    if (change === 'uuid') r.ctx.state.identityId = '10000000-0000-4000-8000-000000000012';
    if (change === 'device') r.ctx.state.sessionToken = token('10000000-0000-4000-8000-000000000022');
    if (change === 'logout') { r.ctx.state.sessionToken = null; r.ctx.state.sessionEpoch++; }
    r.subject.applyStatus({status:'success',linked:false});
    reply.resolve(status({lineDisplayName:'Wrong account'})); await pending;
    assert.equal(r.subject.state.linked,false);
    assert.equal(r.subject.state.displayName,null);
});

test('explicit Login refresh survives same-device new tab and dispatches refresh rather than bind exactly once', async () => {
    const before = rig(); seed(before); before.ctx.window.liff.isLoggedIn = () => false;
    let redirect, issuedIntent;
    before.ctx.window.liff.init = async () => { issuedIntent = JSON.parse(before.storage.get('akra_line_link_intent')); };
    before.ctx.window.liff.login = options => { redirect = options.redirectUri; };
    await before.subject.connect({refreshProfile:true});
    assert.equal(issuedIntent.purpose,'refresh'); assert.ok(issuedIntent.nonce);
    assert.equal(before.calls.length,0);
    const after = rig(before.shared); after.ctx.state.lifecycleMarker = 'new-tab'; after.ctx.window.location = new URL(redirect);
    await after.subject.checkCallbackIntent(); await after.subject.checkCallbackIntent();
    assert.deepEqual(after.calls.map(p => p.action),['refreshLineProfile']);
    assert.equal(after.calls[0].lineAccessToken,'synthetic-line');
    assert.equal(after.subject.state.lineReadiness.state,'unknown');
    assert.equal(after.shared.has('akra_line_link_intent'),false);
});

test('Login refresh with a different device session is discarded with zero provider-write request', async () => {
    const before = rig(); seed(before); before.ctx.window.liff.isLoggedIn = () => false;
    let redirect; before.ctx.window.liff.login = options => { redirect = options.redirectUri; };
    await before.subject.connect({refreshProfile:true});
    const after = rig(before.shared); after.ctx.state.lifecycleMarker = 'new-tab'; after.ctx.window.location = new URL(redirect);
    after.ctx.state.sessionToken = token('10000000-0000-4000-8000-000000000022');
    await after.subject.checkCallbackIntent(); assert.equal(after.calls.length,0);
});

test('Login refresh rejects an account switch during SDK init', async () => {
    const r = rig(), init = deferred(), entered = deferred(); seed(r);
    r.ctx.window.liff.init = () => { entered.resolve(); return init.promise; };
    const pending = r.subject.connect({refreshProfile:true}); await entered.promise;
    r.ctx.state.identityId = '10000000-0000-4000-8000-000000000012'; init.resolve(); await pending;
    assert.equal(r.calls.length,0);
    assert.equal(r.elements.get('line-profile-login-btn').disabled,false);
});

test('wrong linked Login identity leaves the current binding unchanged and clears ready display', async () => {
    const r = rig(); seed(r);
    r.ctx.API.postAction = async p => { r.calls.push(p); throw Object.assign(new Error('raw provider response'),{code:'identity_mismatch'}); };
    await r.subject.connect({refreshProfile:true});
    assert.deepEqual(r.calls.map(p => p.action),['refreshLineProfile']);
    assert.equal(r.subject.state.linked,true); assert.equal(r.subject.state.displayName,'Cached employee');
    assert.equal(r.subject.state.profileState,'stale'); assert.equal(r.subject.state.lineReadiness.state,'unknown');
    assert.match(r.subject.state.error,/ไม่ตรง/); assert.doesNotMatch(r.subject.state.error,/raw provider/);
});

test('unbind clears freshness and readiness alongside the existing identity state', async () => {
    const r = rig(); seed(r); r.ctx.API.postAction = async () => ({status:'success',linked:false});
    await r.subject.unbind();
    assert.equal(r.subject.state.profileLastVerifiedAt,null);
    assert.equal(r.subject.state.lastAttemptResult,null);
    assert.equal(r.subject.state.lineReadiness.state,'not_linked');
});
