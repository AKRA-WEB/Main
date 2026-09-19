const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const catalog=require('../js/permission-catalog.js');
const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
const between=(start,end)=>{const a=html.indexOf(start),b=html.indexOf(end,a);assert.ok(a>=0&&b>a,start);return html.slice(a,b);};
const dependencies={'app-po':'app-tracking','app-akra':'app-w5','app-ret':'app-damage'};
const escapeHtml=value=>String(value).replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
function runtime(){
 const nodes={};const node=()=>({innerHTML:'',children:[],appendChild(child){this.children.push(child);},classList:{add(){},remove(){}}});
 for(const id of ['role-access-selector','role-access-editor','authorization-load-status'])nodes[id]=node();
 const state={authorizationLoaded:true,authorizationSaving:false,authorizationDirty:false,roleConfig:[{val:'ADMIN',label:'ผู้ดูแล'},{val:'SUPERVISOR',label:'หัวหน้างาน'}],appConfig:[{id:'app-tracking',name:'PO',roles:['ADMIN','SUPERVISOR']}],permRows:[{appId:'app-po',permKey:'createPO',ADMIN:true,SUPERVISOR:true}]};
 let answer=false;const confirms=[];
 const c=vm.createContext({state,window:{AkraPermissionCatalog:catalog},escapeHtml,safeIdentifier:x=>String(x||''),getAppDisplayName:app=>app.name,PERMISSION_APP_DEPENDENCIES:dependencies,lucide:{createIcons(){}},confirm:message=>{confirms.push(message);return answer;},document:{getElementById:id=>nodes[id],createElement:node}});
 vm.runInContext(between('function safeIdentifier(','\n        function getAppDisplayName')+between('function authorizationControlLabel(','\n        function safeAppUrl'),c);
 vm.runInContext(`const AdminInteractive={focusedRole:'SUPERVISOR',authorizationApps:()=>state.authorizationAppConfig||state.appConfig,renderAppMatrix(){},renderPermMatrix(){},${between('renderRoleAccessEditor: () =>','            saveAuthorizationChanges:')}${between('togglePermRole: (','            savePermConfig:')}};this.editor=AdminInteractive;`,c);
 return{c,state,nodes,confirms,confirm:value=>answer=value};
}
test('role editor renders actual action scope and stable labels, escapes unknown definitions',()=>{
 const {c,state,nodes}=runtime();c.editor.renderRoleAccessEditor();
 const output=nodes['role-access-editor'].children[0].innerHTML;
 assert.match(output,/สร้างและจัดการ PO/);assert.match(output,/รวมสร้าง แก้ไข และลบ PO/);assert.match(output,/app-po:createPO/);assert.match(output,/SUPERVISOR/);
 state.permRows[0].permKey='unknown-key';state.appConfig[0].name='<script>fixture</script>';nodes['role-access-editor'].children=[];c.editor.renderRoleAccessEditor();
 const unknown=nodes['role-access-editor'].children[0].innerHTML;
 assert.doesNotMatch(unknown,/<script>/);assert.match(unknown,/ยังไม่มีคำอธิบาย/);
 state.authorizationLoaded=false;c.editor.renderRoleAccessEditor();assert.match(nodes['role-access-editor'].innerHTML,/รอโหลด/);
});
test('disabling app asks about actions; cancel, confirmed removal, reenable, ADMIN lock and in-flight gates work',()=>{
 const {c,state,confirms,confirm}=runtime();
 c.editor.setAppRole('app-tracking','SUPERVISOR',false);
 assert.equal(state.permRows[0].SUPERVISOR,true);assert.ok(state.appConfig[0].roles.includes('SUPERVISOR'));assert.match(confirms[0],/createPO/);
 confirm(true);c.editor.setAppRole('app-tracking','SUPERVISOR',false);
 assert.equal(state.permRows[0].SUPERVISOR,false);assert.equal(state.appConfig[0].roles.includes('SUPERVISOR'),false);
 c.editor.togglePermRole('app-po','createPO','SUPERVISOR',true);
 assert.equal(state.permRows[0].SUPERVISOR,true);assert.ok(state.appConfig[0].roles.includes('SUPERVISOR'));
 state.authorizationSaving=true;c.editor.togglePermRole('app-po','createPO','SUPERVISOR',false);c.editor.setAppRole('app-tracking','SUPERVISOR',false);
 assert.equal(state.permRows[0].SUPERVISOR,true);assert.ok(state.appConfig[0].roles.includes('SUPERVISOR'));
 state.authorizationSaving=false;c.editor.togglePermRole('app-po','createPO','ADMIN',false);assert.equal(state.permRows[0].ADMIN,true);
});
test('descriptions distinguish grant aliases, extra role requirements and legacy nonfunctional audit controls',()=>{
 assert.deepEqual(catalog.describe('app-tracking','createPO'),catalog.describe('app-po','createPO'));
 assert.match(catalog.describe('app-gr','approveGR').detail,/ADMIN.*SUPERVISOR/);
 assert.match(catalog.describe('app-kpi','adminDashboard').detail,/ADMIN.*SUPERVISOR/);
 assert.match(catalog.describe('app-kpi','recordWorkload').detail,/ตนเอง.*เว็บ.*LINE/);
 assert.match(catalog.describe('app-kpi','manageWorkload').detail,/ผู้อื่น.*ADMIN.*SUPERVISOR.*ไม่รวมเวลาของตนเอง/);
 for(const key of ['AUDIT_CREATE','AUDIT_REVIEW','AUDIT_TASK'])assert.match(catalog.describe('app-ret',key).detail,/ยังไม่มีการทำงานนี้/);
 assert.match(catalog.appNote('app-manual'),/ADMIN/);assert.match(catalog.appNote('app-evaluation'),/แยกตามผู้ใช้/);
 assert.match(catalog.describe('app-pick','viewRequisitions').detail,/สินค้า/);
 assert.match(catalog.describe('app-pick','createRequisition').detail,/บิล/);
 assert.match(catalog.describe('app-pick','retryLine').detail,/24/);
});
