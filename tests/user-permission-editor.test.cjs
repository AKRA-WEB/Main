const test=require('node:test'),assert=require('node:assert/strict');
const {create,rowsFor}=require('../js/user-permission-editor.js');
const snapshot=()=>({username:'staff',epoch:1,revision:'before',ready:true,
    user:{identityId:'10000000-0000-4000-8000-000000000001',sessionVersion:1,roles:['WAREHOUSE'],explicitPermissions:[{appId:'app-w5',permKey:'recordStock'}]},
    apps:[{id:'app-w5',name:'Fixture W5',roles:['WAREHOUSE'],isActive:true}],
    permRows:[{appId:'app-w5',permKey:'viewInventory',WAREHOUSE:true},{appId:'app-w5',permKey:'recordStock',WAREHOUSE:false}]});
function fixture(options={}){
    const document={activeElement:null,createElement(tag){return {tag,children:[],attributes:{},listeners:{},textContent:'',disabled:false,
        append(...nodes){this.children.push(...nodes);},replaceChildren(){this.children=[];},setAttribute(k,v){this.attributes[k]=v;},getAttribute(k){return this.attributes[k];},
        addEventListener(k,fn){this.listeners[k]=fn;},focus(){document.activeElement=this;}};}};
    const root=document.createElement('div'),status=document.createElement('p'),button=document.createElement('button'),state={epoch:1,user:'staff',dirty:false,busy:false,roleDraft:false,ready:true},calls=[];
    let confirm=false,editor;
    editor=create({root,status,button,document,describe:(app,key)=>({label:key,detail:'Fixture action detail'}),
        isCurrent:s=>s.epoch===state.epoch&&s.username===state.user,canEdit:()=>state.ready,hasRoleDraft:()=>state.roleDraft,
        onDirty:flag=>state.dirty=flag,onBusy:flag=>state.busy=flag,confirm:()=>confirm,notify:message=>calls.push(message),
        send:async payload=>{calls.push(payload);return options.send?options.send(payload):{status:'success',authorizationRevision:'after'};},
        reload:async()=>options.reload?options.reload(editor,state):true});
    editor.load(snapshot());return {editor,root,status,button,state,calls,document,confirm:value=>confirm=value};
}
const inputs=f=>f.root.children.filter(n=>n.tag==='label').map(n=>n.children[0]);

test('Rows distinguish inherited/explicit/latent/unknown grants without assigning app access',()=>{
    const data=snapshot();data.user.explicitPermissions.push({appId:'app-w5',permKey:'orphan'});
    let rows=rowsFor(data);assert.equal(rows[0].inherited,true);assert.equal(rows[0].explicit,false);assert.equal(rows[1].explicit,true);assert.equal(rows[1].inherited,false);assert.equal(rows[2].defined,false);
    data.apps[0].isActive=false;assert.ok(rowsFor(data).every(row=>!row.available));
});
test('Changing a checkbox preserves keyboard focus; dirty cancel and busy/double-save gates work',async()=>{
    let finish;const f=fixture({send:()=>new Promise(resolve=>finish=resolve)}),input=inputs(f)[1];input.focus();input.checked=false;input.listeners.change();
    assert.equal(f.state.dirty,true);assert.equal(f.document.activeElement.getAttribute('data-permission-key'),JSON.stringify(['app-w5','recordStock']));
    assert.equal(f.editor.confirmLeave(),false);f.confirm(true);
    const saving=f.editor.save();assert.equal(f.state.busy,true);assert.equal(f.editor.confirmLeave(),false);assert.equal(await f.editor.save(),false);
    finish({status:'success',authorizationRevision:'after'});assert.equal(await saving,true);assert.equal(f.state.busy,false);assert.equal(f.state.dirty,false);
    assert.equal(f.calls.filter(x=>typeof x==='object').length,1);assert.deepEqual(f.calls.find(x=>typeof x==='object').permissions,[]);
});
test('API failure keeps the draft and requires reconciliation before another write; failed post-commit reload never says save failed',async()=>{
    const fail=fixture({send:async()=>{throw new Error('lost reply');}});fail.editor.toggle({appId:'app-w5',permKey:'recordStock'},false);
    assert.equal(await fail.editor.save(),false);assert.equal(fail.state.dirty,true);assert.equal(fail.button.disabled,true);assert.match(fail.status.textContent,/ยังยืนยันผล/);
    await fail.editor.save();assert.equal(fail.calls.length,1);
    const reload=fixture({reload:async()=>false});reload.editor.toggle({appId:'app-w5',permKey:'recordStock'},false);
    assert.equal(await reload.editor.save(),false);assert.equal(reload.state.dirty,false);assert.match(reload.status.textContent,/บันทึกแล้ว แต่/);assert.equal(reload.state.busy,false);
});
test('Refresh reloads the authoritative snapshot while the save is busy, without leaving controls locked',async()=>{
    const f=fixture({reload:async(editor,state)=>{state.ready=false;editor.render();state.ready=true;const next=snapshot();next.user.explicitPermissions=[];next.revision='after';editor.load(next,true);return true;}});
    f.editor.toggle({appId:'app-w5',permKey:'recordStock'},false);assert.equal(await f.editor.save(),true);assert.equal(f.state.busy,false);
    assert.ok(inputs(f).every(input=>!input.disabled),'fresh checkboxes unlock after completed reload');
    assert.match(f.status.textContent,/บันทึกสิทธิ์เฉพาะบุคคลแล้ว/);
    f.editor.toggle({appId:'app-w5',permKey:'recordStock'},true);assert.equal(f.button.disabled,false);
});
test('Role drafts, unavailable app and missing fresh authorization disable additions; existing latent grant may be removed',async()=>{
    const f=fixture(),data=snapshot();data.apps[0].isActive=false;f.editor.load(data,true);
    assert.equal(inputs(f)[0].disabled,true);assert.equal(inputs(f)[1].disabled,false);
    f.editor.toggle({appId:'app-w5',permKey:'viewInventory'},true);assert.equal(f.state.dirty,false);
    f.editor.toggle({appId:'app-w5',permKey:'recordStock'},false);assert.equal(f.state.dirty,true);
    f.state.roleDraft=true;f.editor.render();assert.equal(await f.editor.save(),false);assert.equal(f.calls.length,0);
    f.state.roleDraft=false;f.state.ready=false;f.editor.render();assert.ok(inputs(f).every(i=>i.disabled));
});
test('Logout/user switch during a response cannot paint old user results or restore their permission state',async()=>{
    let finish;const f=fixture({send:()=>new Promise(resolve=>finish=resolve)});
    f.editor.toggle({appId:'app-w5',permKey:'recordStock'},false);const saving=f.editor.save();f.state.epoch++;f.state.user='new-user';f.editor.reset();
    const message=f.status.textContent;finish({status:'success',authorizationRevision:'after'});assert.equal(await saving,false);
    assert.equal(f.status.textContent,message);assert.equal(f.state.busy,false);assert.equal(f.state.dirty,false);assert.equal(f.root.children.length,0);
});
