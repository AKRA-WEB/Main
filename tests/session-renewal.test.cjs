// Fake clock and actual renewal controller; no network, storage or database.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const hour=3600000,tick=()=>new Promise(setImmediate);
function fixture(){
  let now=1800000000000,current,busy=false,renewed=0,denied=0,hidden=false,request;
  const listeners={},timers=new Map();let serial=0;
  const document={get hidden(){return hidden;},addEventListener:(n,f)=>listeners[n]=f,removeEventListener:n=>delete listeners[n]};
  const window={};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../js/session-renewal.js'),'utf8'),{window,document,Date:{now:()=>now},atob:s=>Buffer.from(s,'base64').toString('binary'),setTimeout:(f,ms)=>{timers.set(++serial,{f,at:now+ms});return serial;},clearTimeout:id=>timers.delete(id)});
  const token=exp=>'e30.'+Buffer.from(JSON.stringify({exp})).toString('base64url')+'.fixture';
  current=token(now+hour);
  const controller=window.AkraSessionRenewal.watch({getToken:()=>current,isBusy:()=>busy,
    renew:async()=>{renewed++;if(request)await request;current=token(now+72*hour);},onDenied:()=>denied++});
  return {controller,listeners,timers,token,advance(ms){now+=ms;for(const [id,t]of [...timers])if(t.at<=now){timers.delete(id);t.f();}},
    setBusy:v=>busy=v,setHidden:v=>hidden=v,setToken:v=>current=v,setRequest:v=>request=v,
    activity:(event={isTrusted:true})=>controller.activity(event),get now(){return now;},get renewed(){return renewed;},get denied(){return denied;}};
}
test('trusted interaction renews old lease; frequent activity is throttled and can continue past the former deadline',async()=>{
  const f=fixture();f.activity();await tick();assert.equal(f.renewed,1);
  f.advance(2*hour);f.activity();await tick();assert.equal(f.renewed,2);
  for(let i=0;i<20;i++)f.activity();await tick();assert.equal(f.renewed,2);
  f.controller.stop();
});
test('idle, focus, synthetic and hidden activity cannot keep a session alive or revive an expired token',async()=>{
  const f=fixture();f.advance(2*hour);await tick();assert.equal(f.renewed,0);
  f.activity();await tick();assert.equal(f.renewed,0);
  f.setToken(f.token(f.now+hour));f.activity({isTrusted:false});f.setHidden(true);f.activity();await tick();assert.equal(f.renewed,0);
  assert.equal(f.listeners.focus,undefined);assert.equal(f.listeners.visibilitychange,undefined);f.controller.stop();
});
test('pending mutation defers renewal; stopped controller and stale activity never renew',async()=>{
  const f=fixture();f.setBusy(true);f.activity();await tick();assert.equal(f.renewed,0);
  f.setBusy(false);f.advance(1000);await tick();assert.equal(f.renewed,1);
  f.advance(2*hour);f.setBusy(true);f.activity();f.controller.stop();f.setBusy(false);f.advance(1000);await tick();assert.equal(f.renewed,1);
});
test('requests coalesce while renewal is pending',async()=>{
  const f=fixture();let finish;f.setRequest(new Promise(resolve=>finish=resolve));f.activity();f.activity();await tick();assert.equal(f.renewed,1);
  finish();await tick();f.controller.stop();
});

test('network failure preserves session and backs off until a later real interaction; denial retires it',async()=>{
  const f=fixture();f.setRequest(Promise.reject(Object.assign(Error('offline'),{code:'request_timeout'})));
  f.activity();await tick();assert.equal(f.renewed,1);assert.equal(f.denied,0);
  f.advance(31000);await tick();assert.equal(f.renewed,1,'no timer-driven retries after network failure');
  f.setRequest(Promise.reject(Object.assign(Error('revoked'),{code:'invalid_or_expired_token'})));
  f.activity();await tick();assert.equal(f.renewed,2);assert.equal(f.denied,1);f.controller.stop();
});
