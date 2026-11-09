/* ORBITA App Shell: one persistent navigation for every account page.
   Rendered synchronously where the script tag stands, so the layout does not
   jump between pages. It carries no paid data; the plan badge comes from /api/me. */
(() => {
  'use strict';
  const primary = [
    ['strategies', 'Стратегии', '/strategies.html', ['/strategies.html', '/strategy.html', '/app.html']],
    ['radar', 'Radar', '/radar.html', ['/radar.html']],
    ['markets', 'Рынки', '/markets.html', ['/markets.html']],
    ['calculator', 'Калькулятор', '/calculator.html', ['/calculator.html']],
    ['learn', 'Обучение', '/learn.html', ['/learn.html']],
    ['subscriptions', 'Подписка', '/subscriptions.html', ['/subscriptions.html', '/partner.html']],
    ['settings', 'Настройки', '/security.html', ['/security.html', '/notifications.html']]
  ];
  const secondary = [
    ['dashboard', 'Моя Орбита', '/dashboard.html', ['/dashboard.html']],
    ['notifications', 'Уведомления', '/notifications.html', []],
    ['results', 'Результаты идей', '/results.html', ['/results.html']],
    ['support', 'Поддержка', '/support.html', ['/support.html']],
    ['brokers', 'Где торговать', '/brokers.html', ['/brokers.html']]
  ];
  const here = location.pathname === '/' ? '/index.html' : location.pathname;
  const esc = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const link = ([id, label, href, match]) => `<a class="shell-link" data-shell="${id}" href="${href}"${match.includes(here) ? ' aria-current="page"' : ''}>${esc(label)}</a>`;
  const html = `<div class="shell-bar"><a class="shell-brand" href="/strategies.html" aria-label="ORBITA — Стратегии"><span aria-hidden="true">◌</span> ORBITA</a><button class="shell-toggle" type="button" aria-expanded="false" aria-controls="shellNav">Меню</button></div>
<nav id="shellNav" class="shell-nav" aria-label="Разделы кабинета"><div class="shell-group">${primary.map(link).join('')}</div><div class="shell-group shell-secondary">${secondary.map(link).join('')}<a class="shell-link shell-admin" href="/admin.html" hidden${here.endsWith('-admin.html') || here === '/admin.html' ? ' aria-current="page"' : ''}>Редакция</a></div>
<div class="shell-tools" data-shell-tools></div><div class="shell-account"><span class="shell-plan" data-plan="loading">Проверяем тариф…</span><span class="shell-email"></span><button class="shell-logout" type="button">Выйти</button></div></nav>`;
  const aside = document.createElement('aside');
  aside.className = 'orbita-shell'; aside.innerHTML = html;
  const anchor = document.currentScript;
  if (anchor?.parentNode) anchor.parentNode.insertBefore(aside, anchor.nextSibling); else document.body.prepend(aside);
  document.documentElement.classList.add('has-shell');
  const toggle = aside.querySelector('.shell-toggle'), nav = aside.querySelector('.shell-nav');
  toggle.addEventListener('click', () => { const open = toggle.getAttribute('aria-expanded') !== 'true'; toggle.setAttribute('aria-expanded', String(open)); nav.classList.toggle('open', open); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && nav.classList.contains('open')) { nav.classList.remove('open'); toggle.setAttribute('aria-expanded', 'false'); toggle.focus(); } });
  aside.querySelector('.shell-logout').addEventListener('click', async () => {
    try { await fetch('/api/logout', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' }); } catch {}
    location.assign('/account.html');
  });
  const planLabel = user => {
    if (!user) return ['guest', 'Не выполнен вход'];
    if (user.access?.isAdmin) return ['admin', 'Администратор'];
    const plans = user.access?.activePlans || [];
    if (plans.includes('exclusive')) return ['exclusive', 'EXCLUSIVE'];
    if (plans.includes('pro')) return ['pro', 'PRO'];
    return ['none', 'Без подписки'];
  };
  function paint(user) {
    const [plan, label] = planLabel(user), badge = aside.querySelector('.shell-plan');
    badge.dataset.plan = plan; badge.textContent = label;
    aside.querySelector('.shell-email').textContent = user?.email || '';
    aside.querySelector('.shell-admin').hidden = !user?.access?.isAdmin;
    aside.querySelector('.shell-logout').hidden = !user;
  }
  window.OrbitaShell = { paint };
  fetch('/api/me', { credentials: 'same-origin', cache: 'no-store' }).then(r => r.ok ? r.json() : null).then(data => paint(data?.user || null)).catch(() => {
    const badge = aside.querySelector('.shell-plan'); badge.dataset.plan = 'unknown'; badge.textContent = 'Тариф не загружен';
  });
})();
