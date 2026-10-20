(async () => {
  const $ = id => document.getElementById(id), S = OrbitaStore, esc = S.escape;
  const catalog = window.ORBITA_STRATEGIES || [];
  const positive = value => typeof value === 'number' && Number.isFinite(value) && value > 0;
  const price = value => positive(value) ? value.toLocaleString('ru-RU', { maximumFractionDigits: 8 }) : '—';
  const pct = value => (value > 0 ? '+' : '') + value.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + '%';
  const planFor = strategy => strategy.plan || (strategy.exclusive ? 'exclusive' : 'pro');
  const planLabel = strategy => planFor(strategy) === 'exclusive' ? 'Orbita Exclusive' : 'Orbita Pro';
  const erroneous = record => !!record.erroneous;
  const calcHref = strategy => 'calculator.html?strategy=' + encodeURIComponent(strategy.name);
  const ideaHref = record => 'app.html?idea=' + encodeURIComponent(record.id);
  const detailHref = strategy => 'strategy.html?strategy=' + encodeURIComponent(strategy.slug);
  let records = [], user = null, feedError = null;
  const canView = strategy => !feedError && !!user && (user.access?.isAdmin || user.role === 'admin' || user.access?.activePlans?.includes(planFor(strategy)));
  const result = record => record.d.state === 'closed' && !erroneous(record) && positive(record.d.entry) && positive(record.meta?.exit) ? (record.meta.exit / record.d.entry - 1) * (record.d.dir === 'ШОРТ' ? -100 : 100) : null;
  const rowsFor = strategy => canView(strategy) ? records.filter(record => record.d.strategy === strategy.name) : [];
  const isOpen = record => ['announced', 'waiting', 'active'].includes(record.d.state) && !erroneous(record);
  const isHistory = record => ['closed', 'cancelled'].includes(record.d.state) || erroneous(record);
  const status = record => erroneous(record) ? 'Ошибочная публикация' : record.d.status || ({ announced: 'Сигнал объявлен', waiting: 'Ожидает входа', active: 'Активен', closed: 'Завершён', cancelled: 'Отменён' }[record.d.state] || 'Опубликован');
  function tags(strategy) { return `<div class="strategy-tags">${[...strategy.markets, strategy.horizon].map(label => `<span>${esc(label)}</span>`).join('')}</div>`; }
  function renderCatalog(filter = 'all') {
    const strategies = catalog.filter(strategy => filter === 'all' || strategy.category === filter);
    $('strategyCount').textContent = `Стратегий: ${strategies.length}`;
    $('strategyCards').innerHTML = strategies.map(strategy => {
      const rows = rowsFor(strategy), available = canView(strategy);
      const stats = available ? `<span><b>${rows.filter(isOpen).length}</b> открытых идей</span><span><b>${rows.filter(isHistory).length}</b> в истории</span>` : `<span>Идеи и история — по подписке ${esc(planLabel(strategy))}</span>`;
      return `<article class="strategy-card${strategy.exclusive ? ' exclusive' : ''}"><span class="strategy-kicker">${esc(strategy.label)}</span><h2><a href="${detailHref(strategy)}">${esc(strategy.name)}</a></h2>${tags(strategy)}<p>${esc(strategy.description)}</p><div class="strategy-card-stats">${stats}</div><div class="strategy-card-actions"><a class="strategy-link" href="${detailHref(strategy)}">Изучить стратегию <span aria-hidden="true">↗</span></a><a class="strategy-text-link" href="${available ? calcHref(strategy) : 'subscriptions.html'}">${available ? 'Посчитать на истории →' : 'Выбрать подписку →'}</a></div></article>`;
    }).join('');
  }
  function paywall(strategy) {
    if (feedError && ![401, 403].includes(feedError.status) && user) return `<div class="strategy-empty"><p>Не удалось загрузить данные стратегии. ${esc(feedError.message)}</p><button type="button" class="strategy-link" id="retryStrategy">Повторить загрузку</button></div>`;
    return `<div class="strategy-empty"><h3>Идеи и история ${esc(planLabel(strategy))}</h3><p>Открытые сигналы, комментарии автора и результаты доступны с действующей подпиской ${esc(planLabel(strategy))}.</p><a class="strategy-link primary-link" href="${user ? 'subscriptions.html' : 'account.html?next=' + encodeURIComponent(location.pathname + location.search)}">${user ? 'Выбрать подписку' : 'Войти в аккаунт'} →</a></div>`;
  }
  function renderDetail() {
    const parameter = new URLSearchParams(location.search).get('strategy'), strategy = catalog.find(item => item.slug === parameter || item.name === parameter);
    if (!strategy) {
      document.title = 'ORBITA — стратегия не найдена';
      $('strategyDetail').innerHTML = '<section class="strategy-hero"><h1>Стратегия не найдена.</h1><p>Выберите стратегию в каталоге.</p><a class="strategy-link" href="strategies.html">Открыть каталог →</a></section>';
      return;
    }
    document.title = 'ORBITA — ' + strategy.name;
    const available = canView(strategy), rows = rowsFor(strategy), open = rows.filter(isOpen), history = rows.filter(isHistory).sort((a, b) => historyTime(b) - historyTime(a));
    $('strategyDetail').innerHTML = `<section class="detail-hero"><div><div class="strategy-kicker">${esc(strategy.label)}</div><h1>${esc(strategy.name)}</h1><p class="strategy-intro">${esc(strategy.description)}</p><a class="strategy-link primary-link" href="${available ? calcHref(strategy) : 'subscriptions.html'}">${available ? 'В калькулятор с этой стратегией' : 'Подписка ' + esc(planLabel(strategy))} <span aria-hidden="true">↗</span></a></div><dl class="detail-facts"><div><dt>Рынки</dt><dd>${strategy.markets.map(esc).join(' · ')}</dd></div><div><dt>Обычный срок сделки</dt><dd>${esc(strategy.horizon)}</dd></div><div><dt>Открытых идей</dt><dd>${available ? open.length : 'По подписке'}</dd></div><div><dt>История результатов</dt><dd>${available ? history.length + ' публикаций' : 'По подписке'}</dd></div></dl></section>
      <section class="strategy-section strategy-overview"><div><div class="strategy-section-heading"><h2>Как устроен подход</h2></div><p>${esc(strategy.approach)}</p><ul class="strategy-principles">${strategy.points.map(point => `<li>${esc(point)}</li>`).join('')}</ul></div><div><div class="strategy-section-heading"><h2>Какой темп вам подойдёт</h2></div><p>${esc(strategy.rhythm)}</p><p>Условия входа и отмены, первоначальные уровни и каждое обновление сохраняются в истории идеи. Учитывайте собственную цену входа.</p></div></section>
      ${strategy.exclusive ? exclusiveArticles(strategy) : ''}
      <section class="strategy-section" aria-labelledby="openHeading"><div class="strategy-section-heading"><h2 id="openHeading">Открытые идеи</h2>${available ? `<span>${open.length} ИДЕЙ</span>` : ''}</div>${available ? open.length ? `<div class="strategy-open-grid">${open.map(ideaCard).join('')}</div>` : '<p class="strategy-empty">Сейчас нет открытых идей. Новый сценарий появится после публикации автора.</p>' : paywall(strategy)}</section>
      <section class="strategy-section" aria-labelledby="historyHeading"><div class="strategy-section-heading"><h2 id="historyHeading">История результатов</h2>${available ? `<a class="strategy-text-link" href="${calcHref(strategy)}">Рассчитать с вашим капиталом →</a>` : ''}</div>${available ? `<p class="strategy-disclaimer">В истории сохраняются прибыльные и убыточные идеи, отмены и ошибочные публикации. Проценты показывают движение цены от входа автора без комиссий, налогов и проскальзывания; это не доходность портфеля.</p>${history.length ? `<div class="strategy-history"><table><thead><tr><th>Идея</th><th>Состояние</th><th>Вход / выход</th><th>Изменение цены</th><th>Обновлено · МСК</th></tr></thead><tbody>${history.map(historyRow).join('')}</tbody></table></div>` : '<p class="strategy-empty">Завершённых публикаций пока нет. Для этой стратегии ещё нельзя оценить результат по истории.</p>'}` : '<p class="strategy-empty">История открывается с подпиской на эту стратегию.</p>'}</section>
      <p class="strategy-disclaimer">Исторический результат не гарантирует будущую доходность. Перед сделкой оцените допустимый риск.</p>`;
    if ($('retryStrategy')) $('retryStrategy').onclick = refresh;
  }
  function historyTime(record) {
    if (record.meta?.updatedAt) return Date.parse(record.meta.updatedAt) || 0;
    const match = String(record.meta?.updated || '').match(/(\d{2})\.(\d{2})\.(\d{4})\s*·\s*(\d{2}):(\d{2})/);
    return match ? Date.UTC(+match[3], +match[2] - 1, +match[1], +match[4] - 3, +match[5]) : 0;
  }
  function ideaCard(record) {
    const d = record.d, hasLevels = [d.entry, d.stop, d.target].every(positive);
    return `<article class="strategy-idea"><div class="strategy-idea-top"><b>${esc(d.ticker)}</b><span class="strategy-status">${esc(status(record))}</span></div><small>${esc(d.dir)}${d.horizon ? ' · ' + esc(d.horizon) : ''}</small><h3>${esc(d.title || d.ticker + ' · ' + d.dir)}</h3>${d.summary ? `<p>${esc(d.summary)}</p>` : ''}<p>${hasLevels ? `Вход ${price(d.entry)} · стоп ${price(d.stop)} · цель ${price(d.target)} ${esc(d.unit || '')}` : 'Сигнал объявлен. Уровни появятся в обновлении автора.'}</p><a href="${ideaHref(record)}">Комментарии и история идеи ↗</a></article>`;
  }
  function historyRow(record) {
    const d = record.d, value = result(record);
    return `<tr><td><a href="${ideaHref(record)}"><b>${esc(d.ticker)} ↗</b></a><small>${esc(d.dir)}</small></td><td>${esc(erroneous(record) ? 'Ошибочная публикация' : d.outcome || status(record))}</td><td>${price(d.entry)} / ${price(record.meta?.exit)} ${esc(d.unit || '')}</td><td class="${value === null ? '' : value < 0 ? 'negative' : 'positive'}">${value === null ? '—' : pct(value)}</td><td>${esc(record.meta?.updated || '—')}</td></tr>`;
  }
  function exclusiveArticles(strategy) {
    return `<section class="strategy-section" aria-labelledby="exclusiveLearnHeading"><div class="strategy-section-heading"><h2 id="exclusiveLearnHeading">Обучение и статьи Exclusive</h2><a class="strategy-text-link" href="learn.html">База знаний →</a></div><div class="strategy-lesson-grid">${(strategy.lessons || []).map(lesson => `<article class="strategy-lesson"><span class="strategy-kicker">ORBITA EXCLUSIVE / СТАТЬЯ</span><h3>${esc(lesson.title)}</h3><p>${esc(lesson.description)}</p><a href="learn.html?lesson=${encodeURIComponent(lesson.id)}">Читать по подписке ↗</a></article>`).join('')}</div></section>`;
  }
  function render() { document.body.dataset.strategyPage === 'catalog' ? renderCatalog(document.querySelector('[data-horizon][aria-pressed="true"]')?.dataset.horizon || 'all') : renderDetail(); }
  async function refresh() {
    try {
      const response = await fetch('/api/me', { credentials: 'same-origin', cache: 'no-store' });
      if (!response.ok) throw Error('Не удалось проверить аккаунт.');
      ({ user } = await response.json());
      try { await S.refresh(); records = S.read().records; feedError = null; }
      catch (error) { records = []; feedError = error; }
    } catch (error) { user = null; records = []; feedError = error; }
    render();
  }
  document.querySelector('.strategy-filters')?.addEventListener('click', event => {
    const button = event.target.closest('[data-horizon]');
    if (!button) return;
    document.querySelectorAll('[data-horizon]').forEach(item => item.setAttribute('aria-pressed', item === button)); renderCatalog(button.dataset.horizon);
  });
  await refresh();
  window.addEventListener('orbita:store-change', () => { records = S.read().records; render(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
})();
