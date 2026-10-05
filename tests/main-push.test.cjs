// Actual client/worker source in isolated VM; no provider sends or browser claim.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const tick = () => new Promise(setImmediate);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return {promise, resolve}; };
const uuid = '10000000-0000-4000-8000-000000000001';
const token = (sessionId = uuid) => 'signed.' + Buffer.from(JSON.stringify({sessionId})).toString('base64url') + '.signature';
const key = Buffer.from([4, ...Array(64).fill(1)]).toString('base64url');

function clientRig(options = {}) {
    const timers = new Map(); let timerId = 0;
    const setTimer = options.fakeTimers ? handler => { timers.set(++timerId, handler); return timerId; } : setTimeout;
    const clearTimer = options.fakeTimers ? id => timers.delete(id) : clearTimeout;
    const nodes = new Map(['main-gr-push','main-gr-push-toggle','main-gr-push-status'].map(id => [id, {
        hidden:true, disabled:true, attrs:{}, handlers:{}, textContent:'',
        setAttribute(name, value) { this.attrs[name] = value; }, addEventListener(name, fn) { this.handlers[name] = fn; }
    }]));
    const calls = [], prompts = [], subscriptions = [], removed = [], registered = [], workflows = [], events = {}, swEvents = {}, history = [];
    let endpoint = options.endpoint ? makeSubscription(options.endpoint) : null;
    function makeSubscription(value) {
        return {endpoint:value, toJSON:() => ({endpoint:value, keys:{p256dh:'public',auth:'salt'}}), unsubscribe:async () => {
            removed.push(value);
            if (options.unsubscribe === false) return false;
            if (endpoint?.endpoint === value) endpoint = null;
            return true;
        }};
    }
    const workerEvents = new Map(), registrationEvents = new Map();
    const installingWorker = {state:'installing', addEventListener:(name, handler) => workerEvents.set(name, handler),
        removeEventListener:(name, handler) => { if (workerEvents.get(name) === handler) workerEvents.delete(name); }};
    const registration = {scope:'https://example.test/Main/',active:options.installing ? null : {state:'activated'},
        installing:options.installing ? installingWorker : null,
        addEventListener:(name, handler) => registrationEvents.set(name, handler),
        removeEventListener:(name, handler) => { if (registrationEvents.get(name) === handler) registrationEvents.delete(name); }, pushManager:{
        getSubscription:async () => endpoint,
        subscribe:async params => {
            subscriptions.push(params);
            if (options.subscribeGate) await options.subscribeGate.promise;
            endpoint = makeSubscription('https://push.example.test/new-' + subscriptions.length);
            return endpoint;
        }
    }};
    const state = {identityId:uuid, sessionToken:token(), sessionVersion:1, sessionAuthorizationRevision:'rev-1', sessionEpoch:1,
        currentRoles:['ADMIN'], currentPerms:{'app-gr':['receiveGR']}, appConfig:[{id:'app-gr',roles:['ADMIN']}]};
    Object.assign(state, options.state || {});
    const location = new URL('https://example.test/Main/' + (options.route || ''));
    const window = {location, isSecureContext:true, PushManager:function () {}, atob:value => Buffer.from(value, 'base64').toString('binary'),
        history:{replaceState:(_, __, url) => { history.push(url); location.href = new URL(url, location).href; }},
        addEventListener:(name, fn) => { events[name] = fn; },
        AkraShell:{canLaunch:() => options.grAccess !== false, openWorkflow:(...args) => { workflows.push(args); return true; }},
        Notification:{permission:options.permission || 'default', requestPermission:() => {
            prompts.push('permission');
            if (options.permissionGate) return options.permissionGate.promise;
            window.Notification.permission = options.choice || 'granted';
            return Promise.resolve(window.Notification.permission);
        }},
        navigator:{serviceWorker:{getRegistration:async () => options.newRegistration ? null : options.existingScope ? {...registration,scope:options.existingScope} : registration,
            register:async (...args) => { registered.push(args); return registration; },ready:Promise.resolve(options.broaderReady ? {scope:'https://example.test/',active:{state:'activated'}} : registration),
            addEventListener:(name, fn) => { swEvents[name] = fn; }}},
        fetch:async (_, request) => {
            const body = JSON.parse(request.body); calls.push(body);
            if (options.handler) return options.handler(body);
            return {ok:true,json:async () => ({success:true,data:body.action === 'status'
                ? {eligible:true,configured:options.configured !== false,publicKey:key,subscribed:options.bound === true}
                : {subscribed:body.action === 'subscribe'}})};
        }
    };
    if (options.unsupported) delete window.PushManager;
    const context = vm.createContext({window, document:{getElementById:id => nodes.get(id)}, URL, Uint8Array, AbortController, setTimeout:setTimer, clearTimeout:clearTimer});
    new vm.Script(source('js/main-push.js')).runInContext(context);
    window.AkraPush.init({state:() => state,apiUrl:'https://api.example.test/functions/v1/push-api'});
    return {window,state,calls,prompts,subscriptions,removed,registered,workflows,events,swEvents,history,nodes,registration,workerEvents,registrationEvents,timers,
        activate:() => { installingWorker.state='activated'; registration.active=installingWorker; registration.installing=null; workerEvents.get('statechange')?.(); },
        section:nodes.get('main-gr-push'), button:nodes.get('main-gr-push-toggle'), status:nodes.get('main-gr-push-status'),
        click:() => nodes.get('main-gr-push-toggle').handlers.click(), get endpoint() { return endpoint; }};
}

test('status reads never prompt; explicit click requests permission synchronously and saves a subscription using the signed token', async () => {
    const rig = clientRig({newRegistration:true}); await tick();
    assert.equal(rig.section.hidden,false); assert.equal(rig.button.disabled,false);
    assert.deepEqual(rig.prompts,[]); assert.equal(rig.calls[0].action,'status');
    assert.equal(rig.registered[0][0],'main-push-sw.js?v=20261005.01');
    assert.equal(rig.registered[0][1].scope,'./'); assert.equal(rig.registered[0][1].updateViaCache,'none');
    const pending = rig.click(); assert.equal(rig.prompts.length,1); await pending;
    assert.equal(rig.subscriptions[0].userVisibleOnly,true); assert.equal(rig.subscriptions[0].applicationServerKey.length,65);
    assert.equal(rig.calls.at(-1).action,'subscribe'); assert.equal(rig.calls.at(-1).token,token());
    assert.equal(rig.calls.at(-1).subscription.endpoint,rig.endpoint.endpoint);
    assert.equal(rig.button.attrs['aria-pressed'],'true'); assert.match(rig.status.textContent,/เปิดแจ้งเตือน.*เซสชัน/);
});

test('staff, missing GR access/perms, sidless, stale and forced-password sessions hide the control without any push API queries', async () => {
    for (const options of [
        {state:{currentRoles:['WAREHOUSE']}}, {grAccess:false}, {state:{currentPerms:{'app-gr':[]}}},
        {state:{sessionToken:'signed.' + Buffer.from('{}').toString('base64url') + '.sig'}},
        {state:{sessionRefreshPending:true}}, {state:{sessionRefreshFailed:true}}, {state:{mustChangePassword:true}},
        {state:{identityId:null}}, {state:{sessionVersion:0}}
    ]) {
        const rig = clientRig(options); await tick();
        assert.equal(rig.section.hidden,true); assert.equal(rig.calls.length,0); assert.equal(rig.registered.length,0);
        await rig.click(); assert.equal(rig.prompts.length,0);
    }
    const supervisor = clientRig({state:{currentRoles:['SUPERVISOR'],currentPerms:{'app-gr':['approveGR']}}}); await tick();
    assert.equal(supervisor.section.hidden,false);
});

test('unsupported, denied and unconfigured browsers show Thai guidance without requesting permission', async () => {
    for (const [options, expected] of [[{unsupported:true},/ยังไม่รองรับ/],[{permission:'denied'},/ปิดกั้น/],[{configured:false},/รอผู้ดูแลตั้งค่า/]]) {
        const rig = clientRig(options); await tick();
        assert.equal(rig.section.hidden,false); assert.equal(rig.button.disabled,true); assert.match(rig.status.textContent,expected);
        await rig.click(); assert.equal(rig.prompts.length,0); assert.equal(rig.subscriptions.length,0);
    }
    const denied = clientRig({choice:'denied'}); await tick(); await denied.click();
    assert.equal(denied.calls.length,1); assert.match(denied.status.textContent,/ปิดกั้น/); assert.equal(denied.button.disabled,true);
});

test('browser endpoint alone is off; an explicit new-session opt-in replaces it instead of reassigning it', async () => {
    const rig = clientRig({endpoint:'https://push.example.test/old-session',permission:'granted'}); await tick();
    assert.equal(rig.calls[0].endpoint,'https://push.example.test/old-session');
    assert.equal(rig.button.attrs['aria-pressed'],'false'); await rig.click();
    assert.deepEqual(rig.prompts,[]); assert.deepEqual(rig.removed,['https://push.example.test/old-session']);
    assert.equal(rig.calls.at(-1).subscription.endpoint,'https://push.example.test/new-1');
});

test('Main ignores broader-scope endpoints and registers its own worker before enabling notifications', async () => {
    const rig=clientRig({existingScope:'https://example.test/',endpoint:'https://push.example.test/broader'}); await tick();
    assert.equal(rig.calls[0].endpoint,undefined);
    assert.equal(rig.registered[0][0],'main-push-sw.js?v=20261005.01');
    assert.equal(rig.button.attrs['aria-pressed'],'false'); assert.equal(rig.button.disabled,false);
});

test('first Main install waits for its registration while a broader root worker already resolves ready', async () => {
    const rig=clientRig({newRegistration:true,installing:true,broaderReady:true}); await tick();
    assert.equal(rig.button.disabled,true); assert.deepEqual(rig.prompts,[]);
    rig.activate(); await tick();
    assert.equal(rig.button.disabled,false);
    assert.equal(rig.status.textContent.includes('ยังเปลี่ยนสถานะ'),false);
    assert.equal(rig.workerEvents.size,0); assert.equal(rig.registrationEvents.size,0);
    await rig.click(); assert.equal(rig.button.attrs['aria-pressed'],'true');
});

test('specific registration failure or timeout releases readiness listeners and leaves opt-in disabled', async () => {
    for (const failure of ['redundant','timeout']) {
        const rig=clientRig({newRegistration:true,installing:true,broaderReady:true,fakeTimers:true}); await tick();
        assert.equal(rig.workerEvents.size,1); assert.equal(rig.registrationEvents.size,1);
        if (failure === 'redundant') {
            rig.registration.installing.state='redundant'; rig.workerEvents.get('statechange')();
        } else {
            assert.equal(rig.timers.size,1); [...rig.timers.values()][0]();
        }
        await tick();
        assert.equal(rig.workerEvents.size,0); assert.equal(rig.registrationEvents.size,0); assert.equal(rig.timers.size,0);
        assert.equal(rig.button.disabled,true); assert.equal(rig.window.AkraPush.getWorkState().busy,false);
        assert.match(rig.status.textContent,/ลองอีกครั้ง/); assert.deepEqual(rig.prompts,[]);
    }
});

test('old-owner activation completion cannot restore controls after signout', async () => {
    const rig=clientRig({newRegistration:true,installing:true,broaderReady:true}); await tick();
    rig.state.sessionToken=null; rig.state.sessionEpoch++; rig.window.AkraPush.reset();
    rig.activate(); await tick();
    assert.equal(rig.section.hidden,true); assert.equal(rig.window.AkraPush.getWorkState().busy,false);
    assert.equal(rig.workerEvents.size,0); assert.equal(rig.registrationEvents.size,0); assert.deepEqual(rig.prompts,[]);
});

test('only a server-confirmed current endpoint shows on; off works while the sender is unconfigured', async () => {
    const rig = clientRig({endpoint:'https://push.example.test/current',bound:true,configured:false,permission:'granted'}); await tick();
    assert.equal(rig.button.attrs['aria-pressed'],'true'); assert.equal(rig.button.disabled,false);
    await rig.click(); assert.equal(rig.calls.at(-1).action,'unsubscribe'); assert.equal(rig.calls.at(-1).endpoint,'https://push.example.test/current');
    assert.equal(rig.endpoint,null); assert.equal(rig.button.attrs['aria-pressed'],'false'); assert.match(rig.status.textContent,/ปิดแจ้งเตือน/);
    assert.deepEqual(rig.prompts,[]);
    const expired = clientRig({bound:true,permission:'granted'}); await tick();
    assert.equal(expired.button.attrs['aria-pressed'],'false');
});

test('server unsubscribe failure keeps the endpoint and on state for retry', async () => {
    const rig = clientRig({endpoint:'https://push.example.test/current',permission:'granted',handler:async body => ({ok:body.action === 'status',
        json:async () => body.action === 'status' ? {success:true,data:{eligible:true,configured:true,publicKey:key,subscribed:true}}
            : {success:false,reason:'request_failed'}})}); await tick(); await rig.click();
    assert.equal(rig.removed.length,0); assert.equal(rig.button.attrs['aria-pressed'],'true'); assert.match(rig.status.textContent,/ลองอีกครั้ง/);
});

test('a nonconfirming unsubscribe response cannot claim the endpoint is off', async () => {
    const rig=clientRig({endpoint:'https://push.example.test/current',bound:true,permission:'granted',handler:async body => ({ok:true,
        json:async () => ({success:true,data:body.action === 'status' ? {eligible:true,configured:true,publicKey:key,subscribed:true} : {subscribed:true}})})});
    await tick(); await rig.click();
    assert.equal(rig.removed.length,0); assert.equal(rig.button.attrs['aria-pressed'],'true');
    assert.match(rig.status.textContent,/ลองอีกครั้ง/);
});

test('an authorization denial hides the control; status connection failure can be retried on focus', async () => {
    for (const reason of ['invalid_or_expired_token','stale_bound_session','stale_authorization_config','permission_denied','mandatory_password_change_required']) {
        const rig = clientRig({handler:async () => ({ok:false,json:async () => ({success:false,reason})})}); await tick();
        assert.equal(rig.section.hidden,true); assert.equal(rig.prompts.length,0);
    }
    let count=0;
    const rig=clientRig({handler:async () => { if (!count++) throw new Error('offline'); return {ok:true,json:async () => ({success:true,data:{eligible:true,configured:true,publicKey:key}})}; }});
    await tick(); assert.match(rig.status.textContent,/การเชื่อมต่อ/); await rig.events.focus(); await tick(); assert.equal(rig.button.disabled,false);
});

test('a late old-account status result cannot enable controls or bind the new account', async () => {
    const gate = deferred(); const rig = clientRig({handler:async () => gate.promise}); await tick();
    rig.state.identityId='20000000-0000-4000-8000-000000000002'; rig.state.sessionToken=token(rig.state.identityId); rig.state.sessionEpoch++;
    rig.window.AkraPush.reset(); gate.resolve({ok:true,json:async () => ({success:true,data:{eligible:true,configured:true,publicKey:key,subscribed:true}})});
    await tick(); assert.equal(rig.section.hidden,true); assert.equal(rig.subscriptions.length,0); assert.equal(rig.calls.length,1);
});

test('identity changes during permission or browser subscribe never post the endpoint under another identity', async () => {
    for (const kind of ['permissionGate','subscribeGate']) {
        const gate=deferred(), rig=clientRig({[kind]:gate}); await tick(); const pending=rig.click(); await tick();
        rig.state.identityId='20000000-0000-4000-8000-000000000002'; rig.state.sessionEpoch++; rig.window.AkraPush.reset();
        gate.resolve('granted'); await pending;
        assert.equal(rig.calls.some(call=>call.action === 'subscribe'),false); assert.equal(rig.section.hidden,true);
    }
});

test('logout during a subscription API write discards its late response', async () => {
    const gate=deferred();
    const rig=clientRig({permission:'granted',handler:async body => body.action === 'subscribe' ? gate.promise
        : {ok:true,json:async () => ({success:true,data:{eligible:true,configured:true,publicKey:key}})}});
    await tick(); const pending=rig.click(); await tick();
    rig.state.sessionToken=null; rig.state.sessionEpoch++; rig.window.AkraPush.reset();
    gate.resolve({ok:true,json:async () => ({success:true,data:{subscribed:true}})}); await pending;
    assert.equal(rig.section.hidden,true); assert.equal(rig.window.AkraPush.getWorkState().busy,false);
});

test('notification navigation waits for verified eligibility and removes its fixed marker without credentials in the route', async () => {
    const gate=deferred();
    const rig=clientRig({route:'?gr_push=1&akra_perf=1#/app/app-gr',handler:async () => gate.promise}); await tick();
    assert.equal(rig.workflows.length,0);
    gate.resolve({ok:true,json:async () => ({success:true,data:{eligible:true,configured:false,publicKey:''}})}); await tick();
    assert.deepEqual(rig.workflows,[['app-gr','.gr-nav-receiving']]);
    assert.deepEqual(rig.history,['/Main/?akra_perf=1#/app/app-gr']);
    const denied=clientRig({route:'?gr_push=1#/app/app-gr',state:{currentRoles:['WAREHOUSE']}}); await tick(); assert.equal(denied.workflows.length,0);
});

test('only the same-origin Main worker and exact message protocol trigger receiving navigation', async () => {
    const rig=clientRig(); await tick();
    const data={channel:'akra-gr-push',version:1,type:'open-receiving',url:'https://evil.test/'};
    for (const scriptURL of ['https://evil.test/Main/main-push-sw.js','https://example.test/GR/main-push-sw.js',undefined]) {
        rig.swEvents.message({source:{scriptURL},data}); await tick();
    }
    assert.equal(rig.workflows.length,0);
    rig.swEvents.message({source:{scriptURL:'https://example.test/Main/main-push-sw.js?v=20261005.01'},data}); await tick();
    assert.deepEqual(rig.workflows,[['app-gr','.gr-nav-receiving']]);
});

function workerRig(windows = []) {
    const events={}, notices=[], opened=[], focused=[], messages=[];
    const self={registration:{scope:'https://example.test/Main/',showNotification:async (...args)=>notices.push(args)},
        clients:{matchAll:async () => windows.map(url=>({url,focus:async()=>focused.push(url),postMessage:value=>messages.push(value)})),
            openWindow:async url=>opened.push(url)}, addEventListener:(name, fn)=>{ events[name]=fn; }};
    new vm.Script(source('main-push-sw.js')).runInNewContext({self,URL});
    const push=async payload=>{let work;events.push({data:{json:()=>{if(payload instanceof Error)throw payload;return payload;}},waitUntil:value=>{work=value;}});await work;};
    const click=async data=>{let work,closed=false;events.notificationclick({notification:{data,close:()=>{closed=true;}},waitUntil:value=>{work=value;}});await work;return closed;};
    return {events,notices,opened,focused,messages,push,click};
}

test('worker renders a short fixed receiving notice and rejects malformed/unrelated payloads', async () => {
    const rig=workerRig();
    assert.deepEqual(Object.keys(rig.events).sort(),['notificationclick','push']);
    for (const payload of [null,new Error('bad json'),{type:'other',eventId:uuid},{type:'gr_receiving',eventId:'<script>'}]) await rig.push(payload);
    assert.equal(rig.notices.length,0);
    await rig.push({type:'gr_receiving',eventId:uuid,url:'https://evil.test/',title:'private actor',body:'private receipt'});
    assert.equal(rig.notices.length,1); assert.equal(rig.notices[0][0],'GR • รับเข้าสินค้า');
    assert.match(rig.notices[0][1].body,/งานรอตรวจสอบ/); assert.doesNotMatch(JSON.stringify(rig.notices),/evil|private/);
    assert.equal(rig.notices[0][1].tag,'gr-receiving-'+uuid);
});

test('worker focuses only Main and sends an allowlisted intent without reloading current drafts', async () => {
    const main='https://example.test/Main/index.html#/app/app-tracking';
    const rig=workerRig(['https://evil.test/Main/','https://example.test/GR/','https://example.test/Main/private/',main]);
    assert.equal(await rig.click({type:'gr_receiving',url:'https://evil.test/'}),true);
    assert.deepEqual(rig.focused,[main]); assert.equal(rig.opened.length,0);
    assert.equal(rig.messages[0].channel,'akra-gr-push'); assert.equal(rig.messages[0].type,'open-receiving');
});

test('worker opens only the fixed scoped Main GR route when no Main window exists', async () => {
    const rig=workerRig(['https://example.test/Main-evil/','https://example.test/GR/']);
    await rig.click({type:'gr_receiving',url:'javascript:alert(1)',token:'private'});
    assert.deepEqual(rig.opened,['https://example.test/Main/?gr_push=1#/app/app-gr']);
    assert.equal(await rig.click({type:'other'}),true); assert.equal(rig.opened.length,1);
});
