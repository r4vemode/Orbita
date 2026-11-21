/* ORBITA service worker. Caches only the public app shell (styles, scripts,
   icons). Pages and /api are always fetched from the network: paid data and
   access checks never come from a cache. Offline → a short notice page. */
const VERSION = 'orbita-shell-v2';
const SHELL = ['/offline.html', '/assets/shell.css', '/assets/shell.js', '/icons/icon-192.png', '/manifest.webmanifest'];
self.addEventListener('install', event => { event.waitUntil(caches.open(VERSION).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', event => { event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', event => {
  const req = event.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  if (req.mode === 'navigate') { event.respondWith(fetch(req).catch(() => caches.match('/offline.html'))); return; }
  if (SHELL.includes(url.pathname)) event.respondWith(fetch(req).then(res => { const copy = res.clone(); if (res.ok) caches.open(VERSION).then(c => c.put(req, copy)); return res; }).catch(() => caches.match(req)));
});
async function currentRecipient(userId) {
  if (typeof userId !== 'string' || !userId) return false;
  try {
    const response = await fetch('/api/me', { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(5000) });
    return response.ok && (await response.json()).user?.id === userId;
  } catch { return false; }
}
self.addEventListener('push', event => {
  event.waitUntil((async () => {
    let data;
    try { data = event.data?.json(); } catch { return; }
    if (!await currentRecipient(data?.userId)) return;
    const target = new URL(typeof data.url === 'string' ? data.url : '/strategies.html', location.origin);
    const url = target.origin === location.origin ? target.href : '/strategies.html';
    await self.registration.showNotification(data.title || 'ORBITA', { body: data.body || '', tag: data.tag, renotify: Boolean(data.tag), icon: '/icons/icon-192.png', badge: '/icons/favicon-32.png', data: { url, userId: data.userId } });
  })());
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil((async () => {
    const { url, userId } = event.notification.data || {};
    if (!await currentRecipient(userId)) return;
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of list) {
      if (new URL(client.url).origin !== location.origin) continue;
      const navigated = await client.navigate(url);
      if (navigated) return navigated.focus();
    }
    return self.clients.openWindow(url);
  })());
});
