/* FTT Signal — Service Worker v1.0
   Place this file at the ROOT of your GitHub Pages repo
   e.g. https://yourusername.github.io/ftt-signal/sw.js
*/

self.addEventListener('install', e => {
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(clients.claim());
});

/* ── PUSH RECEIVED ── */
self.addEventListener('push', e => {
  if (!e.data) return;

  let data;
  try { data = e.data.json(); }
  catch { data = { title: 'FTT Signal', body: e.data.text() }; }

  const dir   = data.direction || '';
  const pair  = data.pair      || '';
  const conf  = data.confidence || '';
  const grade = data.grade     || '';

  const icon  = dir === 'BUY'  ? '▲' :
                dir === 'SELL' ? '▼' : '⏳';

  const title = `FTT Signal — ${pair}`;
  const body  = `${icon} ${dir}  ·  ${conf}%  ·  Grade ${grade}`;

  const options = {
    body,
    icon:  '/ftt-signal/icon-192.png',   // your app icon path
    badge: '/ftt-signal/badge-72.png',
    tag:   `ftt-${pair.replace('/', '')}`,
    renotify: true,
    vibrate: [200, 100, 200],
    data: { url: self.registration.scope, pair, dir },
    actions: [
      { action: 'open',    title: '📊 Open App' },
      { action: 'dismiss', title: 'Dismiss'     },
    ],
  };

  e.waitUntil(self.registration.showNotification(title, options));
});

/* ── NOTIFICATION CLICK ── */
self.addEventListener('notificationclick', e => {
  e.notification.close();

  if (e.action === 'dismiss') return;

  const url = e.notification.data?.url || self.registration.scope;

  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(list => {
        for (const client of list) {
          if (client.url.startsWith(self.registration.scope) && 'focus' in client) {
            return client.focus();
          }
        }
        return clients.openWindow(url);
      })
  );
});
