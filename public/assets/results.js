(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = v => typeof v === 'number' && Number.isFinite(v) ? v.toLocaleString('ru-RU', { maximumFractionDigits: 8 }) : '—';
  const sgn = (v, d = 2) => typeof v === 'number' && Number.isFinite(v) ? (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toLocaleString('ru-RU', { maximumFractionDigits: d }) : '—';
  const moscow = { timeZone: 'Europe/Moscow' };
  const calendar = new Intl.DateTimeFormat('ru-RU', { ...moscow, day: '2-digit', month: '2-digit', year: 'numeric' });
  const clock = new Intl.DateTimeFormat('ru-RU', { ...moscow, hour: '2-digit', minute: '2-digit' });
  const day = iso => Number.isFinite(Date.parse(iso)) ? calendar.format(new Date(iso)) : '—';
  const time = iso => Number.isFinite(Date.parse(iso)) ? clock.format(new Date(iso)) : '—';
  function sourceLink(url) {
    if (typeof url !== 'string') return '';
    try {
      const source = new URL(url);
      if (source.protocol !== 'https:' || source.username || source.password) return '';
      let name;
      if (source.hostname === 'iss.moex.com' && source.pathname.startsWith('/iss/')) name = 'MOEX ISS';
      if (['api.bybit.com', 'api.bybitglobal.com'].includes(source.hostname) && source.pathname === '/v5/market/kline') name = 'Bybit';
      return name ? ` <a class="results-source" href="${esc(source.href)}" target="_blank" rel="noopener noreferrer">${name}</a>` : '';
    } catch { return ''; }
  }
  const filters = new URLSearchParams(location.search), from = $('resultsFrom');
  const requestedTier = filters.get('tier'), local = filters.get('local') === '1';
  const requestedType = filters.get('type');
  const explicitType = requestedType === 'actual' ? 'actual' : ['scenarios', 'demo'].includes(requestedType) ? 'scenarios' : null;
  const endpoints = { actual: '/api/public/results', scenarios: '/api/public/history-scenarios', local: '/api/local/market-history' };
  const published = { subtitle: $('resultsSubtitle').textContent, method: $('resultsMethodText').innerHTML };
  const markets = { stocks: 'Акции', futures: 'Фьючерсы', crypto: 'Криптовалюты' };
  let mode = local ? 'local' : explicitType || 'scenarios';
  let request = null, data = null, tier = !local && ['pro', 'exclusive'].includes(requestedTier) ? requestedTier : '';
  from.value = filters.get('from') || '';
  $('resultsType').hidden = local;
  $('resultsTiers').hidden = local;
  if (local) {
    document.title = 'ORBITA — Локальная история по Мосбирже';
    $('resultsTitle').textContent = 'Локальная история по Мосбирже';
    $('resultsSubtitle').textContent = 'Локальные сценарии PRO по часовым свечам MOEX ISS. Время показано по Москве.';
    $('resultsSegmentHeading').textContent = 'Рынок';
    $('resultsMethodText').textContent = 'Направление определяет предыдущая часовая свеча. После роста открывается LONG, после падения — SHORT. Вход берётся по открытию следующей свечи, выход — по закрытию второй свечи после сигнала. Для журнала задним числом отобраны движения от 1% до 5% по модулю. Стоп и цель справочные. Процент рассчитывается по изменению цены без комиссий и проскальзывания. Один R соответствует одному проценту цены входа.';
  }
  function renderDataset() {
    for (const button of $('resultsType').querySelectorAll('[data-results-type]')) button.setAttribute('aria-pressed', String(button.dataset.resultsType === mode));
    if (local) return;
    const scenarios = mode === 'scenarios';
    $('resultsTable').classList.toggle('results-scenarios', scenarios);
    const period = data?.fromDate && data?.throughDate ? ` с ${day(data.fromDate)} по ${day(data.throughDate)}` : '';
    $('resultsSubtitle').textContent = scenarios ? `Условные сделки по биржевым свечам${period}.` : published.subtitle;
    if (scenarios) $('resultsMethodText').textContent = 'Сценарии рассчитаны по историческим свечам и отобраны после расчёта. В полной выборке каждого тарифа 70% сценариев закрыты в плюс. Процент рассчитывается по изменению цены от входа до выхода, для SHORT знак обратный. Один R равен расстоянию от входа до стопа. Комиссии и проскальзывание не учитываются.';
    else $('resultsMethodText').innerHTML = published.method;
  }
  function renderLocalPrices() {
    const period = data.fromDate && data.throughDate ? `Закрытия с ${day(data.fromDate)} по ${day(data.throughDate)}. ` : '';
    $('resultsSubtitle').textContent = `${period}Локальные сценарии PRO по часовым свечам MOEX ISS. Время показано по Москве.`;
    const quotes = data.latestQuotes || [];
    $('resultsLocalQuotes').hidden = !quotes.length;
    if (!quotes.length) return;
    $('resultsQuoteHeading').textContent = `Последние цены по свечам · ${day(data.asOfDate)}`;
    $('resultsQuoteList').innerHTML = quotes.map(quote => `<li><b>${esc(quote.ticker)}</b> · ${num(quote.price)}${quote.market === 'stocks' ? ' ₽' : ''} · ${clock.format(Date.parse(quote.at))} МСК ·${sourceLink(quote.sourceUrl)}</li>`).join('');
  }
  function rows() {
    const start = from.value ? Date.parse(from.value + 'T00:00:00+03:00') : null;
    return (data?.results || []).filter(r => (!tier || r.tier === tier) && (start === null || Date.parse(r.closedAt) >= start))
      .sort((a, b) => (Date.parse(b.closedAt) || 0) - (Date.parse(a.closedAt) || 0));
  }
  function summary(list) {
    const traded = list.filter(r => r.state === 'closed' && !r.erroneous && r.pct !== null), wins = traded.filter(r => r.pct > 0), rs = traded.map(r => r.r).filter(Number.isFinite);
    const avg = traded.length ? traded.reduce((a, r) => a + r.pct, 0) / traded.length : null, sumR = rs.reduce((a, b) => a + b, 0);
    if (local) {
      const losses = traded.filter(r => r.pct < 0).length;
      $('resultsSummary').innerHTML = `<div><span>Завершено</span><b>${list.length}</b></div><div><span>В плюс</span><b class="up">${wins.length}</b></div><div><span>В минус</span><b class="down">${losses}</b></div>`;
      return;
    }
    if (mode === 'scenarios') {
      const losses = traded.filter(r => r.pct < 0).length;
      $('resultsSummary').innerHTML = `<div><span>Сценариев</span><b>${list.length}</b></div><div><span>В плюс</span><b class="up">${wins.length}</b></div><div><span>В минус</span><b class="down">${losses}</b></div><div><span>Доля в плюсе</span><b>${traded.length ? Math.round(wins.length / traded.length * 100) + '%' : '—'}</b></div>`;
      return;
    }
    $('resultsSummary').innerHTML = `<div><span>Завершено</span><b>${list.length}</b></div><div><span>Со сделкой</span><b>${traded.length}</b></div><div><span>В плюсе</span><b>${traded.length ? Math.round(wins.length / traded.length * 100) + '%' : '—'}</b></div><div><span>Средний результат</span><b class="${avg >= 0 ? 'up' : 'down'}">${avg === null ? '—' : sgn(avg) + '%'}</b></div><div><span>Сумма в рисках</span><b class="${sumR >= 0 ? 'up' : 'down'}">${rs.length ? sgn(sumR) + 'R' : '—'}</b></div><div><span>Открыто сейчас</span><b>${data.open}</b></div>`;
    curve(traded);
  }
  // Cumulative R in closing order: every trade counts, nothing is smoothed.
  function curve(traded) {
    const box = $('resultsCurve'), pts = traded.filter(r => Number.isFinite(r.r)).slice().reverse();
    if (pts.length < 3) { box.hidden = true; return; }
    let acc = 0; const values = [0, ...pts.map(r => (acc += r.r))], w = 800, h = 160, pad = 10, min = Math.min(0, ...values), max = Math.max(0, ...values), span = max - min || 1;
    const X = i => pad + i * (w - 2 * pad) / (values.length - 1), Y = v => h - pad - (v - min) / span * (h - 2 * pad);
    box.innerHTML = `<figcaption class="o-small">Накопленный результат в R по ${pts.length} сделкам, в порядке закрытия</figcaption><svg viewBox="0 0 ${w} ${h}" role="img" aria-label="Накопленный результат ${sgn(acc)}R"><line class="zero" x1="${pad}" x2="${w - pad}" y1="${Y(0)}" y2="${Y(0)}"/><polyline points="${values.map((v, i) => X(i).toFixed(1) + ',' + Y(v).toFixed(1)).join(' ')}"/></svg>`;
    box.hidden = false;
  }
  function render() {
    for (const t of $('resultsTiers').querySelectorAll('[data-tier]')) t.setAttribute('aria-selected', String(t.dataset.tier === tier));
    $('resultsClearDate').hidden = !from.value;
    if (!data) {
      $('resultsSummary').textContent = ''; $('resultsRows').textContent = '';
      for (const id of ['resultsTableWrap', 'resultsTable', 'resultsCurve', 'resultsEmpty']) $(id).hidden = true;
      $('resultsCsv').disabled = true;
      return;
    }
    const list = rows(); summary(list);
    $('resultsTableWrap').hidden = $('resultsTable').hidden = !list.length;
    $('resultsEmpty').hidden = list.length > 0;
    $('resultsEmpty').textContent = mode === 'scenarios'
      ? (from.value ? 'С выбранной даты сценариев нет.' : 'Исторических сценариев для этого тарифа пока нет.')
      : (from.value ? 'С выбранной даты завершённых идей нет.' : 'Завершённых идей пока нет.');
    $('resultsRows').innerHTML = list.map(r => {
      const changedStop = r.initial.stop !== null && r.final.stop !== r.initial.stop, changedTarget = r.initial.target !== null && r.final.target !== r.initial.target;
      const note = [local && !r.erroneous ? 'Закрыто по свече' : r.outcome, changedStop ? `стоп ${num(r.initial.stop)} → ${num(r.final.stop)}` : '', changedTarget ? `цель ${num(r.initial.target)} → ${num(r.final.target)}` : '', r.errorReason ? 'причина: ' + r.errorReason : ''].filter(Boolean).join(' · ');
      const scenarios = mode === 'scenarios';
      const closed = scenarios ? `${day(r.closedAt)} · ${time(r.closedAt)}` : day(r.closedAt);
      const timing = scenarios ? `Вход ${day(r.enteredAt)} · ${time(r.enteredAt)}`
        : local && r.enteredAt && r.closedAt ? `${time(r.enteredAt)} → ${time(r.closedAt)}` : 'опубл. ' + day(r.publishedAt);
      const segment = local ? r.market === 'futures' ? 'Фьючерсы' : 'Акции' : r.tier === 'exclusive' ? 'EXCLUSIVE' : 'PRO';
      const source = mode !== 'actual' ? sourceLink(r.sourceUrl) : '';
      const market = scenarios && markets[r.market] ? `<span class="o-small">${markets[r.market]}</span>` : '';
      return `<tr class="${r.erroneous ? 'err' : ''}"><td class="result-date">${closed}<span class="o-small">${timing}</span></td><td><b>${esc(r.ticker)}</b> <span class="o-tag ${r.dir === 'ШОРТ' ? 'short' : 'long'}">${r.dir === 'ШОРТ' ? 'SHORT' : 'LONG'}</span>${market}</td><td><span class="o-tag ${esc(r.tier)}">${segment}</span></td><td class="num" data-label="Вход">${num(r.initial.entry ?? r.final.entry)}</td><td class="num" data-label="Стоп">${num(r.initial.stop ?? r.final.stop)}</td><td class="num" data-label="Цель">${num(r.initial.target ?? r.final.target)}</td><td class="num" data-label="Выход">${num(r.exit)}</td><td class="note">${esc(note)}${source ? ' ·' + source : ''}</td><td class="num ${r.pct > 0 ? 'up' : r.pct < 0 ? 'down' : ''}">${r.pct === null ? '—' : sgn(r.pct) + '%'}</td><td class="num" data-label="Итог, R">${r.r === null ? '—' : sgn(r.r)}</td></tr>`;
    }).join('');
    $('resultsCsv').disabled = !list.length;
  }
  function csv() {
    const head = ['closedAt', 'publishedAt', 'ticker', 'direction', 'tier', 'strategy', 'entry_initial', 'stop_initial', 'target_initial', 'stop_final', 'target_final', 'exit', 'outcome', 'pct', 'r'];
    const scenarios = mode === 'scenarios';
    if (scenarios) head.push('enteredAt', 'market', 'unit', 'sourceUrl');
    const q = v => { const s = v === null || v === undefined ? '' : String(v); return /[",;\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const lines = [head.join(';'), ...rows().map(r => {
      const columns = [r.closedAt, r.publishedAt, r.ticker, r.dir === 'ШОРТ' ? 'SHORT' : 'LONG', r.tier, r.strategy, r.initial.entry, r.initial.stop, r.initial.target, r.final.stop, r.final.target, r.exit, r.outcome, r.pct?.toFixed(4), r.r?.toFixed(4)];
      if (scenarios) columns.push(r.enteredAt, r.market, r.unit, r.sourceUrl);
      return columns.map(q).join(';');
    })];
    const url = URL.createObjectURL(new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' })), a = document.createElement('a');
    a.href = url;
    a.download = local ? 'orbita-local-moex-history.csv' : scenarios ? 'orbita-history-scenarios.csv' : 'orbita-results.csv';
    a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function updateFilters() {
    const url = new URL(location.href);
    for (const [key, value] of [['tier', tier], ['from', from.value]]) {
      if (value) url.searchParams.set(key, value); else url.searchParams.delete(key);
    }
    if (!local) url.searchParams.set('type', mode);
    history.replaceState(null, '', url);
    render();
  }
  async function load(nextMode, { fallback = false, notice = '' } = {}) {
    request?.abort();
    const current = new AbortController();
    request = current; mode = nextMode; data = null;
    $('resultsError').hidden = true; $('resultsLoading').hidden = false;
    renderDataset(); render();
    try {
      const response = await fetch(endpoints[nextMode], { cache: 'no-store', signal: current.signal });
      if (!response.ok) throw Error();
      const dataset = await response.json();
      if (!Array.isArray(dataset.results)) throw Error();
      if (request !== current) return;
      if (fallback && !dataset.results.length) { void load('actual'); return; }
      data = dataset;
      if (local) renderLocalPrices();
      renderDataset(); render();
      if (notice) { $('resultsError').textContent = notice; $('resultsError').hidden = false; }
    } catch {
      if (request !== current || current.signal.aborted) return;
      if (fallback) { void load('actual', { notice: 'Исторические сценарии временно недоступны. Открыты опубликованные идеи.' }); return; }
      $('resultsError').textContent = local ? 'Локальная история доступна при запуске npm run local.'
        : nextMode === 'scenarios' ? 'Не удалось загрузить исторические сценарии.' : 'Не удалось загрузить опубликованные идеи.';
      $('resultsError').hidden = false;
    } finally {
      if (request === current) { request = null; $('resultsLoading').hidden = true; }
    }
  }
  $('resultsTiers').addEventListener('click', e => { const t = e.target.closest('[data-tier]'); if (!t) return; tier = t.dataset.tier; updateFilters(); });
  $('resultsType').addEventListener('click', e => {
    const button = e.target.closest('[data-results-type]');
    if (!button) return;
    if (button.dataset.resultsType !== mode || !data) void load(button.dataset.resultsType);
    updateFilters();
  });
  from.addEventListener('change', updateFilters);
  $('resultsClearDate').addEventListener('click', () => { from.value = ''; updateFilters(); from.focus(); });
  $('resultsCsv').addEventListener('click', csv);
  void load(mode, { fallback: !local && explicitType === null });
})();
