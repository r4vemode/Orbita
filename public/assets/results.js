(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = v => typeof v === 'number' && Number.isFinite(v) ? v.toLocaleString('ru-RU', { maximumFractionDigits: 8 }) : '—';
  const sgn = (v, d = 2) => typeof v === 'number' && Number.isFinite(v) ? (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toLocaleString('ru-RU', { maximumFractionDigits: d }) : '—';
  const day = iso => Number.isFinite(Date.parse(iso)) ? new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', year: '2-digit' }).format(new Date(iso)) : '—';
  const clock = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit' });
  const sourceLink = url => typeof url === 'string' && url.startsWith('https://iss.moex.com/iss/')
    ? ` <a class="results-source" href="${esc(url)}" target="_blank" rel="noopener noreferrer">MOEX ISS</a>` : '';
  const filters = new URLSearchParams(location.search), from = $('resultsFrom');
  const requestedTier = filters.get('tier'), local = filters.get('local') === '1';
  let data = null, tier = !local && ['pro', 'exclusive'].includes(requestedTier) ? requestedTier : '';
  from.value = filters.get('from') || '';
  if (local) {
    document.title = 'ORBITA — Локальная история по Мосбирже';
    $('resultsTitle').textContent = 'Локальная история по Мосбирже';
    $('resultsSubtitle').textContent = 'Локальные сценарии PRO по часовым свечам MOEX ISS. Время показано по Москве.';
    $('resultsSegmentHeading').textContent = 'Рынок';
    $('resultsMethodText').textContent = 'Направление определяет предыдущая часовая свеча. После роста открывается LONG, после падения — SHORT. Вход берётся по открытию следующей свечи, выход — по закрытию второй свечи после сигнала. Для журнала задним числом отобраны движения от 1% до 5% по модулю. Стоп и цель справочные. Процент рассчитывается по изменению цены без комиссий и проскальзывания. Один R соответствует одному проценту цены входа.';
    document.querySelector('.o-tabs').hidden = true;
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
    return (data?.results || []).filter(r => (!tier || r.tier === tier) && (start === null || Date.parse(r.closedAt) >= start));
  }
  function summary(list) {
    const traded = list.filter(r => r.state === 'closed' && !r.erroneous && r.pct !== null), wins = traded.filter(r => r.pct > 0), rs = traded.map(r => r.r).filter(Number.isFinite);
    const avg = traded.length ? traded.reduce((a, r) => a + r.pct, 0) / traded.length : null, sumR = rs.reduce((a, b) => a + b, 0);
    if (local) {
      const losses = traded.filter(r => r.pct < 0).length;
      $('resultsSummary').innerHTML = `<div><span>Завершено</span><b>${list.length}</b></div><div><span>В плюс</span><b class="up">${wins.length}</b></div><div><span>В минус</span><b class="down">${losses}</b></div>`;
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
    for (const t of document.querySelectorAll('.o-tab')) t.setAttribute('aria-selected', String(t.dataset.tier === tier));
    if (!data) return;
    const list = rows(); summary(list);
    $('resultsTable').hidden = !list.length; $('resultsEmpty').hidden = list.length > 0;
    $('resultsEmpty').textContent = from.value ? 'С выбранной даты завершённых идей нет.' : 'Завершённых идей пока нет.';
    $('resultsRows').innerHTML = list.map(r => {
      const changedStop = r.initial.stop !== null && r.final.stop !== r.initial.stop, changedTarget = r.initial.target !== null && r.final.target !== r.initial.target;
      const note = [local && !r.erroneous ? 'Закрыто по свече' : r.outcome, changedStop ? `стоп ${num(r.initial.stop)} → ${num(r.final.stop)}` : '', changedTarget ? `цель ${num(r.initial.target)} → ${num(r.final.target)}` : '', r.errorReason ? 'причина: ' + r.errorReason : ''].filter(Boolean).join(' · ');
      const timing = local && [r.enteredAt,r.closedAt].every(value => Number.isFinite(Date.parse(value))) ? `${clock.format(Date.parse(r.enteredAt))} → ${clock.format(Date.parse(r.closedAt))}` : 'опубл. ' + day(r.publishedAt);
      const segment = local ? r.market === 'futures' ? 'Фьючерсы' : 'Акции' : r.tier === 'exclusive' ? 'EXCLUSIVE' : 'PRO';
      const source = local && r.sourceUrl ? ' ·' + sourceLink(r.sourceUrl) : '';
      return `<tr class="${r.erroneous ? 'err' : ''}"><td>${day(r.closedAt)}<span class="o-small">${timing}</span></td><td><b>${esc(r.ticker)}</b> <span class="o-tag ${r.dir === 'ШОРТ' ? 'short' : 'long'}">${r.dir === 'ШОРТ' ? 'SHORT' : 'LONG'}</span></td><td><span class="o-tag ${r.tier}">${segment}</span></td><td class="num">${num(r.initial.entry ?? r.final.entry)}</td><td class="num">${num(r.initial.stop ?? r.final.stop)}</td><td class="num">${num(r.initial.target ?? r.final.target)}</td><td class="num">${num(r.exit)}</td><td class="note">${esc(note)}${source}</td><td class="num ${r.pct > 0 ? 'up' : r.pct < 0 ? 'down' : ''}">${r.pct === null ? '—' : sgn(r.pct) + '%'}</td><td class="num">${r.r === null ? '—' : sgn(r.r)}</td></tr>`;
    }).join('');
    $('resultsCsv').disabled = !list.length;
  }
  function csv() {
    const head = ['closedAt', 'publishedAt', 'ticker', 'direction', 'tier', 'strategy', 'entry_initial', 'stop_initial', 'target_initial', 'stop_final', 'target_final', 'exit', 'outcome', 'pct', 'r'];
    const q = v => { const s = v === null || v === undefined ? '' : String(v); return /[",;\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const lines = [head.join(';'), ...rows().map(r => [r.closedAt, r.publishedAt, r.ticker, r.dir === 'ШОРТ' ? 'SHORT' : 'LONG', r.tier, r.strategy, r.initial.entry, r.initial.stop, r.initial.target, r.final.stop, r.final.target, r.exit, r.outcome, r.pct?.toFixed(4), r.r?.toFixed(4)].map(q).join(';'))];
    const url = URL.createObjectURL(new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' })), a = document.createElement('a');
    a.href = url; a.download = local ? 'orbita-local-moex-history.csv' : 'orbita-results.csv'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function updateFilters() {
    const url = new URL(location.href);
    for (const [key, value] of [['tier', tier], ['from', from.value]]) {
      if (value) url.searchParams.set(key, value); else url.searchParams.delete(key);
    }
    history.replaceState(null, '', url);
    render();
  }
  document.querySelector('.o-tabs').addEventListener('click', e => { const t = e.target.closest('.o-tab'); if (!t) return; tier = t.dataset.tier; updateFilters(); });
  from.addEventListener('change', updateFilters);
  $('resultsCsv').addEventListener('click', csv);
  render();
  fetch(local ? '/api/local/market-history' : '/api/public/results', { cache: 'no-store' }).then(r => r.ok ? r.json() : Promise.reject(Error(local ? 'Локальная история доступна при запуске npm run local.' : 'Не удалось загрузить результаты.'))).then(d => { data = d; if (local) renderLocalPrices(); render(); }).catch(e => { $('resultsError').hidden = false; $('resultsError').textContent = e.message; });
})();
