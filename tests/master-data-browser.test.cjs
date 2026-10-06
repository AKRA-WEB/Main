// Real Chrome + exact candidate Main/MasterData assets. Auth uses the candidate
// handler/RPCs in disposable PGlite; domain list/history responses are fictional.
// No provider, production database, real credentials or operational writes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const {createHash} = require('node:crypto');
const {createRequire} = require('node:module');
const mainRoot = path.resolve(__dirname, '..');
let workspace = mainRoot;
while (!fs.existsSync(path.join(workspace, 'MasterData/js/app.js')) && workspace !== path.dirname(workspace)) workspace = path.dirname(workspace);
assert.ok(fs.existsSync(path.join(workspace, 'MasterData/js/app.js')), 'Workspace MasterData candidate required');
const dataRoot = path.join(workspace, 'MasterData');
const backendRoot = path.resolve(process.env.AKRA_MASTER_DATA_TEST_BACKEND || path.join(workspace, '.worktrees/20261006-003/database'));
assert.ok(backendRoot.startsWith(workspace + path.sep), 'Only a workspace backend fixture is allowed');
const libraryRoot = process.env.AKRA_PLAYWRIGHT_MODULES || 'C:/Users/AKRA-Panich-Front/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules';
const {chromium} = require(require.resolve('playwright', {paths:[libraryRoot]}));
const pglite = require(require.resolve('@electric-sql/pglite', {paths:[path.join(workspace, 'database'), libraryRoot]}));
// Run the unchanged candidate helper with explicit offline dependency resolution.
const helperPath = path.join(backendRoot, 'tests/helpers/auth-runtime.cjs');
const helperRequire = createRequire(helperPath), helperModule = {exports:{}};
new vm.Script('(function(require,module,__dirname){\n' + fs.readFileSync(helperPath, 'utf8') + '\n})', {filename:helperPath})
  .runInThisContext()(name => name === '@electric-sql/pglite' ? pglite : helperRequire(name), helperModule, path.dirname(helperPath));
const authFixture = helperModule.exports;
const keys = ['viewMasterData','manageProducts','manageVendors','manageMembers','importProducts','importVendors','importMembers'];
const mainStatic = new Set(['index.html','version.json','manifest.webmanifest','tailwind.css','css/unified-shell.css',
  'js/akra-shell-bridge.js','js/unified-shell.js','js/main-push.js','js/permission-catalog.js','js/user-permission-editor.js','js/main-pwa.js',
  'assets/lucide-0.468.0.min.js','assets/icons/bm.svg','assets/icons/bm-192-v20261001-07.png','assets/icons/bm-512-v20261001-07.png','assets/icons/bm-512-maskable-v20261001-07.png']);
const dataStatic = new Set(['index.html','version.json','style.css','js/akra-shell-bridge.js','js/app.js','js/api.js','js/import-parser.js','assets/vendor/xlsx-0.20.3.full.min.js']);
const mime = {'.html':'text/html','.css':'text/css','.js':'text/javascript','.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.webmanifest':'application/manifest+json'};
const artifactRoot = path.join(workspace, '.artifacts/verification-runs/20261006-003/main-browser-admin');
const results = [], activeRigs = [];
let browser, server, origin;
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function hashes() {
  return Object.fromEntries([
    ...['index.html','version.json','js/unified-shell.js','js/akra-shell-bridge.js','js/permission-catalog.js'].map(file => ['Main/' + file, path.join(mainRoot,file)]),
    ...['index.html','version.json','style.css','js/app.js','js/api.js','js/import-parser.js','js/akra-shell-bridge.js'].map(file => ['MasterData/' + file,path.join(dataRoot,file)]),
    ['database/auth-api/index.ts',path.join(backendRoot,'supabase/functions/auth-api/index.ts')],
    ['database/_shared/main-jwt.ts',path.join(backendRoot,'supabase/functions/_shared/main-jwt.ts')],
    ['database/auth-runtime.cjs',helperPath]
  ].map(([name,file]) => [name,hash(file)]));
}
async function authRequest(rig,payload) {
  return rig.auth.handler(new Request('https://fixture.invalid/auth-api',{method:'POST',headers:{'content-type':'application/json',origin},body:JSON.stringify(payload)}));
}
async function rig({permissions=keys,urlMode='active',roles=['ADMIN']}={}) {
  const db = await authFixture.fixture({userPermissions:true});
  const auth = authFixture.runtime(db,{identityRequired:'true'});
  const envGet = auth.c.Deno.env.get;
  auth.c.Deno.env.get = key => key === 'AUTH_ALLOWED_ORIGINS' ? origin : envGet(key);
  const password = await vm.runInContext("createPasswordHash('fixture-password','user')",auth.c);
  await db.exec('RESET ROLE;');
  await db.exec("INSERT INTO role_configs(role_name) VALUES('SUPERVISOR');");
  await db.query("UPDATE users SET password_hash=$1,password_salt=$2,roles=$3::text[] WHERE username='fixture'",[password.stored,password.salt,roles]);
  await db.exec("UPDATE app_configs SET is_active=false WHERE app_id='app-w5';");
  // Deliberately overgrant SUPERVISOR so the client ADMIN gate is independently exercised.
  await db.query("INSERT INTO app_configs(app_id,name,icon,url,allowed_roles,is_active) VALUES('app-master-data','Fixture directory','database',$1,ARRAY['ADMIN','SUPERVISOR'],$2)",[urlMode === 'empty' ? '' : origin + '/MasterData/',urlMode !== 'inactive']);
  for(const key of keys) await db.query("INSERT INTO perm_configs(app_id,perm_key,perm_name) VALUES('app-master-data',$1,$1)",[key]);
  for(const role of ['ADMIN','SUPERVISOR']) for(const key of permissions) await db.query("INSERT INTO role_permissions(app_id,perm_key,role_name) VALUES('app-master-data',$1,$2)",[key,role]);
  await db.exec("UPDATE auth_config_state SET revision='main-master-browser'; SET ROLE service_role;");
  const context = await browser.newContext({viewport:{width:1440,height:1000}});
  const run = {db,auth,context,domainCalls:[],authActions:[],externalBlocked:0,pageErrors:[],consoleErrors:[],credentialsPosted:0};
  activeRigs.push(run);
  await context.route('**/*', async route => {
    const request=route.request(), url=new URL(request.url());
    if(url.origin === origin) return route.continue();
    if(url.hostname === 'hgxrrskztbpejirrdpbq.supabase.co' && url.pathname === '/functions/v1/auth-api') {
      const payload = request.postDataJSON();run.authActions.push(payload.action);
      if(payload.action === 'login') {assert.equal(payload.id,'fixture');assert.equal(payload.password,'fixture-password');run.credentialsPosted++;}
      const response = await authRequest(run,payload);
      return route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body:await response.text()});
    }
    if(url.hostname === 'hgxrrskztbpejirrdpbq.supabase.co' && url.pathname === '/functions/v1/master-data-api') {
      const payload=request.postDataJSON();
      const verification=await authRequest(run,{action:'verifyToken',appId:'app-master-data',token:payload.token});
      const verified=await verification.json();
      if(!verified.valid) return route.fulfill({status:401,headers:{'access-control-allow-origin':origin},contentType:'application/json',body:JSON.stringify({success:false,error:'invalid_session'})});
      if(!verified.user.roles?.includes('ADMIN') || !verified.user.perms['app-master-data']?.includes('viewMasterData')) return route.fulfill({status:403,headers:{'access-control-allow-origin':origin},contentType:'application/json',body:JSON.stringify({success:false,error:'permission_denied'})});
      assert.ok(['list','history'].includes(payload.action), 'Navigation fixture never accepts domain writes');
      assert.ok(['products','vendors','members'].includes(payload.data.dataset));run.domainCalls.push({action:payload.action,dataset:payload.data.dataset});
      const data=payload.action === 'history' ? {history:[]} : {records:[{
        id:{products:'30000000-0000-4000-8000-000000000001',vendors:'40000000-0000-4000-8000-000000000001',members:'50000000-0000-4000-8000-000000000001'}[payload.data.dataset],
        code:{products:'000001',vendors:'V001',members:'000314'}[payload.data.dataset],
        name:{products:'Product Browser Fixture',vendors:'Vendor Browser Fixture',members:'Member Browser Fixture'}[payload.data.dataset],
        unit:'ชิ้น',active:true,version:'fixture-v1',phone:'000000',email:'',address:'',company:'',category:'Fixture',subname:''
      }],total:1,counts:{all:1,active:1,inactive:0}};
      return route.fulfill({status:200,headers:{'access-control-allow-origin':origin},contentType:'application/json',body:JSON.stringify({success:true,data})});
    }
    run.externalBlocked++;return route.abort('blockedbyclient');
  });
  run.page=await context.newPage();
  run.page.on('pageerror',error => run.pageErrors.push(error.message));
  run.page.on('console',message => {if(message.type()==='error')run.consoleErrors.push(message.text());});
  await run.page.goto(origin + '/Main/');
  await run.page.locator('#username-input').fill('fixture');await run.page.locator('#password-input').fill('fixture-password');
  await run.page.locator('#login-btn').click();await run.page.locator('#dashboard-section:not(.hidden)').waitFor();
  assert.equal(run.credentialsPosted,1);
  const token=await run.page.evaluate(() => localStorage.getItem('akra_session_token'));
  run.claims=await auth.c.verify(token,authFixture.secret);run.token=token;
  assert.equal(run.claims.tokenVersion,2);assert.match(run.claims.identityId,/^[0-9a-f-]{36}$/);assert.match(run.claims.sessionId,/^[0-9a-f-]{36}$/);
  assert.ok(run.claims.sessionStartedAt>0);return run;
}
async function open(run) {
  await run.page.locator('#app-grid button[aria-label="เปิด DATA • ข้อมูลกลาง"]').click();
  await run.page.locator('#shell-module-frame').waitFor();return run.page.frameLocator('#shell-module-frame');
}
async function close(run) {await run.context.close();await run.db.close();activeRigs.splice(activeRigs.indexOf(run),1);}
async function main() {
  const before=hashes();assert.equal(before['Main/js/akra-shell-bridge.js'],before['MasterData/js/akra-shell-bridge.js'],'Reviewed bridge distribution must match');
  fs.mkdirSync(artifactRoot,{recursive:true});
  server=http.createServer((req,res) => {
    res.setHeader('Cache-Control','no-store');
    const pathname=new URL(req.url,'http://127.0.0.1').pathname;
    const match=/^\/(Main|MasterData)\/(.*)$/.exec(pathname);
    if(req.method!=='GET'||!match){res.writeHead(404);res.end();return;}
    const file=match[2]||'index.html',allow=match[1]==='Main'?mainStatic:dataStatic;
    if(!allow.has(file)){res.writeHead(404);res.end();return;}
    const location=path.join(match[1]==='Main'?mainRoot:dataRoot,file);
    res.writeHead(200,{'Content-Type':mime[path.extname(file)]||'application/octet-stream'});res.end(fs.readFileSync(location));
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));origin='http://127.0.0.1:'+server.address().port;
  browser=await chromium.launch({headless:true,executablePath:process.env.AKRA_CHROME_EXECUTABLE||'C:/Program Files/Google/Chrome/Application/chrome.exe'});
  const run=await rig(), child=await open(run);
  await child.getByText('Product Browser Fixture',{exact:true}).first().waitFor();
  const frame=run.page.frames().find(value=>new URL(value.url()).pathname==='/MasterData/');
  assert.equal(await run.page.locator('#shell-module-frame').getAttribute('src'),origin+'/MasterData/?shell=1');
  const bridge=await frame.evaluate(() => ({embedded:AkraModule.embedded,token:AkraModule.getToken(),stored:localStorage.getItem('akra_master_data_token'),parentToken:parent.AkraShell.tokenFor(window)}));
  assert.equal(bridge.embedded,true);assert.equal(bridge.token,run.token);assert.equal(bridge.parentToken,run.token);assert.equal(bridge.stored,null);
  assert.ok(run.auth.calls.some(call=>call.name==='auth_validate_bound_session_v2'&&call.body.p_session_id===run.claims.sessionId));
  results.push('Main form login/current-device verification and memory-only iframe handshake');
  const group=run.page.locator('#shell-app-nav [data-app-id="app-master-data"]');
  for(const [label,dataset,name] of [['Vendor','vendors','Vendor Browser Fixture'],['สมาชิกและลูกค้า','members','Member Browser Fixture'],['สินค้า','products','Product Browser Fixture']]) {
    await group.getByRole('button',{name:'DATA • ข้อมูลกลาง: '+label,exact:true}).click();await child.locator('#tab-'+dataset+'[aria-selected="true"]').waitFor();
    await child.getByText(name,{exact:true}).first().waitFor();assert.equal(run.page.frames().find(value=>new URL(value.url()).pathname==='/MasterData/'),frame);
  }
  results.push('Main dataset workflows activate real child controls and preserve the same frame');
  await child.locator('[data-action="edit-record"]').click();await child.locator('#field-name').fill('Unsaved Browser Draft');
  await group.getByRole('button',{name:'DATA • ข้อมูลกลาง: Vendor',exact:true}).click();
  await child.locator('[data-action="keep-editing"]').waitFor();
  assert.equal(await child.locator('#field-name').inputValue(),'Unsaved Browser Draft');assert.equal(await child.locator('#tab-products').getAttribute('aria-selected'),'true');
  await child.locator('[data-action="keep-editing"]').click();
  await child.locator('[data-action="cancel-edit"]').click();await child.locator('[data-action="discard-and-go"]').click();
  await child.locator('#record-form').waitFor({state:'detached'});assert.equal(run.domainCalls.some(call=>call.action==='save'),false);
  results.push('cancelled Main workflow switch retains unsaved child draft without a write');
  await run.page.screenshot({path:path.join(artifactRoot,'main-master-desktop.png'),fullPage:true});
  await run.page.setViewportSize({width:390,height:900});await child.locator('#tab-members').click();await child.getByText('Member Browser Fixture',{exact:true}).first().waitFor();
  assert.equal(await frame.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await run.page.screenshot({path:path.join(artifactRoot,'main-master-390.png'),fullPage:true});
  results.push('390px Main shell retains accessible child dataset tabs without horizontal overflow');
  assert.deepEqual(run.pageErrors,[]);const counts={authActions:[...new Set(run.authActions)],domainReads:run.domainCalls.length,externalBlocked:run.externalBlocked};await close(run);
  const supervisor=await rig({roles:['SUPERVISOR']});
  const supervisorVerification=await (await authRequest(supervisor,{action:'verifyToken',appId:'app-master-data',token:supervisor.token})).json();
  assert.equal(supervisorVerification.valid,true);
  assert.deepEqual(supervisorVerification.user.roles,['SUPERVISOR']);
  assert.deepEqual(supervisorVerification.user.perms['app-master-data'].slice().sort(),keys.slice().sort());
  assert.equal(await supervisor.page.locator('#app-grid button[aria-label="เปิด DATA • ข้อมูลกลาง"]').count(),0);
  assert.equal(await supervisor.page.locator('#shell-app-nav [data-app-id="app-master-data"]').count(),0);
  const forced=await supervisor.page.evaluate(()=>{
    AKRA_SSO.openApp(location.origin+'/MasterData/','app-master-data');
    return {open:AkraShell.open('app-master-data'),workflow:AkraShell.openWorkflow('app-master-data','#tab-members')};
  });
  assert.deepEqual(forced,{open:false,workflow:false});
  await supervisor.page.evaluate(()=>new Promise(resolve=>{window.addEventListener('hashchange',()=>queueMicrotask(resolve),{once:true});location.hash='#/app/app-master-data';}));
  assert.equal(await supervisor.page.locator('#shell-module-frame').count(),0);assert.equal(supervisor.domainCalls.length,0);
  assert.deepEqual(supervisor.pageErrors,[]);await close(supervisor);
  results.push('SUPERVISOR with all seven grants has no Main menu/workflows and forced launch is denied');
  const combined=await rig({roles:['ADMIN','SUPERVISOR']}),combinedChild=await open(combined);
  await combinedChild.getByText('Product Browser Fixture',{exact:true}).first().waitFor();
  assert.ok(combined.domainCalls.length>0);assert.deepEqual(combined.pageErrors,[]);await close(combined);
  results.push('ADMIN plus SUPERVISOR retains signed Main and child access');
  const viewer=await rig({permissions:['viewMasterData']}),view=await open(viewer);
  for(const dataset of ['products','vendors','members']) {
    await view.locator('#tab-'+dataset).click();await view.locator('#record-list tbody tr').first().waitFor();
    assert.equal(await view.locator('#add-record').isVisible(),false);assert.equal(await view.locator('#open-import').isVisible(),false);assert.equal(await view.locator('[data-action="edit-record"]').count(),0);
  }
  assert.deepEqual(viewer.pageErrors,[]);await close(viewer);results.push('ADMIN view-only signed catalog permits reads and hides add/edit/import across all datasets');
  const denied=await rig({permissions:[]}),deniedChild=await open(denied);
  await deniedChild.locator('#session-screen:not([hidden]) #auth-retry:not([hidden])').waitFor();
  assert.equal(denied.domainCalls.length,0);assert.equal(await deniedChild.locator('#app-content').isVisible(),false);assert.deepEqual(denied.pageErrors,[]);await close(denied);
  results.push('missing view capability rejects entry before any domain request');
  const revoked=await rig();const response=await authRequest(revoked,{action:'logoutSession',token:revoked.token});assert.equal(response.status,200);
  const revokedChild=await open(revoked);await revokedChild.locator('#session-screen:not([hidden]) #auth-retry:not([hidden])').waitFor();
  assert.equal(revoked.domainCalls.length,0);assert.equal(await revokedChild.locator('#record-list').textContent(),'');assert.deepEqual(revoked.pageErrors,[]);await close(revoked);
  results.push('actual current-device revocation denies the retained token before domain reads');
  for(const urlMode of ['inactive','empty']) {
    const gated=await rig({urlMode});
    await gated.page.evaluate(()=>new Promise(resolve=>{window.addEventListener('hashchange',()=>queueMicrotask(resolve),{once:true});location.hash='#/app/app-master-data';}));
    assert.equal(await gated.page.locator('#shell-module-frame').count(),0);assert.equal(gated.domainCalls.length,0);
    assert.deepEqual(gated.pageErrors,[]);await close(gated);results.push(urlMode+' app configuration cannot create a module frame');
  }
  const after=hashes();assert.deepEqual(after,before,'Source changed during browser checks; rerun on final candidate');
  const evidence={environment:'real Chrome; exact candidate Main/MasterData assets; actual auth-api/current-device RPCs in disposable PGlite; fictional read-only domain API',browser:browser.version(),version:JSON.parse(fs.readFileSync(path.join(mainRoot,'version.json'),'utf8')).version,cases:results,counts,pageErrors:[],sourceHashes:after,limits:'No hosted/provider/production or real-data claim; no domain mutation acceptance from this navigation fixture'};
  fs.writeFileSync(path.join(artifactRoot,'evidence.json'),JSON.stringify(evidence,null,2));console.log('PASS '+results.length+' Main/MasterData real-browser navigation cases');
}
main().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{for(const run of [...activeRigs])await close(run);if(browser)await browser.close();if(server)await new Promise(resolve=>server.close(resolve));});
