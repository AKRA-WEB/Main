// Actual Executive controller + shared session bridge; synthetic auth replies only.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const read=file=>fs.readFileSync(path.join(__dirname,'..',file),'utf8');
const user={id:'fixture',identityId:'10000000-0000-4000-8000-000000000011',sessionVersion:1,authorizationRevision:'one',roles:['ADMIN']};
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function rig(options={}){
 const calls=[],events={},docEvents={},elements=new Map(),storage=new Map(options.signedOut?[['akra_main_session','{"version":1,"signedOut":true}']]:[]);
 if(options.token!==false)storage.set('akra_session_token','synthetic');
 for(const id of ['executive-content','executive-access-status','executive-recheck'])elements.set(id,{hidden:id==='executive-content',disabled:false,textContent:'',events:{},addEventListener(name,fn){this.events[name]=fn;}});
 const window={location:new URL('https://example.test/Main/executive-dashboard.html'),localStorage:{getItem:key=>{if(options.storageBlocked)throw Error('blocked');return storage.get(key)||null;}},addEventListener:(name,fn)=>(events[name]??=[]).push(fn)};window.parent=window;
 const ctx={window,document:{hidden:false,getElementById:id=>elements.get(id),addEventListener:(name,fn)=>docEvents[name]=fn},URL,URLSearchParams,fetch:async(url,init)=>{calls.push({url,body:JSON.parse(init.body)});return options.reply?options.reply():{ok:true,json:async()=>({valid:true,user:{...user,...options.user}})};}};
 vm.createContext(ctx);vm.runInContext(read('js/akra-shell-bridge.js'),ctx);vm.runInContext(read('js/executive-session.js'),ctx);
 return {ctx,calls,elements,storage,events,docEvents,settle:()=>new Promise(r=>setImmediate(r)),recheck:()=>elements.get('executive-recheck').events.click()};
}
test('entry HTML is gated before scripts execute and no fabricated live statistics remain',()=>{
 const html=read('executive-dashboard.html');assert.match(html,/<main[^>]*id="executive-content"[^>]*hidden/);
 assert.doesNotMatch(html,/Supabase Live|100% Ingested|Sub-30ms|86,554|1,703|93\.49%|ONLINE|refreshData\(\)/);
 for(const [,src]of html.matchAll(/<script[^>]+src="([^"?]+)(?:\?[^"]*)?"/g))if(!src.startsWith('http'))new vm.Script(read(src));
});
for(const role of ['ADMIN','SUPERVISOR'])test(`server-verified ${role} opens unavailable-data view with only an auth request`,async()=>{
 const r=rig({user:{roles:[role]}});await r.settle();assert.equal(r.elements.get('executive-content').hidden,false);
 assert.match(r.elements.get('executive-access-status').textContent,/ยังไม่เชื่อมต่อข้อมูล/);assert.deepEqual(r.calls.map(c=>c.body.action),['verifyToken']);
});
for(const options of [{token:false},{signedOut:true},{storageBlocked:true}])test('missing/signed-out/unreadable credentials remain gated with no network calls',async()=>{
 const r=rig(options);await r.settle();assert.equal(r.elements.get('executive-content').hidden,true);assert.equal(r.calls.length,0);assert.equal(r.elements.get('executive-recheck').disabled,false);
});
for(const denied of [{roles:['EMPLOYEE']},{roles:['ADMINISTRATOR']},{identityId:''},{sessionVersion:0},{authorizationRevision:''},{mustChangePassword:true}])test('verified but ineligible identity cannot enter Executive',async()=>{
 const r=rig({user:denied});await r.settle();assert.equal(r.elements.get('executive-content').hidden,true);assert.equal(r.calls.length,1);
});
for(const code of [401,403,503])test(`${code} verification failure hides content; manual retry recovers without domain access`,async()=>{
 let deny=true;const r=rig({reply:async()=>({ok:!deny,json:async()=>deny?{valid:false,reason:'fixture_'+code}:{valid:true,user}})});await r.settle();assert.equal(r.elements.get('executive-content').hidden,true);
 deny=false;await r.recheck();assert.equal(r.elements.get('executive-content').hidden,false);assert.ok(r.calls.every(c=>c.body.action==='verifyToken'));
});
test('pending verification hides content and logout before its response cannot reopen it',async()=>{
 const reply=deferred(),r=rig({reply:()=>reply.promise});assert.equal(r.elements.get('executive-content').hidden,true);
 r.storage.set('akra_main_session','{"version":1,"signedOut":true}');reply.resolve({ok:true,json:async()=>({valid:true,user})});await r.settle();assert.equal(r.elements.get('executive-content').hidden,true);
});
test('peer logout retires the screen; a failed refresh never retains an authorized view',async()=>{
 const r=rig();await r.settle();assert.equal(r.elements.get('executive-content').hidden,false);
 r.storage.set('akra_main_session','{"version":1,"signedOut":true}');for(const fn of r.events.storage)await fn({key:'akra_main_session'});
 assert.equal(r.elements.get('executive-content').hidden,true);await r.recheck();assert.equal(r.calls.length,1);
});
test('returning from hidden tab or history verifies again and removes revoked role access',async()=>{
 let roles=['ADMIN'];const r=rig({reply:async()=>({ok:true,json:async()=>({valid:true,user:{...user,roles}})})});await r.settle();roles=['EMPLOYEE'];
 await r.docEvents.visibilitychange();assert.equal(r.elements.get('executive-content').hidden,true);roles=['SUPERVISOR'];
 for(const fn of r.events.pageshow)await fn({persisted:true});assert.equal(r.elements.get('executive-content').hidden,false);
});
test('same-owner token notification is server verified without persisting any credentials',async()=>{
 const r=rig();await r.settle();r.storage.set('akra_main_session',JSON.stringify({version:1,token:'rotated',...user}));r.storage.set('akra_session_token','rotated');
 for(const fn of r.events.storage)await fn({key:'akra_main_session'});assert.equal(r.elements.get('executive-content').hidden,false);
 assert.equal(r.calls.at(-1).body.token,'rotated');
});
