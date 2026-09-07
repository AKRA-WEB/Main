const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const start = html.indexOf('const LineAccount = {');
const source = html.slice(start, html.indexOf('window.LineAccount = LineAccount;', start)) + '\nglobalThis.subject = LineAccount;';
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return {promise,resolve,reject}; };
function rig(storage = new Map()) {
  const calls = [], elements = new Map();
  for (const id of ['line-modal-loading','line-state-linked','line-state-unlinked','line-modal-error','line-modal-error-msg','line-linked-name']) {
    const classes = new Set();
    elements.set(id,{textContent:'',classList:{toggle:(name,force)=>force?classes.add(name):classes.delete(name),contains:name=>classes.has(name)}});
  }
  const ctx = {
    state:{currentUserId:'account-a',sessionToken:'synthetic',sessionEpoch:1,lifecycleMarker:'login-a'},
    document:{getElementById:id=>elements.get(id)||null,title:'Main'},
    window:{location:new URL('https://example.test/Main/'),liff:{init:async()=>{},isLoggedIn:()=>true,getAccessToken:()=>'synthetic-line'}},
    CONFIG:{LINE_LIFF_ID:'synthetic'},
    API:{postAction:async p=>{calls.push(p.action);return {status:'success',linked:p.action!=='unbindLineAccount',lineDisplayName:'Test LINE'};}},
    UI:{showToast(){}}, console:{error(){},warn(){}}, URL, confirm:()=>true,
    sessionStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)}
  };
  ctx.window.history={replaceState:(_s,_t,url)=>{ctx.window.location=new URL(url,ctx.window.location);}};
  vm.createContext(ctx); vm.runInContext(source,ctx,{filename:'Main-LineAccount.js'});
  return {ctx,storage,calls,elements,subject:ctx.subject};
}
const putIntent = (r, fields={}) => {
  r.ctx.window.location=new URL('https://example.test/Main/?code=synthetic&state=synthetic');
  r.storage.set('akra_line_link_intent',JSON.stringify({userId:'account-a',marker:'login-a',timestamp:Date.now(),...fields}));
};

test('T1: same login survives fresh OAuth page after logout/login or password change epoch',async()=>{
  for (const epoch of [1,2,3,5]) {
    const before=rig(); before.ctx.state.sessionEpoch=epoch;
    before.ctx.window.liff.isLoggedIn=()=>false;
    before.ctx.window.liff.login=()=>{};
    await before.subject.connect();
    const after=rig(before.storage);
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
