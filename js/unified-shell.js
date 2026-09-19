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

    const EMBEDDED_HEADER_RULES = Object.freeze([
        { header: '#trd-topbar', action: '.trd-topbar__actions' },
        { header: '.gr-topbar', action: ':scope > div > div > .space-x-2' },
        { header: '#app-content > nav', action: ':scope > div > div > div:last-child' },
        { header: '.returnitem-topbar', action: '.returnitem-topbar__actions' },
        { header: '.app-header', action: ':scope > div > div:last-child' },
        { header: '#app-shell > header', action: ':scope > div > div > div:last-child' },
        { header: '.w5-topbar', action: ':scope > .w5-topbar-inner', createActionGroup: true },
        { header: '.topbar', action: '.topbar-actions' },
        { header: '.top-nav', action: '.nav-controls' }
    ]);

    function childHeaderDocument(frame) {
        try {
            if (frame.contentDocument?.location?.origin !== window.location.origin) return null;
            return frame.contentDocument;
        } catch (_) { return null; }
    }

    function embeddedHeader(doc) {
        for (const rule of EMBEDDED_HEADER_RULES) {
            const element = doc.querySelector(rule.header);
            if (element) return { element, rule };
        }
        return null;
    }

    function embeddedActionHost(header, rule) {
        let host;
        try { host = header.querySelector(rule.action); } catch (_) { return null; }
        if (!host || !rule.createActionGroup) return host || null;
        let actionGroup = host.querySelector('[data-akra-shell-action-group]');
        if (!actionGroup) {
            actionGroup = host.ownerDocument.createElement('div');
            actionGroup.className = 'akra-shell-injected-actions';
            actionGroup.dataset.akraShellActionGroup = 'true';
            host.append(actionGroup);
        }
        return actionGroup;
    }

    function actionSignature(element) {
        return [element.id, element.className, element.getAttribute('title'), element.getAttribute('aria-label'), element.getAttribute('onclick'), element.textContent]
            .filter(Boolean).join(' ').toLowerCase();
    }

    function existingEmbeddedAction(header, type) {
        return [...header.querySelectorAll('button, a')].find(element => {
            if (element.dataset.akraShellAction) return element.dataset.akraShellAction === type;
            const signature = actionSignature(element);
            if (type === 'home') return element.matches('[data-auth-main], .trd-topbar__action--portal')
                || /akramodule\.home|gotoportal|gotomain|returntomain|portal/.test(signature.replace(/\s+/g, ''));
            if (type === 'refresh') return /refresh|รีเฟรช|loadinitialdata|fetchdata/.test(signature);
            return element.id === 'logout-btn' || /logout|ออกจากระบบ|ออก$/.test(signature);
        }) || null;
    }

    function installEmbeddedHeaderStyle(doc) {
        if (doc.getElementById('akra-shell-embedded-style')) return;
        const style = doc.createElement('style');
        style.id = 'akra-shell-embedded-style';
        style.textContent = `
            .akra-shell-injected-actions {
                align-items: center !important;
                display: inline-flex !important;
                flex: 0 0 auto !important;
                gap: 6px !important;
            }
            .akra-shell-injected-action {
                align-items: center !important;
                background: transparent !important;
                border: 1px solid currentColor !important;
                border-radius: 9px !important;
                color: inherit !important;
                cursor: pointer !important;
                display: inline-flex !important;
                font: inherit !important;
                gap: 6px !important;
                justify-content: center !important;
                min-height: 36px !important;
                padding: 0 10px !important;
                white-space: nowrap !important;
            }
            .akra-shell-injected-action:hover { opacity: .82; }
            .akra-shell-injected-action:focus-visible { outline: 3px solid rgba(59,130,246,.42); outline-offset: 2px; }
            .akra-shell-injected-action svg { fill: none; height: 17px; stroke: currentColor; stroke-linecap: round; stroke-linejoin: round; stroke-width: 1.8; width: 17px; }
            @media (max-width: 640px) {
                .akra-shell-injected-actions { gap: 4px !important; }
                .w5-topbar .w5-operator { display: none !important; }
                .akra-shell-injected-action { height: 40px !important; min-height: 40px !important; padding: 0 !important; width: 40px !important; }
                .akra-shell-injected-action span { display: none !important; }
            }
        `;
        (doc.head || doc.documentElement).appendChild(style);
    }

    function injectedAction(doc, type, label, icon, handler) {
        const button = doc.createElement('button');
        button.type = 'button';
        button.className = 'akra-shell-injected-action';
        button.dataset.akraShellAction = type;
        button.title = label;
        button.setAttribute('aria-label', label);
        button.innerHTML = `<svg aria-hidden="true" viewBox="0 0 24 24" focusable="false">${icon}</svg><span>${label}</span>`;
        button.addEventListener('click', handler);
        return button;
    }

    function ensureEmbeddedAction(header, rule, type, label, icon, handler) {
        if (existingEmbeddedAction(header, type)) return true;
        const actionHost = embeddedActionHost(header, rule);
        if (!actionHost) return false;
        const button = injectedAction(header.ownerDocument, type, label, icon, handler);
        if (type === 'home') actionHost.prepend(button);
        else actionHost.append(button);
        return true;
    }

    function adaptEmbeddedHeader(frame) {
        if (!active || active.frame !== frame) return false;
        const doc = childHeaderDocument(frame);
        if (!doc) return false;
        const match = embeddedHeader(doc);
        if (!match) return false;
        const { element: header, rule } = match;
        installEmbeddedHeaderStyle(doc);
        const ready = ensureEmbeddedAction(header, rule, 'home', 'กลับหน้าหลัก', '<path d="m3 10 9-7 9 7"/><path d="M5 9.5V21h14V9.5"/><path d="M9 21v-7h6v7"/>', () => home())
            && ensureEmbeddedAction(header, rule, 'refresh', 'รีเฟรช', '<path d="M20 11a8 8 0 0 0-14.8-4L3 9"/><path d="M3 4v5h5"/><path d="M4 13a8 8 0 0 0 14.8 4L21 15"/><path d="M21 20v-5h-5"/>', () => open(active.id, {reload:true}))
            && ensureEmbeddedAction(header, rule, 'logout', 'ออกจากระบบ', '<path d="M10 4H5v16h5"/><path d="m14 8 4 4-4 4"/><path d="M18 12H9"/>', () => { if (confirmLeave()) host.logout(); });
        if (ready) {
            active.compactHeader = true;
            panel.classList.add('shell-child-header');
        }
        return ready;
    }

    function watchEmbeddedHeader(frame) {
        const doc = childHeaderDocument(frame);
        if (!doc || !active || active.frame !== frame) return;
        adaptEmbeddedHeader(frame);
        if (active.headerObserver) return;
        active.headerObserver = new MutationObserver(() => adaptEmbeddedHeader(frame));
        active.headerObserver.observe(doc.documentElement, { childList:true, subtree:true });
    }

    function init(options) {
        if (host) return;
        host = options;
        panel = document.getElementById('unified-shell');
        selector = document.getElementById('shell-module-select');
        status = document.getElementById('shell-status');
        frameHost = document.getElementById('shell-frame-host');
        selector.addEventListener('change', () => { if (!open(selector.value)) selector.value = active?.id || ''; });
        document.getElementById('shell-home').addEventListener('click', home);
        document.getElementById('shell-refresh').addEventListener('click', () => { if (active) open(active.id, {reload:true}); });
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
        active?.headerObserver?.disconnect();
        try { active?.frame.contentWindow.AkraModule?.prepareLeave?.(); } catch (_) {}
        frameHost?.replaceChildren();
        active = null;
        panel?.classList.remove('shell-child-header');
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
        panel.classList.remove('shell-child-header');
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
        document.getElementById('shell-app-title').textContent = active ? host.label(state.appConfig.find(app => app.id === active.id) || {id:active.id}) : 'กำลังเปิดแอป';
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
        active = {id, frame, url, epoch:state.sessionEpoch, user:state.currentUserId, dirty:false, busy:false, ready:false, compactHeader:false, headerObserver:null};
        const loadSequence = sequence;
        setVisible(true);
        status.hidden = false;
        status.textContent = 'กำลังเปิด ' + host.label(app) + '…';
        document.getElementById('shell-retry').hidden = true;
        populate();
        setRoute(id,!!options.replace);
        frame.addEventListener('load', () => watchEmbeddedHeader(frame), { once:true });
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
