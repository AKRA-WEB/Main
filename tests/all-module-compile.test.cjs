// Compilation/version/distribution evidence only; not a behavior or browser pass.
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const root=path.resolve(__dirname,'../..');
const modules=['Main','PO','PR','GR','Returnitem','KPITracker','Picking','TRDAKRA','AKRA','SOP','Evaluation form'];
const expectedVersions={
 Main:'20260919.09', PO:'20260919.02', PR:'20260918.02', GR:'20260919.02',
 Returnitem:'20260919.01', KPITracker:'20260919.02', Picking:'20260918.02',
 TRDAKRA:'20260919.02', AKRA:'20260919.03', SOP:'20260919.03', 'Evaluation form':'20260918.03'
};
for(const name of modules)test(`${name}: all entry scripts compile and version files agree`,()=>{
 const dir=path.join(root,name);
 const html=fs.readFileSync(path.join(dir,'index.html'),'utf8');
 const version=JSON.parse(fs.readFileSync(path.join(dir,'version.json'),'utf8')).version;
 assert.equal(html.match(/CURRENT_VERSION\s*=\s*['"]([^'"]+)/)?.[1],version);
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
test('every child uses the exact reviewed Main bridge distribution',()=>{
 const canonical=fs.readFileSync(path.join(root,'Main/js/akra-shell-bridge.js'),'utf8');
 for(const name of modules.filter(value=>value!=='Main'))assert.equal(fs.readFileSync(path.join(root,name,'js/akra-shell-bridge.js'),'utf8'),canonical,name);
});
test('Picking capability page loads compiling local scripts with the candidate asset version',()=>{
 const dir=path.join(root,'Picking'),html=fs.readFileSync(path.join(dir,'problem.html'),'utf8');
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
