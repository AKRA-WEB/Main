// Actual bridge protocol with isolated storage/transport. Not browser evidence.
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../js/akra-shell-bridge.js'),'utf8');
const user={id:'same-name',identityId:'10000000-0000-4000-8000-000000000011',sessionVersion:2,authorizationRevision:'r1'};
const record=(token='old',owner=user)=>JSON.stringify({version:1,token,identityId:owner.identityId,sessionVersion:owner.sessionVersion,authorizationRevision:owner.authorizationRevision});
const tick=()=>new Promise(setImmediate);
function rig(){
 const storage=new Map([['akra_main_session',record()],['akra_session_token','old']]),listeners={},invalid=[],refreshes=[],calls=[];
 const window={location:{origin:'https://fixture.invalid',hostname:'fixture.invalid'},localStorage:{getItem:key=>storage.get(key)??null},addEventListener:(name,fn)=>listeners[name]=fn};window.parent=window;
 const c={window,document:{},URLSearchParams,fetch:async(_url,options)=>{calls.push(JSON.parse(options.body));return{ok:true,json:async()=>({valid:true,user})};}};
 vm.runInNewContext(source,c);
 const bind=()=>window.AkraModule.watchSession({appId:'app-pr',user,token:'old',invalidated:()=>invalid.push(true),refreshed:token=>refreshes.push(token)});
 const change=(raw,key='akra_main_session')=>{if(raw===null)storage.delete(key);else storage.set(key,raw);listeners.storage({key,newValue:raw});};
 return{c,window,storage,listeners,invalid,refreshes,calls,bind,change};
}
test('Main-only logout/replacement/revision invalidates standalone without touching owned storage',()=>{
 for(const next of [null,record('new',{...user,identityId:'10000000-0000-4000-8000-000000000012'}),record('new',{...user,sessionVersion:3}),record('new',{...user,authorizationRevision:'r2'})]){
  const f=rig();f.storage.set('draft:original','private');f.bind();f.change(next);
  assert.equal(f.invalid.length,1);assert.equal(f.storage.get('draft:original'),'private');assert.equal(f.calls.length,0);
 }
});
test('same-owner refresh preserves drafts and accepts only the server-verified token, without republishing',async()=>{
 const f=rig();f.bind();let finish;f.c.fetch=async()=>({ok:true,json:()=>new Promise(resolve=>finish=resolve)});
 f.change(record('refreshed'));await tick();assert.deepEqual(f.refreshes,[]);assert.deepEqual(f.invalid,[]);
 finish({valid:true,user});await tick();assert.deepEqual(f.refreshes,['refreshed']);assert.deepEqual(f.invalid,[]);
 assert.equal(f.storage.get('akra_session_token'),'old');
});
test('forged same-owner metadata cannot adopt a different server identity, denial, or failed verification',async()=>{
 for(const result of [{valid:true,user:{...user,identityId:'other'}},{valid:false,reason:'permission_denied'},null]){
  const f=rig();f.bind();f.c.fetch=async()=>{if(!result)throw Error('offline');return{ok:result.valid,json:async()=>result};};
  f.change(record('new'));await tick();assert.equal(f.invalid.length,1);assert.deepEqual(f.refreshes,[]);
 }
});
test('logout wins over an in-flight refresh; older storage notifications read the latest coherent record',async()=>{
 const f=rig();f.bind();let finish;f.c.fetch=async()=>({ok:true,json:()=>new Promise(resolve=>finish=resolve)});
 f.change(record('new'));await tick();f.change(null);finish({valid:true,user});await tick();
 assert.equal(f.invalid.length,1);assert.deepEqual(f.refreshes,[]);
 const g=rig();g.bind();g.listeners.storage({key:'akra_main_session',newValue:record('obsolete',{...user,authorizationRevision:'old'})});await tick();
 assert.deepEqual(g.invalid,[]);assert.deepEqual(g.calls,[]);
});
test('legacy Main token replacement and clear fail closed; unrelated changes do nothing',()=>{
 const f=rig();f.bind();f.change('unrelated','other');assert.deepEqual(f.invalid,[]);
 f.change('legacy-new','akra_session_token');assert.equal(f.invalid.length,1);
 const g=rig();g.bind();g.listeners.storage({key:null,newValue:null});assert.equal(g.invalid.length,1);
});
test('Main changes during initial verification cannot bind a late former owner',async()=>{
 const f=rig();let finish;f.c.fetch=async()=>({ok:true,json:()=>new Promise(resolve=>finish=resolve)});
 const pending=f.window.AkraModule.verifySession('app-pr','old');await tick();f.storage.delete('akra_main_session');finish({valid:true,user});
 await assert.rejects(pending,/session_changed/);
});

test('atomic notification may arrive before compatibility keys; their subsequent write cannot reject the valid refresh',async()=>{
 const f=rig();f.bind();let finish;f.c.fetch=async()=>({ok:true,json:()=>new Promise(resolve=>finish=resolve)});
 f.change(record('new'));await tick();f.change('new','akra_session_token');finish({valid:true,user});await tick();
 assert.deepEqual(f.invalid,[]);assert.deepEqual(f.refreshes,['new']);
});

test('persisted Main sign-out blocks an old standalone token before any verification request',async()=>{
 const f=rig();f.storage.set('akra_main_session',JSON.stringify({version:1,signedOut:true}));
 await assert.rejects(f.window.AkraModule.verifySession('app-pr','previous-app-token'),/main_signed_out/);
 assert.equal(f.calls.length,0);
});
