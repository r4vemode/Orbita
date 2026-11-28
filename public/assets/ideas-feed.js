/* «Стратегии»: one section, two tiers, a compact list built for 20+ ideas a day.
   The server decides what is readable; a locked tier arrives without records. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ok = v => typeof v === 'number' && Number.isFinite(v) && v > 0;
  const num = v => ok(v) ? v.toLocaleString('ru-RU', { maximumFractionDigits: 8 }) : '—';
  const MSK = { timeZone: 'Europe/Moscow' };
  const dateKeyFormat = new Intl.DateTimeFormat('en-CA', { ...MSK, year: 'numeric', month: '2-digit', day: '2-digit' });
  const timeFormat = new Intl.DateTimeFormat('ru-RU', { ...MSK, hour: '2-digit', minute: '2-digit' });
  const dayKey = iso => Number.isFinite(Date.parse(iso)) ? dateKeyFormat.format(new Date(iso)) : '';
  const hhmm = iso => Number.isFinite(Date.parse(iso)) ? timeFormat.format(new Date(iso)) : '—';
  const dayTime = new Intl.DateTimeFormat('ru-RU', { ...MSK, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const dateTime = iso => Number.isFinite(Date.parse(iso)) ? dayTime.format(new Date(iso)) + ' МСК' : '—';
  const number = (value, precision = 2) => Number.isFinite(value) ? value.toLocaleString('ru-RU', { maximumFractionDigits: precision }) : '—';
  const signedPercent = value => Number.isFinite(value) ? pct(value) : '—';
  const markets = { stocks: 'Российские акции', futures: 'Фьючерсы Мосбиржи', crypto: 'Криптовалюты' };
  const analysisLabels = { entryReason: 'Причина входа', context: 'Рыночный контекст', factors: 'Факторы решения', levels: 'Обоснование уровней', risks: 'Риски', exitReason: 'Причина закрытия' };
  const OPEN = ['announced', 'waiting', 'active'];
  const STATES = { announced: ['Объявлена', 'Уровни скоро'], waiting: ['Ждёт входа', 'Цена ещё не дошла до входа'], active: ['В сделке', 'Вход выполнен, ждём цель или стоп'], closed: ['Закрыта', ''], cancelled: ['Отменена', 'Вход не состоялся'] };
  const params = new URLSearchParams(location.search);
  let historyType = ['actual', 'demo'].includes(params.get('type')) ? params.get('type') : null;
  let tier = params.get('tab') === 'exclusive' ? 'exclusive' : 'pro';
  let quick = historyType !== null || params.get('view') === 'history' ? 'history' : null;
  let feed = null, user = null, stats = null, historyRequest = null, historyKey = null, closures = null;
  const expanded = new Set();
  const defaultViews = new Map();
  const historyButton = document.querySelector('[data-quick="history"]');
  const liveFeed = OrbitaIdeaFeedLive.watch(load, 60000);
  const tierOf = r => r.tier || (r.d?.strategy === 'Orbita Exclusive' ? 'exclusive' : 'pro');
  const rr = d => ok(d.entry) && ok(d.stop) && ok(d.target) ? Math.abs(d.target - d.entry) / Math.abs(d.entry - d.stop) : null;
  const result = OrbitaIdeaCloseState.result;
  const pct = v => (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toLocaleString('ru-RU', { maximumFractionDigits: 2 }) + '%';
  const store = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch {} } };

  function dayLabel(key) {
    const today = dayKey(new Date().toISOString()), yesterday = dayKey(new Date(Date.now() - 86400000).toISOString());
    const [y, m, d] = key.split('-');
    return (key === today ? 'Сегодня, ' : key === yesterday ? 'Вчера, ' : '') + `${d}.${m}.${y}`;
  }
  function row(r, view) {
    const d = r.d, long = d.dir !== 'ШОРТ', t = tierOf(r), ratio = rr(d), res = result(r), targets = [d.target, ...(d.targets || [])].filter(ok), open = expanded.has(r.id);
    const [state, hint] = r.erroneous ? ['Ошибка публикации', ''] : STATES[d.state] || [d.status, ''];
    const tgt = targets.length ? num(targets[0]) + (targets.length > 1 ? ` <span class="o-small">+${targets.length - 1}</span>` : '') : '—';
    return `<article class="irow${open ? ' open' : ''}${r.erroneous ? ' erroneous' : ''}" data-id="${esc(r.id)}" data-tier="${t}" data-provenance="${r.demoHistory ? 'demo' : 'actual'}">
      <button type="button" class="irow-main" aria-expanded="${open}" aria-controls="ix-${esc(r.id)}">
        <span class="c-time">${hhmm(rowDate(r, view))}</span>
        <span class="c-name"><b>${esc(d.ticker)}</b><span class="o-small">${esc(d.name && d.name !== d.ticker ? d.name : d.strategy)}</span></span>
        <span class="c-dir"><span class="o-tag ${long ? 'long' : 'short'}" title="${long ? 'Ставка на рост' : 'Ставка на падение'}">${long ? 'LONG' : 'SHORT'}</span></span>
        <span class="c-lv"><i>Вход</i>${num(d.entry)}</span>
        <span class="c-lv c-stop"><i>Стоп</i>${num(d.stop)}</span>
        <span class="c-lv c-tgt"><i>Цель</i>${tgt}</span>
        <span class="c-rr"><i>R/R</i>${ratio ? ratio.toLocaleString('ru-RU', { maximumFractionDigits: 1 }) : '—'}</span>
        <span class="c-state st-${esc(d.state)}" title="${esc(hint)}">${esc(state)}</span>
        <span class="c-res">${res !== null ? `<b class="${res >= 0 ? 'up' : 'down'}">${pct(res)}</b>` : live(r)}</span>
        <span class="c-more" aria-hidden="true">${open ? '▴' : '▾'}</span>
      </button>
      ${open ? detail(r, targets) : ''}
    </article>`;
  }
  // Estimated open result from a verified MOEX price (delayed); hidden without one.
  function live(r) {
    const q = feed?.quotes?.[String(r.d.ticker).toUpperCase()]; if (r.d.state !== 'active' || !q || !ok(r.d.entry)) return '';
    const v = (q.price / r.d.entry - 1) * (r.d.dir === 'ШОРТ' ? -100 : 100);
    return `<span class="live ${v >= 0 ? 'up' : 'down'}" title="Расчётно по цене ${num(q.price)} · ${esc(q.source)} · ${hhmm(q.providerTime)} МСК${q.delayMinutes ? ', задержка ~' + q.delayMinutes + ' мин' : ''}">сейчас ${pct(v)}</span>`;
  }
  // «Сколько брать»: capital and risk % are remembered on this device only.
  const calcPrefs = () => { try { return JSON.parse(localStorage.getItem('orbita.calc.v1')) || {}; } catch { return {}; } };
  function sizer(r) {
    const d = r.d; if (!ok(d.entry) || !ok(d.stop) || !window.OrbitaPositionCalc || r.d.state === 'closed' || r.d.state === 'cancelled') return '';
    const p = calcPrefs(), cur = d.market === 'crypto' ? 'USDT' : '₽';
    return `<div class="sizer" data-id="${esc(r.id)}"><b>Сколько брать</b><div class="sizer-in"><label>Капитал, ${cur}<input type="number" inputmode="decimal" min="1" step="any" name="capital" value="${esc(p.capital ?? '')}" placeholder="100000"></label><label>Риск, %<input type="number" inputmode="decimal" min="0.1" max="100" step="0.1" name="risk" value="${esc(p.risk ?? 1)}"></label></div><p class="sizer-out" aria-live="polite">${sizerText(r, p.capital, p.risk ?? 1)}</p></div>`;
  }
  function sizerText(r, capital, risk) {
    const d = r.d, spec = feed?.specs?.[String(d.ticker).toUpperCase()] || null, cur = d.market === 'crypto' ? 'USDT' : '₽';
    if (!capital) return 'Введите капитал — покажем, сколько лотов взять, чтобы стоп стоил не больше выбранного % капитала.';
    const res = OrbitaPositionCalc.calc({ market: d.market, entry: d.entry, stop: d.stop, capital: Number(capital), riskPct: Number(risk), spec });
    if (!res.ok) return esc(res.error);
    const money = v => Math.round(v).toLocaleString('ru-RU');
    let main = res.kind === 'stock' ? `<strong>${res.count} лот.</strong> (${res.shares} шт., ≈ ${money(res.value)} ₽)` : res.kind === 'future' ? `<strong>${res.count} контр.</strong>${res.margin ? ` · ГО ≈ ${money(res.margin)} ₽` : ''}` : `<strong>${res.count.toLocaleString('ru-RU')} ${esc(d.ticker.split('/')[0])}</strong> (≈ ${money(res.value)} ${cur})`;
    return `${main} · при стопе потеря ≈ ${money(res.actualRisk)} ${cur} из допустимых ${money(res.riskMoney)}${res.warnings.length ? `<span class="sizer-warn">${res.warnings.map(esc).join(' ')}</span>` : ''}<span class="o-small">Без комиссий и проскальзывания.</span>`;
  }
  function demoAnalysis(analysis) {
    if (!analysis) return '';
    const sections = Object.entries(analysisLabels).map(([field, title]) =>
      `<div><dt>${title}</dt><dd>${esc(analysis[field])}</dd></div>`).join('');
    return `<section class="ix-analysis"><h3>Аналитический разбор</h3><dl>${sections}</dl></section>`;
  }
  function demoSource(url) {
    if (typeof url !== 'string') return '';
    try {
      const source = new URL(url);
      if (source.protocol !== 'https:') return '';
      const name = source.hostname === 'iss.moex.com' ? 'MOEX ISS' : /(^|\.)bybit\.com$/.test(source.hostname) ? 'Bybit' : 'Биржевой источник';
      return `<a href="${esc(source.href)}" target="_blank" rel="noopener noreferrer">Свечи · ${name}</a>`;
    } catch { return ''; }
  }
  function detail(r, targets) {
    const d = r.d, t = tierOf(r);
    const facts = [['Стратегия', `<span class="o-tag ${t}">${t === 'exclusive' ? 'EXCLUSIVE' : 'PRO'}</span> ${esc(d.strategy)}`], ['Горизонт', esc(d.horizon || '—')], ['Цели', targets.map(num).join(' → ') || '—'], ['Единица', esc(d.unit || '—')]];
    if (r.demoHistory) {
      facts.push(['Тип истории', 'Исторический сценарий'], ['Рынок', markets[d.market] || '—'],
        ['Открытие', `${num(d.entry)} · ${dateTime(r.meta?.enteredAt)}`], ['Закрытие', `${num(r.meta?.exit)} · ${dateTime(r.meta?.closedAt)}`]);
      const source = demoSource(d.chartUrl);
      if (source) facts.push(['Источник', source]);
    }
    if (r.localMarketHistory) {
      facts.push(['Выход', `${num(r.meta?.exit)} · ${hhmm(r.meta?.closedAt)} МСК`]);
      if (d.chartUrl?.startsWith('https://iss.moex.com/iss/')) facts.push(['Источник', `<a href="${esc(d.chartUrl)}" target="_blank" rel="noopener noreferrer">Свечи MOEX ISS</a>`]);
    }
    return `<div class="irow-detail" id="ix-${esc(r.id)}">
      <div class="ix-text">${d.summary ? `<p>${esc(d.summary)}</p>` : ''}${d.entryRule ? `<p><b>Условие входа:</b> ${esc(d.entryRule)}</p>` : ''}${d.cancelRule ? `<p><b>Отмена и выход:</b> ${esc(d.cancelRule)}</p>` : ''}
        <dl class="ix-facts">${facts.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>
        ${r.demoHistory ? demoAnalysis(d.analysis) : `${sizer(r)}<a class="o-btn o-btn-secondary" href="/app.html?idea=${encodeURIComponent(r.id)}">Полный разбор и история →</a>`}</div>
      <div class="ix-chart">${window.OrbitaIdeaChart ? OrbitaIdeaChart.svg(r) : ''}</div>
    </div>`;
  }
  function locked(kind) {
    const box = $('feedLocked');
    if (kind === 'guest') box.innerHTML = '<h2>Войдите, чтобы видеть идеи</h2><p>Идеи доступны по тарифам PRO и EXCLUSIVE.</p><a class="o-btn o-btn-primary" href="/account.html?next=%2Fstrategies.html">Войти</a> <a class="o-btn o-btn-secondary" href="/account.html?mode=register">Создать аккаунт</a>';
    else if (kind === 'none') box.innerHTML = '<h2>Подключите тариф, чтобы видеть идеи</h2><p><b>PRO</b> — краткосрочные идеи (дейтрейдинг): вход, стоп и цель по каждой. <b>EXCLUSIVE</b> — всё из PRO плюс премиальная лента с расширенным разбором.</p><a class="o-btn o-btn-primary" href="/subscriptions.html?plan=pro&next=%2Fstrategies.html">Подключить PRO</a> <a class="o-btn o-btn-secondary" href="/subscriptions.html?plan=exclusive&next=%2Fstrategies.html">Подключить EXCLUSIVE</a>';
    else box.innerHTML = '<h2>Лента EXCLUSIVE</h2><p>Премиальные идеи с расширенным разбором. Тариф EXCLUSIVE включает все возможности PRO.</p><a class="o-btn o-btn-primary" href="/subscriptions.html?plan=exclusive&next=%2Fstrategies.html%3Ftab%3Dexclusive">Повысить тариф до EXCLUSIVE</a>';
    box.hidden = false;
  }
  const quickMatch = (r, q) => q === 'open' ? OPEN.includes(r.d.state) && !r.erroneous : q === 'active' ? r.d.state === 'active' && !r.erroneous : q === 'waiting' ? ['waiting', 'announced'].includes(r.d.state) && !r.erroneous : !OPEN.includes(r.d.state) || r.erroneous;
  const rowDate = (r, view) => view === 'history' ? r.meta?.closedAt || r.meta?.publishedAt : r.meta?.publishedAt;
  function filtered(rows, view) {
    const q = $('fTicker').value.trim().toUpperCase(), dir = $('fDir').value, market = $('fMarket').value, strategy = $('fStrategy').value, from = $('fFrom').value;
    return rows.filter(r => quickMatch(r, view) && (!q || String(r.d.ticker).toUpperCase().includes(q) || String(r.d.name || '').toUpperCase().includes(q))
      && (!dir || r.d.dir === dir) && (!market || r.d.market === market) && (!strategy || r.d.strategy === strategy) && (!from || dayKey(rowDate(r, view)) >= from));
  }
  function capitalChart(points) {
    const values = points.filter(point => Number.isFinite(point.value));
    if (values.length < 2) return '';
    const first = values[0], last = values.at(-1);
    const minimum = Math.min(...values.map(point => point.value)), maximum = Math.max(...values.map(point => point.value));
    const range = maximum - minimum || 1;
    const x = i => 8 + i / (values.length - 1) * 624;
    const y = value => 16 + (maximum - value) / range * 144;
    const line = values.map((point, i) => `${i ? 'L' : 'M'} ${x(i).toFixed(2)} ${y(point.value).toFixed(2)}`).join(' ');
    const description = `Капитал от ${number(first.value)} до ${number(last.value)} условных единиц`;
    return `<figure class="history-capital"><figcaption>Динамика капитала</figcaption>
      <svg viewBox="0 0 640 176" role="img" aria-label="${esc(description)}">
        <path class="capital-base" d="M 8 ${y(first.value)} H 632"/>
        <path class="capital-line" d="${line}"/>
      </svg><p class="o-small">${esc(description)} · по закрытиям в хронологическом порядке</p>
    </figure>`;
  }
  function monthlyTable(months) {
    if (!months.length) return '';
    const label = month => { const [year, monthNumber] = month.split('-'); return `${monthNumber}.${year}`; };
    return `<details class="history-months"><summary>Помесячная результативность</summary><table>
      <thead><tr><th scope="col">Месяц</th><th scope="col">Сделок</th><th scope="col">Плюс / минус</th><th scope="col">Доходность</th></tr></thead>
      <tbody>${months.map(month => `<tr><th scope="row">${esc(label(month.month))}</th><td>${number(month.closedTrades, 0)}</td><td>${number(month.wins, 0)} / ${number(month.losses, 0)}</td><td>${signedPercent(month.returnPercent)}</td></tr>`).join('')}</tbody>
    </table></details>`;
  }
  function historyStatsMarkup(data, type, strategy, market) {
    const label = type === 'demo' ? 'Исторические сценарии' : 'Опубликованные идеи';
    const params = new URLSearchParams({ type, tier });
    if (strategy) params.set('strategy', strategy);
    if (market) params.set('market', market);
    const { initialCapital, positionNotional } = data.settings;
    const percent = value => Number.isFinite(value) ? `${number(value)}%` : '—';
    const items = [
      ['Закрыто сделок', number(data.closedTrades, 0)], ['Win Rate', percent(data.winRate)],
      ['Совокупная доходность', signedPercent(data.totalReturnPercent)], ['Profit Factor', number(data.profitFactor)],
      ['Максимальная просадка', percent(data.maxDrawdownPercent)], ['Средняя прибыль', signedPercent(data.averageWinPercent)],
      ['Средний убыток', signedPercent(data.averageLossPercent)]
    ];
    return `<h2>${label} · статистика</h2><dl class="history-stat-metrics">${items.map(([name, value]) => `<div><dt>${name}</dt><dd>${value}</dd></div>`).join('')}</dl>
      <p class="o-small">Для выбранного рынка и стратегии. Модель капитала начинается со ${number(initialCapital)} условных единиц, размер каждой позиции ${number(positionNotional)}. Расчёт без плеча и комиссий.</p>
      ${capitalChart(data.capital)}${monthlyTable(data.monthly)}
      <a class="o-btn o-btn-secondary history-calculator" href="/calculator.html?${esc(params.toString())}">Открыть в калькуляторе доходности</a>`;
  }
  function renderHistoryStats(type) {
    const box = $('feedHistoryStats');
    if (!type) {
      historyRequest?.abort(); historyRequest = null; historyKey = null; box.hidden = true; return;
    }
    const market = $('fMarket').value, strategy = $('fStrategy').value;
    const query = new URLSearchParams({ tier, type });
    if (market) query.set('market', market);
    if (strategy) query.set('strategy', strategy);
    const key = query.toString();
    box.hidden = false;
    if (key === historyKey) return;
    historyRequest?.abort();
    const request = new AbortController();
    historyRequest = request; historyKey = key;
    box.textContent = 'Загружаем статистику…';
    fetch('/api/history/statistics?' + key, { cache: 'no-store', credentials: 'same-origin', signal: request.signal })
      .then(response => { if (!response.ok) throw Error(); return response.json(); })
      .then(data => { if (historyRequest === request) box.innerHTML = historyStatsMarkup(data, type, strategy, market); })
      .catch(() => { if (historyRequest === request && !request.signal.aborted) box.textContent = 'Статистика временно недоступна.'; });
  }
  function renderStats() {
    const box = $('feedStats'), s = stats?.[tier];
    if (!s || !s.closed) { box.hidden = true; return; }
    box.hidden = false;
    box.innerHTML = `<div><span class="o-small">Закрыто идей ${tier === 'exclusive' ? 'EXCLUSIVE' : 'PRO'}</span><b>${s.closed}</b></div><div><span class="o-small">Закрыты в плюсе</span><b>${s.winRate.toLocaleString('ru-RU', { maximumFractionDigits: 0 })}%</b></div><div><span class="o-small">Средний результат</span><b class="${s.avgPct >= 0 ? 'up' : 'down'}">${pct(s.avgPct)}</b></div><div><span class="o-small">Средний итог в рисках</span><b>${s.avgR === null ? '—' : (s.avgR > 0 ? '+' : '') + s.avgR.toLocaleString('ru-RU', { maximumFractionDigits: 2 }) + 'R'}</b></div><p class="o-small">По всем закрытым идеям с ценой выхода, без комиссий. Прошлые результаты не гарантируют будущих. <a href="/results.html?type=actual">Все идеи с уровнями →</a></p>`;
  }
  function render() {
    const all = user && feed ? feed.records.filter(r => r.published && !r.archived && tierOf(r) === tier) : [];
    const hasDemoHistory = Boolean(user && feed?.demoHistory);
    const legacyLocal = Boolean(user && !hasDemoHistory && feed?.localMarketHistory && all.some(r => r.localMarketHistory));
    const actual = all.filter(r => !r.demo && !r.isDemo && !r.demoHistory && quickMatch(r, 'history'));
    const demo = all.filter(r => r.demoHistory && quickMatch(r, 'history'));
    const activeHistoryType = hasDemoHistory ? historyType ?? (demo.length ? 'demo' : 'actual') : 'actual';
    const historyRows = !hasDemoHistory ? all : activeHistoryType === 'demo' ? demo : actual;
    const openRows = all.filter(r => !r.demoHistory);
    const hasOpen = openRows.some(r => quickMatch(r, 'open'));
    if (feed && !feed.locked?.includes(tier) && !defaultViews.has(tier)) {
      defaultViews.set(tier, hasOpen || closures?.unread(tier) ? 'open' : 'history');
    }
    const view = quick ?? defaultViews.get(tier) ?? 'open';
    for (const tab of document.querySelectorAll('.o-tab')) { const on = tab.dataset.tier === tier; tab.setAttribute('aria-selected', String(on)); tab.tabIndex = on ? 0 : -1; }
    for (const b of document.querySelectorAll('[data-quick]')) b.setAttribute('aria-pressed', String(b.dataset.quick === view));
    $('feedLocalHistory').hidden = !legacyLocal || view !== 'history';
    $('feedHistoryType').hidden = true;
    $('feedDemoNote').hidden = activeHistoryType !== 'demo';
    for (const b of $('feedHistoryType').querySelectorAll('[data-history-type]')) b.setAttribute('aria-pressed', String(b.dataset.historyType === activeHistoryType));
    $('feedPanel').setAttribute('aria-labelledby', 'tab-' + tier);
    $('feedSkeleton').hidden = true; $('feedLocked').hidden = true; $('feedEmpty').hidden = true; $('feedList').innerHTML = '';
    if (view === 'history' && !legacyLocal && user && feed && !feed.locked?.includes(tier)) $('feedStats').hidden = true;
    else renderStats();
    showHistoryCount();
    const hideTools = () => { $('feedFilters').hidden = true; $('feedQuick').hidden = true; renderHistoryStats(null); };
    if (!user) { hideTools(); locked('guest'); return; }
    if (!feed) { hideTools(); locked('none'); return; }
    for (const t of ['pro', 'exclusive']) {
      const count = feed.records.filter(r => r.published && !r.archived && !r.demoHistory && tierOf(r) === t && quickMatch(r, 'open')).length;
      document.querySelector(`[data-count="${t}"]`).textContent = feed.locked?.includes(t) ? '🔒' : `Открытых ${count}`;
    }
    if (feed.locked?.includes(tier)) { hideTools(); locked(tier === 'pro' ? 'none' : 'upgrade'); return; }
    const sourceRows = view === 'history' ? historyRows : openRows;
    $('actualHistoryCount').textContent = actual.length;
    $('demoHistoryCount').textContent = demo.length;
    for (const q of ['open', 'active', 'waiting']) {
      document.querySelector(`[data-qc="${q}"]`).textContent = openRows.filter(r => quickMatch(r, q)).length;
    }
    const strategies = [...new Set(sourceRows.filter(r => quickMatch(r, view)).map(r => r.d.strategy))].sort(), select = $('fStrategy'), current = select.value;
    select.innerHTML = '<option value="">Все</option>' + strategies.map(s => `<option${s === current ? ' selected' : ''}>${esc(s)}</option>`).join('');
    $('feedFilters').hidden = false; $('feedQuick').hidden = false;
    $('feedHistoryType').hidden = !hasDemoHistory || view !== 'history';
    renderHistoryStats(view === 'history' && !legacyLocal ? activeHistoryType : null);
    const rows = filtered(sourceRows, view).sort((a, b) => (Date.parse(rowDate(b, view)) || 0) - (Date.parse(rowDate(a, view)) || 0));
    $('feedEmpty').hidden = rows.length > 0;
    if (!rows.length) $('feedEmpty').textContent = view === 'open' && !openRows.length ? 'Новых идей пока нет. Мы пришлём уведомление, когда автор опубликует идею — настройте его в разделе «Уведомления».' : 'Нет идей по выбранным условиям.';
    const groups = new Map(); for (const r of rows) { const k = dayKey(rowDate(r, view)); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
    $('feedList').innerHTML = [...groups].map(([k, list]) => `<section class="iday"><h2 class="iday-head">${k ? dayLabel(k) : 'Без даты'} <span class="o-small">${list.length}</span></h2><div class="iday-head-cols" aria-hidden="true"><span>${view === 'history' ? 'Закрытие' : 'Время'}</span><span>Инструмент</span><span></span><span>Вход</span><span>Стоп</span><span>Цель</span><span>R/R</span><span>Статус</span><span>Итог</span><span></span></div>${list.map(r => row(r, view)).join('')}</section>`).join('');
  }
  function syncLocation() {
    const query = new URLSearchParams();
    if (tier === 'exclusive') query.set('tab', 'exclusive');
    if (quick === 'history') {
      query.set('view', 'history');
      if (historyType) query.set('type', historyType);
    }
    history.replaceState(null, '', query.size ? '?' + query : location.pathname);
  }
  function welcome() {
    const kind = params.get('welcome'), box = $('feedWelcome'); if (!kind || !user) return;
    const plan = params.get('plan');
    if (kind === 'paid') box.innerHTML = '<b>Оплата прошла — доступ открыт.</b> Ниже ваши идеи. Начните с вкладки «Открытые»: там идеи, по которым ещё можно войти.';
    else box.innerHTML = `<b>Аккаунт создан.</b> ${user.emailVerified ? '' : 'Подтвердите email (ссылка в письме или в <a href="/security.html">Настройках</a>) — это нужно для оплаты. '}Чтобы видеть идеи, <a href="/subscriptions.html${plan ? '?plan=' + encodeURIComponent(plan) : ''}">подключите тариф</a>.`;
    box.hidden = false; syncLocation();
  }
  function catalog() {
    const list = window.ORBITA_STRATEGIES || [];
    $('feedCatalog').innerHTML = '<ul class="feed-catalog">' + list.map(s => `<li><a href="/strategy.html?strategy=${encodeURIComponent(s.slug)}">${esc(s.name)}</a> <span class="o-tag ${s.exclusive ? 'exclusive' : 'pro'}">${s.exclusive ? 'EXCLUSIVE' : 'PRO'}</span> <span class="o-small">${esc(s.horizon)} · ${esc(s.description)}</span></li>`).join('') + '</ul>';
  }
  function showHistoryCount() {
    OrbitaIdeaFeedLive.showUnread(historyButton, closures?.unread(tier) || 0);
  }
  function acknowledgeHistory() {
    if (!closures?.unread(tier)) return;
    $('feedFilters').reset();
    historyType = 'actual';
    closures.acknowledge(tier);
  }
  function acceptFeed(body) {
    const tiers = body.access?.tiers ?? ['pro', 'exclusive'].filter(value => !body.locked?.includes(value));
    if (feed?.access?.tiers?.some(value => !tiers.includes(value))) OrbitaIdeaCloseMotion.cancel();
    const next = closures.update(body.records, tiers, body.observedAt);
    if ((quick ?? defaultViews.get(tier)) !== 'history') {
      for (const record of next) {
        if (tierOf(record) !== tier) continue;
        const row = $('feedList').querySelector(`.irow[data-id="${CSS.escape(record.id)}"]`);
        if (row) void OrbitaIdeaCloseMotion.fly(row, historyButton, result(record));
      }
    }
    feed = body;
    liveFeed.setEligible(tiers.length > 0);
  }
  async function load() {
    const hadFeed = Boolean(feed);
    const connection = new AbortController();
    const signal = connection.signal;
    const timeout = setTimeout(() => connection.abort(), 15000);
    try {
      const [me, st] = await Promise.all([fetch('/api/me', { credentials: 'same-origin', cache: 'no-store', signal }).then(async response => {
        if (response.status === 401) return { user: null };
        if (!response.ok) throw Error('Не удалось проверить аккаунт.');
        return response.json();
      }), fetch('/api/public/stats', { cache: 'no-store', signal }).then(r => r.ok ? r.json() : null).catch(() => null)]);
      if (user?.id !== me.user?.id || !me.user) {
        liveFeed.setEligible(false);
        feed = null;
        defaultViews.clear();
        expanded.clear();
        closures = me.user ? OrbitaIdeaCloseState.create(me.user.id) : null;
      }
      user = me.user;
      stats = st?.stats || null;
      if (!user?.access?.hasSubscription) {
        feed = null;
        closures?.update([], []);
        liveFeed.setEligible(false);
      }
      if (!feed && (hadFeed || !user?.access?.hasSubscription)) render();
      if (user?.access?.hasSubscription) {
        const r = await fetch('/api/ideas', { credentials: 'same-origin', cache: 'no-store', signal }), body = await r.json().catch(() => ({}));
        if ([401, 403].includes(r.status) || r.ok && body.viewerId !== user.id) {
          feed = null;
          closures.update([], []);
          liveFeed.setEligible(false);
          if (r.status === 401) user = null;
        } else if (!r.ok || !Array.isArray(body.records)) throw Error(body.error || 'Не удалось загрузить идеи.');
        else acceptFeed(body);
      }
      $('feedError').hidden = !feed?.demoHistoryError;
      if (feed?.demoHistoryError) $('feedError').textContent = 'Исторические сценарии временно недоступны.';
      $('feedUpdated').textContent = 'Обновлено в ' + new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' }).format(new Date());
    } catch (e) { $('feedError').hidden = false; $('feedError').textContent = e.message + ' Показаны последние загруженные данные.'; }
    finally { clearTimeout(timeout); }
    historyKey = null; welcome(); render();
  }
  if (store.get('orbita.howto.hidden') === '1' && !params.get('welcome')) $('feedHowto').open = false;
  $('howtoHide').addEventListener('click', () => { $('feedHowto').open = false; store.set('orbita.howto.hidden', '1'); });
  document.querySelector('.o-tabs').addEventListener('click', e => { const tab = e.target.closest('.o-tab'); if (!tab) return; tier = tab.dataset.tier; syncLocation(); render(); });
  document.querySelector('.o-tabs').addEventListener('keydown', e => { if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return; e.preventDefault(); tier = tier === 'pro' ? 'exclusive' : 'pro'; syncLocation(); render(); $('tab-' + tier).focus(); });
  $('feedQuick').addEventListener('click', e => {
    const b = e.target.closest('[data-quick]'); if (!b) return;
    quick = b.dataset.quick;
    if (quick === 'history') acknowledgeHistory();
    syncLocation(); render();
  });
  $('feedHistoryType').addEventListener('click', e => {
    const b = e.target.closest('[data-history-type]'); if (!b) return;
    historyType = b.dataset.historyType;
    quick = 'history';
    if (historyType === 'actual') acknowledgeHistory();
    syncLocation(); render();
  });
  $('feedList').addEventListener('click', e => { const b = e.target.closest('.irow-main'); if (!b) return; const id = b.closest('.irow').dataset.id; expanded.has(id) ? expanded.delete(id) : expanded.add(id); render(); document.querySelector(`.irow[data-id="${CSS.escape(id)}"] .irow-main`)?.focus(); });
  $('feedList').addEventListener('input', e => {
    const box = e.target.closest('.sizer'); if (!box) return;
    const capital = box.querySelector('[name=capital]').value, risk = box.querySelector('[name=risk]').value;
    try { localStorage.setItem('orbita.calc.v1', JSON.stringify({ capital: capital ? Number(capital) : null, risk: risk ? Number(risk) : 1 })); } catch {}
    const r = feed?.records.find(x => x.id === box.dataset.id); if (r) box.querySelector('.sizer-out').innerHTML = sizerText(r, Number(capital), Number(risk));
  });
  $('feedFilters').addEventListener('input', render); $('feedFilters').addEventListener('submit', e => e.preventDefault());
  $('resetFeedFilters').addEventListener('click', () => { $('feedFilters').reset(); render(); });
  $('fFrom').addEventListener('change', render);
  window.addEventListener('storage', event => {
    if (closures && (event.key === closures.key || event.key === null)) showHistoryCount();
  });
  $('feedFiltersBox').open = matchMedia('(min-width: 768px)').matches;
  catalog(); void liveFeed.refresh();
})();
