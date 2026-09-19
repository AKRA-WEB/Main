// Execute the actual per-module bridge hooks. Invalidation internals have dedicated
// identity suites; these tests prove wiring and token/owner retirement, not layout.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.resolve(__dirname,'../..');
for(const [repo,appId] of [['PO','app-tracking'],['GR','app-gr'],['PR','app-pr'],['Returnitem','app-damage'],['AKRA','app-w5'],['TRDAKRA','app-trd'],['KPITracker','app-kpi'],['Picking','app-pick'],['SOP','app-manual'],['Evaluation form','app-evaluation']])test(repo+' shared-session hook refreshes its bound token and retires only its page',()=>{
 const file=path.join(root,repo,repo==='Evaluation form'?'app.js':'index.html'),source=fs.readFileSync(file,'utf8');
 const match=source.match(/window\.AkraModule(?:\?)?\.watchSession(?:\?\.)?\(\{[\s\S]*?\n\s*\}\);/);assert(match,repo);
 const user={id:'employee',identityId:'10000000-0000-4000-8000-000000000011',sessionVersion:1,authorizationRevision:'r1',token:'old'};
 let options;const hidden=new Set(),invalid=[];
 const node={hidden:true,textContent:'',classList:{add:key=>hidden.add(key)}};
 const window={appSession:{...user},currentUser:'Employee',clearTimeout(){},AkraModule:{watchSession:value=>options=value},EvaluationSession:{invalidate:()=>invalid.push('evaluation')}};
 const c=vm.createContext({window,user,sessionToken:'old',ssoToken:'old',token:'old',prSessionToken:'old',appUser:{...user},kpiVerifiedSession:{token:'old'},
  state:{session:{...user},products:['private'],staff:['private'],requisitions:['private'],pollTimer:1},runtime:{user:{...user},token:'old'},
  UI:{showError:()=>invalid.push('ui')},document:{getElementById:()=>node,body:{setAttribute:(_key,value)=>hidden.add(value)}},
  getReturnitemToken:()=> 'old',sopIdentity:()=>user.identityId,hideDataLoading(){},showError:()=>invalid.push('pick'),
  invalidateReturnitemSession:()=>invalid.push('return'),invalidateTrdSession:()=>invalid.push('trd'),invalidateKpiSession:()=>invalid.push('kpi'),showAccessState:()=>invalid.push('sop'),invalidateSession:()=>invalid.push('w5')});
 vm.runInContext(match[0],c);assert.equal(options.appId,appId);assert.equal(options.user.identityId,user.identityId);
 options.refreshed('fresh',user);
 const actual=repo==='PR'?c.prSessionToken:repo==='AKRA'||repo==='TRDAKRA'||repo==='KPITracker'?c.sessionToken:repo==='SOP'?c.runtime.token:repo==='Returnitem'?c.appUser.token:repo==='Picking'?c.state.session.token:window.appSession.token;
 if(repo!=='Evaluation form')assert.equal(actual,'fresh');
 options.invalidated();assert.equal(invalid.length,1);
 if(['PO','GR','PR'].includes(repo))assert.equal(window.appSession,null);
 if(repo==='Picking'){assert.equal(c.state.session,null);assert.equal(c.state.authDenied,true);assert.equal(c.state.products.length,0);}
 if(repo==='PR')assert.equal(hidden.has('hidden'),true);
 if(repo==='Evaluation form')assert.equal(hidden.has('denied'),true);
});
