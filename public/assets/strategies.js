(() => {
  const $ = id => document.getElementById(id), esc = OrbitaStore.escape;
  const catalog = window.ORBITA_STRATEGIES || [];
  const demo = record => record.demo || /^(demo-|exclusive-)/.test(record.id);
  const erroneous = record => record.erroneous || record.invalidated || record.d.state === 'error';
  const price = value => Number(value).toLocaleString('ru-RU', { maximumFractionDigits: 4 });
  const pct = value => (value > 0 ? '+' : '') + value.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + '%';
  const calcHref = strategy => 'calculator.html?strategy=' + encodeURIComponent(strategy.name);
  const ideaHref = record => 'app.html?idea=' + encodeURIComponent(/^demo-[0-5]$/.test(record.id) ? ['sber-20261009','lkoh-20261009','si-20261009','btc-20261009','rosn-20261006','eth-20261007'][Number(record.id.slice(5))] : record.id);
  const detailHref = strategy => 'strategy.html?strategy=' + encodeURIComponent(strategy.slug);
  const result = record => {
    const d = record.d, exit = Number(record.meta?.exit);
    return d.state === 'closed' && !erroneous(record) && ['ЛОНГ', 'ШОРТ'].includes(d.dir) && Number(d.entry) > 0 && Number.isFinite(exit) && exit > 0 ? (exit / d.entry - 1) * (d.dir === 'ШОРТ' ? -100 : 100) : null;
  };
  let records = [];
  function read() { records = OrbitaStore.read().records.filter(record => record.published && record.d); }
  function rowsFor(strategy) { return records.filter(record => record.d.strategy === strategy.name); }
  function counts(strategy) {
    const rows = rowsFor(strategy);
    return { open: rows.filter(record => ['active', 'waiting'].includes(record.d.state) && !erroneous(record)).length, closed: rows.filter(record => ['closed', 'cancelled', 'error'].includes(record.d.state) || erroneous(record)).length };
  }
  function tags(strategy) { return `<div class="strategy-tags">${[...strategy.markets, strategy.horizon].map(label => `<span>${esc(label)}</span>`).join('')}</div>`; }
  function renderCatalog(filter = 'all') {
    const strategies = catalog.filter(strategy => filter === 'all' || strategy.category === filter);
    $('strategyCount').textContent = `Стратегий: ${strategies.length}`;
    $('strategyCards').innerHTML = strategies.map(strategy => {
      const stats = counts(strategy);
      return `<article class="strategy-card${strategy.exclusive ? ' exclusive' : ''}"><span class="strategy-kicker">${esc(strategy.label)}</span><h2><a href="${detailHref(strategy)}">${esc(strategy.name)}</a></h2>${tags(strategy)}<p>${esc(strategy.description)}</p><div class="strategy-card-stats"><span><b>${stats.open}</b> открытых идей</span><span><b>${stats.closed}</b> в истории</span></div><div class="strategy-card-actions"><a class="strategy-link" href="${detailHref(strategy)}">Изучить стратегию <span aria-hidden="true">↗</span></a><a class="strategy-text-link" href="${calcHref(strategy)}">Посчитать на истории →</a></div></article>`;
    }).join('');
  }
  function renderDetail() {
    const parameter = new URLSearchParams(location.search).get('strategy');
    const strategy = catalog.find(item => item.slug === parameter || item.name === parameter);
    if (!strategy) {
      document.title = 'ORBITA — стратегия не найдена';
      $('strategyDetail').innerHTML = '<section class="strategy-hero"><h1>Стратегия не найдена.</h1><p>Откройте каталог, чтобы выбрать действующую стратегию и посмотреть её идеи.</p><a class="strategy-link" href="strategies.html">Открыть каталог →</a></section>';
      return;
    }
    document.title = 'ORBITA — ' + strategy.name;
    const rows = rowsFor(strategy), open = rows.filter(record => ['active', 'waiting'].includes(record.d.state) && !erroneous(record)), history = rows.filter(record => ['closed', 'cancelled', 'error'].includes(record.d.state) || erroneous(record)).sort((a, b) => historyTime(b) - historyTime(a));
    $('strategyDetail').innerHTML = `<section class="detail-hero"><div><div class="strategy-kicker">${esc(strategy.label)}</div><h1>${esc(strategy.name)}</h1><p class="strategy-intro">${esc(strategy.description)}</p><a class="strategy-link primary-link" href="${calcHref(strategy)}">В калькулятор с этой стратегией <span aria-hidden="true">↗</span></a></div><dl class="detail-facts"><div><dt>Рынки</dt><dd>${strategy.markets.map(esc).join(' · ')}</dd></div><div><dt>Обычный срок сделки</dt><dd>${esc(strategy.horizon)}</dd></div><div><dt>Открытых идей</dt><dd>${open.length}</dd></div><div><dt>Публикаций в истории</dt><dd>${history.length}</dd></div></dl></section>
      <section class="strategy-section strategy-overview"><div><div class="strategy-section-heading"><h2>Как устроен подход</h2></div><p>${esc(strategy.approach)}</p><ul class="strategy-principles">${strategy.points.map(point => `<li>${esc(point)}</li>`).join('')}</ul></div><div><div class="strategy-section-heading"><h2>Какой темп вам подойдёт</h2></div><p>${esc(strategy.rhythm)}</p><p>Условия входа и отмены, первоначальные уровни и каждое обновление доступны внутри идеи. Следите за изменениями и учитывайте собственную цену входа.</p></div></section>
      ${strategy.exclusive ? exclusiveContent() : ''}
      <section class="strategy-section" aria-labelledby="openHeading"><div class="strategy-section-heading"><h2 id="openHeading">Открытые идеи</h2><span>${open.length} ИДЕЙ</span></div>${open.length ? `<div class="strategy-open-grid">${open.map(ideaCard).join('')}</div>` : '<p class="strategy-empty">Сейчас нет открытых идей. Новый сценарий появится после публикации автора.</p>'}</section>
      <section class="strategy-section" aria-labelledby="historyHeading"><div class="strategy-section-heading"><h2 id="historyHeading">История результатов</h2><a class="strategy-text-link" href="${calcHref(strategy)}">Рассчитать с вашим капиталом →</a></div><p class="strategy-disclaimer">Здесь сохраняются прибыльные и убыточные идеи, отмены и пометки об ошибочной публикации. Демо отмечены отдельно. Проценты показывают движение цены от входа автора без комиссий, налогов и проскальзывания; это не доходность портфеля.</p>${history.length ? `<div class="strategy-history"><table><thead><tr><th>Идея</th><th>Состояние</th><th>Вход / выход</th><th>Изменение цены</th><th>Обновлено · МСК</th></tr></thead><tbody>${history.map(historyRow).join('')}</tbody></table></div>` : '<p class="strategy-empty">Завершённых публикаций пока нет. Для этой стратегии ещё нельзя оценить результат по истории.</p>'}</section>
      <p class="strategy-disclaimer">Материалы служат для знакомства с подходом. Исторический результат и учебные примеры не гарантируют будущую доходность.</p>`;
  }
  function historyTime(record) {
    const match = String(record.meta?.updated || '').match(/(\d{2})\.(\d{2})\.(\d{4})\s*·\s*(\d{2}):(\d{2})/);
    return match ? Date.UTC(+match[3], +match[2] - 1, +match[1], +match[4] - 3, +match[5]) : 0;
  }
  function ideaCard(record) {
    const d = record.d;
    return `<article class="strategy-idea"><div class="strategy-idea-top"><b>${esc(d.ticker)}</b><span class="strategy-status">${esc(d.status)}</span></div><small>${esc(d.dir)} · ${esc(d.horizon)}${demo(record) ? ' · ДЕМО' : ''}</small><h3>${esc(d.title)}</h3><p>${esc(d.summary)}</p><p>Вход ${price(d.entry)} · стоп ${price(d.stop)} · цель ${price(d.target)} ${esc(d.unit)}</p><a href="${ideaHref(record)}">Условия и история идеи ↗</a></article>`;
  }
  function historyRow(record) {
    const d = record.d, value = result(record), status = erroneous(record) ? 'Ошибочная публикация' : d.outcome || d.status;
    return `<tr><td><a href="${ideaHref(record)}"><b>${esc(d.ticker)} ↗</b></a><small>${esc(d.dir)}${demo(record) ? ' · ДЕМО — учебный пример' : ''}</small></td><td>${esc(status)}</td><td>${price(d.entry)} / ${Number(record.meta?.exit) > 0 ? price(record.meta.exit) : '—'} ${esc(d.unit)}</td><td class="${value === null ? '' : value < 0 ? 'negative' : 'positive'}">${value === null ? '—' : pct(value)}</td><td>${esc(record.meta?.updated || '—')}</td></tr>`;
  }
  function exclusiveContent() {
    const strategy = catalog.find(item => item.exclusive), example = rowsFor(strategy).find(record => record.id === 'exclusive-sber');
    return `<section class="strategy-section trend-notes" aria-labelledby="trendHeading"><div class="strategy-kicker">Разбор тренда / учебный пример</div><div class="strategy-section-heading"><h2 id="trendHeading">От большой картины к плану</h2></div><p>На недельном графике ищем устойчивое направление, на дневном — последовательность максимумов и минимумов. Возврат к поддержке сам по себе не означает вход: сначала проверяем условие подтверждения и расстояние до стопа.</p><p><strong>Пример SBER:</strong> повышающиеся минимумы поддерживают восходящий сценарий. Условный вход 312 ₽, граница риска 300 ₽, ориентир 348 ₽. Если поддержка потеряна, прежняя логика требует пересмотра. Это учебные цены, не текущий обзор рынка.</p><dl class="trend-summary"><div><dt>Контекст</dt><dd>Недельное направление + дневная структура</dd></div><div><dt>Что подтверждает идею</dt><dd>Закрепление выше уровня входа</dd></div><div><dt>Что меняет план</dt><dd>Потеря поддержки или новое событие</dd></div></dl>${example ? `<p><a class="strategy-text-link" href="${ideaHref(example)}">Открыть учебный сценарий SBER →</a></p>` : ''}</section>
      <section class="strategy-section" aria-labelledby="exclusiveLearnHeading"><div class="strategy-section-heading"><h2 id="exclusiveLearnHeading">Обучение и статьи Exclusive</h2><a class="strategy-text-link" href="learn.html">Вся база знаний →</a></div><div class="strategy-lesson-grid">${strategy.lessons.map(lesson => `<article class="strategy-lesson"><span class="strategy-kicker">ORBITA EXCLUSIVE / СТАТЬЯ</span><h3>${esc(lesson.title)}</h3><p>${esc(lesson.description)}</p><a href="learn.html?lesson=${encodeURIComponent(lesson.id)}">Читать разбор ↗</a></article>`).join('')}</div></section>`;
  }
  try {
    read();
    if (document.body.dataset.strategyPage === 'catalog') {
      renderCatalog();
      document.querySelector('.strategy-filters').addEventListener('click', event => {
        const button = event.target.closest('[data-horizon]');
        if (!button) return;
        document.querySelectorAll('[data-horizon]').forEach(item => item.setAttribute('aria-pressed', item === button));
        renderCatalog(button.dataset.horizon);
      });
    } else renderDetail();
    window.addEventListener('storage', event => {
      if (event.key !== OrbitaStore.key) return;
      try { read(); document.body.dataset.strategyPage === 'catalog' ? renderCatalog(document.querySelector('[data-horizon][aria-pressed="true"]').dataset.horizon) : renderDetail(); }
      catch (error) { $('strategyError').textContent = error.message; }
    });
  } catch (error) { $('strategyError').textContent = 'Не удалось прочитать историю идей. ' + error.message; }
})();
