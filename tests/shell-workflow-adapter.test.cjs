const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require('node:path').join(__dirname,'../js/unified-shell.js'),'utf8');
const start=source.indexOf('    function clickWorkflow(item) {'),end=source.indexOf('    function activateWorkflow(',start);
function run(frame){const context=vm.createContext({active:{frame}});vm.runInContext(source.slice(start,end)+'\nthis.activate=clickWorkflow;',context);return context.activate;}
test('Main delegates reviewed workflow routes to the child adapter without running child inline handlers in Main',()=>{
 let selected;const frame={contentDocument:{querySelector(){throw Error('parent execution must not occur');}},contentWindow:{AkraModule:{activateWorkflow(selector){selected=selector;return true;}}}};
 assert.equal(run(frame)({selector:'#dtab-duties'}),true);assert.equal(selected,'#dtab-duties');
 frame.contentWindow.AkraModule.activateWorkflow=()=>false;assert.equal(run(frame)({selector:'#dtab-duties'}),false);
});
test('legacy modules retain document click navigation and missing targets are recoverable',()=>{
 let clicks=0;const frame={contentDocument:{querySelector:selector=>selector==='#legacy'?{click(){clicks++;}}:null}};
 assert.equal(run(frame)({selector:'#legacy'}),true);assert.equal(clicks,1);assert.equal(run(frame)({selector:'#missing'}),false);
});
