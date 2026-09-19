/* Main-owned protocol v1. Child documents keep their own runtime and backend checks. */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.AkraShell = api;
}(typeof window === 'undefined' ? {} : window, function () {
    'use strict';
    const MODULE_PATHS = Object.freeze({
        'app-w5': '/AKRA/', 'app-trd': '/TRDAKRA/', 'app-gr': '/GR/',
        'app-pr': '/PR/', 'app-pick': '/Picking/', 'app-tracking': '/TrackingPO/',
        'app-damage': '/Returnitem/', 'app-kpi': '/KPITRACKER/', 'app-manual': '/SOP/',
        // Reserved candidate path; live enablement requires an actual hosted target.
        'app-evaluation': '/Evaluation/'
    });
    function moduleUrl(app, origin) {
        try {
            const url = new URL(app.url);
            if (url.origin !== origin || url.pathname !== MODULE_PATHS[app.id] || url.search || url.hash || url.username || url.password) return '';
            if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost','127.0.0.1'].includes(url.hostname))) return '';
            url.searchParams.set('shell', '1');
            return url.href;
        } catch (_) { return ''; }
    }
    function routeId(hash) {
        if (!hash || hash === '#/' || hash === '#') return '';
        const match = /^#\/app\/(app-[a-z0-9-]+)$/.exec(hash);
        return match ? match[1] : null;
    }
    function canLaunch(id, state) {
        if (!state.sessionToken || state.sessionRefreshPending || state.sessionRefreshFailed || state.mustChangePassword) return false;
        return (state.appConfig || []).some(app => app.id === id && Array.isArray(app.roles) && app.roles.some(role => (state.currentRoles || []).includes(role)));
    }
    function acceptsMessage(event, source, origin) {
        return event.source === source && event.origin === origin && event.data?.channel === 'akra-shell' && event.data.version === 1;
    }
    let host, panel, selector, status, frameHost, active = null, sequence = 0, readyTimer;
    let currentHash = '', suspended = false;
    const api = { moduleUrl, routeId, canLaunch, acceptsMessage, init, open, home, reset, sync, tokenFor, confirmLeave };

    function init(options) {
        if (host) return;
        host = options;
        panel = document.getElementById('unified-shell');
        selector = document.getElementById('shell-module-select');
        status = document.getElementById('shell-status');
        frameHost = document.getElementById('shell-frame-host');
        selector.addEventListener('change', () => { if (!open(selector.value)) selector.value = active?.id || ''; });
        document.getElementById('shell-home').addEventListener('click', home);
        document.getElementById('shell-retry').addEventListener('click', () => { if (active) open(active.id, {reload:true}); });
        document.getElementById('shell-logout').addEventListener('click', () => { if (confirmLeave()) host.logout(); });
        document.getElementById('shell-admin').addEventListener('click', () => { if (home()) host.admin(); });
        window.addEventListener('message', onMessage);
        window.addEventListener('hashchange', onRoute);
        window.addEventListener('popstate', onRoute);
        window.addEventListener('beforeunload', event => {
            if (hasPendingWork()) { event.preventDefault(); event.returnValue = ''; }
        });
        window.addEventListener('storage', event => {
            if (window.AkraModule?.watchSession) return; // Verified shared-session channel owns current Main tabs.
            // A peer owns the newly stored identity; clear only this tab's old state.
            if ((event.key === 'akra_session_token' || event.key === null) && event.newValue !== host.state().sessionToken) {
                host.logout({ preserveStoredSession: true });
            }
        });
        window.addEventListener('focus', sync);
        sync();
    }
    function hasPendingWork() {
        if (!active) return false;
        try { return !!active.frame.contentWindow.AkraModule?.hasPendingWork(); }
        catch (_) { return active.dirty || active.busy; }
    }
    function confirmLeave() {
        let busy = active?.busy;
        try { busy = active?.frame.contentWindow.AkraModule?.getWorkState?.().busy || busy; } catch (_) {}
        if (busy) { host.notify('กำลังบันทึกรายการ กรุณารอผลก่อนเปลี่ยนแอปหรือออกจากระบบ'); return false; }
        return !hasPendingWork() || window.confirm('มีข้อมูลที่แก้ไขหรือรายการที่อาจยังไม่บันทึก ต้องการออกจากหน้านี้หรือไม่?');
    }
    function setVisible(visible) {
        panel.hidden = !visible;
        document.body.classList[visible ? 'add' : 'remove']('shell-active');
        if (visible) document.getElementById('shell-home').focus();
        for (const id of ['dashboard-section','login-section','admin-section']) {
            const section = document.getElementById(id);
            if (!section) continue;
            section.inert = visible;
            if (visible) section.setAttribute('aria-hidden','true');
            else section.removeAttribute('aria-hidden');
        }
    }
    function setRoute(id, replace = false) {
        const next = id ? '#/app/' + id : '#/';
        currentHash = next;
        if (window.location.hash === next) return;
        window.history[replace ? 'replaceState' : 'pushState'](null, '', window.location.pathname + window.location.search + next);
    }
    function removeFrame() {
        sequence += 1;
        clearTimeout(readyTimer);
        // The parent already confirmed navigation, or revoked this session.
        try { active?.frame.contentWindow.AkraModule?.prepareLeave?.(); } catch (_) {}
        frameHost?.replaceChildren();
        active = null;
    }
    function reset() {
        if (!host) return;
        removeFrame();
        setVisible(false);
        suspended = false;
        // Logout deliberately removes the old user's route and module document.
        setRoute('', true);
    }
    function home(options = {}) {
        if (!host || (!options.confirmed && !confirmLeave())) return false;
        removeFrame();
        setVisible(false);
        suspended = false;
        setRoute('', options.replace === true);
        host.home();
        document.getElementById('app-grid')?.querySelector('button')?.focus();
        return true;
    }
    function showError(message) {
        status.textContent = message;
        status.hidden = false;
        document.getElementById('shell-retry').hidden = !active;
        if (active) active.frame.hidden = true;
    }
    function populate() {
        const state = host.state();
        selector.replaceChildren();
        for (const app of state.appConfig || []) {
            if (!canLaunch(app.id,state) || !moduleUrl(app,window.location.origin)) continue;
            const option = document.createElement('option');
            option.value = app.id;
            option.textContent = host.label(app);
            selector.appendChild(option);
        }
        selector.value = active?.id || '';
        document.getElementById('shell-user').textContent = state.currentUser || '';
        document.getElementById('shell-admin').hidden = !(state.currentRoles || []).includes('ADMIN');
    }
    function open(id, options = {}) {
        if (!host) return false;
        const state = host.state();
        if (!canLaunch(id,state)) { host.notify('ไม่มีสิทธิ์เข้าแอปนี้ หรือยังตรวจสอบเซสชันไม่สำเร็จ'); return false; }
        const app = state.appConfig.find(item => item.id === id);
        const url = moduleUrl(app,window.location.origin);
        if (!url) { host.notify('แอปนี้ยังไม่ได้ตั้งค่าเส้นทางที่รองรับ กรุณาติดต่อผู้ดูแล'); return false; }
        if (active?.id === id && !options.reload) return true;
        if (!options.force && !confirmLeave()) return false;
        removeFrame();
        suspended = false;
        const frame = document.createElement('iframe');
        frame.id = 'shell-module-frame';
        frame.title = host.label(app);
        frame.referrerPolicy = 'no-referrer';
        // This is a trusted same-origin document adapter, not a security sandbox.
        // Each API must verify the current signed session and action permission.
        frame.hidden = true;
        active = {id, frame, url, epoch:state.sessionEpoch, user:state.currentUserId, dirty:false, busy:false, ready:false};
        const loadSequence = sequence;
        setVisible(true);
        status.hidden = false;
        status.textContent = 'กำลังเปิด ' + host.label(app) + '…';
        document.getElementById('shell-retry').hidden = true;
        populate();
        setRoute(id,!!options.replace);
        frame.src = url;
        frameHost.appendChild(frame);
        readyTimer = setTimeout(() => {
            if (active && sequence === loadSequence) showError('เปิดแอปไม่สำเร็จ กรุณาลองใหม่ หรือกลับหน้าหลัก');
        },20000);
        return true;
    }
    function tokenFor(source) {
        if (!active || source !== active.frame.contentWindow || suspended) return '';
        const state = host.state();
        if (active.epoch !== state.sessionEpoch || active.user !== state.currentUserId || !canLaunch(active.id,state)) return '';
        try {
            if (source.location.origin !== window.location.origin || source.location.pathname !== new URL(active.url).pathname) return '';
        } catch (_) { return ''; }
        return state.sessionToken;
    }
    function onMessage(event) {
        if (!active || !acceptsMessage(event,active.frame.contentWindow,window.location.origin)) return;
        const message = event.data;
        if (message.type === 'home') { home(); return; }
        if (message.type === 'logout') { if (confirmLeave()) host.logout(); return; }
        if (message.type === 'ready') active.ready = true;
        if (host.state().sessionRefreshPending) return;
        if (!tokenFor(event.source)) { suspended = true; showError('เซสชันหรือสิทธิ์ถูกเปลี่ยน กรุณากลับหน้าหลักเพื่อตรวจสอบอีกครั้ง'); return; }
        if (message.type === 'ready') {
            clearTimeout(readyTimer);
            active.frame.hidden = false;
            status.hidden = true;
            document.getElementById('shell-retry').hidden = true;
        } else if (message.type === 'state') {
            active.dirty = message.dirty === true;
            active.busy = message.busy === true;
        } else if (message.type === 'auth-required') {
            suspended = true;
            showError('เซสชันหมดอายุหรือไม่มีสิทธิ์ กรุณากลับหน้าหลักเพื่อเข้าสู่ระบบใหม่');
        }
    }
    function onRoute() {
        if (!host) return;
        const id = routeId(window.location.hash);
        if (id === null) { host.notify('ไม่พบหน้าแอปที่ระบุ'); setRoute(active?.id || '',true); return; }
        if (!host.state().sessionToken || host.state().sessionRefreshPending) return;
        if (id === (active?.id || '')) { currentHash = window.location.hash; return; }
        if (!confirmLeave()) {
            window.history.replaceState(null,'',window.location.pathname + window.location.search + currentHash);
            return;
        }
        if (!id) { home({confirmed:true,replace:true}); return; }
        if (!open(id,{replace:true,force:true})) setRoute(active?.id || '',true);
    }
    function sync() {
        if (!host) return;
        const state = host.state();
        populate();
        if (active && state.sessionRefreshPending && active.epoch === state.sessionEpoch && active.user === state.currentUserId) {
            // A refresh is not a revocation: keep drafts, temporarily stop interaction.
            active.frame.inert = true;
            status.hidden = false;
            status.textContent = 'กำลังตรวจสอบเซสชันและสิทธิ์…';
            return;
        }
        if (active && (!canLaunch(active.id,state) || active.epoch !== state.sessionEpoch || active.user !== state.currentUserId)) {
            // Revocation/user change is not a cancellable leave: remove sensitive document.
            removeFrame();
            suspended = true;
            showError('สิทธิ์หรือเซสชันเปลี่ยนแล้ว กรุณากลับหน้าหลัก');
        }
        if (active && !suspended) {
            active.frame.inert = false;
            if (active.ready) { clearTimeout(readyTimer); active.frame.hidden = false; status.hidden = true; }
        }
        if (!active && !suspended && state.sessionToken && !state.sessionRefreshPending && !state.sessionRefreshFailed && !state.mustChangePassword) onRoute();
    }
    return api;
}));
