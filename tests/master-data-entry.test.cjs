// Isolated controller/runtime fixtures; these checks make no hosted/browser claim.
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {moduleUrl,canLaunch}=require('../js/unified-shell.js');
const permissions=require('../js/permission-catalog.js');
const origin='https://akra-web.github.io';
const app={id:'app-master-data',url:origin+'/MasterData/',roles:['ADMIN'],isActive:true};

test('Master Data fallback has no guessed URL, active role or launchable entry',()=>{
    const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
    const array=html.match(/const DEFAULT_APP_CONFIG = (\[[\s\S]*?\n\s*\]);/)[1];
    const apps=new vm.Script('('+array+')').runInNewContext({});
    const candidate=apps.find(row=>row.id===app.id);
    assert.equal(candidate.url,'');assert.equal(candidate.isActive,false);assert.equal(candidate.roles.length,0);
    for(const role of ['ADMIN','SUPERVISOR','CUSTOM']){
        assert.equal(canLaunch(app.id,{sessionToken:'fixture',currentRoles:[role],appConfig:apps}),false);
    }
    assert.equal(moduleUrl(candidate,origin),'');
});

test('Master Data requires its exact configured origin/path and rejects URL credential transport',()=>{
    assert.equal(moduleUrl(app,origin),origin+'/MasterData/?shell=1');
    for(const url of ['',origin+'/Main/',origin+'/MasterData/index.html',origin+'/MasterData/?token=fixture',origin+'/MasterData/#fixture','https://evil.invalid/MasterData/','https://fixture@akra-web.github.io/MasterData/']){
        assert.equal(moduleUrl({...app,url},origin),'');
    }
    const state={sessionToken:'fixture',currentRoles:['ADMIN'],appConfig:[app]};
    assert.equal(canLaunch(app.id,state),true);
    for(const patch of [{isActive:false},{roles:[]}])assert.equal(canLaunch(app.id,{...state,appConfig:[{...app,...patch}]}),false);
    assert.equal(canLaunch(app.id,{...state,currentRoles:['SUPERVISOR']}),false);
});

test('Master Data requires exact ADMIN even when another role has app and operation grants',()=>{
    const configured={...app,roles:['ADMIN','SUPERVISOR']};
    const state={sessionToken:'fixture',currentRoles:['SUPERVISOR'],appConfig:[configured],
        userPermissions:{'app-master-data':['viewMasterData','manageProducts','manageVendors','manageMembers','importProducts','importVendors','importMembers']}};
    assert.equal(canLaunch(app.id,state),false);
    assert.equal(canLaunch(app.id,{...state,currentRoles:['admin']}),false);
    assert.equal(canLaunch(app.id,{...state,currentRoles:'ADMIN'}),false);
    assert.equal(canLaunch(app.id,{...state,currentRoles:['ADMIN','SUPERVISOR']}),true);
    assert.equal(canLaunch(app.id,{...state,currentRoles:['ADMIN'],userPermissions:{'app-master-data':['viewMasterData']}}),true);
    const other={id:'app-gr',roles:['SUPERVISOR'],isActive:true};
    assert.equal(canLaunch(other.id,{...state,appConfig:[other]}),true);
});

function switcher({config,user,current=''}={}){
    const rows=new Map();if(config!==undefined)rows.set('akra_app_config',JSON.stringify(config));
    if(user!==undefined)rows.set('akra_user_data',JSON.stringify(user));
    const window={location:{origin,hostname:'akra-web.github.io',search:''},localStorage:{getItem:key=>rows.get(key)||null},addEventListener(){}};
    window.parent=window;
    const document={readyState:'loading',addEventListener(){}};
    const source=fs.readFileSync(path.join(__dirname,'../js/akra-shell-bridge.js'),'utf8').replace(/\r\n/g,'\n');
    const instrumented=source.replace('    if (!shell) return;\n',"    window.fixtureEntries = () => switcherEntries();\n    window.fixtureCurrent = id => { standaloneAppId = id; };\n    if (!shell) return;\n");
    vm.runInNewContext(instrumented,{window,document,URL,URLSearchParams,AbortController,setTimeout,clearTimeout});
    window.fixtureCurrent(current);return window.fixtureEntries();
}

test('new standalone switcher entry cannot guess a URL from role/app cache or its current path',()=>{
    for(const config of [undefined,[],[{id:app.id,roles:['ADMIN'],url:'',isActive:false}],[{...app,url:''}],[{...app,url:'https://evil.invalid/MasterData/'}],[{...app,url:origin+'/MasterData/?token=fixture'}]]){
        const entries=switcher({config,user:{apps:[app.id],roles:['ADMIN']},current:app.id});
        assert.equal(entries.some(row=>row.id===app.id),false);
    }
    assert.equal(switcher({current:app.id}).length,0);
    assert.equal(switcher({config:[app],user:{apps:[app.id],roles:['ADMIN']}}).some(row=>row.id===app.id),true);
    assert.equal(switcher({config:[app],user:{roles:['ADMIN']}}).some(row=>row.id===app.id),true);
    assert.equal(switcher({config:[app],user:{roles:['SUPERVISOR']}}).some(row=>row.id===app.id),false);
    assert.equal(switcher({config:[{...app,isActive:false}],user:{apps:[app.id],roles:['ADMIN']}}).some(row=>row.id===app.id),false);
});

test('Master Data standalone switcher denies non-ADMIN authorized-app and role caches',()=>{
    const configured={...app,roles:['ADMIN','SUPERVISOR']};
    for(const user of [{roles:['SUPERVISOR']},{roles:['SUPERVISOR'],apps:[app.id]},{roles:[],apps:[app.id]}]){
        assert.equal(switcher({config:[configured],user,current:app.id}).some(row=>row.id===app.id),false);
    }
    assert.equal(switcher({config:[configured],user:{roles:['ADMIN','SUPERVISOR'],apps:[app.id]}}).some(row=>row.id===app.id),true);
});

test('permission descriptions cover the seven server-defined Master Data operations',()=>{
    for(const key of ['viewMasterData','manageProducts','manageVendors','manageMembers','importProducts','importVendors','importMembers']){
        const description=permissions.describe(app.id,key);assert.notEqual(description.label,key);assert.ok(description.detail.length>0);
    }
    assert.equal(permissions.describe(app.id,'unknownCapability').label,'unknownCapability');
});
