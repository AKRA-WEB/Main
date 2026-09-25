// Loopback-only browser fixture. External operational APIs are replaced, never forwarded.
// Default module documents test the real shell/bridge protocol, not domain workflows.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const base = path.resolve(__dirname,'../..');
let moduleBase = base;
while (!fs.existsSync(path.join(moduleBase, 'AKRA')) && moduleBase !== path.dirname(moduleBase)) {
    moduleBase = path.dirname(moduleBase);
}
if (!fs.existsSync(path.join(moduleBase, 'AKRA'))) throw new Error('workspace_modules_not_found');
const port = Number(process.env.SHELL_TEST_PORT || 4173);
const origin = `http://127.0.0.1:${port}`;
const roots = {Main:'Main',TrackingPO:'PO',PR:'PR',GR:'GR',Returnitem:'Returnitem',KPITRACKER:'KPITracker',Picking:'Picking',TRDAKRA:'TRDAKRA',AKRA:'AKRA',SOP:'SOP',Evaluation:'Evaluation form'};
const mainHtml = fs.readFileSync(path.resolve(__dirname, '../index.html'),'utf8');
const configLiteral = mainHtml.match(/const DEFAULT_APP_CONFIG = (\[[\s\S]*?\n        \]);/)[1];
const apps = vm.runInNewContext(configLiteral).map(app=>({...app,url:app.url.replace('https://akra-web.github.io',origin)}));
if (!apps.some(app => app.id === 'app-evaluation')) {
    apps.push({id:'app-evaluation',name:'แบบประเมินพนักงาน',url:origin+'/Evaluation/',roles:['ADMIN'],icon:'clipboard-check'});
}
const fixturePermissions = {'app-po':['createPO','approvePR','closePO'],'app-gr':['receiveGR','approveGR'],'app-akra':['manageProducts'],'app-ret':['ADD_RET','QC_RET','BATCH_RET','TRACK_CUST','ADD_CLM','WH_CLM','MANAGE_CLM'],'app-kpi':['adminDashboard'],'app-pr':['viewPR','createPR']};
const claims = {id:'fixture-user',name:'ผู้ใช้ทดสอบ Shell',roles:['ADMIN'],perms:fixturePermissions,apps:apps.map(app=>app.id),tokenVersion:2,sessionVersion:1,authorizationRevision:'fixture',exp:4102444800};
claims.perms['app-trd']=['viewInventory','manageInventory','receiveInventory','manageLocations','saveSurvey','sendSummary'];
claims.perms['app-manual']=['readDocuments','manageDocuments'];
claims.identityId = '10000000-0000-4000-8000-000000000011';
claims.permissionCatalog = {'app-pick':['viewRequisitions','createRequisition','retryLine']};
claims.permissionCatalog['app-kpi']=['adminDashboard','recordWorkload','manageWorkload'];
const readOnlyProfile = process.env.SHELL_READ_ONLY_PROFILE === '1';
claims.perms['app-kpi']=(readOnlyProfile||process.env.SHELL_KPI_WORKLOAD_DENIED==='1')?['adminDashboard','manageWorkload']:['adminDashboard','recordWorkload','manageWorkload'];
claims.perms['app-pick'] = readOnlyProfile || process.env.SHELL_PICK_READ_ONLY === '1' ? ['viewRequisitions'] : [...claims.permissionCatalog['app-pick']];
let token = [Buffer.from('{"alg":"HS256"}').toString('base64url'),Buffer.from(JSON.stringify(claims)).toString('base64url'),'fixture-not-a-real-signature'].join('.');
const session = {status:'success',token,user:claims,appConfig:apps};
let identityAuth=null,identityDb=null;
let mainRefreshMode='normal';
const pendingMainRefresh=[];
let purchasingReads=0;
let w5Reads=0, w5AdjustmentWrites=0, w5AdjustedStock=null;
let returnitemReads=0, returnitemWrites=0;
let trdReads=0, trdMutationWrites=0, trdSurveyWrites=0;
let sopReads=0, sopMutationWrites=0, permissionWrites=0, prReads=0, pickReads=0, kpiReads=0;
async function initializeIdentityAuth(){
    const {fixture,runtime}=require('../../database/tests/helpers/auth-runtime.cjs');
    identityDb=await fixture({userPermissions:true});identityAuth=runtime(identityDb,{identityRequired:'true'});
    await identityDb.exec('RESET ROLE');
    const password=await vm.runInContext("createPasswordHash('fixture-password','user')",identityAuth.c);
    await identityDb.query("UPDATE users SET username='fixture-user',id=$1,password_hash=$2,password_salt=$3 WHERE username='fixture'",[claims.identityId,password.stored,password.salt]);
    for(const app of apps)await identityDb.query(`INSERT INTO app_configs(app_id,name,icon,url,allowed_roles,is_active) VALUES($1,$2,$3,$4,$5,true)
        ON CONFLICT(app_id) DO UPDATE SET name=EXCLUDED.name,url=EXCLUDED.url,allowed_roles=EXCLUDED.allowed_roles,is_active=true`,[app.id,app.name,app.icon||'box',app.url.replace(origin,'https://akra-web.github.io'),app.id==='app-w5'?['ADMIN','WAREHOUSE']:['ADMIN']]);
    for(const [permissionAppId,keys] of Object.entries(claims.perms))for(const key of keys){
        const appId=({'app-po':'app-tracking','app-akra':'app-w5','app-ret':'app-damage'})[permissionAppId]||permissionAppId;
        await identityDb.query('INSERT INTO perm_configs(app_id,perm_key,perm_name) VALUES($1,$2,$2) ON CONFLICT(app_id,perm_key) DO NOTHING',[appId,key]);
        await identityDb.query("INSERT INTO role_permissions(app_id,perm_key,role_name) VALUES($1,$2,'ADMIN') ON CONFLICT DO NOTHING",[appId,key]);
    }
    if(readOnlyProfile){
        await identityDb.query("DELETE FROM role_permissions WHERE role_name='ADMIN' AND ((app_id='app-pick' AND perm_key IN ('createRequisition','retryLine')) OR (app_id='app-kpi' AND perm_key='recordWorkload'))");
    }
    await identityDb.exec('SET ROLE service_role');
}
const prFixtureWrites = new Map();
let prFixtureLostReply = process.env.SHELL_PR_LOST_REPLY === '1';
let purchasingWorkflowPr = {
    rowNumber: 1, uid: 'PR-FIXTURE-UID-0001', prId: 'PR-FIXTURE-ID-0001', prNumber: 'PR-FIXTURE-0001',
    product: 'สินค้าจำลอง PR', sku: 'FIXTURE-1', quantity: '2', unit: 'ชิ้น', warehouse: 'W5',
    receiverName: 'ผู้ใช้ทดสอบ Shell', remark: 'เส้นทางทดสอบ PR ถึง W5', status: 'Pending'
};
const purchasingWorkflowProduct = {
    sku: 'FIXTURE-1', name: 'สินค้าจำลอง PR', unit: 'ชิ้น', last_vendor: 'Vendor Fixture',
    vendor: 'Vendor Fixture', default_vendor: 'Vendor Fixture', last_warehouse: 'W5'
};
const purchasingPoRows = new Map();
let poWrites = 0, grReviewWrites = 0, grCompletedWrites = 0, workflowStock = 0;
const pickFixtureWrites = new Map();
let pickFixtureLostReply = process.env.SHELL_PICK_LOST_REPLY === '1', pickFixtureCalls = 0, pickFixtureReplays = 0;
const problemCapability = 'fixture-problem-capability-not-a-real-token';
const problemBill = {uid:'fixture-problem',version:3,billNo:1001,billType:'บิลจัด',assignee:'พนักงานจำลอง',lineStatus:'problem',
    items:[{name:'สินค้าชื่อซ้ำ',qty:2,unit:'ชิ้น'},{name:'สินค้าชื่อซ้ำ',qty:5,unit:'กล่อง'}],
    problemItems:[{index:0,actualQty:1,note:'แถวแรก'},{index:1,actualQty:4,note:'แถวที่สอง'}]};
const problemReceipts = new Map();
let problemCalls=0,problemReplays=0,problemLostReply=process.env.SHELL_PROBLEM_LOST_REPLY==='1',problemConflict=process.env.SHELL_PROBLEM_CONFLICT==='1';
let problemReads=0,problemReviewOutage=process.env.SHELL_PROBLEM_REVIEW_OUTAGE==='1';
let kpiWorkloadWrites=0,kpiWorkloadAttempts=0;
const injection = `<script>(function(){const nativeFetch=window.fetch.bind(window);window.fetch=function(input,init){const url=new URL(typeof input==='string'?input:input.url,location.href);if(url.hostname.endsWith('.supabase.co')||url.hostname==='script.google.com'){return nativeFetch('/__fixture/api',{method:'POST',headers:{'Content-Type':'application/json'},signal:init?.signal,body:JSON.stringify({url:url.href,authorization:new Headers(init?.headers).get('authorization'),body:typeof init?.body==='string'?init.body:'{}'})});}return nativeFetch(input,init);};})();</script>`;
function fixtureModule(app) {
    return `<!doctype html><html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><script src="js/akra-shell-bridge.js"></script></head><body><h1>${app.name}</h1><p>เอกสารจำลองสำหรับตรวจ Shell — ไม่ใช่ข้อมูลจริง</p><p id="session-result"></p><label>รายละเอียดงาน <input id="draft"></label><button id="save">บันทึกตัวอย่าง</button><button id="home">กลับ Main</button><script>document.getElementById('session-result').textContent=AkraModule.getToken()?'ยืนยันการรับ session จาก Main':'ไม่มี session';document.getElementById('save').onclick=()=>{AkraModule.markSaved();document.getElementById('session-result').textContent='บันทึกตัวอย่างแล้ว';};document.getElementById('home').onclick=()=>AkraModule.home('/Main/');</script></body></html>`;
}
const server = http.createServer(async (req,res)=>{
    res.setHeader('Cache-Control','no-store');
    // Even an unmocked library request cannot reach operational APIs from fixtures.
    res.setHeader('Content-Security-Policy', "connect-src 'self'; form-action 'self'; frame-src 'self' blob:");
    if (req.headers.host !== `127.0.0.1:${port}` && req.headers.host !== `localhost:${port}`) {res.writeHead(403).end();return;}
    const url = new URL(req.url,origin);
    if(url.pathname==='/__fixture/main-refresh'&&identityDb){
        if(req.method==='POST'){
            if(req.headers.origin!==origin){res.writeHead(403).end();return;}
            let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>100){res.writeHead(413).end();return;}}
            const mode=new URLSearchParams(raw).get('mode');
            if(!['normal','held','fail'].includes(mode)){res.writeHead(400).end();return;}
            mainRefreshMode=mode;if(mode!=='held')pendingMainRefresh.splice(0).forEach(resolve=>resolve());
            res.writeHead(303,{Location:'/__fixture/main-refresh'}).end();return;
        }
        res.setHeader('Content-Type','text/html; charset=utf-8');
        res.end(`<!doctype html><html lang="th"><meta charset="utf-8"><h1>Main session test control</h1><p>Mode: ${mainRefreshMode}</p><form method="post"><button name="mode" value="held">Hold refresh</button><button name="mode" value="normal">Release refresh</button><button name="mode" value="fail">Fail refresh</button></form></html>`);return;
    }
    if (url.pathname === '/__fixture/status') {res.setHeader('Content-Type','application/json');res.end(JSON.stringify({pickingBills:pickFixtureWrites.size,pickingCalls:pickFixtureCalls,pickingReplays:pickFixtureReplays,problemReports:problemReceipts.size,problemCalls,problemReplays,problemVersion:problemBill.version,kpiWorkloadWrites,kpiWorkloadAttempts,purchasingReads,w5Reads,w5AdjustmentWrites,w5AdjustedStock,returnitemReads,returnitemWrites,trdReads,trdMutationWrites,trdSurveyWrites,sopReads,sopMutationWrites,permissionWrites,prReads,prWrites:prFixtureWrites.size,poWrites,grReviewWrites,grCompletedWrites,workflowStock,pickReads,kpiReads}));return;}
    if (url.pathname === '/__fixture/sop-file.svg') {
        res.setHeader('Content-Type','image/svg+xml');
        res.end('<svg xmlns="http://www.w3.org/2000/svg" width="840" height="1188" viewBox="0 0 840 1188"><rect width="840" height="1188" fill="#f0f4f8"/><rect x="60" y="60" width="720" height="1068" fill="white" stroke="#22384c"/><text x="110" y="150" font-family="sans-serif" font-size="40" fill="#22384c">SOP FIXTURE</text><text x="110" y="230" font-family="sans-serif" font-size="24">Synthetic reader page - no private data</text><path d="M110 310h600M110 410h600M110 510h600" stroke="#cbd5e1" stroke-width="8"/></svg>');return;
    }
    const standalonePaths={po:'/TrackingPO/',gr:'/GR/',w5:'/AKRA/',returnitem:'/Returnitem/',trd:'/TRDAKRA/',sop:'/SOP/',kpi:'/KPITRACKER/',pr:'/PR/',pick:'/Picking/',evaluation:'/Evaluation/'};
    if(url.pathname==='/__fixture/standalone'&&identityDb){
        res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<!doctype html><html lang="en"><h1>Standalone test apps</h1>'+Object.keys(standalonePaths).map(key=>'<p><a href="/__fixture/standalone/'+key+'">'+key+'</a></p>').join('')+'</html>');return;
    }
    if (identityDb && url.pathname.startsWith('/__fixture/standalone/') && standalonePaths[url.pathname.split('/').at(-1)]) {
        const appPath=standalonePaths[url.pathname.split('/').at(-1)];
        res.writeHead(302,{Location:appPath+'?sso='+encodeURIComponent(token)}).end();return;
    }
    if(url.pathname==='/__fixture/identity'&&identityDb){
        if(req.method==='POST'){
            if(req.headers.origin!==origin){res.writeHead(403).end();return;}
            let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>100){res.writeHead(413).end();return;}}
            const which=new URLSearchParams(raw).get('owner');
            if(!['original','replacement'].includes(which)){res.writeHead(400).end();return;}
            const id='10000000-0000-4000-8000-0000000000'+(which==='original'?'11':'12');
            await identityDb.query("UPDATE users SET id=$1 WHERE username='fixture-user'",[id]);
            res.writeHead(303,{Location:'/__fixture/identity'}).end();return;
        }
        const current=(await identityDb.query("SELECT id FROM users WHERE username='fixture-user'")).rows[0].id;
        res.setHeader('Content-Type','text/html; charset=utf-8');res.end(`<!doctype html><html lang="th"><meta charset="utf-8"><h1>บัญชีจำลองทดสอบข้อมูลร่าง</h1><p>บัญชีปัจจุบัน: ${current.endsWith('11')?'เดิม':'สร้างใหม่ด้วยรหัสพนักงานเดิม'}</p><form method="post"><button name="owner" value="original">ใช้บัญชีเดิม</button><button name="owner" value="replacement">ใช้บัญชีสร้างใหม่</button></form><a href="/Main/">เปิด Main</a><p><a href="/__fixture/standalone/po">เปิด PO แบบแยกหน้า</a> <a href="/__fixture/standalone/gr">เปิด GR แบบแยกหน้า</a></p><p><a href="/TrackingPO/?sso=synthetic-invalid">PO เซสชันไม่ถูกต้อง</a> <a href="/GR/?sso=synthetic-invalid">GR เซสชันไม่ถูกต้อง</a></p><p>รหัส: fixture-user / รหัสผ่าน: fixture-password (ข้อมูลจำลองเท่านั้น)</p></html>`);return;
    }
    if (url.pathname === '/__fixture/problem') {res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<a href="/Picking/problem.html?uid=fixture-problem&token='+problemCapability+'">เปิดแบบรายงานปัญหาจำลอง</a><a href="/Picking/problem.html?uid=wrong-bill&token='+problemCapability+'">ทดสอบลิงก์ผิดบิล</a>');return;}
    if (url.pathname === '/__fixture/api' && req.method === 'POST') {
        let raw='';for await (const chunk of req) {raw+=chunk;if(raw.length>100000){res.writeHead(413).end();return;}}
        let body={},target,authorization;
        try {const envelope=JSON.parse(raw);body=JSON.parse(envelope.body);authorization=envelope.authorization;target=new URL(envelope.url||origin);if(!body.action)body.action=target.searchParams.get('action');}catch(_){}
        res.setHeader('Content-Type','application/json');
        if(identityAuth&&['login','refreshSession','verifyToken','changePassword','getAdminData','saveUserPermissions'].includes(body.action)){
            if(body.action==='refreshSession'){
                if(mainRefreshMode==='held')await new Promise(resolve=>pendingMainRefresh.push(resolve));
                if(mainRefreshMode==='fail'){res.writeHead(503).end(JSON.stringify({status:'error',reason:'fixture_refresh_unavailable'}));return;}
            }
            const response=await identityAuth.handler(new Request('https://fixture.invalid/auth-api',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}));
            const result=await response.json();
            if(readOnlyProfile && result.user){
                result.user={...result.user,perms:JSON.parse(JSON.stringify(claims.perms)),permissionCatalog:JSON.parse(JSON.stringify(claims.permissionCatalog))};
            }
            if(Array.isArray(result.appConfig)) result.appConfig=result.appConfig.map(app=>({...app,url:app.url.replace('https://akra-web.github.io',origin)}));
            if(result.status==='success'&&result.token){
                token=result.token;Object.assign(claims,result.user);session.token=token;session.appConfig=result.appConfig;
            }
            if(body.action==='saveUserPermissions' && result.status==='success') permissionWrites++;
            res.writeHead(response.status).end(JSON.stringify(result));return;
        }
        if (['login','refreshSession'].includes(body.action)) {res.end(JSON.stringify(session));return;}
        if (body.action === 'verifyToken' && (body.token === token || target?.searchParams.get('token') === token) && (!body.appId || claims.apps.includes(body.appId))) {
            res.end(JSON.stringify({valid:true,user:claims}));return;
        }
        if (body.action === 'getLineAccountStatus') {res.end(JSON.stringify({status:'success',linked:false}));return;}
        if (body.action === 'log') {res.end(JSON.stringify({status:'success'}));return;}
        if(target?.pathname==='/functions/v1/sop-api') {
            sopReads++;
            if(authorization!=='Bearer '+token) {res.writeHead(403).end(JSON.stringify({status:'error',reason:'fixture_action_not_configured'}));return;}
            if(body.action==='updatePages') {
                if(!claims.perms['app-manual']?.includes('manageDocuments') || body.documentId!=='sop-fixture' || !Array.isArray(body.pages) || body.pages.length!==2) {res.writeHead(403).end(JSON.stringify({status:'error',reason:'permission_denied'}));return;}
                sopMutationWrites++;
                res.end(JSON.stringify({status:'success'}));return;
            }
            if(!['list','getFiles'].includes(body.action)) {res.writeHead(403).end(JSON.stringify({status:'error',reason:'fixture_action_not_configured'}));return;}
            const assets=[1,2].map(i=>({id:'sop-page-'+i,name:'fixture-'+i+'.svg',displayName:'หน้าทดสอบ '+i,sortOrder:i-1,type:'image/svg+xml'}));
            const result=body.action==='list'?{user:{id:claims.identityId,name:claims.name,roles:claims.roles,sessionVersion:claims.sessionVersion,authorizationRevision:claims.authorizationRevision,canManageDocuments:true},documents:[{id:'sop-fixture',code:'SOP-FIX',title:'คู่มือทดสอบการแยกบัญชี',status:'published',type:'sop',roles:['all'],summary:'ข้อมูลจำลองสำหรับทดสอบเท่านั้น',updatedAt:'2026-09-18',assets}]}:{assets:assets.map(a=>({...a,url:origin+'/__fixture/sop-file.svg',previewUrl:origin+'/__fixture/sop-file.svg',expiresAt:Date.now()+3600000}))};
            res.end(JSON.stringify({status:'success',...result}));return;
        }
        if(target?.pathname==='/functions/v1/trd-api') {
            if(authorization!=='Bearer '+token) {res.writeHead(403).end(JSON.stringify({status:'error',reason:'fixture_action_not_configured'}));return;}
            if(body.action==='mutateInventoryDelta') {
                if(!claims.perms['app-trd']?.includes('manageInventory') || !Array.isArray(body.operations) || body.operations.length===0) {res.writeHead(403).end(JSON.stringify({status:'error',reason:'permission_denied'}));return;}
                trdMutationWrites++;
                res.end(JSON.stringify({status:'success',items:[]}));return;
            }
            if(body.action==='saveSurveyLog') {
                if(!claims.perms['app-trd']?.includes('saveSurvey') || !Array.isArray(body.items) || body.items.length===0) {res.writeHead(403).end(JSON.stringify({status:'error',reason:'permission_denied'}));return;}
                trdSurveyWrites++;
                res.end(JSON.stringify({status:'success'}));return;
            }
            if(!['getInitialData','getFullHistory','getSurveyLogMonthly'].includes(body.action)) {res.writeHead(403).end(JSON.stringify({status:'error',reason:'fixture_action_not_configured'}));return;}
            trdReads++;
            const items=[{id:'TRD-FIX-001',itemName:'รายการเบิก TRD เดิม',requestQty:3,storageCapacity:5,status:'สั่งเบิก',timestamp:'2026-09-18T03:00:00Z',requestedBy:'Fixture',revision:1}];
            res.end(JSON.stringify({status:'success',items,products:[{name:'สินค้า TRD ทดสอบแยกบัญชี',unit:'ชิ้น',floor:'1',location:'A',parLevel:5}],records:[]}));return;
        }
        if(target?.pathname==='/functions/v1/returnitem-api') {
            returnitemReads++;
            const authorizedReturnRequest = body.action==='searchProducts'
                ? authorization==='Bearer '+token
                : body.token===token;
            if(!authorizedReturnRequest) {res.writeHead(403).end(JSON.stringify({status:'error',reason:'fixture_action_not_configured'}));return;}
            if(body.action==='searchProducts') {
                res.end(JSON.stringify({status:'success',products:[{sku:'FIX-001',name:'สินค้ารับคืนทดสอบแยกบัญชี',unit:'ชิ้น',vendor:'Vendor Fixture'}]}));return;
            }
            if(body.action==='addReturn') {
                if(!claims.perms['app-ret'].includes('ADD_RET') || body.sku!=='FIX-001' || Number(body.qty)!==1) {res.writeHead(403).end(JSON.stringify({status:'error',reason:'permission_denied'}));return;}
                returnitemWrites++;
                res.end(JSON.stringify({status:'success',data:{id:'RET-FIXTURE-WRITE-001',sku:body.sku,name:body.name,qty:body.qty,status:body.status}}));return;
            }
            if(body.action!=='getInitialData') {res.writeHead(403).end(JSON.stringify({status:'error',reason:'fixture_action_not_configured'}));return;}
            res.end(JSON.stringify({status:'success',data:{products:[{sku:'FIX-001',name:'สินค้ารับคืนทดสอบแยกบัญชี',unit:'ชิ้น',vendor:'Vendor Fixture'}],returns:[{id:'RET-FIXTURE-001',name:'สินค้ารับคืนทดสอบแยกบัญชี',sku:'FIX-001',qty:2,unit:'ชิ้น',status:'รอ QC',dateStr:'2026-09-18',source:'หน้าร้าน/ลูกค้า',customerName:'ลูกค้าจำลอง'}],claims:[],claimStock:[],claimBills:[],claimBillLines:[],claimBillReady:true,claimDetailsLoaded:true,claimStockCount:0,claimBillHistoryHasMore:false}}));return;
        }
        if(target?.pathname==='/functions/v1/akra-api') {
            if(authorization!=='Bearer '+token) {res.writeHead(403).end(JSON.stringify({success:false,error:'fixture_action_not_configured'}));return;}
            if(body.action==='adjustStock') {
                if(!claims.perms['app-akra'].includes('manageProducts') || body.productId !== 1 || !Number.isInteger(body.newStock) || body.newStock < 0) {
                    res.writeHead(403).end(JSON.stringify({success:false,error:'permission_denied'}));return;
                }
                w5AdjustmentWrites++;
                w5AdjustedStock=body.newStock;
                res.end(JSON.stringify({success:true,productId:body.productId,newStock:body.newStock}));return;
            }
            if(body.action!=='getData') {res.writeHead(403).end(JSON.stringify({success:false,error:'fixture_action_not_configured'}));return;}
            w5Reads++;
            res.end(JSON.stringify({success:true,products:[{id:'workflow-1',name:'สินค้าจำลอง PR',stock:workflowStock,unit:'ชิ้น',category:'workflow'}, {id:1,name:'สินค้าทดสอบแยกบัญชี W5',stock:w5AdjustedStock ?? 12,unit:'ชิ้น',category:'chilled'}],history:[],pickList:[]}));return;
        }
        if(target?.pathname==='/functions/v1/po-api') {
            purchasingReads++;
            if(body.token!==token) {res.writeHead(403).end(JSON.stringify({success:false,reason:'fixture_action_not_configured'}));return;}
            if(body.action==='getProducts') {res.end(JSON.stringify({success:true,products:[purchasingWorkflowProduct],vendors:['Vendor Fixture']}));return;}
            if(body.action==='getInitialData') {
                const rows=[...purchasingPoRows.values()];
                res.end(JSON.stringify({success:true,products:[purchasingWorkflowProduct],pendingPOs:rows.filter(row=>row.status!=='GR Completed'),grCompleted:rows.filter(row=>row.status==='GR Completed'),prList:purchasingWorkflowPr.status==='Pending'?[purchasingWorkflowPr]:[],apvList:[],vendors:['Vendor Fixture']}));return;
            }
            if(body.action==='approvePR') {
                const data=body.data||{}; const item=(data.items||[])[0]||{};
                const row={uid:'PO-FIXTURE-UID-0001',refPrUid:data.prUid||purchasingWorkflowPr.uid,rowNumber:1,poDate:'19/09/2026',poNumber:'PO-FIXTURE-0001',vendor:data.vendor||'Vendor Fixture',warehouse:data.warehouse||'W5',expectedDate:data.expectedDate||'',sku:item.sku||purchasingWorkflowPr.sku,product:item.product||purchasingWorkflowPr.product,quantity:String(item.quantity||purchasingWorkflowPr.quantity),unit:item.unit||purchasingWorkflowPr.unit,billRemark:data.remark||'',itemRemark:item.remark||'',poRemark:item.remark||data.remark||'',remark:'',status:'Pending GR',displayStatus:'Pending GR',grQty:'',locIn:'',exp:'',ata:'',receiverName:'',oldStock:'',extraItems:[]};
                purchasingPoRows.set(row.uid,row); purchasingWorkflowPr={...purchasingWorkflowPr,status:'Approved'}; poWrites++;
                res.end(JSON.stringify({success:true,poUids:[row.uid],poNumber:row.poNumber}));return;
            }
            res.writeHead(403).end(JSON.stringify({success:false,reason:'fixture_action_not_configured'}));return;
        }
        if(target?.pathname==='/functions/v1/gr-api') {
            purchasingReads++;
            if(body.token!==token) {res.writeHead(403).end(JSON.stringify({success:false,reason:'fixture_action_not_configured'}));return;}
            if(body.action==='getProducts') {res.end(JSON.stringify({success:true,products:[purchasingWorkflowProduct]}));return;}
            if(body.action==='getInitialData') {
                const rows=[...purchasingPoRows.values()];
                res.end(JSON.stringify({success:true,pendingPOs:rows.filter(row=>row.status!=='GR Completed'),grCompleted:rows.filter(row=>row.status==='GR Completed'),products:[purchasingWorkflowProduct],vendors:['Vendor Fixture']}));return;
            }
            if(body.action==='bulkReceivePO') {
                const data=body.data||{}; const uid=(data.groupPoUids||[])[0]; const row=purchasingPoRows.get(uid);
                if(!row) {res.writeHead(404).end(JSON.stringify({success:false,reason:'fixture_po_not_found'}));return;}
                const item=(data.items||[])[0]||{};
                row.status=data.targetStatus||row.status; row.displayStatus=row.status; row.grQty=item.grQty||row.grQty; row.locIn=item.locIn||row.locIn; row.ata=data.ata||row.ata; row.receiverName=data.receiverName||row.receiverName;
                if(data.targetStatus==='Pending Review') grReviewWrites++;
                if(data.targetStatus==='GR Completed') {grCompletedWrites++; workflowStock+=Number(item.grQty||0);}
                res.end(JSON.stringify({success:true,message:'fixture purchasing workflow saved'}));return;
            }
            res.writeHead(403).end(JSON.stringify({success:false,reason:'fixture_action_not_configured'}));return;
        }
        if(target?.pathname.endsWith('/kpi-api')&&body.token===token){
            kpiReads++;
            const today=new Date(Date.now()+7*3600000).toISOString().slice(0,10);
            if(['getConfig','getAdminStatus'].includes(body.action)){
                res.end(JSON.stringify({status:'success',viewer:{uid:claims.id,name:claims.name,roles:claims.roles,status:'Active'},employees:[{uid:claims.id,name:claims.name,roles:claims.roles,status:'Active',branches:'AKRA,TRD'}],workload:{date:today,hour:18,recordedEmployees:[],recordedEmployeeUids:[]},systemConfig:{}}));return;
            }
            if(body.action==='getLiveRequisitions'){res.end(JSON.stringify({status:'success',date:body.date,requisitions:[],feedStatus:'ok'}));return;}
            if(['getDailyData','getWorkloadData','getIncidentData','getActions','getAuditData','getShiftRoster','getSkillCatalog'].includes(body.action)){
                res.end(JSON.stringify({status:'success',records:[],actions:[],audits:[],roster:[],skills:[],hasMore:false,nextCursor:null}));return;
            }
            if(['saveWorkload','clearWorkload'].includes(body.action)){
                kpiWorkloadAttempts++;
                if(!claims.perms['app-kpi'].includes('recordWorkload')){res.writeHead(403).end(JSON.stringify({status:'error',reason:'permission_denied'}));return;}
                if(body.employeeUid!==claims.id||body.action==='saveWorkload'&&(!body.workload||![0,5,10,11,12,13].includes(body.workload.capacity)||['outbound','inbound','transfer','shared'].reduce((sum,key)=>sum+Number(body.workload[key]),0)!==body.workload.capacity)){
                    res.writeHead(400).end(JSON.stringify({status:'error',reason:'fixture_invalid_workload'}));return;
                }
                if(process.env.SHELL_KPI_API_FAILURE==='1'){res.writeHead(503).end(JSON.stringify({status:'error',reason:'fixture_database_unavailable'}));return;}
                kpiWorkloadWrites++;res.end(JSON.stringify({status:'success',workload:body.action==='saveWorkload'?[{...body.workload,employeeUid:claims.id}]:[]}));return;
            }
        }
        if (target?.pathname.endsWith('/picking-api')) pickReads++;
        if (target?.pathname.endsWith('/picking-api') && ['getBill','reportProblem'].includes(body.action)) {
            if(body.token!==problemCapability || body.uid!==problemBill.uid) {res.writeHead(403).end(JSON.stringify({success:false,reason:'invalid_bill_capability'}));return;}
            if(body.action==='getBill') {
                problemReads++;
                if(problemReviewOutage && problemReads>1){problemReviewOutage=false;res.writeHead(503).end(JSON.stringify({success:false,reason:'picking_service_unavailable'}));return;}
                res.end(JSON.stringify({success:true,bill:problemBill}));return;
            }
            problemCalls++;
            const fingerprint=JSON.stringify({version:body.version,items:body.items});
            let receipt=problemReceipts.get(body.clientRequestId);
            if(receipt && receipt.fingerprint!==fingerprint) {res.writeHead(409).end(JSON.stringify({success:false,reason:'picking_event_conflict'}));return;}
            if(receipt) problemReplays++;
            else {
                if(problemConflict){problemConflict=false;problemBill.version++;}
                if(body.version!==problemBill.version) {res.writeHead(409).end(JSON.stringify({success:false,reason:'picking_version_conflict'}));return;}
                if(!Array.isArray(body.items)||body.items.length!==2||body.items.some((item,i)=>item.index!==i||!Number.isFinite(item.actualQty)||item.actualQty<0)) {res.writeHead(400).end(JSON.stringify({success:false,reason:'invalid_picking_problem'}));return;}
                problemBill.version++; problemBill.problemItems=body.items;
                problemBill.lineStatus=body.items.some((item,i)=>item.actualQty<problemBill.items[i].qty)?'problem':'picked';
                receipt={fingerprint}; problemReceipts.set(body.clientRequestId,receipt);
            }
            if(problemLostReply){problemLostReply=false;res.writeHead(503).end(JSON.stringify({success:false,reason:'picking_service_unavailable'}));return;}
            res.end(JSON.stringify({success:true,saved:true,lineSent:process.env.SHELL_PROBLEM_LINE_PENDING!=='1',requisition:problemBill}));return;
        }
        if (target?.pathname.endsWith('/picking-api') && authorization === 'Bearer '+token) {
            const permissions={bootstrap:'viewRequisitions',getRequisitions:'viewRequisitions',getRev:'viewRequisitions',saveRequisition:'createRequisition',retryLine:'retryLine'};
            if (!Object.hasOwn(permissions,body.action) || !claims.perms['app-pick'].includes(permissions[body.action])) {res.writeHead(403).end(JSON.stringify({success:false,reason:'permission_denied'}));return;}
            const requisitions=[...pickFixtureWrites.values()].map(row=>row.result.requisition),rev='pick-'+pickFixtureWrites.size;
            if (body.action === 'bootstrap') {res.end(JSON.stringify({success:true,user:claims,rev,requisitions,products:[{id:'FIXTURE-1',name:'สินค้าจำลอง Picking',defaultUnit:'ชิ้น',active:true}],staff:[{id:'10000000-0000-4000-8000-000000000001',name:'พนักงานจำลอง',active:true}]}));return;}
            if (body.action === 'getRev') {res.end(JSON.stringify({success:true,rev}));return;}
            if (body.action === 'getRequisitions') {res.end(JSON.stringify({success:true,rev,requisitions}));return;}
            if (body.action === 'saveRequisition') {
                pickFixtureCalls++;
                let saved=pickFixtureWrites.get(body.data.clientRequestId);
                if(saved && JSON.stringify(saved.data)!==JSON.stringify(body.data)) {res.writeHead(409).end(JSON.stringify({success:false,reason:'idempotency_conflict'}));return;}
                if(saved) pickFixtureReplays++;
                else {
                    saved={data:body.data,result:{success:true,saved:true,lineSent:true,rev:'pick-'+(pickFixtureWrites.size+1),requisition:{uid:'fixture-picking-'+(pickFixtureWrites.size+1),timestamp:new Date().toISOString(),billNo:pickFixtureWrites.size+1,billType:body.data.billType,assignee:'พนักงานจำลอง',requester:claims.name,items:body.data.items,clientRequestId:body.data.clientRequestId,lineStatus:'pending'}}};
                    pickFixtureWrites.set(body.data.clientRequestId,saved);
                }
                if(pickFixtureLostReply) {pickFixtureLostReply=false;res.writeHead(503).end(JSON.stringify({success:false,reason:'picking_service_unavailable'}));return;}
                res.end(JSON.stringify(saved.result));return;
            }
        }
        if (target?.pathname.endsWith('/pr-api') && body.token === token) {
            prReads++;
            if (body.action === 'getProducts') {res.end(JSON.stringify({success:true,products:[{sku:'FIXTURE-1',name:'สินค้าจำลอง PR',unit:'ชิ้น'}]}));return;}
            if (body.action === 'getPRHistory') {res.end(JSON.stringify({success:true,history:[...prFixtureWrites.values()].flatMap(row=>row.data.items.map(item=>({...item,requester:claims.name,warehouse:row.data.warehouse,date:'17/09/2026 11:00',prNumber:row.result.prNumber,status:'Pending'})))}));return;}
            if (body.action === 'createPR') {
                let saved=prFixtureWrites.get(body.clientRequestId);
                if(saved && JSON.stringify(saved.data)!==JSON.stringify(body.data)) {res.writeHead(409).end(JSON.stringify({success:false,reason:'idempotency_conflict'}));return;}
                if(!saved) {saved={data:body.data,result:{success:true,prId:'fixture-'+(prFixtureWrites.size+1),prNumber:'PR-20260917-'+(1001+prFixtureWrites.size)}};prFixtureWrites.set(body.clientRequestId,saved);const item=(body.data?.items||[])[0]||{};purchasingWorkflowPr={...purchasingWorkflowPr,product:item.product||purchasingWorkflowPr.product,sku:item.sku||purchasingWorkflowPr.sku,quantity:String(item.quantity||purchasingWorkflowPr.quantity),unit:item.unit||purchasingWorkflowPr.unit,warehouse:body.data?.warehouse||purchasingWorkflowPr.warehouse,receiverName:body.data?.requester||purchasingWorkflowPr.receiverName};}
                if(prFixtureLostReply) {prFixtureLostReply=false;res.writeHead(503).end(JSON.stringify({success:false,reason:'pr_service_unavailable'}));return;}
                res.end(JSON.stringify(saved.result));return;
            }
        }
        res.writeHead(403).end(JSON.stringify({status:'error',reason:'fixture_action_not_configured'}));return;
    }
    let segments;try {segments=decodeURIComponent(url.pathname).split('/').filter(Boolean);}catch(_){res.writeHead(400).end();return;}
    if (segments.some(segment=>segment.startsWith('.')||segment.includes('\\'))) {res.writeHead(403).end();return;}
    const repo = roots[segments.shift()];
    if (!repo) {res.writeHead(404).end();return;}
    const relative = segments.join('/') || 'index.html';
    const root = repo === 'Main' ? path.resolve(__dirname, '..') : path.join(moduleBase,repo);
    const file = path.resolve(root,relative);
    if (!file.startsWith(root+path.sep) || !/\.(html|js|css|json|svg|woff2|png|jpg)$/.test(file)) {res.writeHead(403).end();return;}
    if (!fs.existsSync(file)) {res.writeHead(404).end();return;}
    const type = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.svg':'image/svg+xml'}[path.extname(file)]||'application/octet-stream';
    res.setHeader('Content-Type',type);
    if (relative === 'index.html' && repo !== 'Main' && !process.argv.includes('--real-modules')) {
        res.end(fixtureModule(apps.find(app=>new URL(app.url).pathname===url.pathname)));return;
    }
    let content = fs.readFileSync(file);
    if (file.endsWith('.html')) {
        content = content.toString('utf8').replaceAll('https://akra-web.github.io',origin);
        // The fixture injects a local API shim; production keeps the script-restricting CSP.
        if (repo === 'Main') content = content.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>\s*/i, '');
        content = content.replace('<head>','<head>'+injection);
    }
    res.end(content);
});
Promise.resolve(process.argv.includes('--identity-auth')?initializeIdentityAuth():null).then(()=>{
    server.listen(port,'127.0.0.1',()=>console.log(`Shell fixture on ${origin}/Main/ (${process.argv.includes('--real-modules')?'actual modules with denied unconfigured APIs':'protocol-only module fixtures'}; ${identityAuth?'actual isolated auth-api/SQL':'synthetic auth'})`));
}).catch(error=>{console.error('Fixture initialization failed:',error.message);process.exitCode=1;});
