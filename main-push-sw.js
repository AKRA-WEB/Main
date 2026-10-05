/* Notifications only: deliberately no fetch handler or offline asset cache. */
'use strict';
self.addEventListener('push', event => {
    let payload;
    try { payload = event.data?.json(); } catch (_) { return; }
    if (payload?.type !== 'gr_receiving' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(payload.eventId || '')) return;
    event.waitUntil(self.registration.showNotification('GR • รับเข้าสินค้า', {
        body:'มีการบันทึกรับสินค้าสำเร็จ เปิด GR เพื่อดูรายการรับสินค้าและงานรอตรวจสอบ',
        icon:'assets/icons/bm-192-v20261001-07.png',
        tag:'gr-receiving-' + payload.eventId,
        data:{type:'gr_receiving'}
    }));
});
self.addEventListener('notificationclick', event => {
    event.notification.close();
    if (event.notification.data?.type !== 'gr_receiving') return;
    event.waitUntil((async () => {
        const main = new URL(self.registration.scope);
        const windows = await self.clients.matchAll({type:'window', includeUncontrolled:true});
        for (const client of windows) {
            let url;
            try { url = new URL(client.url); } catch (_) { continue; }
            if (url.origin !== main.origin || ![main.pathname, main.pathname + 'index.html'].includes(url.pathname)) continue;
            await client.focus();
            client.postMessage({channel:'akra-gr-push', version:1, type:'open-receiving'});
            return;
        }
        main.searchParams.set('gr_push', '1');
        main.hash = '/app/app-gr';
        await self.clients.openWindow(main.href);
    })());
});
