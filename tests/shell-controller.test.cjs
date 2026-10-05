// Runtime controller contract tests. This fake DOM is not browser evidence.
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
function setup() {
    const elements = {}, listeners = {}, history = [], timers = new Map(), notices = [];
    let now = 0;
    let timer = 0, confirms = 0, allowLeave = true, homes = 0, logouts = 0;
    function element(tag='div') {
        return {tag, hidden:false, inert:false, children:[], attrs:{}, listeners:{},
            classList:{add(){},remove(){}},
            addEventListener(name,fn){this.listeners[name]=fn;},
            appendChild(child){this.children.push(child);}, replaceChildren(){this.children=[];},
            setAttribute(k,v){this.attrs[k]=v;},removeAttribute(k){delete this.attrs[k];},
            querySelector(){return null;},focus(){this.focused=true;}};
    }
    const location = {origin:'https://akra-web.github.io',pathname:'/Main/',search:'',hash:''};
    const state = {sessionToken:'session-one',sessionEpoch:1,currentUserId:'one',currentUser:'Fixture',currentRoles:['ADMIN'],appConfig:[
        {id:'app-tracking',url:location.origin+'/TrackingPO/',roles:['ADMIN'],name:'PO'},
        {id:'app-gr',url:location.origin+'/GR/',roles:['ADMIN'],name:'GR'}]};
    const document = {body:element(),getElementById:id=>elements[id]||(elements[id]=element()),createElement:tag=>{
        const el=element(tag);if(tag==='iframe'){
            let dirty=false,busy=false;
            el.contentWindow={location:{origin:location.origin,pathname:'/TrackingPO/'},AkraModule:{
                hasPendingWork:()=>dirty||busy,getWorkState:()=>({dirty,busy}),
                setState:(d,b=false)=>{dirty=d;busy=b;},prepareLeave:()=>{el.leaving=true;}
            }};
            const targets = new Map();
            el.contentDocument = {querySelector:selector=>targets.get(selector) || null};
            el.targets = targets;
            Object.defineProperty(el,'src',{get:()=>el.url,set:value=>{el.url=value;el.contentWindow.location.pathname=new URL(value).pathname;}});
        }return el;
    }};
    for (const id of ['dashboard-section','login-section','admin-section']) document.getElementById(id);
    const window={location,addEventListener:(name,fn)=>listeners[name]=fn,confirm:()=>{confirms++;return allowLeave;},history:{}};
    for(const method of ['pushState','replaceState'])window.history[method]=(s,title,url)=>{location.hash=url.slice(url.indexOf('#'));history.push({method,url});};
    const later=fn=>{timers.set(++timer,fn);return timer;};
    window.setTimeout=later;
    const context=vm.createContext({window,document,URL,Date:{now:()=>now},setTimeout:later,clearTimeout:id=>timers.delete(id)});
    new vm.Script(fs.readFileSync(path.join(__dirname,'../js/unified-shell.js'),'utf8')).runInContext(context);
    const shell=window.AkraShell;
    shell.init({state:()=>state,label:app=>app.name,notify:message=>notices.push(message),home:()=>homes++,admin:()=>{},logout:()=>logouts++});
    const frame=()=>elements['shell-frame-host'].children[0];
    const message=(type,details={},source=frame()?.contentWindow)=>listeners.message({source,origin:location.origin,data:{channel:'akra-shell',version:1,type,...details}});
    const workflow=(id,index=0)=>elements['shell-app-nav'].children.find(group=>group.attrs['data-app-id']===id).children[1].children[index].listeners.click();
    const advance=(ms=100)=>{now+=ms;const pending=[...timers];timers.clear();pending.forEach(([,fn])=>fn());};
    return {shell,state,elements,frame,listeners,location,history,timers,message,workflow,advance,notices,allow:val=>allowLeave=val,count:()=>({confirms,homes,logouts})};
}
function assertWorkState(actual,expected){
    assert.equal(actual.dirty,expected.dirty);
    assert.equal(actual.busy,expected.busy);
    assert.equal(actual.unknown,expected.unknown);
}

test('push receiving workflow resolves the existing allowlist and waits for the authorized frame controls',()=>{
    const c=setup();
    assert.equal(c.shell.openWorkflow('app-gr','.gr-nav-receiving'),true);
    assert.equal(c.location.hash,'#/app/app-gr');
    let clicks=0;
    c.message('ready');
    c.frame().targets.set('.gr-nav-receiving',{click(){clicks++;}});
    c.advance();
    assert.equal(clicks,1);
    assert.equal(c.shell.openWorkflow('app-gr','.untrusted-selector'),false);
    assert.equal(c.shell.openWorkflow('https://evil.test/','.gr-nav-receiving'),false);
    assert.equal(clicks,1);
});
test('push workflow preserves cancelled dirty navigation and discards delayed intent after signout or role loss',()=>{
    const c=setup();c.shell.open('app-tracking');const old=c.frame();
    old.contentWindow.AkraModule.setState(true);c.allow(false);
    assert.equal(c.shell.openWorkflow('app-gr','.gr-nav-receiving'),false);
    assert.equal(c.frame(),old);assert.equal(c.location.hash,'#/app/app-tracking');
    for(const revoke of [state=>{state.sessionToken='';state.sessionEpoch++;},state=>{state.currentRoles=['STAFF'];}]){
        const f=setup();assert.equal(f.shell.openWorkflow('app-gr','.gr-nav-receiving'),true);let clicks=0;
        f.message('ready');revoke(f.state);f.shell.sync();
        f.frame()?.targets.set('.gr-nav-receiving',{click(){clicks++;}});f.advance();assert.equal(clicks,0);
    }
    const f=setup();f.shell.open('app-gr');f.frame().contentWindow.AkraModule.setState(true);f.allow(false);
    assert.equal(f.shell.openWorkflow('app-gr','.gr-nav-receiving'),false);
});

test('Main opts child diagnostics in only for exact akra_perf=1 without forwarding other query values',()=>{
    const c=setup();c.location.search='?akra_perf=1&private_value=fixture-secret';c.shell.open('app-tracking');
    assert.equal(c.frame().src,'https://akra-web.github.io/TrackingPO/?shell=1&akra_perf=1');
    assert.equal(c.shell.tokenFor(c.frame().contentWindow),'session-one');
    for(const search of ['', '?akra_perf=true', '?private_value=fixture-secret']){
        const f=setup();f.location.search=search;f.shell.open('app-tracking');
        assert.equal(f.frame().src,'https://akra-web.github.io/TrackingPO/?shell=1');
    }
});
test('open keeps only one document and removes background Main from keyboard/accessibility flow',()=>{
    const c=setup();c.shell.open('app-tracking');
    assert.equal(c.elements['dashboard-section'].inert,true);
    assert.equal(c.elements['dashboard-section'].attrs['aria-hidden'],'true');
    c.shell.open('app-gr');assert.equal(c.elements['shell-frame-host'].children.length,1);
    c.shell.home();assert.equal(c.elements['dashboard-section'].inert,false);
    assert.equal(c.elements['dashboard-section'].attrs['aria-hidden'],undefined);
});
test('dirty cancelled switch retains exact document and route',()=>{
    const c=setup();c.shell.open('app-tracking');const old=c.frame();
    old.contentWindow.AkraModule.setState(true);c.allow(false);
    assert.equal(c.shell.open('app-gr'),false);assert.equal(c.frame(),old);
    assert.equal(c.location.hash,'#/app/app-tracking');assert.equal(old.leaving,undefined);
});
test('back to Main asks once and deliberately releases only the accepted document',()=>{
    const c=setup();c.shell.open('app-tracking');const old=c.frame();
    old.contentWindow.AkraModule.setState(true);c.location.hash='#/';c.listeners.hashchange();
    assert.equal(c.count().confirms,1);assert.equal(c.count().homes,1);assert.equal(old.leaving,true);
});
test('history back normalizes a missing Main hash with replaceState so Forward remains available',()=>{
    const c=setup();c.shell.open('app-tracking');
    c.location.hash='';c.listeners.popstate();
    assert.equal(c.count().homes,1);
    assert.equal(c.history.at(-1).method,'replaceState');
    assert.equal(c.location.hash,'#/');
});
test('in-flight work cannot be discarded by switch, home or child logout',()=>{
    const c=setup();c.shell.open('app-tracking');const old=c.frame();old.contentWindow.AkraModule.setState(false,true);
    assert.equal(c.shell.open('app-gr'),false);assert.equal(c.shell.home(),false);
    c.message('logout');assert.equal(c.count().logouts,0);assert.equal(c.frame(),old);
});
test('temporary session refresh preserves draft document, actual revocation destroys it',()=>{
    const c=setup();c.shell.open('app-tracking');c.message('ready');const old=c.frame();old.contentWindow.AkraModule.setState(true);
    c.state.sessionRefreshPending=true;c.shell.sync();assert.equal(c.frame(),old);assert.equal(old.inert,true);
    c.state.sessionRefreshPending=false;c.state.sessionToken='session-two';c.shell.sync();
    assert.equal(old.inert,false);assert.equal(c.shell.tokenFor(old.contentWindow),'session-two');
    c.state.appConfig=[];c.shell.sync();assert.equal(c.frame(),undefined);
});
test('late readiness from removed frame cannot reveal the new frame or obtain its token',()=>{
    const c=setup();c.shell.open('app-tracking');const old=c.frame();c.shell.open('app-gr');
    c.message('ready',{},old.contentWindow);assert.equal(c.frame().hidden,true);
    assert.equal(c.shell.tokenFor(old.contentWindow),'');
});
test('forged origin/incorrect path cannot request credentials and loading timeout is recoverable',()=>{
    const c=setup();c.shell.open('app-tracking');const f=c.frame();
    f.contentWindow.location.pathname='/wrong/';assert.equal(c.shell.tokenFor(f.contentWindow),'');
    [...c.timers.values()].forEach(fn=>fn());
    assert.equal(c.elements['shell-retry'].hidden,false);assert.equal(c.elements['shell-status'].hidden,false);
    c.shell.home();assert.equal(c.elements['unified-shell'].hidden,true);
});
test('update work state is unknown until a child reports readiness and state',()=>{
    const c=setup();
    assertWorkState(c.shell.getWorkState(),{dirty:false,busy:false,unknown:false});
    c.shell.open('app-tracking');
    assertWorkState(c.shell.getWorkState(),{dirty:false,busy:false,unknown:true});
    c.message('ready');
    assertWorkState(c.shell.getWorkState(),{dirty:false,busy:false,unknown:false});
    c.shell.home();
    assertWorkState(c.shell.getWorkState(),{dirty:false,busy:false,unknown:false});
});
test('update work state includes child drafts and saves and fails closed without a state bridge',()=>{
    const c=setup();c.shell.open('app-tracking');c.message('ready');
    const module=c.frame().contentWindow.AkraModule;
    module.setState(true,false);
    assertWorkState(c.shell.getWorkState(),{dirty:true,busy:false,unknown:false});
    module.setState(false,true);
    assertWorkState(c.shell.getWorkState(),{dirty:false,busy:true,unknown:false});
    delete module.getWorkState;
    assertWorkState(c.shell.getWorkState(),{dirty:false,busy:false,unknown:true});
});

test('focus and unchanged synchronization preserve sidebar buttons and select options',()=>{
    const c=setup();c.shell.open('app-tracking');c.message('ready');
    const group=c.elements['shell-app-nav'].children[0], option=c.elements['shell-module-select'].children[0];
    c.listeners.focus();c.shell.sync();
    assert.equal(c.elements['shell-app-nav'].children[0],group);
    assert.equal(c.elements['shell-module-select'].children[0],option);
    c.state.appConfig[0].name='Renamed PO';c.shell.sync();
    assert.notEqual(c.elements['shell-app-nav'].children[0],group);
    c.state.appConfig=[];c.shell.sync();assert.equal(c.elements['shell-app-nav'].children.length,0);
});

test('one same-app workflow click waits for ready and controls, latest selection runs once',()=>{
    const c=setup();c.shell.open('app-tracking');let first=0,latest=0;
    c.workflow('app-tracking',0);c.workflow('app-tracking',1);
    c.message('ready');
    c.frame().targets.set('#btn-tab-pr',{click:()=>first++});
    c.frame().targets.set('#btn-tab-po',{click:()=>latest++});
    c.advance();c.shell.sync();c.advance();
    assert.equal(first,0);assert.equal(latest,1);assert.equal(c.notices.length,0);
});

test('cross-app workflow resumes when ready overlaps session refresh',()=>{
    const c=setup();c.shell.open('app-tracking');let clicks=0;
    c.workflow('app-gr',1);c.frame().targets.set('.gr-nav-vendor',{click:()=>clicks++});
    c.state.sessionRefreshPending=true;c.message('ready');assert.equal(clicks,0);
    c.state.sessionRefreshPending=false;c.shell.sync();c.advance();
    assert.equal(clicks,1);
});

test('pending workflow is cancelled by home and cannot reach a reopened app',()=>{
    const c=setup();let clicks=0;c.shell.open('app-tracking');c.workflow('app-gr',1);
    c.message('ready');const old=[...c.timers.values()];c.shell.home();
    c.shell.open('app-gr');c.frame().targets.set('.gr-nav-vendor',{click:()=>clicks++});c.message('ready');
    old.forEach(fn=>fn());c.advance();assert.equal(clicks,0);
});

test('workflow retries stop on revoked identity and reject disabled controls',()=>{
    const c=setup();let clicks=0;c.shell.open('app-tracking');c.message('ready');
    c.frame().targets.set('#btn-tab-po',{disabled:true,click:()=>clicks++});c.workflow('app-tracking',1);
    c.advance();assert.equal(clicks,0);
    c.frame().targets.get('#btn-tab-po').disabled=false;c.state.sessionEpoch++;c.advance();
    assert.equal(clicks,0);
});

test('unavailable workflow expires with one notification instead of retrying forever',()=>{
    const c=setup();c.shell.open('app-tracking');c.message('ready');c.workflow('app-tracking',1);
    c.advance(20001);c.advance(20001);assert.equal(c.notices.length,1);
});
