const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
function fixture(send){
 const nodes={},messages=[],calls=[];let confirmResult=true;
 const node=id=>{if(!nodes[id]){const classes=new Set(id==='interactive-form'?['hidden']:[]);nodes[id]={value:'',textContent:'',innerHTML:'',disabled:false,readOnly:false,focus(){},classList:{add:key=>classes.add(key),remove:key=>classes.delete(key),toggle(){},contains:key=>classes.has(key)}};}return nodes[id];};
 const state={sessionEpoch:1,currentUserId:'admin',authorizationLoaded:true,authorizationRevision:'before',authorizationSaving:false,authorizationDirty:false,userMutationEditorReady:true,
   users:{other:{name:'Other',identityId:'10000000-0000-4000-8000-000000000001',sessionVersion:1,roles:['WAREHOUSE'],explicitPermissions:[]}},roleConfig:[],appConfig:[]};
 const context=vm.createContext({state,document:{getElementById:node,querySelectorAll:()=>[]},confirm:()=>confirmResult,UI:{showToast:(...v)=>messages.push(v)},App:{handleLogout:()=>{state.sessionEpoch++;state.users={};}},
   safeStorage:{setItem(){}},CONFIG:{},API:{postAction:async payload=>{calls.push(payload);return send?send(payload):{status:'success'};},sendLog(){}},lucide:{createIcons(){}}});
 vm.runInContext(html.slice(html.indexOf('        const AdminInteractive = {'),html.indexOf('        const LineAccount = {'))+'\nthis.admin=AdminInteractive;',context);
 const admin=context.admin;for(const method of ['renderUserList','renderRoleGrid','updateAppPreview','loadUserPermissions'])admin[method]=()=>{};
 admin.fetchAdminData=async()=>true;admin.selectUser('other');
 return {admin,state,messages,calls,node,context,confirm:value=>confirmResult=value};
}
test('Profile save captures the selected identity, version and roles; busy prevents another user/role/double submission',async()=>{
 let finish;const f=fixture(()=>new Promise(resolve=>finish=resolve));f.node('editor-name').value='Edited';
 const saving=f.admin.handleSave({preventDefault(){}});
 assert.equal(f.calls[0].expectedUser.userId,f.state.users.other.identityId);assert.equal(f.calls[0].expectedUser.sessionVersion,1);
 f.admin.toggleRole('ADMIN');f.admin.selectUser('missing');await f.admin.handleSave({preventDefault(){}});
 assert.equal(f.calls.length,1);assert.deepEqual(Array.from(f.calls[0].roles),['WAREHOUSE']);assert.equal(f.admin.editingUserId,'other');
 finish({status:'success'});await saving;
});
test('Create-only intent, dirty cancel and successful reconciliation retain authoritative identity',async()=>{
 const f=fixture();f.node('editor-name').value='Unsaved';f.confirm(false);f.admin.setupNewUser();assert.equal(f.admin.editingUserId,'other');
 f.confirm(true);f.admin.setupNewUser();f.node('editor-id').value='new';f.node('editor-name').value='New';f.admin.editingRoles=['WAREHOUSE'];
 f.admin.fetchAdminData=async()=>{f.state.users.new={...f.state.users.other,identityId:'10000000-0000-4000-8000-000000000002',name:'NEW'};f.admin.reconcileProfile();return true;};
 assert.equal(await f.admin.handleSave({preventDefault(){}}),true);assert.equal(f.calls[0].expectedUser.mode,'create');
 assert.equal(f.admin.editingProfile.identityId,f.state.users.new.identityId);assert.equal(f.node('editor-name').value,'NEW');assert.equal(f.admin.profileDirty(),false);
});
test('A confirmed self update signs out instead of treating the deliberately invalidated session as a failed save',async()=>{
 const f=fixture();f.state.currentUserId='other';assert.equal(await f.admin.handleSave({preventDefault(){}}),true);
 assert.equal(f.state.sessionEpoch,2);assert.deepEqual(f.state.users,{});assert.match(f.messages[0][0],/เข้าสู่ระบบใหม่/);
});
test('Delete/reset use saved target identity; failed post-commit reload is reported as saved, not failed',async()=>{
 const del=fixture();del.state.currentUser='Other';await del.admin.handleDelete();assert.equal(del.calls[0].action,'deleteUser');assert.equal(del.calls[0].expectedUser.userId,del.state.users.other.identityId);
 const reset=fixture();reset.admin.fetchAdminData=async()=>false;await reset.admin.handleResetPassword();
 assert.equal(reset.calls[0].action,'adminResetPassword');assert.match(reset.messages.at(-1)[0],/บันทึกแล้ว แต่/);assert.equal(reset.admin.profileUncertain,true);
});
test('Late profile save after logout cannot reinsert cached user or repaint an old selection',async()=>{
 let finish;const f=fixture(()=>new Promise(resolve=>finish=resolve));const saving=f.admin.handleSave({preventDefault(){}});
 f.state.sessionEpoch++;f.state.users={};f.admin.editingUserId=null;finish({status:'success'});await saving;
 assert.deepEqual(f.state.users,{});assert.equal(f.admin.editingUserId,null);assert.equal(f.messages.length,0);
});
test('Lost profile reply locks writes until refresh and never reports definitive failure or auto-retries',async()=>{
 const f=fixture(async()=>{throw new Error('lost');});f.admin.fetchAdminData=async()=>false;
 await f.admin.handleSave({preventDefault(){}});await f.admin.handleSave({preventDefault(){}});
 assert.equal(f.calls.length,1);assert.ok(f.messages.some(x=>/ยังยืนยันผล/.test(x[0])));assert.equal(f.state.authorizationLoaded,false);
});
