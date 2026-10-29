/* UX retirement only. Decoded expiry never grants authentication or permissions. */
(function () {
    const WARNING_MS = 5 * 60 * 1000;
    function expiresAt(token) {
        try {
            const parts = String(token || '').split('.');
            if (parts.length !== 3) return 0;
            const raw = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'))).exp;
            if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return 0;
            return raw < 1000000000000 ? raw * 1000 : raw;
        } catch (_) { return 0; }
    }
    function isExpired(token) { return expiresAt(token) <= Date.now(); }
    function watch({getToken, onExpire, onWarning, isBusy = () => false}) {
        let timer, stopped = false, warnedToken = null;
        function stop() {
            stopped = true;
            clearTimeout(timer);
            window.removeEventListener('focus', resume);
            window.removeEventListener('pageshow', resume);
            document.removeEventListener('visibilitychange', resume);
        }
        function check() {
            if (stopped) return false;
            clearTimeout(timer);
            const token = getToken(), remaining = expiresAt(token) - Date.now();
            if (remaining <= 0) {
                // Keep the pending response alive. Never retry a mutation here.
                if (isBusy()) timer = setTimeout(check, 250);
                else { stop(); onExpire(); }
                return false;
            }
            if (remaining <= WARNING_MS && warnedToken !== token) {
                warnedToken = token;
                onWarning?.();
            }
            timer = setTimeout(check, Math.min(15000, remaining, remaining > WARNING_MS ? remaining - WARNING_MS : 15000));
            return true;
        }
        function resume() { if (!document.hidden) check(); }
        window.addEventListener('focus', resume);
        window.addEventListener('pageshow', resume);
        document.addEventListener('visibilitychange', resume);
        check();
        return {check, stop};
    }
    window.AkraSessionExpiry = Object.freeze({isExpired, watch});
}());
