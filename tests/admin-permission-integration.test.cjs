const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
function fixture({refresh=true,post=null}={}){
    const nodes=new Map(),messages=[],calls=[],cached={};
    const node=id=>{if(!nodes.has(id))nodes.set(id,{value:'',disabled:false,innerHTML:'original',textContent:'',classList:{add(){},remove(){},contains(){return true;}}});return nodes.get(id);};
    const state={sessionEpoch:1,currentRoles:['ADMIN'],mustChangePassword:false,authorizationLoaded:true,authorizationRevision:'before',authorizationDirty:true,authorizationSaving:false,
        users:{},appConfig:[{id:'active'}],authorizationAppConfig:[{id:'active'},{id:'inactive',isActive:false}],permRows:[{appId:'active',permKey:'read'}],roleConfig:[]};
    const latest=()=>({status:'success',users:{other:{identityId:'fixture-id',roles:['WAREHOUSE'],sessionVersion:1,explicitPermissions:[]}},appConfig:[{id:'active'}],authorizationAppConfig:[{id:'active'},{id:'inactive',isActive:false}],permRows:[],roleConfig:[],authorizationRevision:'after',authorizationSchemaVersion:2});
    const context=vm.createContext({state,document:{getElementById:node,querySelectorAll:()=>[]},confirm:()=>true,console:{warn(){}},lucide:{createIcons(){}},
        UI:{showToast:(...args)=>messages.push(args),switchSection(){}},App:{refreshSession:async()=>{calls.push('refresh');return refresh;}},
        API:{postAction:async payload=>{calls.push(payload);return post?post(payload,latest):payload.action==='getAdminData'?latest():{status:'success',authorizationRevision:'after'};},sendLog(){}},
        safeStorage:{setItem:(key,value)=>cached[key]=value,getItem:key=>cached[key]},CONFIG:{STORAGE_USER_DB:'users',STORAGE_APP_CONFIG:'apps'},reconcileAuthorizationDependencies:()=>[]});
    vm.runInContext(html.slice(html.indexOf('        const AdminInteractive = {'),html.indexOf('        const LineAccount = {'))+'\nthis.admin=AdminInteractive;',context);
    const admin=context.admin;
    for(const method of ['renderUserList','setupAppPreviewGrid','renderRoleAccessEditor','renderAppMatrix','renderPermMatrix','updateAppPreview','loadUserPermissions'])admin[method]=()=>{};
    return {state,admin,calls,messages,nodes,node,context,latest,cached};
}
test('Role save includes inactive apps then refreshes session before editor read; launch config stays active only',async()=>{
    const f=fixture();assert.equal(await f.admin.saveAuthorizationChanges(f.node('save'),'saved'),true);
    assert.equal(f.calls[0].action,'saveAuthorizationConfig');assert.equal(f.calls[0].appConfig.length,2);
    assert.equal(f.calls[1],'refresh');assert.equal(f.calls[2].action,'getAdminData');
    assert.equal(f.state.appConfig.length,1);assert.equal(f.state.authorizationAppConfig.length,2);assert.equal(f.state.userPermissionEditorReady,true);
    assert.equal(f.state.authorizationSaving,false);assert.equal(f.state.authorizationDirty,false);assert.deepEqual(f.messages.at(-1),['saved','success']);
});
test('Confirmed save with failed reload warns accurately and leaves retry available; lost save reply never promises old rights remain',async()=>{
    const committed=fixture({post:async payload=>{if(payload.action==='getAdminData')throw new Error('offline');return {status:'success',authorizationRevision:'after'};}});
    assert.equal(await committed.admin.saveAuthorizationChanges(committed.node('save'),'saved'),true);
    assert.match(committed.messages.at(-1)[0],/บันทึกสิทธิ์แล้ว แต่/);assert.equal(committed.messages.at(-1)[1],'warning');
    assert.equal(committed.state.authorizationLoaded,false);assert.equal(committed.node('refresh-data-btn').disabled,false);
    const lost=fixture({post:async(payload,latest)=>{if(payload.action==='saveAuthorizationConfig')throw new Error('lost');return latest();}});
    assert.equal(await lost.admin.saveAuthorizationChanges(lost.node('save'),'saved'),false);
    assert.match(lost.messages[0][0],/ยังยืนยันผล/);assert.doesNotMatch(lost.messages[0][0],/คงสิทธิ์ชุดเดิม/);assert.equal(lost.state.authorizationLoaded,true);
});
test('Late response after logout never restores admin snapshot; failed session refresh sends no admin read',async()=>{
    let finish,started;const pending=new Promise(resolve=>started=resolve);
    const late=fixture({post:()=>new Promise(resolve=>{finish=resolve;started();})});late.state.authorizationDirty=false;
    const reading=late.admin.fetchAdminData(true);await pending;late.state.sessionEpoch++;finish(late.latest());await reading;
    assert.deepEqual(late.state.users,{});assert.equal(late.state.authorizationLoaded,false);
    const denied=fixture({refresh:false});assert.equal(await denied.admin.fetchAdminData(true),null);assert.deepEqual(denied.calls,['refresh']);assert.equal(denied.state.authorizationLoaded,false);
});
test('A role save response received after logout cannot reload or repaint the previous administrator session',async()=>{
    let finish;const f=fixture({post:(payload,latest)=>payload.action==='saveAuthorizationConfig'?new Promise(resolve=>finish=resolve):latest()});
    const saving=f.admin.saveAuthorizationChanges(f.node('save'),'saved');f.state.sessionEpoch++;f.state.authorizationRevision=null;f.state.authorizationLoaded=false;f.state.authorizationSaving=false;
    finish({status:'success',authorizationRevision:'old-session'});
    assert.equal(await saving,false);assert.equal(f.state.authorizationRevision,null);assert.equal(f.calls.length,1);assert.equal(f.messages.length,0);
});
test('Denied or failed admin fetch never restores the unscoped private roster and clears its current selection',async()=>{
    for(const denied of [false,true]){
        const f=fixture({post:async()=>{throw Error('offline');}});
        f.cached.users=JSON.stringify({old:{name:'Former administrator private roster'}});
        f.state.users={selected:{name:'Previous snapshot'}};f.admin.editingUserId='selected';
        if(denied)f.context.App.refreshSession=async()=>{f.state.currentRoles=['WAREHOUSE'];return true;};
        await f.admin.fetchAdminData(true);
        assert.equal(Object.keys(f.state.users).length,0);assert.equal(f.admin.editingUserId,null);
        assert.equal(f.state.authorizationLoaded,false);assert.ok(f.cached.users,'unknown old cache is not deleted or imported');
    }
});
