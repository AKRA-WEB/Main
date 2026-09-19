const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8').replace(/\r\n/g,'\n');
const section=(a,b)=>{const start=html.indexOf(a),end=html.indexOf(b,start+a.length);assert(start>=0&&end>start);return html.slice(start,end);};
const tick=()=>new Promise(setImmediate);
const user={id:'fixture',name:'Verified',roles:['ADMIN'],identityId:'10000000-0000-4000-8000-000000000011',sessionVersion:2,authorizationRevision:'current',apps:[],perms:{}};
function rig(){
 const storage=new Map(),nodes=new Map(),sections=[],views=[],toasts=[];
 const node=id=>{if(!nodes.has(id))nodes.set(id,{value:'',checked:false,disabled:false,innerHTML:'',innerText:'',focus(){},classList:{add(){},remove(){},toggle(){}},querySelectorAll:()=>[]});return nodes.get(id);};
 const state={sessionToken:null,sessionEpoch:0,currentUser:null,currentUserId:null,currentRoles:[],currentPerms:{},appConfig:[],mustChangePassword:false};
 const c=vm.createContext({state,JSON,Date,URL,AbortController,console,document:{getElementById:node},window:{AkraShell:{reset(){}}},CONFIG:{STORAGE_SESSION:'token',STORAGE_USER_DATA:'user',STORAGE_USER_DB:'users',STORAGE_APP_CONFIG:'apps',API_URL:'https://fixture.invalid/'},
  safeStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,String(v)),removeItem:k=>storage.delete(k)},sessionStorage:{getItem:()=>null,setItem(){},removeItem(){}},
  DEFAULT_APP_CONFIG:[],generateLifecycleMarker:()=> 'fixture-marker',parseCachedUserData:JSON.parse,parseCachedAppConfig:value=>JSON.parse(value||'[]'),pwdModal:node('password-modal'),lucide:{createIcons(){}},
  setTimeout(){},clearTimeout(){},AppVersionGuard:{blockIfStale:async()=>false},
  UI:{switchSection:id=>sections.push(id),showToast:(...args)=>toasts.push(args)},AdminInteractive:{userPermissionEditor:{reset(){}},resetProfile(){}},
  LineAccount:{refreshStatus(){},checkCallbackIntent(){},updateHeaderButton(){},closeModal(){}},API:{postAction:async()=>({status:'success',token:'verified',user,appConfig:[]})}});
 const run=s=>vm.runInContext(s,c);
 run(section('        const App = {','        const AKRA_SSO = {')+'\nthis.app=App;');
 c.app.renderDashboard=()=>views.push(state.currentUser);c.app.openChangePasswordModal=()=>views.push('password');c.app.runPendingNavigation=()=>{};
 run('this.startup=async()=>{'+section('                const savedToken = safeStorage.getItem(CONFIG.STORAGE_SESSION);','\n            },\n\n            handleLogin:')+'};');
 return {c,state,storage,node,sections,views,toasts,run};
}
test('Main cached private identity/roles never render before verified refresh, including cached password-change flag',async()=>{
 for(const mustChangePassword of [false,true]){
  const f=rig();f.storage.set('token','old');f.storage.set('user',JSON.stringify({id:'old',name:'Unverified private name',roles:['ADMIN'],mustChangePassword}));
  let finish;f.c.API.postAction=()=>new Promise(resolve=>finish=resolve);
  const pending=f.c.startup();await tick();assert.deepEqual(f.views,[]);assert.equal(f.state.currentUser,null);assert.equal(typeof finish,'function');
  finish({status:'success',token:'verified',user,appConfig:[]});await pending;
  assert.deepEqual(f.views,['Verified']);assert.equal(f.sections.at(-1),'dashboard-section');
 }
});
test('Main failed warm boot remains public; a token alone can be reverified without trusting cached user JSON',async()=>{
 const f=rig();f.storage.set('token','old');f.c.API.postAction=async()=>{throw Error('network');};
 await f.c.startup();assert.deepEqual(f.views,[]);assert.equal(f.sections.at(-1),'login-section');assert.equal(f.storage.get('token'),'old');
 const g=rig();g.storage.set('token','old');await g.c.startup();assert.deepEqual(g.views,['Verified']);
});
test('Main saves verified UUID/session/revision metadata additively',()=>{
 const f=rig();f.c.app.saveSession({token:'verified',user,appConfig:[]});const cached=JSON.parse(f.storage.get('user'));
 for(const key of ['identityId','sessionVersion','authorizationRevision'])assert.equal(cached[key],user[key]);
 assert.equal(f.state.identityId,user.identityId);
 f.c.DEFAULT_APP_CONFIG=[{id:'old-default'}];f.c.app.saveSession({token:'verified',user,appConfig:[]});assert.equal(f.state.appConfig.length,0);
});
test('Main late refresh preserves a newer shared login before its storage event; verified mandatory-password flag is honored',async()=>{
 const f=rig();f.state.sessionToken='old';f.storage.set('token','old');let finish;
 f.c.API.postAction=()=>new Promise(resolve=>finish=resolve);const pending=f.c.app.refreshSession();await tick();f.storage.set('token','new-peer');
 finish({status:'success',token:'old-refresh',user,appConfig:[]});assert.equal(await pending,false);assert.equal(f.storage.get('token'),'new-peer');
 const g=rig();g.storage.set('token','old');g.c.API.postAction=async()=>({status:'success',token:'verified',user:{...user,mustChangePassword:true},appConfig:[]});
 await g.c.startup();assert.deepEqual(g.views,['Verified','password']);
});
test('Main obsolete password-change failure cannot sign out or warn the replacement page owner',async()=>{
 const f=rig();for(const [id,value]of [['curr-pwd-input','old-password'],['new-pwd-input','new-password'],['confirm-pwd-input','new-password']])f.node(id).value=value;
 let fail;f.c.API.postAction=()=>new Promise((_,reject)=>fail=reject);const pending=f.c.app.handleChangePassword({preventDefault(){}});await tick();
 f.state.sessionEpoch++;f.state.currentUser='Replacement';f.state.sessionToken='new';fail(Object.assign(Error('stale_password'),{code:'stale_password'}));await pending;
 assert.equal(f.state.sessionToken,'new');assert.deepEqual(f.toasts,[]);
});
test('Main pending login cannot overwrite a newer shared login even before its storage event arrives',async()=>{
 const f=rig();f.node('username-input').value='fixture';f.node('password-input').value='fixture-password';let finish;
 f.c.API.postAction=()=>new Promise(resolve=>finish=resolve);
 const pending=f.c.app.handleLogin({preventDefault(){}});await tick();f.storage.set('token','new-peer');f.storage.set('user','new-peer-user');
 finish({status:'success',token:'old-login',user,appConfig:[]});await pending;
 assert.equal(f.storage.get('token'),'new-peer');assert.equal(f.storage.get('user'),'new-peer-user');assert.deepEqual(f.views,[]);
});
test('Main API cannot adopt a new owner token while version guard is pending, or return a former owner JSON body',async()=>{
 for(const stage of ['guard','json']){
  const f=rig();f.state.sessionToken='old';let finish,calls=0;
  if(stage==='guard')f.c.AppVersionGuard.blockIfStale=()=>new Promise(resolve=>finish=resolve);
  f.c.fetch=async(_url,options)=>{calls++;assert.equal(JSON.parse(options.body).token,'old');return{ok:true,json:()=>new Promise(resolve=>finish=resolve)};};
  f.run(section('        const API = {','        const AdminInteractive = {')+'\nthis.api=API;');
  const pending=f.c.api.postAction({action:'getAdminData'});await tick();f.state.sessionEpoch++;f.state.sessionToken='new';
  finish(stage==='guard'?false:{status:'success',users:[{name:'old private'}]});
  await assert.rejects(pending,e=>e.code==='session_changed');assert.equal(calls,stage==='guard'?0:1);
 }
});
test('Main refresh-button failure copy never claims a private cache fallback',async()=>{
 const f=rig();let listener;f.node('refresh-data-btn').addEventListener=(_event,fn)=>listener=fn;
 f.c.AdminInteractive.fetchAdminData=async()=>false;
 const start=html.indexOf("                document.getElementById('refresh-data-btn').addEventListener('click', async () => {");
 const end=html.indexOf('\n                });',start)+'\n                });'.length;assert(start>=0&&end>start);f.run(html.slice(start,end));await listener();
 assert.doesNotMatch(f.toasts.at(-1)[0],/ข้อมูลสำรอง/);assert.match(f.toasts.at(-1)[0],/ยังยืนยัน|รีเฟรช/);
});

test('Main save publishes one coherent record; same identity refresh preserves epoch, changed authorization retires private state',()=>{
 const f=rig(),writes=[];const set=f.c.safeStorage.setItem;f.c.safeStorage.setItem=(key,value)=>{writes.push(key);set(key,value);};
 f.c.app.saveSession({token:'first',user,appConfig:[]});assert.equal(writes[0],'akra_main_session');
 assert.deepEqual(JSON.parse(f.storage.get('akra_main_session')),{version:1,token:'first',identityId:user.identityId,sessionVersion:2,authorizationRevision:'current'});
 f.c.app.saveSession({token:'refreshed',user,appConfig:[]});assert.equal(f.state.sessionEpoch,0);
 f.state.users={old:'private'};f.c.app.saveSession({token:'revised',user:{...user,authorizationRevision:'next'},appConfig:[]});
 assert.equal(f.state.sessionEpoch,1);assert.equal(Object.keys(f.state.users).length,0);assert.equal(f.state.sessionToken,'revised');
});

test('Main self-initiated Admin refresh adopts the new authorization revision without clearing the active editor',()=>{
 const f=rig();
 f.c.app.saveSession({token:'first',user,appConfig:[]});
 f.state.users={other:{private:true}};
 f.c.app.saveSession({token:'revised',user:{...user,authorizationRevision:'next'},appConfig:[]},{allowAuthorizationRevisionChange:true});
 assert.equal(f.state.sessionEpoch,0);
 assert.deepEqual(f.state.users,{other:{private:true}});
 assert.equal(f.state.sessionToken,'revised');
});

test('actual Main and bridge adopt verified peer refresh without writes; peer logout clears memory only',async()=>{
 const f=rig(),listeners={};f.c.window.parent=f.c.window;f.c.window.location={};f.c.window.localStorage=f.c.safeStorage;
 f.c.window.AkraShell.sync=()=>{};
 f.c.window.addEventListener=(key,fn)=>listeners[key]=fn;
 f.c.fetch=async()=>({ok:true,json:async()=>({valid:true,user})});
 f.run(fs.readFileSync(path.join(__dirname,'../js/akra-shell-bridge.js'),'utf8'));
 f.c.app.saveSession({token:'first',user,appConfig:[]});
 const old=JSON.parse(f.storage.get('akra_main_session'));f.storage.set('akra_main_session',JSON.stringify({...old,token:'peer-refresh'}));f.storage.set('akra_session_token','peer-refresh');
 await listeners.storage({key:'akra_main_session'});
 assert.equal(f.state.sessionToken,'peer-refresh');assert.equal(f.state.sessionEpoch,0);assert.equal(f.storage.get('token'),'first','no republishing');
 f.storage.delete('akra_main_session');f.storage.delete('akra_session_token');await listeners.storage({key:'akra_main_session'});
 assert.equal(f.state.sessionToken,null);assert.equal(f.state.sessionEpoch,1);assert.equal(f.storage.get('token'),'first','peer notification does not delete another saved record');
});

test('Main sign-out marker overrides an old compatibility token; record-first peer login supersedes a pending refresh',async()=>{
 const f=rig();f.storage.set('token','old');f.c.window.AkraModule={isMainSignedOut:()=>true};let calls=0;
 f.c.API.postAction=async()=>{calls++;throw Error('must not refresh');};await f.c.startup();assert.equal(calls,0);assert.equal(f.sections.at(-1),'login-section');
 const g=rig();g.state.sessionToken='old';g.storage.set('token','old');let finish;
 g.c.API.postAction=()=>new Promise(resolve=>finish=resolve);const pending=g.c.app.refreshSession();await tick();
 g.storage.set('akra_main_session','peer-record-written-before-token');finish({status:'success',token:'old-refresh',user,appConfig:[]});
 assert.equal(await pending,false);assert.equal(g.storage.get('akra_main_session'),'peer-record-written-before-token');
});
