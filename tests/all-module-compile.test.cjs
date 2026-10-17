// Compilation/version/distribution evidence only; not a behavior or browser pass.
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const root=path.resolve(__dirname,'../..');
const modules=['Main','PO','PR','GR','Returnitem','KPITracker','Picking','TRDAKRA','AKRA','SOP','MasterData','Evaluation form'];
const expectedVersions={
 Main:'20261014.01', PO:'20261013.03', PR:'20261013.03', GR:'20261014.01',
 Returnitem:'20261013.03', KPITracker:'20261014.01', Picking:'20261002.01',
 TRDAKRA:'20261014.01', AKRA:'20261014.04', SOP:'20261013.03', MasterData:'20261013.03', 'Evaluation form':'20261002.01'
};
function moduleRoot(name){
 if(!['Picking','Evaluation form'].includes(name))return path.join(root,name);
 const key=name==='Picking'?'AKRA_TEST_PICKING_ROOT':'AKRA_TEST_EVALUATION_ROOT',selected=process.env[key];
 assert.ok(selected&&path.isAbsolute(selected),key+' must explicitly select the retained disabled read reference');
 return path.resolve(selected);
}
for(const name of modules)test(`${name}: all entry scripts compile and version files agree`,()=>{
 const dir=moduleRoot(name);
 const html=fs.readFileSync(path.join(dir,'index.html'),'utf8');
 const version=JSON.parse(fs.readFileSync(path.join(dir,'version.json'),'utf8')).version;
 const versionSource=name==='MasterData'?fs.readFileSync(path.join(dir,'js/app.js'),'utf8'):html;
 assert.equal(versionSource.match(/CURRENT_VERSION\s*=\s*['"]([^'"]+)/)?.[1],version);
 assert.equal(version,expectedVersions[name]);
 let compiled=0;
 for(const [,attributes,inline] of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)){
  const src=attributes.match(/\bsrc=['"]([^'"]+)/)?.[1];
  if(src){
   if(/^(https?:)?\/\//.test(src))continue;
   const file=path.resolve(dir,src.split('?')[0]);
   assert.ok(file.startsWith(dir+path.sep),'local script stays in its module');
   new vm.Script(fs.readFileSync(file,'utf8'),{filename:name+'/'+src});compiled++;
  }else if(inline.trim()) {new vm.Script(inline,{filename:name+'/inline'});compiled++;}
 }
 assert.ok(compiled>0);
});
// Main contract explicitly permits observer drift. Execute the shared token/message/busy
// protocol for every retained distribution instead of assuming byte identity.
test('every current and retained disabled bridge preserves the authenticated Main wire protocol',async()=>{
 for(const name of modules){
  const source=fs.readFileSync(path.join(moduleRoot(name),'js/akra-shell-bridge.js'),'utf8'),events={},messages=[],requests=[];
  let token='fictional-owner-token';
  const parent={location:{origin:'https://akra-web.github.io',pathname:'/Main/'},AkraShell:{tokenFor:()=>token},postMessage:(message,to)=>messages.push({message,to})};
  const window={parent,location:{origin:'https://akra-web.github.io',hostname:'akra-web.github.io',search:''},addEventListener:(key,fn)=>events[key]=fn};
  const document={readyState:'loading',addEventListener:(key,fn)=>events[key]=fn,querySelector:()=>null};
  vm.runInNewContext(source,{window,document,URLSearchParams,AbortController,setTimeout,clearTimeout,fetch:async(url,options)=>{requests.push({url,options});return{ok:true,json:async()=>({valid:true,user:{id:'fictional-owner'}})};}});
  const bridge=window.AkraModule;assert.equal(bridge.embedded,true,name);assert.equal(bridge.getToken(),token,name);assert.equal(bridge.isLocalPreview(),false,name);
  const user=await bridge.verifySession('app-kpi');assert.equal(user.id,'fictional-owner');assert.equal(requests.length,1);
  assert.equal(requests[0].options.method,'POST');assert.equal(requests[0].url.includes(token),false);assert.deepEqual(JSON.parse(requests[0].options.body),{action:'verifyToken',appId:'app-kpi',token});
  token='fictional-refreshed-token';assert.equal(bridge.getToken(),token,name+' gets current token');
  bridge.markDirty();await assert.rejects(bridge.runMutation(async()=>{throw Error('fictional-save-failed');}),/fictional-save-failed/);assert.equal(bridge.getWorkState().busy,false);assert.equal(bridge.hasPendingWork(),true);
  bridge.markSaved();assert.equal(bridge.hasPendingWork(),false);
  token='';assert.throws(()=>bridge.getToken(),/shell_session_unavailable/,name+' denies missing shell token');
 }
});
test('Picking capability page loads compiling local scripts with the candidate asset version',()=>{
 const dir=moduleRoot('Picking'),html=fs.readFileSync(path.join(dir,'problem.html'),'utf8');
 const version=JSON.parse(fs.readFileSync(path.join(dir,'version.json'),'utf8')).version;
 let compiled=0;
 for(const [,attributes,inline] of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)){
  const src=attributes.match(/\bsrc=['"]([^'"]+)/)?.[1];
  if(src){
   assert.ok(!/^(https?:)?\/\//.test(src),'capability page has no third-party script');
   const file=path.resolve(dir,src.split('?')[0]);assert.ok(file.startsWith(dir+path.sep));
   assert.equal(new URL(src,'https://fixture.invalid/').searchParams.get('v'),version);
   new vm.Script(fs.readFileSync(file,'utf8'),{filename:src});compiled++;
  }else if(inline.trim()){new vm.Script(inline);compiled++;}
 }
 assert.equal(compiled,2);
});
