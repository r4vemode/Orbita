(async () => {
  const S = OrbitaStore, $ = id => document.getElementById(id), esc = S.escape;
  const positive = value => typeof value === 'number' && Number.isFinite(value) && value > 0;
  const number = value => positive(value) ? value.toLocaleString('ru-RU', { maximumFractionDigits: 8 }) : '—';
  const percent = value => (value > 0 ? '+' : '') + value.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + '%';
  const status = record => record.erroneous ? 'Ошибочная публикация' : record.d.status || ({ announced: 'Сигнал объявлен', waiting: 'Ожидает входа', active: 'Активен', closed: 'Завершён', cancelled: 'Отменён' }[record.d.state] || 'Опубликован');
  const marketName = value => ({ stocks: 'Акции', futures: 'Фьючерсы', crypto: 'Криптовалюты' }[value] || 'Рынок');
  let records = [], account, saved = new Set(), view = 'all', market = 'all', state = 'all', selected = null, spotlight = null, saving = false, personalReady = false, redirecting = false;
  async function api(url, options = {}) {
    const response = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers }, credentials: 'same-origin', cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) { const error = new Error(data.error || 'Не удалось получить данные.'); error.status = response.status; throw error; }
    return data;
  }
  function handleError(error) {
    if (error.status === 401 || error.status === 403) { if (redirecting) return; redirecting = true; location.replace(error.status === 401 ? 'account.html?next=' + encodeURIComponent(location.pathname + location.search) : 'subscriptions.html'); return; }
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
  function renderStage() {
    const rows = visible(), record = records.find(item => item.id === selected) || rows.find(item => item.id === spotlight) || rows[0];
    const stage = $('signalStage');
    const expanded = !!selected && record?.id === selected;
    stage.classList.toggle('is-empty', !record);
    stage.classList.toggle('detail-mode', expanded);
    $('back').hidden = $('signalDetail').hidden = $('signalChartTitle').hidden = !expanded;
    $('signalSwitcher').hidden = !record;
    if (!record) { $('signalScene').innerHTML = ''; $('signalStory').innerHTML = ''; $('signalDetail').innerHTML = ''; $('signalChartTitle').textContent = ''; return; }
    spotlight = record.id;
    const d = record.d, meta = record.meta || {}, hasLevels = [d.entry, d.stop, d.target].every(positive);
    const position = rows.findIndex(item => item.id === record.id);
    $('signalCounter').textContent = `${String(Math.max(0, position) + 1).padStart(2, '0')} / ${String(rows.length).padStart(2, '0')}`;
    $('previousSignal').disabled = $('nextSignal').disabled = rows.length < 2;
    $('signalScene').innerHTML = OrbitaSignalVisual.markup(record, {scope:'stage'});
    $('signalChartTitle').innerHTML = `${esc(d.ticker)} <small>${esc(d.dir)} · уровни автора</small>`;
    $('signalStory').innerHTML = `<span class="tag signal-tag ${d.dir === 'ШОРТ' ? 'direction-short' : 'direction-long'}">${esc(d.dir)} · ${esc(status(record))}</span><div class="ticker${d.ticker.length > 6 ? ' ticker-long' : ''}">${esc(d.ticker)}</div><div class="eyebrow">${esc(d.name || d.strategy)}</div><p>${esc(d.summary || d.title)}</p><button class="explore" id="openSignal" type="button">Разобрать идею <span class="signal-arrow" aria-hidden="true"></span></button>`;
    $('openSignal').onclick = () => select(record.id);
    $('signalDetail').innerHTML = `<div class="eyebrow">${esc(d.strategy)} / ${esc(d.dir)}</div><h2>${esc(d.ticker)}</h2><span class="tag">${esc(status(record))}</span><p class="detail-updated">Обновлено ${esc(meta.updated || meta.published || 'при публикации')} МСК${record.demo ? ' · Учебный пример' : ''}</p><h3>${esc(d.title || `${d.ticker} · ${d.dir}`)}</h3>${d.thesis ? `<p>${esc(d.thesis)}</p>` : d.summary ? `<p>${esc(d.summary)}</p>` : ''}${hasLevels ? `<div class="metrics"><div><span>Вход</span><b>${number(d.entry)} ${esc(d.unit)}</b></div><div><span>Стоп сейчас</span><b>${number(d.stop)} ${esc(d.unit)}</b></div><div><span>Цель</span><b>${number(d.target)} ${esc(d.unit)}</b></div><div><span>Горизонт</span><b>${esc(d.horizon || 'Уточняется автором')}</b></div></div>` : '<p class="announced-note">Уровни ещё не опубликованы. Автор добавит условия входа, стоп и цель отдельным обновлением.</p>'}<button class="explore" id="follow" type="button" aria-pressed="${saved.has(record.id)}">${saved.has(record.id) ? '✓ Отслеживается' : 'Следить за идеей'} <span class="signal-arrow" aria-hidden="true"></span></button><p class="visual-note">Схема показывает условия идеи. Биржевые котировки не подключены.</p>`;
    $('follow').onclick = () => toggleSaved(record.id);
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
      const visualState = record.erroneous ? 'error' : ['announced','waiting','active','closed','cancelled'].includes(d.state) ? d.state : 'waiting';
      return `<button type="button" class="idea signal-card${record.id === selected ? ' selected' : ''}" data-idea="${esc(record.id)}" aria-pressed="${record.id === selected}"><div class="row"><span class="signal-market">${esc(marketName(d.market))}${record.demo ? ' · учебная идея' : ''}</span><span class="signal-state state-${visualState}"><i aria-hidden="true"></i>${esc(status(record))}</span></div><div class="row signal-identity"><strong>${esc(d.ticker)}</strong><span class="signal-direction ${d.dir === 'ШОРТ' ? 'direction-short' : 'direction-long'}">${d.dir === 'ШОРТ' ? '↓' : '↑'} ${esc(d.dir)}</span></div><div class="signal-name">${esc(d.strategy)}</div><div class="card-signal-visual" aria-hidden="true">${OrbitaSignalVisual.markup(record, {compact:true,scope:'card'})}</div><p class="signal-title">${esc(title)}</p>${d.summary ? `<p class="signal-summary">${esc(d.summary)}</p>` : ''}${levels(d)}${value === null ? '' : `<div class="history-result ${value < 0 ? 'is-negative' : 'is-positive'}"><strong>${percent(value)}</strong><span>По цене инструмента<br>без издержек</span></div>`}${personalReady ? OrbitaPersonal.card({ ...d, id: record.id }, record.meta || {}) : ''}<div class="row signal-footer"><span>${saved.has(record.id) ? '✓ Отслеживается' : esc(d.horizon || 'Новый сигнал')}</span><span class="signal-open">Разобрать идею <i class="signal-arrow" aria-hidden="true"></i></span></div></button>`;
    }).join('');
    $('feedEmpty').hidden = !!rows.length;
    $('feedEmptyText').textContent = view === 'saved' ? 'Откройте идею и нажмите «Следить за идеей».' : records.length ? 'Измените фильтры, чтобы увидеть другие идеи.' : 'Автор ещё не опубликовал идеи по вашей подписке.';
    renderStage();
  }
  function eventMarkup(record) {
    const events = Array.isArray(record.meta?.events) ? record.meta.events : [];
    return events.length ? `<ol class="event-list">${events.map((event, index) => `<li class="${index === events.length - 1 ? 'event-latest' : ''}"><span class="event-time">${esc(event[0])} МСК</span><h4>${esc(event[1])}</h4><p>${esc(event[2])}</p></li>`).join('')}</ol>` : '<p>У этой публикации пока нет отдельных обновлений.</p>';
  }
  function renderDetail() {
    const record = records.find(item => item.id === selected);
    if (!record) { $('ideaDetail').hidden = true; renderStage(); return; }
    const d = record.d, meta = record.meta || {}, value = result(record), hasLevels = [d.entry, d.stop, d.target].every(positive), strategy = (window.ORBITA_STRATEGIES || []).find(item => item.name === d.strategy);
    $('ideaDetail').hidden = false;
    $('detailContent').innerHTML = `<div class="paid-detail-heading"><div class="eyebrow">ПЛАН И СОПРОВОЖДЕНИЕ / ${esc(d.ticker)}</div><p class="detail-updated">${esc(meta.updated || meta.published || '')} МСК</p></div>${record.erroneous ? `<p class="error-publication">Ошибочная публикация: ${esc(meta.errorReason || 'Причина указана в истории.')}. Сохранена для проверки и исключена из расчётов.</p>` : ''}
      <div class="paid-detail-grid"><section class="paid-conditions"><h3>Условия идеи</h3>${levels(d)}${hasLevels ? `<p>${esc(meta.entryRule || 'Смотрите подтверждение входа в истории публикации.')}</p><p>${esc(meta.cancelRule || '')}</p>${positive(d.current) ? `<p>Последняя цена автора: ${number(d.current)} ${esc(d.unit || '')}. Это не поток котировок.</p>` : ''}` : '<p>Идея объявлена. Автор добавит условия входа, стоп и цель отдельным обновлением.</p>'}${meta.initial ? `<div class="original-conditions"><h4>Первоначальная публикация</h4><p>${[meta.initial.entry, meta.initial.stop, meta.initial.target].every(positive) ? `Вход ${number(meta.initial.entry)} · стоп ${number(meta.initial.stop)} · цель ${number(meta.initial.target)} ${esc(d.unit || '')}` : 'Сигнал был опубликован без ценовых уровней.'}</p><p>${esc(meta.initial.entryRule || '')}</p><p>${esc(meta.initial.cancelRule || '')}</p><p>${esc(meta.published || '')} МСК</p></div>` : ''}${value === null ? '' : `<div class="scenario-result ${value < 0 ? 'result-negative' : 'result-positive'}"><span>${esc(d.outcome || 'Идея завершена')}</span><strong>${percent(value)}</strong><small>Изменение цены от входа автора, без комиссий, налогов и проскальзывания.</small></div>`}<div class="idea-links">${strategy ? `<a href="strategy.html?strategy=${encodeURIComponent(strategy.slug)}">О стратегии →</a>` : ''}<a href="brokers.html?market=${encodeURIComponent(d.market || '')}">Где торговать →</a></div><div id="personalMount"></div></section><section class="paid-history"><div class="eyebrow">ХРОНОЛОГИЯ · МСК</div><h3>Комментарии и изменения</h3>${eventMarkup(record)}</section></div>`;
    renderStage();
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
    selected = spotlight = id; renderFeed(); renderDetail();
    if (updateUrl) { const url = new URL(location.href); url.searchParams.set('idea', id); history.replaceState(null, '', url); }
    $('signalStage').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  async function refresh() {
    try { await S.refresh(); records = S.read().records; renderFeed(); if (selected && !records.some(record => record.id === selected)) { selected = null; notify('Эта идея недоступна по текущей подписке.'); } renderDetail(); }
    catch (error) { handleError(error); }
  }
  function closeDetail(scroll = true) { selected = null; $('ideaDetail').hidden = true; const url = new URL(location.href); url.searchParams.delete('idea'); history.replaceState(null, '', url); renderFeed(); if (scroll) $('signalFeed').scrollIntoView({ behavior: 'smooth' }); }
  document.querySelectorAll('[data-view]').forEach(button => button.onclick = () => { view = button.dataset.view; state = market = 'all'; closeDetail(false); });
  document.querySelectorAll('[data-market]').forEach(button => button.onclick = () => { market = button.dataset.market; closeDetail(false); });
  document.querySelectorAll('[data-status]').forEach(button => button.onclick = () => { state = button.dataset.status; closeDetail(false); });
  $('cards').onclick = event => { const button = event.target.closest('[data-idea]'); if (button) select(button.dataset.idea); };
  $('back').onclick = () => closeDetail();
  function stepSignal(delta) { const rows = visible(); if (!rows.length) return; const index = rows.findIndex(record => record.id === (selected || spotlight)), next = rows[(Math.max(0,index) + delta + rows.length) % rows.length]; if (selected) select(next.id); else { spotlight = next.id; renderStage(); } }
  $('previousSignal').onclick = () => stepSignal(-1); $('nextSignal').onclick = () => stepSignal(1);
  document.addEventListener('keydown', event => { if (event.target.closest('input,textarea,select,[contenteditable="true"]') || document.querySelector('dialog[open]')) return; if (event.key === 'Escape' && selected) closeDetail(); if (event.key === 'ArrowLeft') { event.preventDefault(); stepSignal(-1); } if (event.key === 'ArrowRight') { event.preventDefault(); stepSignal(1); } });
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
