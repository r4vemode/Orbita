/* PWA: service worker registration, install prompt and browser push. */
(() => {
  'use strict';
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
  const registration = navigator.serviceWorker.register('/sw.js').catch(() => null);
  let deferred = null;
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  function installButton() {
    const host = document.querySelector('[data-shell-tools]'); if (!host || standalone || host.querySelector('.pwa-install')) return;
    const b = document.createElement('button'); b.type = 'button'; b.className = 'pwa-install'; b.textContent = 'Установить приложение';
    b.addEventListener('click', async () => {
      if (deferred) { deferred.prompt(); await deferred.userChoice.catch(() => null); deferred = null; b.remove(); return; }
      alert(ios ? 'На iPhone: нажмите «Поделиться» в Safari → «На экран „Домой“». После этого в приложении можно включить уведомления.' : 'Откройте меню браузера → «Установить приложение» или «Добавить на главный экран».');
    });
    host.prepend(b);
  }
  window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferred = e; installButton(); });
  if (ios && !standalone) addEventListener('DOMContentLoaded', installButton);
  const toKey = b64 => { const raw = atob((b64 + '='.repeat((4 - b64.length % 4) % 4)).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(raw, c => c.charCodeAt(0)); };
  async function ready() {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error('Не удалось запустить уведомления в браузере.')), 10000);
    });
    const active = registration.then(reg => {
      if (!reg) throw Error('Не удалось запустить уведомления в браузере.');
      return navigator.serviceWorker.ready;
    });
    try { return await Promise.race([active, timeout]); }
    finally { clearTimeout(timer); }
  }
  async function pushRequest(url, options) {
    const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(10000), ...options });
    const body = await response.json().catch(() => null);
    if (!response.ok || !body) throw Error(body?.error || 'Не удалось обновить состояние уведомлений.');
    return body;
  }
  async function state() {
    if (!('PushManager' in window) || !('Notification' in window)) return { supported: false, reason: ios && !standalone ? 'ios-install' : 'unsupported' };
    const reg = await ready(), sub = await reg.pushManager.getSubscription();
    const config = await pushRequest('/api/push/config', { headers: sub ? { 'X-Orbita-Push-Endpoint': sub.endpoint } : {} });
    return { supported: true, permission: Notification.permission, subscribed: config.registered === true, configured: config.configured, eligible: config.eligible, publicKey: config.publicKey, userId: config.userId };
  }
  async function enable(config) {
    if (!config.configured) throw Error('Push-уведомления выключены на сервере.');
    if (!config.eligible) throw Error('Push-уведомления доступны по подписке PRO или EXCLUSIVE.');
    if (await Notification.requestPermission() !== 'granted') throw Error('Разрешите уведомления для сайта в настройках браузера.');
    const reg = await ready();
    const sub = await reg.pushManager.getSubscription() || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: toKey(config.publicKey) });
    await pushRequest('/api/push/subscription', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...sub.toJSON(), userId: config.userId }) });
  }
  async function disable(config) {
    const reg = await ready(), sub = await reg.pushManager.getSubscription();
    if (!sub) return;
    await pushRequest('/api/push/subscription', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint: sub.endpoint, userId: config.userId }) });
    await sub.unsubscribe();
  }
  window.OrbitaPWA = { state, enable, disable };
})();
