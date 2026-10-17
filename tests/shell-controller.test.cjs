// Runtime controller contract tests. This fake DOM is not browser evidence.
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
function setup() {
    const elements = {}, listeners = {}, history = [], timers = new Map(), notices = [];
    let now = 0;
    let timer = 0, confirms = 0, nativeConfirms = 0, homes = 0, logouts = 0, admins = 0;
    function element(tag='div') {
        return {tag, hidden:false, inert:false, open:false, children:[], attrs:{}, listeners:{}, style:{}, isConnected:true,
            classList:{add(){},remove(){}},
            addEventListener(name,fn){this.listeners[name]=fn;},
            appendChild(child){this.children.push(child);child.parent=this;}, replaceChildren(){this.children=[];},
            remove(){this.isConnected=false;if(this.parent)this.parent.children=this.parent.children.filter(child=>child!==this);},
            setAttribute(k,v){this.attrs[k]=v;},removeAttribute(k){delete this.attrs[k];},
            querySelector(selector){return selector === '[aria-current="page"]' ? this.children.find(child=>child.attrs['aria-current']==='page') || null : null;},
            showModal(){this.open=true;},close(){this.open=false;this.listeners.close?.();},focus(){this.focused=true;document.activeElement=this;},blur(){document.activeElement=null;}};
    }
    const location = {origin:'https://akra-web.github.io',pathname:'/Main/',search:'',hash:''};
    const state = {sessionToken:'session-one',sessionEpoch:1,currentUserId:'one',currentUser:'Fixture',currentRoles:['ADMIN'],appConfig:[
        {id:'app-tracking',url:location.origin+'/TrackingPO/',roles:['ADMIN'],name:'PO'},
        {id:'app-gr',url:location.origin+'/GR/',roles:['ADMIN'],name:'GR'}]};
    const document = {body:element(),activeElement:null,getElementById:id=>elements[id]||(elements[id]=element()),createElement:tag=>{
        if(tag==='dialog')confirms++;
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
    const window={location,addEventListener:(name,fn)=>listeners[name]=fn,confirm:()=>{nativeConfirms++;return false;},history:{}};
    for(const method of ['pushState','replaceState'])window.history[method]=(s,title,url)=>{location.hash=url.slice(url.indexOf('#'));history.push({method,url});};
    const later=fn=>{timers.set(++timer,fn);return timer;};
    window.setTimeout=later;
    const context=vm.createContext({window,document,URL,Date:{now:()=>now},setTimeout:later,clearTimeout:id=>timers.delete(id)});
    const dialogSource=path.join(__dirname,'../js/bm-dialog.js');
    if(fs.existsSync(dialogSource))new vm.Script(fs.readFileSync(dialogSource,'utf8')).runInContext(context);
    new vm.Script(fs.readFileSync(path.join(__dirname,'../js/unified-shell.js'),'utf8')).runInContext(context);
    const shell=window.AkraShell;
    shell.init({state:()=>state,label:app=>app.name,notify:message=>notices.push(message),home:()=>homes++,admin:()=>admins++,logout:()=>logouts++});
    const frame=()=>elements['shell-frame-host'].children[0];
    const message=(type,details={},source=frame()?.contentWindow)=>listeners.message({source,origin:location.origin,data:{channel:'akra-shell',version:1,type,...details}});
    const workflow=(id,index=0)=>elements['shell-app-nav'].children.find(group=>group.attrs['data-app-id']===id).children[1].children[index].listeners.click();
    const advance=(ms=100)=>{now+=ms;const pending=[...timers];timers.clear();pending.forEach(([,fn])=>fn());};
    const dialog=()=>document.body.children.find(child=>child.id==='bm-ui-dialog');
    const decide=approved=>dialog()?.children.at(-1).children.find(child=>child.textContent===(approved?'ยืนยัน':'ยกเลิก'))?.listeners.click();
    return {shell,state,window,elements,frame,listeners,location,history,timers,message,workflow,advance,notices,dialog,decide,allow:()=>{},count:()=>({confirms,nativeConfirms,homes,logouts,admins})};
}
const tick=()=>new Promise(setImmediate);
function assertWorkState(actual,expected){
    assert.equal(actual.dirty,expected.dirty);
    assert.equal(actual.busy,expected.busy);
    assert.equal(actual.unknown,expected.unknown);
}

test('Master Data stays closed until an active configured target is supplied',()=>{
    const c=setup();
    c.state.appConfig.push({id:'app-master-data',url:'',roles:['ADMIN'],isActive:false,name:'Data'});
    assert.equal(c.shell.open('app-master-data'),false);
    assert.equal(c.frame(),undefined);
    c.state.appConfig.at(-1).isActive=true;
    assert.equal(c.shell.open('app-master-data'),false);
    assert.equal(c.frame(),undefined);
    c.state.appConfig.at(-1).url=c.location.origin+'/MasterData/';
    assert.equal(c.shell.open('app-master-data'),true);
    assert.equal(c.frame().src,c.location.origin+'/MasterData/?shell=1');
    assert.equal(c.shell.tokenFor(c.frame().contentWindow),'session-one');
});

test('Master Data dataset selection waits for its authorized child and preserves draft cancellation',()=>{
    const c=setup();
    c.state.appConfig.push({id:'app-master-data',url:c.location.origin+'/MasterData/',roles:['ADMIN'],name:'Data'});
    assert.equal(c.shell.openWorkflow('app-master-data','#tab-members'),true);
    let clicks=0;c.frame().targets.set('#tab-members',{click(){clicks++;}});
    c.advance();assert.equal(clicks,0);c.message('ready');c.advance();assert.equal(clicks,1);
    assert.equal(c.shell.openWorkflow('app-master-data','#arbitrary-action'),false);
    c.frame().contentWindow.AkraModule.setState(true);c.allow(false);
    assert.equal(c.shell.openWorkflow('app-master-data','#tab-products'),false);
    assert.equal(clicks,1);
    c.state.appConfig.at(-1).isActive=false;c.shell.sync();
    assert.equal(c.frame(),undefined);
});

test('Master Data hides workflows and denies forced launch without ADMIN despite app grants',()=>{
    const c=setup();
    c.state.appConfig.push({id:'app-master-data',url:c.location.origin+'/MasterData/',roles:['ADMIN','SUPERVISOR'],name:'Data'});
    c.state.currentRoles=['SUPERVISOR'];
    c.shell.sync();
    assert.equal(c.elements['shell-app-nav'].children.some(group=>group.attrs['data-app-id']==='app-master-data'),false);
    assert.equal(c.shell.open('app-master-data'),false);
    assert.equal(c.shell.openWorkflow('app-master-data','#tab-products'),false);
    assert.equal(c.frame(),undefined);
    c.state.currentRoles=['ADMIN','SUPERVISOR'];c.shell.sync();
    assert.equal(c.shell.open('app-master-data'),true);
    const child=c.frame().contentWindow;
    assert.equal(c.shell.tokenFor(child),'session-one');
    c.state.currentRoles=['SUPERVISOR'];
    assert.equal(c.shell.tokenFor(child),'');c.shell.sync();
    assert.equal(c.frame(),undefined);
});

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
test('back to Main asks once and deliberately releases only the accepted document',async()=>{
    const c=setup();c.shell.open('app-tracking');const old=c.frame();
    old.contentWindow.AkraModule.setState(true);c.location.hash='#/';c.listeners.hashchange();
    assert.equal(c.count().confirms,1);assert.equal(c.count().homes,0);assert.equal(c.frame(),old);
    c.decide(true);await tick();assert.equal(c.count().homes,1);assert.equal(old.leaving,true);assert.equal(c.count().nativeConfirms,0);
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

test('mobile chooser lists permitted apps, preserves cancelled dirty navigation and returns focus on close',async()=>{
    const c=setup();c.shell.open('app-tracking');c.message('ready');const original=c.frame();
    c.elements['shell-apps'].listeners.click();
    const dialog=c.elements['shell-app-dialog'],nav=c.elements['shell-mobile-app-nav'];
    assert.equal(dialog.open,true);assert.equal(c.elements['shell-apps'].attrs['aria-expanded'],'true');
    assert.deepEqual(nav.children.map(button=>button.attrs['data-app-id']),['app-tracking','app-gr']);
    assert.equal(nav.children[0].focused,true);
    nav.children[0].listeners.click();assert.equal(c.frame(),original);assert.equal(dialog.open,false);
    c.elements['shell-apps'].listeners.click();assert.equal(dialog.open,true);
    original.contentWindow.AkraModule.setState(true);c.allow(false);nav.children[1].listeners.click();
    assert.equal(c.frame(),original);assert.equal(dialog.open,true);
    c.decide(false);await tick();assert.equal(c.frame(),original);
    nav.children[1].listeners.click();c.decide(true);await tick();assert.notEqual(c.frame(),original);
    assert.equal(dialog.open,false);assert.equal(c.elements['shell-apps'].attrs['aria-expanded'],'false');assert.equal(c.elements['shell-apps'].focused,true);
});

test('mobile chooser blocks busy switches, rechecks stale grants and closes on session retirement',()=>{
    const c=setup();c.shell.open('app-tracking');c.message('ready');const original=c.frame();
    c.elements['shell-apps'].listeners.click();const nav=c.elements['shell-mobile-app-nav'],dialog=c.elements['shell-app-dialog'];
    original.contentWindow.AkraModule.setState(false,true);nav.children[1].listeners.click();
    assert.equal(c.frame(),original);assert.equal(dialog.open,true);assert.match(c.notices.at(-1),/กำลังบันทึก/);
    original.contentWindow.AkraModule.setState(false,false);c.state.appConfig[1].isActive=false;nav.children[1].listeners.click();
    assert.equal(c.frame(),original);assert.equal(dialog.open,true);
    c.state.sessionToken='';c.state.sessionEpoch++;c.shell.sync();assert.equal(c.frame(),undefined);assert.equal(dialog.open,false);
    c.elements['shell-apps'].listeners.click();assert.equal(dialog.open,false);
});

test('sidebar uses short app text while preserving full tooltip and accessible name',()=>{
    const c=setup();c.state.appConfig[0].name='PO • ระบบจัดซื้อชื่อเต็มทดสอบ';c.shell.sync();
    const button=c.elements['shell-app-nav'].children[0].children[0].children[0];
    assert.equal(button.children[1].textContent,'PO จัดซื้อ');assert.equal(button.title,c.state.appConfig[0].name);
    assert.ok(button.attrs['aria-label'].includes(button.children[1].textContent),'visible short label occurs in accessible name');
    assert.ok(button.attrs['aria-label'].includes(c.state.appConfig[0].name),'full application name is also retained');
});

test('approved dirty switch is asynchronous, keeps the boolean API and reports only actual navigation once',async()=>{
    const c=setup(),opened=[];c.shell.open('app-tracking');const old=c.frame();old.contentWindow.AkraModule.setState(true);
    assert.equal(c.shell.open('app-gr',{onOpened:()=>opened.push('app-gr')}),false);assert.equal(c.frame(),old);assert.deepEqual(opened,[]);
    assert.ok(c.dialog(),'the in-page decision appears');c.shell.open('app-gr',{onOpened:()=>opened.push('duplicate')});
    assert.equal(c.count().confirms,1);c.decide(true);await tick();assert.notEqual(c.frame(),old);assert.equal(c.location.hash,'#/app/app-gr');assert.deepEqual(opened,['app-gr']);assert.equal(c.count().nativeConfirms,0);
});

test('pending decisions cannot navigate a changed owner, token, frame, epoch or revoked grant',async()=>{
    for(const change of ['owner','token','epoch','frame','grant','refresh','identity','version','authorization','main-stamp','stored']){
        const c=setup(),opened=[];c.shell.open('app-tracking');const old=c.frame();old.contentWindow.AkraModule.setState(true);c.shell.open('app-gr',{onOpened:()=>opened.push('app-gr')});
        if(change==='owner')c.state.currentUserId='replacement';if(change==='token')c.state.sessionToken='replacement';if(change==='epoch')c.state.sessionEpoch++;if(change==='grant')c.state.appConfig[1].isActive=false;if(change==='refresh')c.state.sessionRefreshPending=true;
        if(change==='identity')c.state.identityId='replacement';if(change==='version')c.state.sessionVersion=2;if(change==='authorization')c.state.sessionAuthorizationRevision='replacement';
        if(change==='main-stamp')c.window.AkraModule={sessionStamp:()=> 'replacement'};if(change==='stored')c.window.localStorage={getItem:()=> 'replacement'};
        if(change==='frame')c.shell.open('app-tracking',{reload:true,force:true});
        c.decide(true);await tick();assert.deepEqual(opened,[],change);assert.notEqual(c.location.hash,'#/app/app-gr',change);assert.equal(c.count().nativeConfirms,0,change);
    }
});

test('late busy work blocks approved navigation and canceled dirty leave preserves its exact frame',async()=>{
    for(const approved of [true,false]){
        const c=setup();c.shell.open('app-tracking');const old=c.frame();old.contentWindow.AkraModule.setState(true);assert.equal(c.shell.home(),false);
        if(approved)old.contentWindow.AkraModule.setState(true,true);c.decide(approved);await tick();assert.equal(c.frame(),old);assert.equal(old.leaving,undefined);assert.equal(c.count().homes,0);if(approved)assert.match(c.notices.at(-1),/กำลังบันทึก/);
    }
});

test('dirty workflow, admin and child logout wait for their captured in-page decision',async()=>{
    for(const action of ['workflow','same-workflow','admin','logout']){
        const c=setup();c.shell.open('app-tracking');const old=c.frame();old.contentWindow.AkraModule.setState(true);
        if(action==='workflow')c.shell.openWorkflow('app-gr','.gr-nav-receiving');if(action==='same-workflow')c.shell.openWorkflow('app-tracking','#btn-tab-po');if(action==='admin')c.elements['shell-admin'].listeners.click();if(action==='logout')c.message('logout');
        assert.ok(c.dialog(),action);assert.equal(c.frame(),old);assert.equal(c.count().logouts,0);assert.equal(c.count().admins,0);c.decide(true);await tick();
        if(action==='workflow'||action==='same-workflow'){let clicks=0;c.frame().targets.set(action==='workflow'?'.gr-nav-receiving':'#btn-tab-po',{click:()=>clicks++});c.message('ready');c.advance();assert.equal(clicks,1,action);}
        if(action==='admin')assert.equal(c.count().admins,1);if(action==='logout')assert.equal(c.count().logouts,1);
    }
});
