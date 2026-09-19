const test=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs');const path=require('node:path');const vm=require('node:vm');
const root=path.resolve(__dirname,'../..');
for(const [repo,file,globalName,method,args] of [
    ['PO','supabase-po-client.js','AkraSupabasePO','createPO',[{},'stale-token']],
    ['GR','supabase-gr-client.js','AkraSupabaseGR','bulkReceivePO',[{},'stale-token']],
    ['Returnitem','supabase-returnitem-client.js','AkraSupabaseReturnitem','recordReturn',[{},'stale-token']],
    ['KPITracker','supabase-kpi-client.js','AkraSupabaseKPI','saveWorkload',['stale-token','fixture-user','2026-09-17',{}]]
])test(`${repo} tracks full mutation, uses live Shell token, and clears dirty only after success`,async()=>{
    let busy=0,saved=0,requests=[],settle;
    const window={appUser:{identityId:'10000000-0000-4000-8000-000000000011',token:'live-token'},AkraModule:{embedded:true,getToken:()=> 'live-token',markSaved:()=>{saved++;},runMutation:async fn=>{busy++;try{return await fn();}finally{busy--;}}}};
    const kpiOwner={token:'stale-token',user:{identityId:'10000000-0000-4000-8000-000000000011'}};
    window.getKpiSessionOwner=()=>kpiOwner;window.getKpiSessionToken=()=> 'live-token';
    const context=vm.createContext({window,self:window,AbortController,setTimeout,clearTimeout,console,
        fetch:(url,options)=>{requests.push(JSON.parse(options.body));return new Promise(resolve=>settle=resolve);}});
    vm.runInContext(fs.readFileSync(path.join(root,repo,'js',file),'utf8'),context);
    const pending=window[globalName][method](...args);
    try {
        assert.equal(busy,1);assert.equal(requests.length,1);assert.equal(requests[0].token,'live-token');
    } finally {settle({ok:true,json:async()=>({status:'success',success:true,workload:[]})});await pending;}
    assert.equal(busy,0);assert.equal(requests.length,1);
    assert.equal(saved,['PO','GR','KPITracker'].includes(repo) ? 1 : 0);
});

for(const [repo,file,globalName,method,args] of [
    ['PO','supabase-po-client.js','AkraSupabasePO','createPO',[{},'stale-token']],
    ['GR','supabase-gr-client.js','AkraSupabaseGR','bulkReceivePO',[{},'stale-token']],
    ['KPITracker','supabase-kpi-client.js','AkraSupabaseKPI','saveWorkload',['stale-token','fixture-user','2026-09-17',{}]]
])test(`${repo} keeps Shell dirty after a rejected mutation`,async()=>{
    let saved=0;
    const window={appUser:{identityId:'10000000-0000-4000-8000-000000000011',token:'live-token'},AkraModule:{embedded:true,getToken:()=> 'live-token',markSaved:()=>{saved++;},runMutation:async fn=>fn()}};
    const kpiOwner={token:'stale-token',user:{identityId:'10000000-0000-4000-8000-000000000011'}};
    window.getKpiSessionOwner=()=>kpiOwner;window.getKpiSessionToken=()=> 'live-token';
    const context=vm.createContext({window,self:window,AbortController,setTimeout,clearTimeout,console,
        fetch:async()=>({ok:false,status:403,json:async()=>({status:'error',success:false,reason:'permission_denied'})})});
    vm.runInContext(fs.readFileSync(path.join(root,repo,'js',file),'utf8'),context);
    await assert.rejects(() => window[globalName][method](...args));
    assert.equal(saved,0);
});
