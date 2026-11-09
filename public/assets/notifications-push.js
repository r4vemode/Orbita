(() => {
  'use strict';
  const $ = id => document.getElementById(id), P = window.OrbitaPWA;
  async function paint() {
    const b = $('pushToggle'), status = $('pushStatus');
    if (!P) { b.hidden = true; status.textContent = 'Этот браузер не поддерживает push-уведомления или страница открыта не по HTTPS.'; return; }
    const s = await P.state().catch(() => ({ supported: false }));
    if (!s.supported) { b.hidden = true; status.textContent = s.reason === 'ios-install' ? 'На iPhone push работает в установленном приложении: «Поделиться» → «На экран „Домой“», затем откройте ORBITA с экрана и включите уведомления здесь.' : 'Браузер не поддерживает push-уведомления.'; return; }
    b.hidden = false; b.disabled = false;
    if (s.permission === 'denied') { b.disabled = true; b.textContent = 'Уведомления запрещены'; status.textContent = 'Разрешите уведомления для этого сайта в настройках браузера.'; return; }
    b.textContent = s.subscribed ? 'Выключить на этом устройстве' : 'Включить на этом устройстве';
    b.className = 'o-btn ' + (s.subscribed ? 'o-btn-secondary' : 'o-btn-primary');
    status.textContent = s.subscribed ? 'Включено. Выберите ниже, о каких событиях сообщать.' : '';
  }
  $('pushToggle').addEventListener('click', async () => {
    const b = $('pushToggle'); b.disabled = true;
    try { const s = await P.state(); if (s.subscribed) await P.disable(); else await P.enable(); } catch (e) { $('pushStatus').textContent = e.message; }
    await paint();
  });
  paint();
})();
