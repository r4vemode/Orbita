(() => {
  'use strict';
  const $ = id => document.getElementById(id), P = window.OrbitaPWA;
  let current;
  async function paint(message) {
    const b = $('pushToggle'), status = $('pushStatus');
    if (!P) { b.hidden = true; status.textContent = 'Этот браузер не поддерживает push-уведомления или страница открыта не по HTTPS.'; return; }
    let s;
    try { s = await P.state(); }
    catch (error) { current = null; b.hidden = false; b.disabled = false; b.textContent = 'Повторить проверку'; status.textContent = message || error.message; return; }
    current = s;
    if (!s.supported) { b.hidden = true; status.textContent = s.reason === 'ios-install' ? 'На iPhone push работает в установленном приложении: «Поделиться» → «На экран „Домой“», затем откройте ORBITA с экрана и включите уведомления здесь.' : 'Браузер не поддерживает push-уведомления.'; return; }
    b.hidden = false; b.disabled = false;
    b.textContent = s.subscribed ? 'Выключить на этом устройстве' : 'Включить на этом устройстве';
    b.className = 'o-btn ' + (s.subscribed ? 'o-btn-secondary' : 'o-btn-primary');
    if (!s.configured) { b.disabled = !s.subscribed; status.textContent = 'Push-уведомления выключены на сервере.'; }
    else if (s.permission === 'denied') { b.disabled = !s.subscribed; status.textContent = 'Разрешите уведомления для этого сайта в настройках браузера.'; }
    else if (!s.eligible && !s.subscribed) { b.disabled = true; status.textContent = 'Push-уведомления доступны по подписке PRO или EXCLUSIVE.'; }
    else status.textContent = s.subscribed ? 'Включено. Выберите ниже, о каких событиях сообщать.' : '';
    if (message) status.textContent = message;
  }
  $('pushToggle').addEventListener('click', async () => {
    const b = $('pushToggle'); b.disabled = true;
    let message;
    try { if (current?.subscribed) await P.disable(current); else if (current?.supported) await P.enable(current); }
    catch (error) { message = error.message; }
    await paint(message);
  });
  paint();
})();
