/* PWA: service worker registration, install prompt and browser push. */
(() => {
  'use strict';
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
  navigator.serviceWorker.register('/sw.js').catch(() => {});
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
  async function state() {
    if (!('PushManager' in window) || !('Notification' in window)) return { supported: false, reason: ios && !standalone ? 'ios-install' : 'unsupported' };
    const reg = await navigator.serviceWorker.ready, sub = await reg.pushManager.getSubscription();
    return { supported: true, permission: Notification.permission, subscribed: Boolean(sub) };
  }
  async function enable() {
    const config = await fetch('/api/push/config', { credentials: 'same-origin', cache: 'no-store' }).then(r => r.json());
    if (!config.configured) throw Error('Push-уведомления выключены на сервере.');
    if (await Notification.requestPermission() !== 'granted') throw Error('Разрешите уведомления для сайта в настройках браузера.');
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription() || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: toKey(config.publicKey) });
    const r = await fetch('/api/push/subscription', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(sub.toJSON()) });
    if (!r.ok) { const body = await r.json().catch(() => ({})); throw Error(body.error || 'Не удалось включить уведомления.'); }
  }
  async function disable() {
    const reg = await navigator.serviceWorker.ready, sub = await reg.pushManager.getSubscription();
    await fetch('/api/push/subscription', { method: 'DELETE', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint: sub?.endpoint }) });
    await sub?.unsubscribe();
  }
  window.OrbitaPWA = { state, enable, disable };
})();
