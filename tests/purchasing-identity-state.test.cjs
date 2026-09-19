// Actual PO/GR entrypoints, cache helpers and adapters; isolated storage/network only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '../..');
const original = { id:'reused-name', name:'Original', identityId:'10000000-0000-4000-8000-000000000011',
    sessionVersion:1, authorizationRevision:'rev-one', roles:['ADMIN'], perms:{'app-po':['createPO'],'app-gr':['receiveGR']} };
const replacement = { ...original, identityId:'10000000-0000-4000-8000-000000000012' };
const tick = () => new Promise(setImmediate);
function source(repo) { return fs.readFileSync(path.join(root, repo, 'index.html'),'utf8'); }
for (const repo of ['PO','GR']) {
    test(`${repo} standalone rejects decoded claims and waits for current Main authorization before UI/domain/cache`, async () => {
        for (const outcome of ['denied','allowed','replaced']) {
            const denied = outcome === 'denied', accepted = outcome === 'allowed';
            let finish, verified=0, reads=0, loaded=0, shown=0;
            const store = new Map(), window = { location:{search:'?sso=forged.jwt.signature',pathname:`/${repo}/`}, history:{replaceState(){}},
                AkraModule:{embedded:false,getToken:()=>'',isLocalPreview:()=>false,home(){},
                    verifySession(id, token) { verified++; assert.equal(id,repo==='PO'?'app-tracking':'app-gr'); assert.equal(token,'forged.jwt.signature'); return new Promise((resolve,reject)=>{finish=()=>denied?reject(Error('invalid_session')):resolve({...original});}); } } };
            const ctx = vm.createContext({window, URLSearchParams, console:{log(){},warn(){},error(){}},
                localStorage:{getItem:k=>store.get(k)||null,setItem:(k,v)=>store.set(k,v),removeItem:k=>store.delete(k)},
                checkAppVersion:async()=>true,AppVersionGuard:{start(){}},CURRENT_VERSION:'fixture',lucide:{createIcons(){}},
                UI:{showLoading(){},showApp(){shown++;},showError(){}},APP_CONFIG:{STORAGE_KEY:'legacy',PORTAL_URL:'/Main/'},
                decodeJwtPayload:()=>({...original}), normalizeRoles:r=>r,hasPoAccess:()=>true,hasGrAccess:()=>true,
                buildAppSession:(u,t)=>({...u,token:t}),isLocalPreviewMode:()=>false,PERF_MODE:false,
                readApiCall:async()=>{reads++;return{};},loadInitialData:async()=>{loaded++;},openReceiving:async()=>{loaded++;},
                document:{title:repo,getElementById:()=>null},fetch:()=>{throw Error('legacy verification forbidden');}});
            vm.runInContext(source(repo).match(/var AuthGuard = ([\s\S]*?\n    };)/)[0]+'\nAuthGuard.bindEvents=()=>{};',ctx);
            const pending = ctx.AuthGuard.init(); await tick();
            assert.equal(shown,0,'unverified claims must never reveal UI/cache');
            assert.equal(reads,0,'no domain prefetch before Main authorization');
            assert.equal(loaded,0); assert.equal(verified,1);
            if (outcome === 'replaced') store.set('legacy','new-tab-session');
            finish(); await pending;
            assert.equal(shown,accepted?1:0); assert.equal(loaded,accepted?1:0); assert.equal(reads,accepted?1:0);
            if (accepted) assert.equal(window.appSession.identityId, original.identityId);
            if (outcome === 'replaced') assert.equal(store.get('legacy'),'new-tab-session','late verification must not overwrite a new login');
        }
    });
    test(`${repo} read cache isolates UUID, session and authorization revision without importing global data`, () => {
        const html = source(repo), start = html.indexOf(`    const ${repo}_CACHE_TTL`);
        const begin = repo==='PO' ? html.indexOf('    const PO_ACTIVE_CACHE_TTL') : start;
        const end = html.indexOf(repo==='PO'?'    function delay(':'    async function loadGRProductsBackground(',begin);
        const store = new Map([['fixture',JSON.stringify({_ts:Date.now(),_d:'old global data'})]]);
        const window={appSession:{...original}};
        const ctx=vm.createContext({window,Date,JSON,encodeURIComponent,console:{warn(){}},
            localStorage:{getItem:k=>store.get(k)||null,setItem:(k,v)=>store.set(k,v),removeItem:k=>store.delete(k)}});
        vm.runInContext(html.slice(begin,end),ctx);
        assert.equal(ctx.getCache('fixture',60000),null,'legacy global data cannot select a new owner');
        assert.equal(ctx.setCache('fixture','owner-one'),true);
        assert.equal(ctx.getCache('fixture',60000),'owner-one');
        window.appSession={...replacement}; assert.equal(ctx.getCache('fixture',60000),null);
        window.appSession={...original,authorizationRevision:'rev-two'}; assert.equal(ctx.getCache('fixture',60000),null);
        window.appSession={...original,sessionVersion:2}; assert.equal(ctx.getCache('fixture',60000),null);
        window.appSession={...original}; assert.equal(ctx.getCache('fixture',60000),'owner-one');
        ctx.removeCache('fixture'); assert.equal(ctx.getCache('fixture',60000),null);
        assert.equal(JSON.parse(store.get('fixture'))._d,'old global data','unknown old cache is not reassigned/deleted');
        window.appSession=null; assert.equal(ctx.setCache('fixture','unverified'),false); assert.equal(ctx.getCache('fixture',60000),null);
    });
    test(`${repo} late adapter response after account/token replacement is rejected for reads and writes`, async () => {
        for (const action of ['getInitialData',repo==='PO'?'createPO':'bulkReceivePO']) {
            let settle, token='old-token', busy=0, calls=0;
            const window={appSession:{...original},AkraModule:{embedded:true,getToken:()=>token,
                runMutation:async fn=>{busy++;try{return await fn();}finally{busy--;}}}};
            const ctx=vm.createContext({window,self:window,AbortController,setTimeout,clearTimeout,
                fetch:()=>{calls++;return new Promise(resolve=>settle=resolve);}});
            vm.runInContext(fs.readFileSync(path.join(root,repo,'js',`supabase-${repo.toLowerCase()}-client.js`),'utf8'),ctx);
            const pending=window[`AkraSupabase${repo}`].request(action,{},token);
            window.appSession={...replacement}; token='new-token';
            settle({ok:true,json:async()=>({success:true,privateRows:['original account']})});
            await assert.rejects(pending,error=>error.reason==='session_changed');
            assert.equal(calls,1);assert.equal(busy,0);
        }
    });
    test(`${repo} standalone token is bound to verified page and cross-tab changes hide private UI`, () => {
        const html=source(repo), events={}, nodes=new Map();
        const node=id=>{if(!nodes.has(id)){const classes=new Set();nodes.set(id,{classList:{add:c=>classes.add(c),remove:c=>classes.delete(c),contains:c=>classes.has(c)},addEventListener(){}});}return nodes.get(id);};
        const window={appSession:{...original,token:'verified-token'},AkraModule:{embedded:false},addEventListener:(name,fn)=>events[name]=fn};
        const ctx=vm.createContext({window,APP_CONFIG:{STORAGE_KEY:'legacy'},localStorage:{getItem:()=> 'other-account-token'},
            document:{body:node('body'),getElementById:node}});
        const auth=html.match(/var AuthGuard = ([\s\S]*?\n    };)/)[0];
        const ui=html.match(/var UI = ([\s\S]*?\n    };)/)[0];
        const tokenFn=html.match(/function getSessionToken\(\) \{[\s\S]*?\n    \}/)[0];
        vm.runInContext(ui+'\n'+auth+'\n'+tokenFn,ctx);
        ctx.AuthGuard.bindEvents(); assert.equal(ctx.getSessionToken(),'verified-token');
        events.storage({key:'unrelated',oldValue:'a',newValue:'b'}); assert.ok(window.appSession);
        events.storage({key:'legacy',oldValue:'verified-token',newValue:'other-account-token'});
        assert.equal(window.appSession,null);assert.equal(ctx.getSessionToken(),'');
        assert.equal(node('app-content').classList.contains('hidden'),true,'private content must disappear, not just show an error alongside it');
        window.appSession={...original,token:'verified-token'};
        events.storage({key:null,oldValue:null,newValue:null}); assert.equal(window.appSession,null,'clear in another tab invalidates this page too');
    });
}
