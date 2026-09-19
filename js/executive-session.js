/* Executive is a Main subpage, not a separate app or a reporting API. */
(function () {
    'use strict';
    const bridge = window.AkraModule;
    const content = document.getElementById('executive-content');
    const status = document.getElementById('executive-access-status');
    const button = document.getElementById('executive-recheck');
    let generation = 0;

    function eligible(user) {
        return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(user?.identityId || '')
            && Number.isSafeInteger(user.sessionVersion) && user.sessionVersion > 0
            && typeof user.authorizationRevision === 'string' && !!user.authorizationRevision
            && !user.mustChangePassword && Array.isArray(user.roles)
            && user.roles.some(role => role === 'ADMIN' || role === 'SUPERVISOR');
    }

    function retire() {
        ++generation;
        bridge?.stopWatchingSession();
        content.hidden = true;
        button.disabled = false;
        status.textContent = 'เซสชันหรือสิทธิ์เปลี่ยนแล้ว กรุณากลับ Main เพื่อเข้าสู่ระบบอีกครั้ง';
    }

    async function checkAccess() {
        const current = ++generation;
        bridge?.stopWatchingSession();
        content.hidden = true;
        button.disabled = true;
        status.textContent = 'กำลังตรวจสอบสิทธิ์จาก Main…';
        try {
            let token;
            try { token = window.localStorage.getItem('akra_session_token'); } catch (_) { /* Fail closed. */ }
            if (!token || !bridge || bridge.isMainSignedOut()) throw new Error('no_token');
            const user = await bridge.verifySession('', token);
            if (current !== generation) return;
            if (!eligible(user)) throw new Error('executive_forbidden');
            bridge.watchSession({appId:'',user,token,invalidated:retire,refreshed:(_token,nextUser) => {
                if (!eligible(nextUser)) retire();
            }});
            if (current !== generation) return;
            content.hidden = false;
            status.textContent = 'ยืนยันสิทธิ์แล้ว — หน้านี้ยังไม่เชื่อมต่อข้อมูลสรุปจริง โปรดดูข้อมูลล่าสุดในแอปต้นทางผ่าน Main';
        } catch (error) {
            if (current !== generation) return;
            status.textContent = error.message === 'no_token'
                ? 'กรุณาเข้าสู่ระบบผ่าน Main ก่อนเปิดหน้านี้'
                : error.message === 'executive_forbidden'
                    ? 'บัญชีนี้ไม่มีสิทธิ์เข้า Executive หรือยังต้องเปลี่ยนรหัสผ่าน กรุณากลับ Main'
                    : 'ตรวจสอบสิทธิ์ไม่สำเร็จ กรุณาลองอีกครั้ง หรือกลับ Main เพื่อเข้าสู่ระบบ';
        } finally {
            if (current === generation) button.disabled = false;
        }
    }

    button.addEventListener('click', checkAccess);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) return checkAccess(); });
    window.addEventListener('pageshow', event => { if (event.persisted) return checkAccess(); });
    void checkAccess();
}());
