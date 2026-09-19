// Actual Main logout + shell storage listener; synchronous synthetic tabs, not a browser.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
const source=html.slice(html.indexOf('        const App = {'),html.indexOf('        const AKRA_SSO = {'));
const shellSource=fs.readFileSync(path.join(__dirname,'../js/unified-shell.js'),'utf8');
function fixture(){
 const shared=new Map([['akra_session_token','old'],['user','old user'],['users','old roster']]),pending=[],tabs=[],removals=[];
 function tab(){
  const elements={},listeners={},sessionRemoved=[],state={sessionToken:'old',sessionEpoch:1,currentUserId:'old',currentUser:'Old',currentRoles:['ADMIN'],appConfig:[]};
  const element=()=>({children:[],classList:{add(){},remove(){},toggle(){}},addEventListener(){},replaceChildren(){this.children=[];},appendChild(n){this.children.push(n);},querySelectorAll:()=>[],setAttribute(){},removeAttribute(){},focus(){}});
  const document={body:element(),getElementById:id=>elements[id]||(elements[id]=element()),createElement:element};
  const window={location:{origin:'https://example.test',pathname:'/Main/',search:'',hash:''},history:{replaceState(){}},addEventListener:(key,fn)=>listeners[key]=fn};
  const t={listeners,state,sessionRemoved};tabs.push(t);
  function write(key,value){const oldValue=shared.get(key)??null;if(oldValue===value)return;if(value===null)shared.delete(key);else shared.set(key,value);for(const other of tabs)if(other!==t)pending.push(()=>other.listeners.storage({key,oldValue,newValue:value}));}
  const context=vm.createContext({window,document,state,URL,setTimeout,clearTimeout,CONFIG:{STORAGE_SESSION:'akra_session_token',STORAGE_USER_DATA:'user',STORAGE_USER_DB:'users'},
   sessionStorage:{removeItem:key=>sessionRemoved.push(key)},safeStorage:{setItem:(key,value)=>write(key,value),removeItem:key=>{removals.push(key);write(key,null);}},
   AdminInteractive:{userPermissionEditor:{reset(){}},resetProfile(){}},LineAccount:{updateHeaderButton(){},closeModal(){}},UI:{switchSection(){}}});
  vm.runInContext(source+'\nthis.app=App;',context);vm.runInContext(shellSource,context);
  window.AkraShell.init({state:()=>state,label:app=>app.name,notify(){},home(){},admin(){},logout:options=>context.app.handleLogout(options)});
  return Object.assign(t,{write,app:context.app});
 }
 const flush=()=>{let n=0;while(pending.length){assert.ok(++n<30,'storage events must not cascade indefinitely');pending.shift()();}};
 return {tab,shared,flush,removals};
}
test('A login in another tab clears old local identity without deleting the newer shared session',()=>{
 const f=fixture(),old=f.tab(),fresh=f.tab();fresh.state.sessionToken='new';fresh.write('akra_session_token','new');f.shared.set('user','new user');f.flush();
 assert.equal(old.state.sessionToken,null);assert.equal(old.state.currentUser,null);assert.equal(old.state.sessionEpoch,2);
 assert.equal(fresh.state.sessionToken,'new');assert.equal(f.shared.get('akra_session_token'),'new');assert.equal(f.shared.get('user'),'new user');
 assert.deepEqual(f.removals,[]);assert.ok(old.sessionRemoved.includes('akra_session_lifecycle_marker'));
});
test('Explicit logout still removes shared credentials and signs out peer tabs without a write cascade',()=>{
 const f=fixture(),first=f.tab(),second=f.tab();first.app.handleLogout();f.flush();
 assert.equal(first.state.sessionToken,null);assert.equal(second.state.sessionToken,null);assert.equal(f.shared.size,1);
 assert.deepEqual(JSON.parse(f.shared.get('akra_main_session')),{version:1,signedOut:true});
 assert.deepEqual(f.removals,['akra_session_token','user','users']);
});
test('Identical/unrelated storage changes do not sign out; clearing storage invalidates local identity',()=>{
 const f=fixture(),t=f.tab();t.listeners.storage({key:'unrelated',newValue:'changed'});t.listeners.storage({key:'akra_session_token',newValue:'old'});
 assert.equal(t.state.sessionToken,'old');t.listeners.storage({key:null,newValue:null});assert.equal(t.state.sessionToken,null);assert.deepEqual(f.removals,[]);
});
