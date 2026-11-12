/* User interaction renews a valid lease; idle timers and polling never do. */
(function () {
    const HOUR = 60 * 60 * 1000, RETRY_MS = 30000, ACTIVE_MS = 60000;
    const EVENTS = ['pointerdown', 'keydown', 'input', 'wheel'];
    function remaining(token) {
        try {
            const exp = JSON.parse(atob(String(token).split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).exp;
            if (typeof exp !== 'number' || !Number.isFinite(exp)) return 0;
            return (exp < 1000000000000 ? exp * 1000 : exp) - Date.now();
        } catch (_) { return 0; }
    }
    function watch({getToken, renew, isBusy = () => false, onDenied}) {
        let stopped = false, pending = false, timer, activeUntil = 0, lastAttempt = -Infinity;
        function stop() {
            stopped = true; clearTimeout(timer);
            for (const name of EVENTS) document.removeEventListener(name, activity, true);
        }
        async function check() {
            clearTimeout(timer);
            if (stopped || pending || document.hidden || Date.now() > activeUntil) return;
            let ttl;
            try { ttl = remaining(getToken()); } catch (_) { return; }
            // Renew at most hourly, with a short backoff after a failed attempt.
            if (ttl <= 0 || ttl > 71 * HOUR || Date.now() - lastAttempt < RETRY_MS) return;
            if (isBusy()) { timer = setTimeout(check, 250); return; }
            pending = true; lastAttempt = Date.now();
            try { await renew(); }
            catch (error) {
                if (!stopped && (error?.code === 'invalid_or_expired_token' || error?.status === 401)) onDenied?.(error);
                // A transport failure does not revoke the valid local session.
                // Only another real interaction may start a later attempt.
            } finally { pending = false; }
        }
        function activity(event) {
            if (stopped || event?.isTrusted !== true || document.hidden) return;
            activeUntil = Date.now() + ACTIVE_MS;
            void check();
        }
        for (const name of EVENTS) document.addEventListener(name, activity, {capture:true, passive:true});
        return {activity, stop};
    }
    window.AkraSessionRenewal = Object.freeze({watch});
}());
