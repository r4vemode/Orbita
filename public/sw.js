/* ORBITA service worker. Caches only the public app shell (styles, scripts,
   icons). Pages and /api are always fetched from the network: paid data and
   access checks never come from a cache. Offline → a short notice page. */
const VERSION = 'orbita-shell-v1';
const SHELL = ['/offline.html', '/assets/shell.css', '/assets/shell.js', '/icons/icon-192.png', '/manifest.webmanifest'];
self.addEventListener('install', event => { event.waitUntil(caches.open(VERSION).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', event => { event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', event => {
  const req = event.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  if (req.mode === 'navigate') { event.respondWith(fetch(req).catch(() => caches.match('/offline.html'))); return; }
  if (SHELL.includes(url.pathname)) event.respondWith(fetch(req).then(res => { const copy = res.clone(); if (res.ok) caches.open(VERSION).then(c => c.put(req, copy)); return res; }).catch(() => caches.match(req)));
});
self.addEventListener('push', event => {
  let data = {}; try { data = event.data ? event.data.json() : {}; } catch { data = { title: 'ORBITA', body: event.data?.text() || '' }; }
  const url = typeof data.url === 'string' && data.url.startsWith('/') ? data.url : '/strategies.html';
  event.waitUntil(self.registration.showNotification(data.title || 'ORBITA', { body: data.body || '', tag: data.tag, renotify: Boolean(data.tag), icon: '/icons/icon-192.png', badge: '/icons/favicon-32.png', data: { url } }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close(); const url = event.notification.data?.url || '/strategies.html';
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => { for (const c of list) if (new URL(c.url).origin === location.origin && 'focus' in c) { c.navigate(url); return c.focus(); } return self.clients.openWindow(url); }));
});
