const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const start = html.indexOf('const LineAccount = {');
const source = html.slice(start, html.indexOf('window.LineAccount = LineAccount;', start)) + '\nglobalThis.subject = LineAccount;';
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return {promise,resolve,reject}; };
const sessionToken = id => 'fixture.' + Buffer.from(JSON.stringify({sessionId:id})).toString('base64url') + '.fixture';
function rig(storage = new Map(), shared = new Map()) {
  const calls = [], elements = new Map();
  for (const id of ['line-modal-loading','line-state-linked','line-state-unlinked','line-modal-error','line-modal-error-msg','line-linked-name']) {
    const classes = new Set();
    elements.set(id,{textContent:'',classList:{toggle:(name,force)=>force?classes.add(name):classes.delete(name),contains:name=>classes.has(name)}});
  }
  const ctx = {
    state:{currentUserId:'account-a',identityId:'10000000-0000-4000-8000-000000000011',sessionVersion:1,sessionAuthorizationRevision:'revision-one',sessionToken:sessionToken('10000000-0000-4000-8000-000000000021'),sessionEpoch:1,lifecycleMarker:'login-a'},
    document:{getElementById:id=>elements.get(id)||null,title:'Main'},
    window:{location:new URL('https://example.test/Main/'),liff:{init:async()=>{},isLoggedIn:()=>true,getAccessToken:()=>'synthetic-line'}},
    CONFIG:{LINE_LIFF_ID:'synthetic'},
    API:{postAction:async p=>{calls.push(p.action);return {status:'success',linked:p.action!=='unbindLineAccount',lineDisplayName:'Test LINE'};}},
    UI:{showToast(){}}, console:{error(){},warn(){}}, URL, confirm:()=>true,
    atob:value=>Buffer.from(value,'base64').toString('binary'), crypto:require('node:crypto').webcrypto,
    safeStorage:{getItem:k=>shared.get(k)||null,setItem:(k,v)=>shared.set(k,v),removeItem:k=>shared.delete(k)},
    sessionStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)}
  };
  ctx.window.history={replaceState:(_s,_t,url)=>{ctx.window.location=new URL(url,ctx.window.location);}};
  vm.createContext(ctx); vm.runInContext(source,ctx,{filename:'Main-LineAccount.js'});
  return {ctx,storage,shared,calls,elements,subject:ctx.subject};
}
const putIntent = (r, fields={}) => {
  r.ctx.window.location=new URL('https://example.test/Main/?code=synthetic&state=synthetic');
  r.storage.set('akra_line_link_intent',JSON.stringify({userId:'account-a',identityId:r.ctx.state.identityId,sessionVersion:1,authorizationRevision:'revision-one',marker:'login-a',timestamp:Date.now(),...fields}));
};

test('T1: same login survives fresh OAuth page after logout/login or password change epoch',async()=>{
  for (const epoch of [1,2,3,5]) {
    const before=rig(); before.ctx.state.sessionEpoch=epoch;
    before.ctx.window.liff.isLoggedIn=()=>false;
    before.ctx.window.liff.login=()=>{};
    await before.subject.connect();
    const after=rig(before.storage,before.shared);
    after.ctx.window.location=new URL('https://example.test/Main/?code=synthetic&state=synthetic');
    let initUrl;
    after.ctx.window.liff.init=async()=>{initUrl=after.ctx.window.location.search;};
    await after.subject.checkCallbackIntent();
    assert.deepEqual(after.calls,['bindLineAccount'],`epoch ${epoch} must survive reload`);
    assert.equal(new URLSearchParams(initUrl).get('code'),'synthetic');
    assert.equal(after.ctx.window.location.search,'');
    await after.subject.checkCallbackIntent();
    assert.equal(after.calls.length,1,'consume once');
  }
});

test('connect normalizes Main directory URL to the registered LIFF endpoint', async () => {
  const r = rig();
  r.ctx.window.liff.isLoggedIn = () => false;
  let loginRedirectUri = null;
  r.ctx.window.liff.login = options => { loginRedirectUri = options.redirectUri; };

  await r.subject.connect();

  const redirect = new URL(loginRedirectUri);
  assert.equal(redirect.origin + redirect.pathname, 'https://example.test/Main/index.html');
  assert.ok(redirect.searchParams.get('line_link'), 'redirect must correlate a new-window return');
  assert.deepEqual(r.calls, [], 'Unlogged connect must not bind before LINE login completes');
});

for (const [name,fields] of [
  ['legacy',{userId:undefined,user:'account-a',marker:undefined}],
  ['missing marker',{marker:undefined}],['empty marker',{marker:''}],
  ['wrong marker',{marker:'another-login'}],['wrong user',{userId:'account-b'}],
  ['missing canonical ID',{userId:undefined,user:'account-a'}],
  ['expired',{timestamp:Date.now()-660000}],['future',{timestamp:Date.now()+30000}],
  ['string timestamp',{timestamp:String(Date.now())}],['missing timestamp',{timestamp:undefined}]
]) test(`T3: reject ${name} intent with zero mutation`,async()=>{
  const r=rig(); putIntent(r,fields); await r.subject.checkCallbackIntent();
  assert.deepEqual(r.calls,[]); assert.equal(r.storage.has('akra_line_link_intent'),false);
});

for (const method of ['connect','unbind']) for (const fail of [false,true]) {
  test(`T2: ${method} ${fail?'failure':'success'} settles superseded loading and actual modal`,async()=>{
    const r=rig(), read=deferred();
    r.subject.state.linked=method==='unbind';
    r.ctx.API.postAction=p=>p.action==='getLineAccountStatus'?read.promise:
      fail?Promise.reject(new Error('synthetic failure')):Promise.resolve({status:'success',linked:method==='connect'});
    const pending=r.subject.refreshStatus();
    await r.subject[method]();
    read.resolve({status:'success',linked:method!=='connect'}); await pending;
    assert.equal(r.subject.state.loading,false);
    assert.equal(r.elements.get('line-modal-loading').classList.contains('hidden'),true);
    assert.equal(r.subject._inFlightOp,null);
    assert.equal(r.subject.state.linked,fail?method==='unbind':method==='connect');
    const visible=r.subject.state.linked?'line-state-linked':'line-state-unlinked';
    assert.equal(r.elements.get(visible).classList.contains('hidden'),false);
  });
}

test('status requested during mutation cannot invalidate its success',async()=>{
  const r=rig(), write=deferred();
  r.ctx.API.postAction=p=>{r.calls.push(p.action);return p.action==='bindLineAccount'?write.promise:Promise.resolve({status:'success',linked:false});};
  const pending=r.subject.connect();
  while (!r.calls.length) await Promise.resolve();
  await r.subject.refreshStatus();
  write.resolve({status:'success',linked:true}); await pending;
  assert.equal(r.subject.state.linked,true);
  assert.equal(r.subject.state.loading,false);
});

test('same-account new session during LIFF init aborts; conflicting mutations serialize',async()=>{
  const r=rig(), init=deferred(), entered=deferred();
  r.ctx.window.liff.init=()=>{entered.resolve();return init.promise;};
  const pending=r.subject.connect(); await entered.promise;
  await r.subject.connect(); await r.subject.unbind();
  r.ctx.state.sessionEpoch++; r.ctx.state.lifecycleMarker='new-login';
  init.resolve(); await pending;
  assert.deepEqual(r.calls,[]);
});

test('late write response from obsolete session cannot change the new session view',async()=>{
  const r=rig(), write=deferred(), entered=deferred();
  r.ctx.API.postAction=()=>{entered.resolve();return write.promise;};
  const pending=r.subject.connect(); await entered.promise;
  r.ctx.state.sessionEpoch++; r.ctx.state.currentUserId='account-b';
  r.subject.state={loading:false,linked:false,displayName:null,error:null};
  write.resolve({status:'success',linked:true,lineDisplayName:'Old account'}); await pending;
  assert.equal(r.subject.state.linked,false); assert.equal(r.subject.state.error,null);
});

test('cancel unlink does not mutate; callback without intent does not bind',async()=>{
  const r=rig();r.ctx.confirm=()=>false;await r.subject.unbind();
  r.ctx.window.location=new URL('https://example.test/Main/?code=synthetic');
  await r.subject.checkCallbackIntent();assert.deepEqual(r.calls,[]);
});

test('obsolete operation releases its disabled control for the next login',async()=>{
  const r=rig(), init=deferred(), entered=deferred();
  const button={disabled:false,innerHTML:''};
  r.elements.set('line-connect-btn',button); r.ctx.lucide={createIcons(){}};
  r.ctx.window.liff.init=()=>{entered.resolve();return init.promise;};
  const pending=r.subject.connect(); await entered.promise;
  assert.equal(button.disabled,true);
  r.ctx.state.sessionEpoch++;r.ctx.state.currentUserId='account-b';
  init.resolve();await pending;
  assert.equal(button.disabled,false,'New login must not inherit a disabled LINE control');
  assert.deepEqual(r.calls,[]);
});

for(const fields of [{identityId:'10000000-0000-4000-8000-000000000012'},{identityId:undefined},{sessionVersion:2},{authorizationRevision:'old'}])test('callback cannot carry an old UUID/session/revision intent into the current account',async()=>{
 const r=rig();putIntent(r,fields);await r.subject.checkCallbackIntent();assert.deepEqual(r.calls,[]);assert.equal(r.storage.has('akra_line_link_intent'),false);
});

test('changed UUID during SDK initialization cannot bind even if the username and page epoch are unchanged',async()=>{
 const r=rig(),init=deferred(),entered=deferred();r.ctx.window.liff.init=()=>{entered.resolve();return init.promise;};
 const pending=r.subject.connect();await entered.promise;r.ctx.state.identityId='10000000-0000-4000-8000-000000000012';init.resolve();await pending;assert.deepEqual(r.calls,[]);
});

test('session reset releases old operation; its late finalizer cannot release a new login operation or its control',async()=>{
 const r=rig(),oldInit=deferred(),oldEntered=deferred(),newInit=deferred(),newEntered=deferred();let n=0;
 const button={disabled:false,innerHTML:''};r.elements.set('line-connect-btn',button);r.ctx.lucide={createIcons(){}};
 r.ctx.window.liff.init=()=>{if(++n===1){oldEntered.resolve();return oldInit.promise;}newEntered.resolve();return newInit.promise;};
 const old=r.subject.connect();await oldEntered.promise;r.subject.resetOperations();r.ctx.state.sessionEpoch++;
 const next=r.subject.connect();await newEntered.promise;oldInit.resolve();await old;
 assert.notEqual(r.subject._inFlightOp,null);assert.equal(button.disabled,true);assert.deepEqual(r.calls,[]);
 newInit.resolve();await next;assert.equal(r.subject._inFlightOp,null);assert.equal(button.disabled,false);assert.deepEqual(r.calls,['bindLineAccount']);
});

for(const metadata of [{identityId:'not-a-uuid'},{sessionVersion:0},{sessionVersion:undefined},{sessionAuthorizationRevision:''}])test('incomplete verified identity cannot start a LINE operation',async()=>{
 const r=rig();Object.assign(r.ctx.state,metadata);let sdkCalls=0;r.ctx.window.liff.init=async()=>{sdkCalls++;};
 await r.subject.connect();await r.subject.unbind();await r.subject.refreshStatus();
 assert.equal(sdkCalls,0);assert.deepEqual(r.calls,[]);
});

for(const method of ['refreshStatus','unbind'])test(`late ${method} response cannot paint another UUID with the same employee ID`,async()=>{
 const r=rig(),reply=deferred();r.ctx.API.postAction=()=>reply.promise;
 const pending=r.subject[method]();r.ctx.state.identityId='10000000-0000-4000-8000-000000000012';
 r.subject.state={loading:false,linked:false,displayName:null,error:null};
 reply.resolve({status:'success',linked:true,lineDisplayName:'Old LINE'});await pending;
 assert.equal(r.subject.state.linked,false);assert.equal(r.subject.state.displayName,null);
});

test('explicit click records intent before SDK initialization can navigate',async()=>{
 const r=rig();let observed;
 r.ctx.window.liff.init=async()=>{observed=JSON.parse(r.storage.get('akra_line_link_intent')||'null');};
 await r.subject.connect();
 assert.equal(observed?.userId,'account-a');assert.ok(observed?.nonce);
 assert.equal(r.storage.has('akra_line_link_intent'),false,'completed bind consumes intent');
 assert.equal(r.shared.has('akra_line_link_intent'),false);
});

test('primary LIFF navigation keeps intent for clean secondary redirect and binds once',async()=>{
 const before=rig();putIntent(before);let entered;
 const initializing=new Promise(resolve=>entered=resolve);
 before.ctx.window.liff.init=()=>{entered();return new Promise(()=>{});};
 before.subject.checkCallbackIntent();await initializing;
 assert.ok(before.storage.has('akra_line_link_intent'),'intent must survive a navigating init');
 const after=rig(before.storage,before.shared);
 after.ctx.window.location=new URL('https://example.test/Main/index.html');
 await after.subject.checkCallbackIntent();await after.subject.checkCallbackIntent();
 assert.deepEqual(after.calls,['bindLineAccount']);
});

async function startRedirect(){
 const r=rig();r.ctx.window.liff.isLoggedIn=()=>false;let redirect;
 r.ctx.window.liff.login=options=>{redirect=options.redirectUri;};await r.subject.connect();
 return {r,redirect};
}

test('PWA return in new tab resumes only the same verified device session and URL nonce',async()=>{
 const {r,redirect}=await startRedirect();const after=rig(new Map(),r.shared);
 after.ctx.state.lifecycleMarker='new-tab';after.ctx.window.location=new URL(redirect);
 await after.subject.checkCallbackIntent();await after.subject.checkCallbackIntent();
 assert.deepEqual(after.calls,['bindLineAccount']);
 assert.equal(r.shared.has('akra_line_link_intent'),false);
 // Original PWA must not bind again after the other window completed.
 r.ctx.window.liff.isLoggedIn=()=>true;await r.subject.checkCallbackIntent();assert.deepEqual(r.calls,[]);
});

for(const mode of ['new-device-session','missing-nonce','wrong-nonce','wrong-identity','expired'])test(`new-tab ${mode} return cannot bind`,async()=>{
 const {r,redirect}=await startRedirect();const after=rig(new Map(),r.shared);
 after.ctx.state.lifecycleMarker='new-tab';after.ctx.window.location=new URL(redirect);
 if(mode==='new-device-session')after.ctx.state.sessionToken=sessionToken('10000000-0000-4000-8000-000000000022');
 if(mode==='missing-nonce')after.ctx.window.location.search='?code=fixture';
 if(mode==='wrong-nonce')after.ctx.window.location.search='?line_link=wrong';
 if(mode==='wrong-identity')after.ctx.state.identityId='10000000-0000-4000-8000-000000000012';
 if(mode==='expired'){const intent=JSON.parse(r.shared.get('akra_line_link_intent'));intent.timestamp-=660000;r.shared.set('akra_line_link_intent',JSON.stringify(intent));}
 await after.subject.checkCallbackIntent();assert.deepEqual(after.calls,[]);
});

test('cancelled callback clears intent and never starts another LINE login',async()=>{
 const r=rig();putIntent(r);r.ctx.window.liff.isLoggedIn=()=>false;let logins=0;
 r.ctx.window.liff.login=()=>{logins++;};await r.subject.checkCallbackIntent();
 assert.equal(logins,0);assert.deepEqual(r.calls,[]);assert.equal(r.storage.has('akra_line_link_intent'),false);
 assert.ok(r.subject.state.error);
});

test('same-tab redirect works when shared storage is unavailable',async()=>{
 const r=rig();r.ctx.safeStorage.setItem=()=>{};r.ctx.window.liff.isLoggedIn=()=>false;
 let redirect;r.ctx.window.liff.login=options=>{redirect=options.redirectUri;};await r.subject.connect();
 r.ctx.window.location=new URL(redirect);r.ctx.window.liff.isLoggedIn=()=>true;
 await r.subject.checkCallbackIntent();assert.deepEqual(r.calls,['bindLineAccount']);
});

test('another window consumes request during SDK init: no second binding',async()=>{
 const {r,redirect}=await startRedirect();const after=rig(new Map(),r.shared),ready=deferred(),init=deferred();
 after.ctx.window.location=new URL(redirect);after.ctx.state.lifecycleMarker='new-tab';
 after.ctx.window.liff.init=()=>{ready.resolve();return init.promise;};const pending=after.subject.checkCallbackIntent();await ready.promise;
 r.ctx.window.liff.isLoggedIn=()=>true;await r.subject.checkCallbackIntent();init.resolve();await pending;
 assert.deepEqual(r.calls,['bindLineAccount']);assert.deepEqual(after.calls,[]);
});

test('return refreshes status; successful binding signals the original window',async()=>{
 const r=rig();await r.subject.connect();assert.ok(r.shared.get('akra_line_account_changed'));
 r.calls.length=0;r.subject.onReturn();await new Promise(setImmediate);
 assert.deepEqual(r.calls,['getLineAccountStatus']);
 r.ctx.document.hidden=true;r.subject.onReturn();assert.equal(r.calls.length,1);
});

test('device session changes during SDK work cannot bind and old errors do not clear a new intent',async()=>{
 const r=rig(),ready=deferred(),init=deferred();r.ctx.window.liff.init=()=>{ready.resolve();return init.promise;};
 const pending=r.subject.connect();await ready.promise;
 r.ctx.state.sessionToken=sessionToken('10000000-0000-4000-8000-000000000022');
 const next={nonce:'new-request',marker:'new-login'};r.shared.set('akra_line_link_intent',JSON.stringify(next));
 init.resolve();await pending;assert.deepEqual(r.calls,[]);assert.equal(JSON.parse(r.shared.get('akra_line_link_intent')).nonce,'new-request');
});

test('new-tab callback still reads shared request if tab storage fails',async()=>{
 const {r,redirect}=await startRedirect();const after=rig(new Map(),r.shared);
 after.ctx.window.location=new URL(redirect);after.ctx.state.lifecycleMarker='new-tab';
 after.ctx.sessionStorage.getItem=()=>{throw Error('blocked tab storage');};
 await after.subject.checkCallbackIntent();assert.deepEqual(after.calls,['bindLineAccount']);
});

test('liff.state carries the correlation nonce into a fresh tab',async()=>{
 const {r,redirect}=await startRedirect();const after=rig(new Map(),r.shared);
 after.ctx.window.location=new URL('https://example.test/Main/index.html?liff.state='+encodeURIComponent(new URL(redirect).search));
 after.ctx.state.lifecycleMarker='new-tab';let params;
 after.ctx.window.liff.init=async()=>{params=after.ctx.window.location.search;};
 await after.subject.checkCallbackIntent();assert.deepEqual(after.calls,['bindLineAccount']);assert.ok(params.includes('liff.state='));
});

test('unavailable storage aborts before SDK navigation',async()=>{
 const r=rig();r.ctx.safeStorage.setItem=()=>{};r.ctx.sessionStorage.setItem=()=>{throw Error('blocked');};
 let sdk=0;r.ctx.window.liff.init=async()=>{sdk++;};await r.subject.connect();
 assert.equal(sdk,0);assert.deepEqual(r.calls,[]);assert.ok(r.subject.state.error);
});
