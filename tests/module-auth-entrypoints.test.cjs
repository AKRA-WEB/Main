// Execute actual child entrypoints with denied/allowed Main replies; no network.
const test=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs');const path=require('node:path');const vm=require('node:vm');
const root=path.resolve(__dirname,'../..');
for(const [repo,appId] of [['PO','app-tracking'],['GR','app-gr'],['PR','app-pr']]) {
    for(const denied of [false,true])test(`${repo} embedded startup ${denied?'denies':'verifies'} current Main app access without cached fallback`,async()=>{
        const html=fs.readFileSync(path.join(root,repo,'index.html'),'utf8');
        const code=html.match(/var AuthGuard = ([\s\S]*?\n    };)/)[0];
        let verified=0,loaded=0,shown=0,storageCalls=0;
        const user={id:'fixture',name:'Fixture',roles:['CUSTOM'],perms:{'app-po':['createPO'],'app-gr':['receiveGR']}};
        const window={location:{hostname:'localhost',search:'?shell=1'},AkraModule:{embedded:true,isLocalPreview:()=>false,getToken:()=> 'fixture-token',verifySession:async id=>{verified++;assert.equal(id,appId);if(denied)throw Error('permission_denied');return user;}}};
        window.AkraPR = require('../../PR/js/pr-api-client.js');
        const context=vm.createContext({window,URLSearchParams,console:{error(){},warn(){},log(){}},
            checkAppVersion:async()=>true,AppVersionGuard:{start(){}},CURRENT_VERSION:'fixture',lucide:{createIcons(){}},
            APP_CONFIG:{STORAGE_KEY:'legacy',PORTAL_URL:'https://fixture.invalid/Main/'},
            UI:{showLoading(){},showError(){},showApp:()=>shown++},
            localStorage:{getItem(){storageCalls++;throw Error('cached fallback');},setItem(){storageCalls++;},removeItem(){}},
            loadInitialData:async()=>loaded++,openReceiving:async()=>loaded++,
            restorePendingPR(){},
            buildAppSession:(claims,token)=>({...claims,token}),hasPoAccess:()=>true,hasGrAccess:()=>true,
            isLocalPreviewMode:()=>false,readApiCall:async()=>({}),PERF_MODE:false,
            document:{getElementById:()=>({addEventListener(){}})},setTimeout:()=>0
        });
        new vm.Script(code+'\nAuthGuard.bindEvents=()=>{};').runInContext(context);
        await vm.runInContext('AuthGuard.init()',context);
        assert.equal(verified,1);assert.equal(storageCalls,0);
        assert.equal(loaded,denied?0:1);assert.equal(shown,denied?0:1);
    });
}
for(const denied of [false,true])test(`KPI embedded SSO ${denied?'denies':'verifies'} without shared token/cache mutation`,async()=>{
    const {rig,original}=require('../../KPITracker/tests/helpers/identity-runtime.cjs');
    let verified=0,storageCalls=0;
    const f=rig({verify:async id=>{verified++;assert.equal(id,'app-kpi');if(denied)throw Error('denied');return{...original,id:'Fixture',name:'Fixture',roles:['CUSTOM'],perms:{}};}});
    f.window.location.search='?shell=1';f.window.AkraModule.embedded=true;f.window.AkraModule.getToken=()=> 'fixture-token';
    f.c.localStorage.setItem=()=>storageCalls++;
    f.local.set('akra_sso_token','old-main');f.local.set('akra_sso_user_data','old-user');
    const result=await f.c.resolveSsoAuth();
    assert.equal(verified,1);assert.equal(storageCalls,0);assert.equal(result.attempted,true);
    assert.equal(result.expired,denied);assert.equal(result.userData?.username,denied?undefined:'fixture');
    assert.equal(f.local.get('akra_sso_token'),'old-main');assert.equal(f.local.get('akra_sso_user_data'),'old-user');
});
for(const [repo,appId,name,indent] of [['AKRA','app-w5','verifyAccess',4],['Returnitem','app-damage','verifyAccess',8],['TRDAKRA','app-trd','ssoInit',8]]) {
    for(const denied of [false,true])test(`${repo} embedded auth ${denied?'denies':'accepts'} verified Main assignment without legacy roles/cache`,async()=>{
        const html=fs.readFileSync(path.join(root,repo,'index.html'),'utf8');
        const code=html.match(new RegExp('async function '+name+'\\(\\) \\{[\\s\\S]*?\\n'+' '.repeat(indent)+'\\}'))[0];
        let verified=0,loaded=0,storageCalls=0;
        const window={location:{hostname:'localhost',search:'?shell=1'},AkraModule:{embedded:true,isLocalPreview:()=>false,getToken:()=> 'fixture-token',verifySession:async id=>{verified++;assert.equal(id,appId);if(denied)throw Error('permission_denied');return{id:'fixture',name:'Fixture',roles:['CUSTOM'],perms:{}};}}};
        const context=vm.createContext({window,location:window.location,URLSearchParams,console:{warn(){},error(){}},
            localStorage:{getItem(){storageCalls++;return null;},setItem(){storageCalls++;},removeItem(){}},
            SSO_CONFIG:{STORAGE_KEY:'legacy',REQUIRED_ROLES:['ADMIN']},ALLOWED_ROLES:['ADMIN'],STORAGE_KEY:'legacy',MAIN_PORTAL_URL:'https://fixture.invalid/Main/',
            appUser:null,currentUser:null,sessionToken:null,decodeJwtPayload:()=>({id:'fixture',roles:['CUSTOM']}),
            showLoading(){},ssoShowError(){},redirectToLogin(){},invalidateReturnitemSession(){},restoreTrdUserState(){},showTrdPrivateUI(){},fetchInitialData:()=>loaded++,document:{},alert(){}
        });
        window.AkraModule.authRequired=()=>{};window.AkraModule.home=()=>{};
        vm.runInContext(code,context);const accepted=await vm.runInContext(name+'()',context);
        assert.equal(verified,1);assert.equal(storageCalls,0);
        if(repo==='TRDAKRA')assert.equal(loaded,denied?0:1);else assert.equal(accepted,!denied);
    });
}
