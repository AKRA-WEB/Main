const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname,'../js/akra-shell-bridge.js'),'utf8');
function setup({embedded=true,token='fixture',origin='https://akra-web.github.io',pathname='/Main/',reply={valid:true,user:{id:'fixture-user'}}}={}) {
    const messages=[],listeners={},requests=[];
    const document={readyState:'loading',addEventListener:(name,fn)=>listeners[name]=fn};
    const window={location:{origin,hostname:new URL(origin).hostname,search:''},addEventListener:(name,fn)=>listeners[name]=fn};
    window.parent=embedded?{location:{origin,pathname},AkraShell:{tokenFor:()=>token},postMessage:(message,to)=>messages.push({message,to})}:window;
    vm.runInNewContext(source,{window,document,URLSearchParams,fetch:async(url,options)=>{requests.push({url,options});return {ok:reply.valid,json:async()=>reply};}});
    return {module:window.AkraModule,messages,listeners,window,requests};
}
test('embedded app receives memory-only token and never becomes preview',()=>{
    const {module,messages,listeners}=setup();
    assert.equal(module.getToken(),'fixture');
    assert.equal(module.isLocalPreview(),false);
    listeners.DOMContentLoaded();
    assert.equal(messages[0].message.type,'ready');
    assert.equal(JSON.stringify(messages).includes('fixture'),false);
});
test('missing shell session fails closed instead of falling back to cached user',()=>{
    assert.throws(()=>setup({token:''}).module.getToken(),/shell_session_unavailable/);
});
test('arbitrary same-origin parent cannot be the Main shell',()=>{
    const {module}=setup({pathname:'/untrusted/'});
    assert.equal(module.embedded,false);
    assert.equal(module.getToken(),'');
});
test('Main index.html alias is still recognized as the trusted shell parent',()=>{
    const {module}=setup({pathname:'/Main/index.html'});
    assert.equal(module.embedded,true);
    assert.equal(module.getToken(),'fixture');
});
test('nested busy operations and dirty work survive a failed/unfinished save',()=>{
    const {module,listeners}=setup();
    module.startWork();module.startWork();module.endWork();
    assert.equal(module.hasPendingWork(),true);
    module.endWork();assert.equal(module.hasPendingWork(),false);
    module.markDirty();assert.equal(module.hasPendingWork(),true);
    let prevented=false;listeners.beforeunload({preventDefault:()=>prevented=true});
    assert.equal(prevented,true);
    module.markSaved();assert.equal(module.hasPendingWork(),false);
});
test('preview requires explicit demo on localhost and never an embedded production page',()=>{
    const standalone=setup({embedded:false,origin:'http://localhost:4173'});
    assert.equal(standalone.module.isLocalPreview(),false);
    standalone.window.location.search='?demo=1';
    assert.equal(standalone.module.isLocalPreview(),true);
});
test('module authentication verifies current Main session and assigned app via POST, never URL token',async()=>{
    const c=setup();const user=await c.module.verifySession('app-evaluation');
    assert.equal(user.id,'fixture-user');assert.equal(c.requests.length,1);
    assert.equal(c.requests[0].url.includes('token'),false);
    assert.deepEqual(JSON.parse(c.requests[0].options.body),{action:'verifyToken',appId:'app-evaluation',token:'fixture'});
});
test('denied or absent session cannot fall back to cache or preview',async()=>{
    const c=setup({reply:{valid:false,reason:'permission_denied'}});
    await assert.rejects(c.module.verifySession('app-evaluation'),/permission_denied/);
    const absent=setup({token:''});await assert.rejects(absent.module.verifySession('app-evaluation'),/shell_session_unavailable/);
    assert.equal(absent.requests.length,0);
});
test('operation tracking always releases busy on rejection but never clears dirty data implicitly',async()=>{
    const c=setup();c.module.markDirty();let reject;
    const pending=c.module.runMutation(()=>new Promise((_,fail)=>reject=fail));
    assert.equal(c.module.getWorkState().busy,true);reject(new Error('fixture failure'));
    await assert.rejects(pending,/fixture failure/);
    assert.equal(c.module.getWorkState().busy,false);assert.equal(c.module.hasPendingWork(),true);
});
