/* In-page dialogs. Awaited decisions belong to the page/session that opened them. */
(function(window) {
    'use strict';
    let active = null;
    const alerts = [];
    const operations = new Set();
    const snapshot = () => window.getBmDialogContext?.() || [window.AkraModule?.getToken?.(), window.AkraModule?.sessionStamp?.()];
    const current = before => { const after = snapshot(); return before.length === after.length && before.every((value, index) => value === after[index]); };
    function ask(message, options = {}) {
        if (active) {
            if (!options.alert) return Promise.resolve(false);
            const owner = snapshot();
            return new Promise(resolve => alerts.push({message, options, owner, resolve}));
        }
        const owner = snapshot(), previous = document.activeElement;
        return new Promise(resolve => {
            const dialog = document.createElement('dialog');
            dialog.id = 'bm-ui-dialog';
            dialog.setAttribute('aria-labelledby', 'bm-ui-dialog-title');
            dialog.setAttribute('aria-describedby', 'bm-ui-dialog-message');
            dialog.setAttribute('aria-modal', 'true');
            const variant = ['danger','warning'].includes(options.variant) ? options.variant : 'default';
            const accent = variant === 'danger' ? '#be123c' : variant === 'warning' ? '#92400e' : '#2563eb';
            dialog.setAttribute('data-variant', variant);
            dialog.style.cssText = 'font:inherit;color:#0f172a;background:#fff;border:1px solid #cbd5e1;border-radius:16px;padding:24px;width:min(420px,calc(100vw - 32px));max-height:calc(100dvh - 32px);overflow:auto;box-shadow:0 16px 48px #0f172a33;';
            const title = document.createElement('h2'), text = document.createElement('p'), controls = document.createElement('div');
            title.id = 'bm-ui-dialog-title'; title.textContent = options.title || (options.alert ? 'แจ้งเตือน' : 'ยืนยันการดำเนินการ');
            title.style.cssText = 'font-size:16px;font-weight:700;margin:0 0 12px;color:' + (variant === 'default' ? '#0f172a' : accent) + ';';
            text.id = 'bm-ui-dialog-message'; text.textContent = message;
            text.style.cssText = 'font-size:14px;line-height:1.6;color:#475569;white-space:pre-line;overflow-wrap:anywhere;margin:0 0 20px;';
            controls.style.cssText = 'display:flex;justify-content:flex-end;gap:12px;';
            const buttons = [];
            function button(label, approved) {
                const el = document.createElement('button'); el.type = 'button'; el.textContent = label;
                el.style.cssText = 'font:inherit;font-size:14px;font-weight:700;min-height:44px;padding:8px 20px;border:1px solid #cbd5e1;border-radius:8px;cursor:pointer;background:' + (approved ? accent + ';color:#fff;' : '#f1f5f9;color:#334155;');
                el.addEventListener('click', () => finish(approved)); controls.appendChild(el); buttons.push(el);
            }
            const finish = (approved, restoreFocus = true) => {
                if (active?.dialog !== dialog) return;
                active = null;
                const valid = current(owner);
                dialog.close(); dialog.remove();
                if (restoreFocus && valid && previous?.isConnected) previous.focus?.({preventScroll:true});
                else if (document.activeElement === previous) previous?.blur?.();
                resolve(Boolean(approved && valid));
                while (alerts.length) {
                    const next = alerts.shift();
                    if (!current(next.owner)) { next.resolve(false); continue; }
                    ask(next.message, next.options).then(next.resolve);
                    break;
                }
            };
            if (!options.alert) button('ยกเลิก', false);
            button(options.alert ? 'ตกลง' : 'ยืนยัน', true);
            dialog.appendChild(title); dialog.appendChild(text); dialog.appendChild(controls);
            dialog.addEventListener('cancel', event => { event.preventDefault(); finish(Boolean(options.alert)); });
            dialog.addEventListener('keydown', event => {
                if (event.key === 'Escape') { event.preventDefault(); finish(Boolean(options.alert)); }
                if (event.key === 'Tab') {
                    const index = buttons.indexOf(document.activeElement);
                    const next = (index + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length;
                    event.preventDefault(); buttons[next].focus();
                }
            });
            active = {dialog, finish}; document.body.appendChild(dialog); dialog.showModal(); buttons[0].focus();
        });
    }
    async function run(key, message, operation, options) {
        if (operations.has(key)) return false;
        operations.add(key);
        const owner = snapshot();
        try {
            if (!await ask(message, options) || !current(owner)) return false;
            await operation(() => current(owner));
            return true;
        } finally { operations.delete(key); }
    }
    window.BMDialog = Object.freeze({ask, alert:(message, options) => ask(message, {...options, alert:true}), run, cancel:() => { for (const next of alerts.splice(0)) next.resolve(false); active?.finish(false, false); }});
})(window);
