(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.AkraUserPermissions = api;
}(typeof window === 'undefined' ? {} : window, function () {
    'use strict';
    const aliases = { 'app-po': 'app-tracking', 'app-akra': 'app-w5', 'app-ret': 'app-damage' };
    const key = item => JSON.stringify([item.appId, item.permKey]);
    const normalized = items => [...new Set((items || []).map(key))].sort().join('|');
    function rowsFor(snapshot) {
        const user = snapshot.user;
        const explicit = new Set(user.explicitPermissions.map(key));
        const definitions = new Map(snapshot.permRows.map(row => [key(row), row]));
        const rows = [...definitions.values()];
        for (const grant of user.explicitPermissions) if (!definitions.has(key(grant))) rows.push(grant);
        return rows.map(row => {
            const app = snapshot.apps.find(app => app.id === (aliases[row.appId] || row.appId));
            const available = !!app && app.isActive !== false && app.roles.some(role => user.roles.includes(role));
            return { appId: row.appId, permKey: row.permKey, appName: app?.name || row.appId,
                available, inactive: app?.isActive === false, defined: definitions.has(key(row)),
                inherited: user.roles.some(role => row[role] === true), explicit: explicit.has(key(row)) };
        });
    }
    function create(options) {
        const { root, status, button, document: doc } = options;
        let snapshot = null, draft = [], busy = false, uncertain = false;
        const dirty = () => !!snapshot && normalized(draft) !== normalized(snapshot.user.explicitPermissions);
        const ready = () => !!snapshot?.ready && !!snapshot.user?.identityId && Number.isInteger(snapshot.user.sessionVersion) &&
            snapshot.user.sessionVersion > 0 && !!snapshot.revision && options.isCurrent(snapshot) && options.canEdit() && !options.hasRoleDraft();
        const element = (tag, text, className) => {
            const node = doc.createElement(tag); if (text !== undefined) node.textContent = text;
            if (className) node.className = className; return node;
        };
        function render(message) {
            const focusedKey = doc.activeElement?.getAttribute?.('data-permission-key');
            let restoreFocus;
            root.replaceChildren();
            button.disabled = busy || uncertain || !ready() || !dirty();
            button.textContent = busy ? 'กำลังบันทึกสิทธิ์...' : 'บันทึกสิทธิ์เฉพาะบุคคล';
            status.textContent = message || (!snapshot ? 'เลือกพนักงานที่บันทึกแล้วเพื่อดูสิทธิ์ย่อย' : !ready()
                ? 'ต้องโหลดสิทธิ์ล่าสุด และบันทึกหรือยกเลิกร่างข้อมูลผู้ใช้/สิทธิ์บทบาทก่อนแก้ไขส่วนนี้'
                : uncertain ? 'ต้องกดรีเฟรชเพื่อตรวจสอบผลก่อนแก้ไขต่อ'
                : dirty() ? 'มีสิทธิ์เฉพาะบุคคลที่ยังไม่ได้บันทึก' : 'แสดงบทบาทที่บันทึกแล้ว สิทธิ์ย่อยยังต้องผ่านเงื่อนไขของแต่ละแอป');
            if (!snapshot?.user || !Array.isArray(snapshot.user.explicitPermissions)) return;
            let lastGroup = '';
            for (const row of rowsFor(snapshot)) {
                const group = aliases[row.appId] || row.appId;
                if (group !== lastGroup) { root.append(element('h4', row.appName, 'font-semibold text-slate-800 mt-5 mb-2')); lastGroup = group; }
                const description = options.describe(row.appId, row.permKey);
                const label = element('label', undefined, 'flex items-start gap-3 py-3 border-b border-slate-100');
                const input = element('input'); input.type = 'checkbox'; input.className = 'mt-1 w-5 h-5 shrink-0 accent-blue-800';
                input.checked = draft.some(item => key(item) === key(row));
                input.disabled = busy || uncertain || !ready() || (!row.explicit && (!row.defined || !row.available));
                input.setAttribute('aria-label', `เพิ่มเฉพาะบุคคล: ${snapshot.username} ${row.appName} ${row.permKey}`);
                input.setAttribute('data-permission-key', key(row));
                if (focusedKey === key(row)) restoreFocus = input;
                input.addEventListener('change', () => toggle(row, input.checked));
                const copy = element('span', undefined, 'min-w-0 flex-1 break-words text-sm');
                copy.append(element('span', description.label, 'block font-medium text-slate-800'));
                copy.append(element('span', `${row.appId}:${row.permKey}`, 'block text-slate-500'));
                copy.append(element('span', row.inherited ? 'ได้รับจากบทบาทอยู่แล้ว — เอาสิทธิ์เพิ่มออกยังใช้งานได้ตามบทบาท' : 'ไม่ได้รับสิทธิ์นี้จากบทบาท', 'block text-slate-600 mt-1'));
                if (!row.available) copy.append(element('span', row.inactive ? 'แอปปิดใช้งาน — สิทธิ์ที่เก็บไว้ยังไม่เปิดให้เข้าแอป' : 'บทบาทยังไม่มีสิทธิ์เข้าแอป — เพิ่มสิทธิ์ใหม่ไม่ได้', 'block text-slate-600'));
                if (!row.defined) copy.append(element('span', 'รายการเดิมไม่อยู่ในชุดสิทธิ์ปัจจุบัน เก็บไว้ได้หรือเอาออกโดยตั้งใจ', 'block text-slate-600'));
                if (description.detail) copy.append(element('span', description.detail, 'block text-slate-600 mt-1'));
                label.append(input, copy); root.append(label);
            }
            if (!root.children.length) root.append(element('p', 'ยังไม่มีรายการสิทธิ์ย่อยสำหรับผู้ใช้นี้', 'text-sm text-slate-600'));
            restoreFocus?.focus();
        }
        function load(next, force = false) {
            if (!force && !confirmLeave()) return false;
            snapshot = next ? JSON.parse(JSON.stringify(next)) : null;
            draft = snapshot?.user?.explicitPermissions?.map(item => ({ ...item })) || [];
            uncertain = false; options.onDirty(false); render(); return true;
        }
        function toggle(row, checked) {
            const current = snapshot && rowsFor(snapshot).find(item => key(item) === key(row));
            if (busy || uncertain || !ready() || !current || (!current.explicit && (!current.defined || !current.available))) return;
            draft = draft.filter(item => key(item) !== key(row));
            if (checked) draft.push({ appId: row.appId, permKey: row.permKey });
            options.onDirty(dirty()); render();
        }
        async function save() {
            if (busy || uncertain || !ready() || !dirty()) return false;
            const captured = snapshot;
            const permissions = draft.map(item => ({ ...item }));
            busy = true; options.onBusy(true); render();
            let committed = false;
            try {
                const result = await options.send({ action: 'saveUserPermissions', id: captured.username, userId: captured.user.identityId,
                    sessionVersion: captured.user.sessionVersion, authorizationRevision: captured.revision, permissions });
                if (!options.isCurrent(captured)) return false;
                if (result?.status !== 'success' || !result.authorizationRevision) throw new Error('unconfirmed_permission_save');
                committed = true;
                snapshot.user.explicitPermissions = permissions; draft = permissions.map(item => ({ ...item })); options.onDirty(false);
                if (!await options.reload()) throw new Error('permission_reload_failed');
                if (!options.isCurrent(captured)) return false;
                render('บันทึกสิทธิ์เฉพาะบุคคลแล้ว และตรวจสอบข้อมูลล่าสุดเรียบร้อย'); return true;
            } catch (_) {
                if (!options.isCurrent(captured)) return false;
                uncertain = true;
                render(committed ? 'บันทึกแล้ว แต่โหลดสิทธิ์ล่าสุดไม่สำเร็จ กรุณากดรีเฟรชก่อนทำต่อ'
                    : 'ยังยืนยันผลบันทึกไม่ได้ กรุณากดรีเฟรชเพื่อตรวจสอบก่อนทำต่อ');
                return false;
            } finally {
                busy = false;
                if (options.isCurrent(captured)) { options.onBusy(false); render(status.textContent); }
            }
        }
        function confirmLeave() {
            if (busy) { options.notify('กำลังบันทึกสิทธิ์ กรุณารอผลก่อนออกจากหน้านี้'); return false; }
            if ((dirty() || uncertain) && !options.confirm('สิทธิ์เฉพาะบุคคลยังไม่ได้บันทึกหรือยังยืนยันผลไม่ได้ ต้องการออกและโหลดข้อมูลใหม่ภายหลังหรือไม่?')) return false;
            return true;
        }
        function reset() { snapshot = null; draft = []; busy = false; uncertain = false; options.onDirty(false); options.onBusy(false); render(); }
        button.addEventListener('click', save);
        render();
        return { load, toggle, save, render, reset, confirmLeave, pending: () => busy || dirty() || uncertain, isBusy: () => busy };
    }
    return { rowsFor, create };
}));
