// Runtime controller contract tests. This fake DOM is not browser evidence.
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
function setup() {
    const elements = {}, listeners = {}, history = [], timers = new Map();
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
        }return el;
    }};
    for (const id of ['dashboard-section','login-section','admin-section']) document.getElementById(id);
    const window={location,addEventListener:(name,fn)=>listeners[name]=fn,confirm:()=>{confirms++;return allowLeave;},history:{}};
    for(const method of ['pushState','replaceState'])window.history[method]=(s,title,url)=>{location.hash=url.slice(url.indexOf('#'));history.push({method,url});};
    const context=vm.createContext({window,document,URL,setTimeout:fn=>{timers.set(++timer,fn);return timer;},clearTimeout:id=>timers.delete(id)});
    new vm.Script(fs.readFileSync(path.join(__dirname,'../js/unified-shell.js'),'utf8')).runInContext(context);
    const shell=window.AkraShell;
    shell.init({state:()=>state,label:app=>app.name,notify:()=>{},home:()=>homes++,admin:()=>{},logout:()=>logouts++});
    const frame=()=>elements['shell-frame-host'].children[0];
    const message=(type,details={},source=frame()?.contentWindow)=>listeners.message({source,origin:location.origin,data:{channel:'akra-shell',version:1,type,...details}});
    return {shell,state,elements,frame,listeners,location,history,timers,message,allow:val=>allowLeave=val,count:()=>({confirms,homes,logouts})};
}
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
