/* ORBITA App Shell: one persistent navigation for every account page.
   Rendered synchronously where the script tag stands, so the layout does not
   jump between pages. It carries no paid data; the plan badge comes from /api/me. */
(() => {
  'use strict';
  const anchor = document.currentScript;
  const editorMode = anchor?.dataset.orbitaShell === 'editor';
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
  const editorGroups = [
    ['Публикации', [
      ['signals', 'Сигналы', '/admin.html'],
      ['editor-radar', 'Radar · редакция', '/radar-admin.html'],
      ['telegram-signals', 'Telegram · сигналы', '/telegram-admin.html'],
      ['materials', 'Уроки и статьи', '/content-admin.html'],
      ['backtest', 'Проверка истории', '/backtest-admin.html']
    ]],
    ['Клиенты', [
      ['clients', 'Доступ клиентов', '/admin.html#subscriptionsPanel'],
      ['payments', 'Платежи', '/payments-admin.html'],
      ['support-tickets', 'Обращения', '/support-admin.html'],
      ['partners', 'Маркетологи и рефералы', '/partners-admin.html'],
      ['partner-offers', 'Предложения брокеров', '/settings-admin.html#partners']
    ]],
    ['Сервис', [
      ['market-sources', 'Рынки · источники данных', '/markets-admin.html'],
      ['legal', 'Реквизиты и документы', '/legal-admin.html'],
      ['editor-settings', 'Настройки', '/settings-admin.html'],
      ['launch', 'Готовность сервиса', '/launch-admin.html'],
      ['author-guide', 'Порядок публикации', '/guide.html#author'],
      ['security', 'Безопасность входа', '/security.html'],
      ['editor-notifications', 'Уведомления', '/notifications.html']
    ]]
  ];
  const cabinetLinks = [
    ['open-dashboard', 'Открыть кабинет ↗', '/dashboard.html'],
    ['open-radar', 'Radar', '/radar.html'],
    ['open-markets', 'Рынки', '/markets.html'],
    ['open-learn', 'Обучение', '/learn.html'],
    ['open-subscriptions', 'Моя подписка', '/subscriptions.html'],
    ['open-support', 'Мои обращения', '/support.html']
  ];
  const here = location.pathname === '/' ? '/index.html' : location.pathname;
  const esc = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const editorPaths = new Set(editorGroups.flatMap(([, entries]) => entries.map(([, , href]) => href)));
  const editorPath = () => editorPaths.has(here + location.hash) ? here + location.hash : here;
  const activePath = editorMode ? editorPath() : here;
  const link = ([id, label, href, match = [href]]) => `<a class="shell-link" data-shell="${id}" href="${href}"${match.includes(activePath) ? ' aria-current="page"' : ''}>${esc(label)}</a>`;
  const accountLinks = `<div class="shell-group">${primary.map(link).join('')}</div>
    <div class="shell-group shell-secondary">${secondary.map(link).join('')}<a class="shell-link shell-admin" href="/admin.html" hidden>Редакция</a></div>`;
  const editorLinks = editorMode ? editorGroups.map(([title, entries], index) => `
    <div class="shell-group${index ? ' shell-secondary' : ''}" role="group" aria-label="${esc(title)}">
      <span class="shell-group-title" aria-hidden="true">${esc(title)}</span>${entries.map(link).join('')}
    </div>`).join('') + `<div class="shell-group shell-secondary" role="group" aria-label="Кабинет">
      ${link(cabinetLinks[0])}
      <details class="shell-cabinet"><summary>Разделы кабинета</summary>${cabinetLinks.slice(1).map(link).join('')}</details>
    </div>` : '';
  const brandHref = editorMode ? '/admin.html' : '/strategies.html';
  const brandLabel = editorMode ? 'ORBITA — Редакция' : 'ORBITA — Стратегии';
  const html = `<div class="shell-bar"><a class="shell-brand" href="${brandHref}" aria-label="${brandLabel}"><span aria-hidden="true">◌</span> ORBITA</a><button class="shell-toggle" type="button" aria-expanded="false" aria-controls="shellNav">Меню</button></div>
<nav id="shellNav" class="shell-nav" aria-label="${editorMode ? 'Разделы редакции' : 'Разделы кабинета'}">${editorMode ? editorLinks : accountLinks}
<div class="shell-tools" data-shell-tools></div><div class="shell-account"><span class="shell-plan" data-plan="loading">Проверяем тариф…</span><span class="shell-email"></span><button class="shell-logout" type="button">Выйти</button></div></nav>`;
  const aside = document.createElement('aside');
  aside.className = 'orbita-shell'; aside.innerHTML = html;
  if (anchor?.parentNode) anchor.parentNode.insertBefore(aside, anchor.nextSibling); else document.body.prepend(aside);
  document.documentElement.classList.add('has-shell');
  if (editorMode) document.documentElement.classList.add('has-editor-shell');
  const toggle = aside.querySelector('.shell-toggle'), nav = aside.querySelector('.shell-nav');
  function setExpanded(open) {
    toggle.setAttribute('aria-expanded', String(open));
    nav.classList.toggle('open', open);
  }
  toggle.addEventListener('click', () => setExpanded(toggle.getAttribute('aria-expanded') !== 'true'));
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && nav.classList.contains('open')) {
      setExpanded(false);
      toggle.focus();
    }
  });
  if (editorMode) {
    nav.addEventListener('click', event => {
      if (event.target.closest('a.shell-link')) setExpanded(false);
    });
    window.addEventListener('hashchange', () => {
      const current = editorPath();
      for (const item of nav.querySelectorAll('a.shell-link')) {
        if (item.getAttribute('href') === current) item.setAttribute('aria-current', 'page');
        else item.removeAttribute('aria-current');
      }
    });
  }
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
    if (!editorMode) aside.querySelector('.shell-admin').hidden = !user?.access?.isAdmin;
    aside.querySelector('.shell-logout').hidden = !user;
  }
  window.OrbitaShell = { paint };
  fetch('/api/me', { credentials: 'same-origin', cache: 'no-store' }).then(r => r.ok ? r.json() : null).then(data => paint(data?.user || null)).catch(() => {
    const badge = aside.querySelector('.shell-plan'); badge.dataset.plan = 'unknown'; badge.textContent = 'Тариф не загружен';
  });
})();
