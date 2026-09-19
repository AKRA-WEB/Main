const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const root=path.resolve(__dirname,'../..');
function extract(repo,signature){
 const source=fs.readFileSync(path.join(root,repo,'index.html'),'utf8');
 const start=source.indexOf(signature);assert.ok(start>=0,signature);
 const lineEnd=source.indexOf('\n',start),open=source.lastIndexOf('{',lineEnd);let i=open+1,depth=1;
 while(depth&&i<source.length){if(source[i]==='{')depth++;if(source[i]==='}')depth--;i++;}
 assert.equal(depth,0);return source.slice(start,i);
}
function fixture(){
 let busy=0,settle;const calls=[],alerts=[];
 const bridge={embedded:true,getToken:()=> 'live-fixture-token',runMutation:async fn=>{busy++;try{return await fn();}finally{busy--;}}};
 const c=vm.createContext({window:{AkraModule:bridge},console,FormData,sessionToken:'stale',runtime:{token:'stale'},state:{},
  WEB_APP_URL:'https://fixture.invalid',authUrl:()=> 'https://fixture.invalid',apiEndpoint:()=> 'https://fixture.invalid',
  AppVersionGuard:{blockIfStale:async()=>false},fetch:(url,options)=>{calls.push(options);return new Promise(resolve=>settle=resolve);}});
 return{c,calls,alerts,busy:()=>busy,resolve:(ok=true)=>settle({ok,status:ok?200:503,json:async()=>({status:ok?'success':'error',success:ok})})};
}
test('W5 offline operation must not report a successful save',async()=>{
 const {c,alerts,calls}=fixture();
 vm.runInContext(`this.app={${extract('AKRA','async apiCall(')},${extract('AKRA','async transportApiCall(')}}`,c);
 Object.assign(c.app,{isOnline:false,showAlert:(...args)=>alerts.push(args)});
 assert.equal(await c.app.apiCall({action:'transaction'}),false);
 assert.equal(calls.length,0);assert.equal(alerts.length,1);
});
test('SOP admin UI uses the backend capability, including explicit ADMIN revocation and old-backend compatibility',()=>{
 const c=vm.createContext({});vm.runInContext(extract('SOP','function canManageDocuments('),c);
 assert.equal(c.canManageDocuments({roles:['ADMIN'],canManageDocuments:false}),false);
 assert.equal(c.canManageDocuments({roles:['ADMIN'],canManageDocuments:true}),true);
 assert.equal(c.canManageDocuments({roles:['ADMIN']}),true);
 assert.equal(c.canManageDocuments({roles:['SUPERVISOR']}),false);
});
test('TRD permission errors tell the user to check Main and do not claim a save',()=>{
 const c=vm.createContext({});vm.runInContext(extract('TRDAKRA','function saveErrorMessage('),c);
 for(const message of ['permission_denied','http_403'])assert.match(c.saveErrorMessage({message}),/Main.*ยังไม่ได้บันทึก/);
});
test('W5 mutation retains busy through response, uses fresh token and unwinds state on failure',async()=>{
 const f=fixture();vm.runInContext(`this.app={${extract('AKRA','async apiCall(')},${extract('AKRA','async transportApiCall(')}}`,f.c);
 f.c.appUser={id:'fixture'};vm.runInContext(extract('AKRA','function getW5Token(')+extract('AKRA','function isCurrentW5Session('),f.c);
 Object.assign(f.c.app,{isAuthorized:true,isOnline:true,dataRevision:0,showAlert:(...args)=>f.alerts.push(args)});
 const pending=f.c.app.apiCall({action:'transaction'});await new Promise(setImmediate);
 assert.equal(f.busy(),1);assert.equal(f.calls.length,1);assert.equal(JSON.parse(f.calls[0].body).token,'live-fixture-token');
 f.resolve(false);assert.equal(await pending,false);assert.equal(f.busy(),0);assert.equal(f.c.app.dataMutationPending,false);assert.equal(f.calls.length,1);
});
test('TRD mutation uses fresh header token and releases busy after server rejection',async()=>{
 const f=fixture();vm.runInContext(extract('TRDAKRA','async function postMutation(')+extract('TRDAKRA','async function transportMutation('),f.c);
 f.c.window.appSession={id:'fixture'};vm.runInContext(extract('TRDAKRA','function getTrdToken(')+extract('TRDAKRA','function isCurrentTrdSession('),f.c);
 const pending=f.c.postMutation({action:'saveSurveyLog'});assert.equal(f.busy(),1);assert.equal(f.calls[0].headers.Authorization,'Bearer live-fixture-token');
 f.resolve(false);await assert.rejects(pending,/http_503/);assert.equal(f.busy(),0);assert.equal(f.calls.length,1);
});
for(const mode of ['JSON','form'])test(`SOP ${mode} save tracks busy and refreshes credentials without mutation retry`,async()=>{
 const f=fixture();for(const name of ['apiRequest','transportApiRequest','apiForm','transportApiForm'])vm.runInContext(extract('SOP','async function '+name+'('),f.c);
 f.c.runtime.user={id:'10000000-0000-4000-8000-000000000011'};f.c.runtime.generation=1;
 for(const name of ['getSopToken','captureSopSession','isCurrentSopSession','sopIdentity'])vm.runInContext(extract('SOP','function '+name+'('),f.c);
 const form=new FormData();form.set('token','stale');form.set('action','createDocument');
 const pending=mode==='JSON'?f.c.apiRequest('updatePages',{pages:[]}):f.c.apiForm(form);
 assert.equal(f.busy(),1);assert.equal(f.calls[0].headers.Authorization,'Bearer live-fixture-token');
 assert.equal(mode==='JSON'?JSON.parse(f.calls[0].body).token:form.get('token'),'live-fixture-token');
 f.resolve(false);await assert.rejects(pending,/request_failed/);assert.equal(f.busy(),0);assert.equal(f.calls.length,1);
});
