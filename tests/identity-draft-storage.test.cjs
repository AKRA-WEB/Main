// Cross-module local storage acceptance: a username is not an immutable owner.
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const pr=require('../../PR/js/pr-api-client.js'),picking=require('../../Picking/js/supabase-picking-client.js');
const a='10000000-0000-4000-8000-000000000001',b='10000000-0000-4000-8000-000000000002';
const store=()=>{const values=new Map();return {values,getItem:key=>values.get(key)||null,setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key)};};
const prData={requester:'Fixture',warehouse:'W1',items:[{product:'Fixture',quantity:1}]};
const pickData={billType:'Fixture',assigneeId:a,items:[{name:'Fixture',qty:1,unit:'piece'}]};
function pickUser(identityId){return{id:'same-name',identityId,apps:['app-pick'],roles:['ADMIN'],perms:{}};}
function evaluation(){const window={};vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../../Evaluation form/js/evaluation-session.js'),'utf8'),{window});return window.EvaluationSession;}
test('PR replacement identity never restores another person draft even when username is identical',async()=>{
 const storage=store();let identityId=a;
 const client=pr.create({storage,getUserId:()=> 'same-name',getIdentityId:()=>identityId,getToken:()=> 'fixture',requestId:()=> 'fixture-request',fetch:async()=>{throw Error('offline');}});
 await client.call('createPR',prData);assert.deepEqual(client.pending().data,prData);const first=client.storageKey('CACHE');
 identityId=b;assert.equal(client.pending(),null);assert.notEqual(client.storageKey('CACHE'),first);
 identityId=a;assert.deepEqual(client.pending().data,prData);
});
test('PR late confirmation after same-username identity switch is not rendered or cleared for the new owner',async()=>{
 const storage=store();let identityId=a,reply;
 const client=pr.create({storage,getUserId:()=> 'same-name',getIdentityId:()=>identityId,getToken:()=> 'fixture',requestId:()=> 'fixture-request',fetch:()=>new Promise(resolve=>reply=resolve)});
 const pending=client.call('createPR',prData);identityId=b;reply(Response.json({success:true,prId:'fixture'}));
 assert.equal((await pending).reason,'session_changed');identityId=a;assert.deepEqual(client.pending().data,prData);
});
test('Picking replacement identity has distinct draft/cache scope and cannot consume an old late response',async()=>{
 const storage=store();let user=pickUser(a),reply;
 const client=picking.create({storage,getUser:()=>user,getToken:()=> 'fixture',requestId:()=> 'fixture-request',fetch:()=>new Promise(resolve=>reply=resolve)});
 const draft=client.prepare(pickData),first=client.storageKey('CACHE'),pending=client.call('saveRequisition',draft);
 user=pickUser(b);assert.equal(client.pending(),null);assert.notEqual(client.storageKey('CACHE'),first);
 reply(Response.json({success:true,saved:true,requisition:{uid:'fixture'}}));await assert.rejects(pending,error=>error.reason==='session_changed');
 user=pickUser(a);assert.equal(client.pending().clientRequestId,draft.clientRequestId);
});
test('Evaluation forms are scoped by verified UUID, not a reused username',async()=>{
 const s=evaluation();await s.authorize({verifySession:async()=>({id:'same-name',identityId:a})});const first=s.key('DRAFT');
 await s.authorize({verifySession:async()=>({id:'same-name',identityId:b})});assert.notEqual(s.key('DRAFT'),first);
 await assert.rejects(s.authorize({verifySession:async()=>({id:'same-name'})}),/identity_required/);
 assert.throws(()=>s.key('DRAFT'),/evaluation_auth_required/);
});
test('Evaluation superseded verification cannot restore an old owner after another verification completed',async()=>{
 const s=evaluation();let resolve;
 const old=s.authorize({verifySession:()=>new Promise(done=>resolve=done)});
 await s.authorize({verifySession:async()=>({id:'same-name',identityId:b})});const expected=s.key('DRAFT');
 resolve({id:'same-name',identityId:a});await assert.rejects(old,/session_changed/);assert.equal(s.key('DRAFT'),expected);
});
test('Unattributed legacy pending requests block new writes without revealing, importing or deleting their payload',async()=>{
 for(const [name,key] of [['PR','PR_PENDING_SUBMISSION::same-name'],['Picking','pick_v2:same-name:pending']]){
  const storage=store(),old='private previous-person fixture';storage.setItem(key,old);let calls=0;
  const fetch=async()=>{calls++;throw Error('must not send');};
  if(name==='PR'){
   const client=pr.create({storage,getUserId:()=> 'same-name',getIdentityId:()=>b,getToken:()=> 'fixture',fetch});
   const result=await client.call('createPR',prData);assert.equal(result.reason,'legacy_pending_reconciliation_required');assert.ok(!JSON.stringify(result).includes(old));
  }else{
   const client=picking.create({storage,getUser:()=>pickUser(b),getToken:()=> 'fixture',fetch});
   assert.throws(()=>client.prepare(pickData),error=>error.reason==='legacy_pending_reconciliation_required'&&!error.message.includes(old));
  }
  assert.equal(calls,0);assert.equal(storage.values.size,1);assert.equal(storage.getItem(key),old);
 }
});
test('Missing immutable owner and silently failed PR persistence deny before sending',async()=>{
 const storage=store();let calls=0;
 const options={storage,getUserId:()=> 'same-name',getToken:()=> 'fixture',fetch:async()=>{calls++;throw Error('must not send');}};
 assert.equal((await pr.create(options).call('createPR',prData)).reason,'identity_required');
 assert.throws(()=>picking.create({...options,getUser:()=>pickUser(undefined)}).prepare(pickData),error=>error.reason==='identity_required');
 storage.setItem=()=>{};
 assert.equal((await pr.create({...options,getIdentityId:()=>a,requestId:()=> 'fixture-request'}).call('createPR',prData)).reason,'pending_storage_unavailable');
 assert.equal(calls,0);
});
