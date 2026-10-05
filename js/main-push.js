/* Device opt-in uses the verified Main session; the API owns authorization. */
(function (root) {
    'use strict';
    let host, section, button, status, generation = 0, ownerKey = '', busy = false;
    let registration = null, subscribed = false, configured = false, publicKey = '';
    const route = new URL(root.location.href).searchParams.get('gr_push') === '1';
    let pendingReceiving = route;
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    function owner() {
        const state = host.state();
        try {
            const encoded = String(state.sessionToken || '').split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
            const sessionId = JSON.parse(root.atob(encoded + '='.repeat((4 - encoded.length % 4) % 4))).sessionId;
            const perms = state.currentPerms?.['app-gr'];
            if (!uuid.test(state.identityId || '') || !uuid.test(sessionId || '')
                || !Number.isSafeInteger(state.sessionVersion) || state.sessionVersion <= 0
                || !state.sessionAuthorizationRevision || state.sessionRefreshPending || state.sessionRefreshFailed || state.mustChangePassword
                || !state.currentRoles?.some(role => role === 'ADMIN' || role === 'SUPERVISOR')
                || !Array.isArray(perms) || !perms.some(permission => permission === 'receiveGR' || permission === 'approveGR')
                || !root.AkraShell?.canLaunch('app-gr', state)) return null;
            return {token:state.sessionToken, key:JSON.stringify([state.identityId, sessionId, state.sessionVersion,
                state.sessionAuthorizationRevision, state.sessionEpoch, state.sessionToken])};
        } catch (_) { return null; }
    }
    function current(snapshot, requestGeneration) {
        return generation === requestGeneration && owner()?.key === snapshot.key;
    }
    function supported() {
        return root.isSecureContext && !!root.navigator.serviceWorker && !!root.PushManager && !!root.Notification;
    }
    function render(message) {
        if (message) status.textContent = message;
        button.textContent = subscribed ? 'ปิดแจ้งเตือนรับสินค้า' : 'เปิดแจ้งเตือนรับสินค้า';
        button.disabled = busy || !supported() || (!subscribed && (!configured || !registration?.active || root.Notification.permission === 'denied'));
        button.setAttribute('aria-pressed', String(subscribed));
    }
    function readyMessage() {
        if (!supported()) return 'เบราว์เซอร์นี้ยังไม่รองรับแจ้งเตือน กรุณาใช้ Chrome หรือ Edge หรือเปิดแอปที่ติดตั้งไว้บนอุปกรณ์';
        if (subscribed) return 'เปิดแจ้งเตือนการรับสินค้าแล้วสำหรับบัญชีและเซสชันนี้บนอุปกรณ์นี้';
        if (root.Notification.permission === 'denied') return 'เบราว์เซอร์ปิดกั้นแจ้งเตือน กรุณาอนุญาตในการตั้งค่าเว็บไซต์ แล้วกลับมาเปิดแจ้งเตือนอีกครั้ง';
        if (!configured) return 'ระบบแจ้งเตือนยังรอผู้ดูแลตั้งค่า กรุณากลับมาลองอีกครั้งภายหลัง';
        return 'แจ้งเมื่อมีการบันทึกรับสินค้าสำเร็จ รวมรับบางส่วน กดเปิดเพื่ออนุญาตบนอุปกรณ์นี้';
    }
    async function request(action, snapshot, data = {}) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 12000);
        try {
            const response = await root.fetch(host.apiUrl, {method:'POST', headers:{'Content-Type':'application/json'},
                body:JSON.stringify({action, token:snapshot.token, ...data}), signal:controller.signal, credentials:'omit', cache:'no-store'});
            const result = await response.json();
            if (!response.ok || result.success !== true) throw new Error(result.reason || 'request_failed');
            return result.data || {};
        } finally { clearTimeout(timer); }
    }
    function failure(error) {
        if (['invalid_or_expired_token','stale_bound_session','stale_authorization_config','permission_denied','mandatory_password_change_required'].includes(error.message)) {
            section.hidden = true;
            return;
        }
        if (error.message === 'push_not_configured') configured = false;
        render(error.message === 'push_not_configured' ? 'ระบบแจ้งเตือนยังรอผู้ดูแลตั้งค่า กรุณาลองอีกครั้งภายหลัง'
            : 'ยังเปลี่ยนสถานะแจ้งเตือนไม่สำเร็จ กรุณาตรวจสอบการเชื่อมต่อแล้วลองอีกครั้ง');
    }
    function openReceiving() {
        if (!pendingReceiving || !owner()) return;
        pendingReceiving = false;
        const url = new URL(root.location.href);
        url.searchParams.delete('gr_push');
        root.history.replaceState(null, '', url.pathname + url.search + url.hash);
        root.AkraShell.openWorkflow('app-gr', '.gr-nav-receiving');
    }
    function workerReady(candidate) {
        return new Promise((resolve, reject) => {
            let watched, timer, settled = false;
            function finish(error) {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                candidate.removeEventListener('updatefound', check);
                watched?.removeEventListener('statechange', check);
                error ? reject(error) : resolve(candidate);
            }
            function check() {
                if (candidate.active?.state === 'activated') { finish(); return; }
                const worker = candidate.installing || candidate.waiting || candidate.active;
                if (worker !== watched) {
                    watched?.removeEventListener('statechange', check);
                    watched = worker;
                    watched?.addEventListener('statechange', check);
                }
                if (watched?.state === 'redundant') finish(new Error('worker_unavailable'));
            }
            timer = setTimeout(() => finish(new Error('worker_unavailable')), 12000);
            candidate.addEventListener('updatefound', check);
            check();
        });
    }
    async function sync(force = false) {
        if (!host) return;
        const snapshot = owner();
        if (!snapshot) { reset(); return; }
        if (!force && snapshot.key === ownerKey) return;
        if (busy && snapshot.key === ownerKey) return;
        const requestGeneration = ++generation;
        ownerKey = snapshot.key;
        busy = true; subscribed = false; configured = false; publicKey = '';
        section.hidden = false;
        render('กำลังตรวจสอบแจ้งเตือนบนอุปกรณ์นี้…');
        try {
            let deviceRegistration = supported() ? await root.navigator.serviceWorker.getRegistration(new URL('./', root.location.href).href) : null;
            if (!current(snapshot, requestGeneration)) return;
            // A broader site worker is not Main's device subscription owner.
            if (deviceRegistration?.scope !== new URL('./', root.location.href).href) deviceRegistration = null;
            const device = deviceRegistration ? await deviceRegistration.pushManager.getSubscription() : null;
            if (!current(snapshot, requestGeneration)) return;
            const result = await request('status', snapshot, device ? {endpoint:device.endpoint} : {});
            if (!current(snapshot, requestGeneration)) return;
            if (result.eligible !== true) { section.hidden = true; return; }
            configured = result.configured === true;
            publicKey = typeof result.publicKey === 'string' ? result.publicKey : '';
            subscribed = !!device && result.subscribed === true;
            openReceiving();
            if (supported()) {
                deviceRegistration = await root.navigator.serviceWorker.register('main-push-sw.js?v=20261005.01', {scope:'./', updateViaCache:'none'});
                if (!current(snapshot, requestGeneration)) return;
                if (deviceRegistration.active?.state !== 'activated') {
                    deviceRegistration = await workerReady(deviceRegistration);
                    if (!current(snapshot, requestGeneration)) return;
                }
            }
            if (deviceRegistration && deviceRegistration.scope !== new URL('./', root.location.href).href) throw new Error('worker_scope_mismatch');
            registration = deviceRegistration;
            render(readyMessage());
        } catch (error) {
            if (!current(snapshot, requestGeneration)) return;
            ownerKey = ''; // A failed status read can be retried on the next focus.
            failure(error);
        } finally {
            if (current(snapshot, requestGeneration)) { busy = false; render(); }
        }
    }
    function applicationKey(value) {
        const binary = root.atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4));
        const key = Uint8Array.from(binary, character => character.charCodeAt(0));
        if (key.length !== 65 || key[0] !== 4) throw new Error('invalid_public_key');
        return key;
    }
    async function toggle() {
        const snapshot = owner();
        if (!snapshot || busy || button.disabled) return;
        const requestGeneration = ++generation;
        const turningOff = subscribed;
        busy = true;
        render(turningOff ? 'กำลังปิดแจ้งเตือน…' : 'กำลังเปิดแจ้งเตือน…');
        // Start the browser permission request in this click, before any await.
        let permission;
        try {
            permission = turningOff ? null : root.Notification.permission === 'default'
                ? root.Notification.requestPermission() : Promise.resolve(root.Notification.permission);
            if (!turningOff && await permission !== 'granted') {
                if (current(snapshot, requestGeneration)) render(readyMessage());
                return;
            }
            if (!current(snapshot, requestGeneration)) return;
            if (!registration?.active) throw new Error('worker_unavailable');
            let device = await registration.pushManager.getSubscription();
            if (!current(snapshot, requestGeneration)) return;
            if (turningOff) {
                if (device) {
                    const result = await request('unsubscribe', snapshot, {endpoint:device.endpoint});
                    if (!current(snapshot, requestGeneration)) return;
                    if (result.subscribed !== false) throw new Error('subscription_not_disabled');
                    subscribed = false;
                    if (!await device.unsubscribe()) throw new Error('browser_unsubscribe_failed');
                    if (!current(snapshot, requestGeneration)) return;
                }
                subscribed = false;
                render('ปิดแจ้งเตือนบนอุปกรณ์นี้แล้ว');
                return;
            }
            // An endpoint bound to an older account/session must never be reassigned.
            if (device) {
                if (!await device.unsubscribe()) throw new Error('browser_unsubscribe_failed');
                if (!current(snapshot, requestGeneration)) return;
            }
            device = await registration.pushManager.subscribe({userVisibleOnly:true, applicationServerKey:applicationKey(publicKey)});
            if (!current(snapshot, requestGeneration)) return;
            const result = await request('subscribe', snapshot, {subscription:device.toJSON()});
            if (!current(snapshot, requestGeneration)) return;
            if (result.subscribed !== true) throw new Error('subscription_not_saved');
            subscribed = true;
            render(readyMessage());
        } catch (error) {
            if (current(snapshot, requestGeneration)) failure(error);
        } finally {
            if (current(snapshot, requestGeneration)) {
                busy = false; render();
                if (pendingReceiving) sync(true);
            }
        }
    }
    function reset() {
        generation += 1; ownerKey = ''; busy = false; subscribed = false; configured = false; publicKey = '';
        registration = null;
        if (section) section.hidden = true;
    }
    function init(options) {
        if (host) return;
        host = options;
        section = document.getElementById('main-gr-push');
        button = document.getElementById('main-gr-push-toggle');
        status = document.getElementById('main-gr-push-status');
        if (!section || !button || !status) { host = null; return; }
        button.addEventListener('click', toggle);
        root.addEventListener('focus', () => sync(true));
        root.navigator.serviceWorker?.addEventListener('message', event => {
            const message = event.data;
            let source;
            try { source = new URL(event.source?.scriptURL); } catch (_) { return; }
            if (source.origin !== root.location.origin || source.pathname !== new URL('main-push-sw.js', root.location.href).pathname
                || message?.channel !== 'akra-gr-push' || message.version !== 1 || message.type !== 'open-receiving') return;
            pendingReceiving = true;
            sync(true);
        });
        sync();
    }
    root.AkraPush = {init, sync, reset, getWorkState:() => ({busy})};
}(window));
