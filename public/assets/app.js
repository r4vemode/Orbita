(async () => {
  const S = OrbitaStore, $ = id => document.getElementById(id), esc = S.escape;
  const positive = value => typeof value === 'number' && Number.isFinite(value) && value > 0;
  const number = value => positive(value) ? value.toLocaleString('ru-RU', { maximumFractionDigits: 8 }) : '—';
  const percent = value => (value > 0 ? '+' : '') + value.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + '%';
  const status = record => record.erroneous ? 'Ошибочная публикация' : record.d.status || ({ announced: 'Сигнал объявлен', waiting: 'Ожидает входа', active: 'Активен', closed: 'Завершён', cancelled: 'Отменён' }[record.d.state] || 'Опубликован');
  const marketName = value => ({ stocks: 'Акции', futures: 'Фьючерсы', crypto: 'Криптовалюты' }[value] || 'Рынок');
  let records = [], account, saved = new Set(), view = 'all', market = 'all', state = 'all', selected = null, saving = false, personalReady = false;
  async function api(url, options = {}) {
    const response = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers }, credentials: 'same-origin', cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) { const error = new Error(data.error || 'Не удалось получить данные.'); error.status = response.status; throw error; }
    return data;
  }
  function handleError(error) {
    if (error.status === 401) { location.replace('account.html?next=' + encodeURIComponent(location.pathname + location.search)); return; }
    if (error.status === 403) { location.replace('subscriptions.html'); return; }
    $('appStatus').textContent = error.message;
  }
  const result = record => {
    const d = record.d, exit = record.meta?.exit;
    return !record.erroneous && d.state === 'closed' && positive(d.entry) && positive(exit) ? (exit / d.entry - 1) * (d.dir === 'ШОРТ' ? -100 : 100) : null;
  };
  function notify(message) { $('appStatus').textContent = message; }
  function visible() {
    return records.filter(record => (view !== 'saved' || saved.has(record.id)) && (view !== 'history' || ['closed', 'cancelled'].includes(record.d.state) || record.erroneous) && (market === 'all' || record.d.market === market) && (state === 'all' || record.d.state === state));
  }
  function levels(d) {
    if (![d.entry, d.stop, d.target].every(positive)) return '<p class="announced-note">Уровни ещё не опубликованы. Следите за комментариями автора.</p>';
    return `<div class="signal-levels"><span>Вход<b>${number(d.entry)}</b></span><span>Стоп<b>${number(d.stop)}</b></span><span>Цель<b>${number(d.target)}</b></span></div>`;
  }
  function renderFeed() {
    const rows = visible();
    $('savedCount').textContent = records.filter(record => saved.has(record.id)).length;
    $('feedCount').textContent = `Идей: ${rows.length}`;
    $('collectionNote').textContent = view === 'saved' ? 'Ваши отслеживаемые идеи. Все изменения появятся в обновлениях.' : view === 'history' ? 'Завершённые, отменённые и ошибочные публикации. Прибыльные и убыточные сделки остаются в истории.' : 'Идеи по вашим действующим подпискам. Начальный сигнал может содержать только инструмент и направление; уровни и комментарии автор добавит позже.';
    document.querySelectorAll('[data-view]').forEach(button => button.setAttribute('aria-pressed', button.dataset.view === view));
    document.querySelectorAll('[data-market]').forEach(button => button.setAttribute('aria-pressed', button.dataset.market === market));
    document.querySelectorAll('[data-status]').forEach(button => button.setAttribute('aria-pressed', button.dataset.status === state));
    $('cards').innerHTML = rows.map(record => {
      const d = record.d, value = result(record), title = d.title || `${d.ticker} · ${d.dir}`;
      return `<button type="button" class="idea signal-card${record.id === selected ? ' selected' : ''}" data-idea="${esc(record.id)}"><div class="row"><span class="signal-market">${esc(marketName(d.market))}</span><span class="signal-state">${esc(status(record))}</span></div><div class="row signal-identity"><strong>${esc(d.ticker)}</strong><span class="signal-direction">${esc(d.dir)}</span></div><div class="signal-name">${esc(d.strategy)}</div><p>${esc(title)}</p>${d.summary ? `<p class="signal-summary">${esc(d.summary)}</p>` : ''}${levels(d)}${value === null ? '' : `<div class="history-result ${value < 0 ? 'is-negative' : 'is-positive'}"><strong>${percent(value)}</strong><span>По цене инструмента<br>без издержек</span></div>`}${personalReady ? OrbitaPersonal.card({ ...d, id: record.id }, record.meta || {}) : ''}<div class="row signal-footer"><span>${saved.has(record.id) ? '✓ Отслеживается' : esc(d.horizon || 'Новый сигнал')}</span><span class="signal-open">Смотреть идею ↗</span></div></button>`;
    }).join('');
    $('feedEmpty').hidden = !!rows.length;
    $('feedEmptyText').textContent = view === 'saved' ? 'Откройте идею и нажмите «Следить за идеей».' : records.length ? 'Измените фильтры, чтобы увидеть другие идеи.' : 'Автор ещё не опубликовал идеи по вашей подписке.';
  }
  function eventMarkup(record) {
    const events = Array.isArray(record.meta?.events) ? record.meta.events : [];
    return events.length ? `<ol class="event-list">${events.map((event, index) => `<li class="${index === events.length - 1 ? 'event-latest' : ''}"><span class="event-time">${esc(event[0])} МСК</span><h4>${esc(event[1])}</h4><p>${esc(event[2])}</p></li>`).join('')}</ol>` : '<p>У этой публикации пока нет отдельных обновлений.</p>';
  }
  function renderDetail() {
    const record = records.find(item => item.id === selected);
    if (!record) { $('ideaDetail').hidden = true; return; }
    const d = record.d, meta = record.meta || {}, value = result(record), hasLevels = [d.entry, d.stop, d.target].every(positive), strategy = (window.ORBITA_STRATEGIES || []).find(item => item.name === d.strategy);
    $('ideaDetail').hidden = false;
    $('detailContent').innerHTML = `<div class="paid-detail-heading"><div><div class="eyebrow">${esc(d.strategy)} / ${esc(d.dir)}</div><h1>${esc(d.ticker)}</h1><span class="tag">${esc(status(record))}</span><h2>${esc(d.title || `${d.ticker} · ${d.dir}`)}</h2></div><button class="explore" id="follow" aria-pressed="${saved.has(record.id)}">${saved.has(record.id) ? '✓ Отслеживается' : 'Следить за идеей'}</button></div>${record.erroneous ? `<p class="error-publication">Ошибочная публикация: ${esc(meta.errorReason || 'Причина указана в истории.')}. Сохранена для проверки и исключена из расчётов.</p>` : ''}${d.summary ? `<p class="paid-lead">${esc(d.summary)}</p>` : ''}${d.thesis ? `<p class="paid-thesis">${esc(d.thesis)}</p>` : ''}
      <div class="paid-detail-grid"><section class="paid-conditions"><h3>Условия идеи</h3>${levels(d)}${hasLevels ? `<p>${esc(meta.entryRule || 'Смотрите подтверждение входа в истории публикации.')}</p><p>${esc(meta.cancelRule || '')}</p>${positive(d.current) ? `<p>Последняя цена автора: ${number(d.current)} ${esc(d.unit || '')}. Это не поток котировок.</p>` : ''}` : '<p>Идея объявлена. Автор добавит условия входа, стоп и цель отдельным обновлением.</p>'}${meta.initial ? `<div class="original-conditions"><h4>Первоначальная публикация</h4><p>${[meta.initial.entry, meta.initial.stop, meta.initial.target].every(positive) ? `Вход ${number(meta.initial.entry)} · стоп ${number(meta.initial.stop)} · цель ${number(meta.initial.target)} ${esc(d.unit || '')}` : 'Сигнал был опубликован без ценовых уровней.'}</p><p>${esc(meta.initial.entryRule || '')}</p><p>${esc(meta.initial.cancelRule || '')}</p><p>${esc(meta.published || '')} МСК</p></div>` : ''}${value === null ? '' : `<div class="scenario-result ${value < 0 ? 'result-negative' : 'result-positive'}"><span>${esc(d.outcome || 'Идея завершена')}</span><strong>${percent(value)}</strong><small>Изменение цены от входа автора, без комиссий, налогов и проскальзывания.</small></div>`}<div class="idea-links">${strategy ? `<a href="strategy.html?strategy=${encodeURIComponent(strategy.slug)}">О стратегии →</a>` : ''}<a href="brokers.html?market=${encodeURIComponent(d.market || '')}">Где торговать →</a></div><div id="personalMount"></div></section><section class="paid-history"><div class="eyebrow">ХРОНОЛОГИЯ · МСК</div><h3>Комментарии и изменения</h3>${eventMarkup(record)}</section></div>`;
    $('follow').onclick = () => toggleSaved(record.id);
    if (personalReady && positive(d.entry)) OrbitaPersonal.mount($('personalMount'), { ...d, id: record.id, erroneous: !!record.erroneous, unit: d.unit || (d.market === 'crypto' ? 'USDT' : d.market === 'futures' ? 'пт' : '₽') }, meta);
  }
  async function toggleSaved(id) {
    if (saving) return;
    const next = new Set(saved); next.has(id) ? next.delete(id) : next.add(id); saving = true;
    try { await api('/api/watchlist', { method: 'PUT', body: JSON.stringify({ ids: [...next] }) }); saved = next; renderFeed(); renderDetail(); window.dispatchEvent(new CustomEvent('orbita:watch-change')); notify(saved.has(id) ? 'Идея добавлена в отслеживаемые.' : 'Отслеживание выключено.'); }
    catch (error) { handleError(error); }
    finally { saving = false; }
  }
  function select(id, updateUrl = true) {
    selected = id; renderFeed(); renderDetail();
    if (updateUrl) { const url = new URL(location.href); url.searchParams.set('idea', id); history.replaceState(null, '', url); }
    $('ideaDetail').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  async function refresh() {
    try { await S.refresh(); records = S.read().records; renderFeed(); if (selected && !records.some(record => record.id === selected)) { selected = null; notify('Эта идея недоступна по текущей подписке.'); } renderDetail(); }
    catch (error) { handleError(error); }
  }
  document.querySelectorAll('[data-view]').forEach(button => button.onclick = () => { view = button.dataset.view; state = market = 'all'; renderFeed(); });
  document.querySelectorAll('[data-market]').forEach(button => button.onclick = () => { market = button.dataset.market; renderFeed(); });
  document.querySelectorAll('[data-status]').forEach(button => button.onclick = () => { state = button.dataset.status; renderFeed(); });
  $('cards').onclick = event => { const button = event.target.closest('[data-idea]'); if (button) select(button.dataset.idea); };
  $('back').onclick = () => { selected = null; $('ideaDetail').hidden = true; history.replaceState(null, '', location.pathname); $('signalFeed').scrollIntoView({ behavior: 'smooth' }); };
  $('refreshIdeas').onclick = refresh;
  try {
    ({ user: account } = await api('/api/me'));
    if (!account) { handleError({ status: 401 }); return; }
    $('accountLink').textContent = account.email || 'Мой аккаунт';
    await S.refresh(); records = S.read().records;
    const watch = await api('/api/watchlist'); saved = new Set(watch.ids || []);
    await OrbitaPersonal.init(account, () => { renderFeed(); renderDetail(); }); personalReady = true;
    renderFeed(); $('appStatus').textContent = '';
    const linked = new URLSearchParams(location.search).get('idea');
    if (linked) { if (records.some(record => record.id === linked)) select(linked, false); else notify('Идея не найдена или не входит в вашу подписку.'); }
    window.addEventListener('orbita:store-change', () => { records = S.read().records; renderFeed(); renderDetail(); });
    window.addEventListener('orbita:access-denied', event => handleError({ status: event.detail?.status || 403 }));
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
    setInterval(() => { if (!document.hidden) refresh(); }, 30000);
  } catch (error) { handleError(error); }
})();
