(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  let data = null, selected = null, timer = null;
  const finite = v => typeof v === 'number' && Number.isFinite(v);
  const int = v => finite(v) ? new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(v) : '—';
  const signed = v => finite(v) ? (v > 0 ? '+' : v < 0 ? '−' : '') + int(Math.abs(v)) : '—';
  const pct = v => finite(v) ? (v > 0 ? '+' : v < 0 ? '−' : '') + new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(Math.abs(v)) + '%' : '—';
  const share = v => finite(v) ? new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(v) + '%' : '—';
  const price = v => finite(v) ? new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 4 }).format(v) : '—';
  const day = d => /^\d{4}-\d{2}-\d{2}$/.test(d || '') ? d.slice(8, 10) + '.' + d.slice(5, 7) + '.' + d.slice(0, 4) : '—';
  const time = iso => Number.isFinite(Date.parse(iso)) ? new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(iso)) + ' МСК' : '—';
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = String(text); return n; };
  const tone = v => finite(v) ? (v > 0 ? 'up' : v < 0 ? 'down' : '') : '';

  function lock(status, message) {
    clearTimeout(timer); $('marketsWorkspace').hidden = true; $('marketsLocked').hidden = false;
    $('marketsLockedTitle').textContent = status === 401 ? 'Войдите в аккаунт' : 'Нужна подписка';
    $('marketsLockedText').textContent = message || 'Раздел доступен по тарифам PRO и EXCLUSIVE.';
    $('marketsLockedLink').href = status === 401 ? '/account.html?next=%2Fmarkets.html' : '/subscriptions.html?next=%2Fmarkets.html';
    $('marketsLockedLink').textContent = status === 401 ? 'Войти' : 'Выбрать тариф';
  }
  // Source captions name the exchange date of each metric, never "today" by default.
  function freshnessText(f, kind, value) {
    if (!f || f.state === 'missing') return 'нет данных';
    if (kind === 'quote') return (f.state === 'stale' ? 'устарело · ' : '') + 'на ' + time(value) + (data.delayMinutes ? ' · задержка ~' + data.delayMinutes + ' мин' : '');
    return (f.state === 'stale' ? 'устарело · ' : '') + 'на ' + day(value) + (f.state === 'previous-session' ? ' (последняя сессия)' : '');
  }
  function sourceLine() {
    const s = data.sources, parts = [data.source];
    const state = { ok: '', running: 'обновляется', waiting: 'ожидает первого обновления', error: 'ошибка обновления', off: 'источник выключен', license: 'выключен до подтверждения условий MOEX' };
    for (const [kind, label] of [['quotes', 'котировки'], ['positions', 'позиции']]) { const item = s[kind]; parts.push(label + ': ' + (item.status === 'ok' ? 'обновлено ' + time(item.lastSuccess) : state[item.status] || item.status)); }
    $('marketsSource').textContent = parts.join(' · ');
  }
  const crowdLabel = s => s.level === 'extreme' ? (s.direction === 'long' ? 'Экстремум в лонге' : 'Экстремум в шорте') : s.level === 'elevated' ? (s.direction === 'long' ? 'Больше лонгов, чем обычно' : 'Больше шортов, чем обычно') : 'Как обычно';
  function sorted(list) {
    const q = $('marketsSearch').value.trim().toLocaleLowerCase('ru-RU'), group = $('marketsGroup').value, sort = $('marketsSort').value;
    return list.filter(i => (group === 'all' || i.group === group) && (!q || [i.asset, i.name, i.contract?.secid, i.contract?.shortName, i.underlying].filter(Boolean).join(' ').toLocaleLowerCase('ru-RU').includes(q)))
      .sort((a, b) => sort === 'name' ? a.name.localeCompare(b.name, 'ru') : sort === 'change' ? Math.abs(b.quote?.changePct ?? 0) - Math.abs(a.quote?.changePct ?? 0) : sort === 'fizNet' ? Math.abs(b.sentiment?.z ?? 0) - Math.abs(a.sentiment?.z ?? 0) : (b.positions?.openInterest ?? 0) - (a.positions?.openInterest ?? 0));
  }
  function cell(row, cls, main, sub, label) { const td = el('td', cls); td.dataset.label = label; td.append(el('span', 'v', main)); if (sub) td.append(el('span', 'o-small', sub)); row.append(td); return td; }
  function render() {
    const list = sorted(data.instruments), body = $('marketsRows'); body.replaceChildren();
    $('marketsTable').hidden = !list.length; $('marketsEmpty').hidden = list.length > 0;
    if (!data.instruments.length) { $('marketsEmpty').textContent = data.mode === 'moex' ? 'Данные ещё не загружены. Первое обновление выполняется после запуска сервера.' : 'Источник рыночных данных выключен администратором.'; $('marketsEmpty').hidden = false; }
    for (const i of list) {
      const tr = el('tr'); tr.tabIndex = 0; tr.dataset.asset = i.asset; if (selected === i.asset) tr.setAttribute('aria-selected', 'true');
      const name = el('td', 'name'); name.dataset.label = 'Инструмент'; name.append(el('b', '', i.name)); name.append(el('span', 'o-small', (i.contract?.shortName || i.asset) + (i.contract?.expiry && !i.contract.expiry.startsWith('2100') ? ' · эксп. ' + day(i.contract.expiry) : ' · бессрочный'))); tr.append(name);
      const q = i.quote, p = i.positions;
      { const sub = cell(tr, 'num', price(q?.last), q ? pct(q.changePct) : '', 'Цена').querySelector('.o-small'); if (sub && tone(q?.changePct)) sub.classList.add(tone(q.changePct)); }
      cell(tr, 'num', int(q?.volume), '', 'Объём');
      cell(tr, 'num', int(q?.openInterest), '', 'ОИ контракта');
      cell(tr, 'num ' + tone(p?.fiz.net), signed(p?.fiz.net), p ? 'за день ' + signed(p.change.fizNet) : '', 'Физлица, нетто');
      { const sn = i.sentiment, td = cell(tr, 'crowd', sn ? crowdLabel(sn) : '—', sn ? (sn.z > 0 ? '+' : '') + String(sn.z).replace('.', ',') + 'σ от нормы' : 'мало истории', 'Толпа (физлица)'); if (sn) td.dataset.level = sn.level; }
      const meta = el('td', 'meta'); meta.dataset.label = 'Данные';
      const qs = el('span', 'o-small' + (q?.freshness?.state === 'stale' ? ' stale' : ''), 'Цена ' + freshnessText(q?.freshness, 'quote', q?.quoteTime || q?.providerTime));
      const ps = el('span', 'o-small' + (p?.freshness?.state === 'stale' ? ' stale' : ''), 'Позиции ' + freshnessText(p?.freshness, 'daily', p?.date));
      meta.append(qs, ps); tr.append(meta);
      tr.addEventListener('click', () => open(i.asset)); tr.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(i.asset); } });
      body.append(tr);
    }
    if (selected) detail();
  }
  // Compact SVG line chart of a series; thin lines, zero axis, no decoration.
  function chart(points, key, label, color) {
    const values = points.map(p => p[key]).filter(finite); if (values.length < 2) return el('p', 'o-small', label + ': недостаточно истории.');
    const w = 520, h = 120, pad = 6, min = Math.min(...values, key === 'openInterest' ? Infinity : 0), max = Math.max(...values, key === 'openInterest' ? -Infinity : 0), span = max - min || 1;
    const xy = points.map((p, i) => finite(p[key]) ? [pad + i * (w - 2 * pad) / (points.length - 1), h - pad - (p[key] - min) / span * (h - 2 * pad)] : null).filter(Boolean);
    const ns = 'http://www.w3.org/2000/svg', svg = document.createElementNS(ns, 'svg'); svg.setAttribute('viewBox', `0 0 ${w} ${h}`); svg.setAttribute('class', 'markets-chart'); svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', `${label}: от ${int(values[0])} до ${int(values.at(-1))} за ${points.length} сессий`);
    if (min < 0 && max > 0) { const zero = document.createElementNS(ns, 'line'), y = h - pad - (0 - min) / span * (h - 2 * pad); zero.setAttribute('x1', pad); zero.setAttribute('x2', w - pad); zero.setAttribute('y1', y); zero.setAttribute('y2', y); zero.setAttribute('class', 'zero'); svg.append(zero); }
    const path = document.createElementNS(ns, 'polyline'); path.setAttribute('points', xy.map(p => p.map(n => n.toFixed(1)).join(',')).join(' ')); path.setAttribute('stroke', color); path.setAttribute('fill', 'none'); path.setAttribute('stroke-width', '1.5'); svg.append(path);
    const box = el('figure', 'markets-figure'); box.append(el('figcaption', 'o-small', `${label} · ${day(points[0].date)} — ${day(points.at(-1).date)} · MOEX`), svg); return box;
  }
  // Price (settlement) and individuals' net position on one time axis; each
  // series has its own scale, labelled at the left and right edges.
  function combined(i) {
    const byDate = new Map(i.history.map(h => [h.date, { date: h.date, net: h.fizNet }]));
    for (const s of i.sessions) { const row = byDate.get(s.date) || { date: s.date }; row.price = s.settlePrice ?? s.close; byDate.set(s.date, row); }
    const rows = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)).slice(-30).filter(r => finite(r.price) || finite(r.net));
    if (rows.filter(r => finite(r.price)).length < 2 || rows.filter(r => finite(r.net)).length < 2) return el('p', 'o-small', 'Цена и позиции: недостаточно истории.');
    const w = 520, h = 140, pad = 8, ns = 'http://www.w3.org/2000/svg', svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`); svg.setAttribute('class', 'markets-chart'); svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', `Расчётная цена и нетто-позиция физлиц за ${rows.length} сессий`);
    const line = (key, color, dash) => { const vals = rows.map(r => r[key]).filter(finite), min = Math.min(...vals), max = Math.max(...vals), span = max - min || 1; const pts = rows.map((r, idx) => finite(r[key]) ? `${(pad + idx * (w - 2 * pad) / (rows.length - 1)).toFixed(1)},${(h - pad - (r[key] - min) / span * (h - 2 * pad)).toFixed(1)}` : null).filter(Boolean); const pl = document.createElementNS(ns, 'polyline'); pl.setAttribute('points', pts.join(' ')); pl.setAttribute('fill', 'none'); pl.setAttribute('stroke', color); pl.setAttribute('stroke-width', '1.5'); if (dash) pl.setAttribute('stroke-dasharray', dash); svg.append(pl); };
    line('price', 'var(--o-ink)'); line('net', 'var(--o-pro)', '4 3');
    const box = el('figure', 'markets-figure'), cap = el('figcaption', 'o-small');
    cap.innerHTML = `<span class="lg lg-price"></span>Цена (расчётная) · <span class="lg lg-net"></span>Нетто физлиц · ${day(rows[0].date)} — ${day(rows.at(-1).date)} · MOEX`;
    box.append(cap, svg); return box;
  }
  function groupBlock(title, g, oi) {
    const box = el('div', 'markets-group'); box.append(el('h3', '', title));
    const dl = el('dl');
    for (const [k, v] of [['Длинные, контр.', int(g.long) + ' (' + share(g.longShare) + ' ОИ)'], ['Короткие, контр.', int(g.short) + ' (' + share(g.shortShare) + ' ОИ)'], ['Нетто', signed(g.net)], ['Лиц в лонге / шорте', int(g.personsLong) + ' / ' + int(g.personsShort)], ['Изменение за сессию', 'лонг ' + signed(g.changeLong) + ', шорт ' + signed(g.changeShort)]]) { dl.append(el('dt', '', k), el('dd', '', v)); }
    box.append(dl); return box;
  }
  function detail() {
    const i = data.instruments.find(x => x.asset === selected), box = $('marketsDetail'); box.replaceChildren(); if (!i) { box.hidden = true; return; }
    box.hidden = false;
    const head = el('div', 'markets-detail-head'); head.append(el('h2', '', i.name + ' · ' + (i.contract?.shortName || i.asset)));
    const close = el('button', 'o-btn o-btn-tertiary', 'Закрыть'); close.type = 'button'; close.onclick = () => { selected = null; render(); box.hidden = true; }; head.append(close); box.append(head);
    const p = i.positions, s = i.session;
    const facts = el('dl', 'markets-facts');
    const add = (k, v, note) => { const d = el('div'); d.append(el('dt', '', k), el('dd', '', v)); if (note) d.append(el('span', 'o-small', note)); facts.append(d); };
    add('Цена', price(i.quote?.last), freshnessText(i.quote?.freshness, 'quote', i.quote?.quoteTime || i.quote?.providerTime) + ' · MOEX');
    add('Расчётная цена сессии', price(s?.settlePrice), 'на ' + day(s?.date) + ' · MOEX');
    add('Объём сессии, контр.', int(s?.volume), 'на ' + day(s?.date) + ' · MOEX');
    add('ОИ контракта', int(s?.openInterest), 'на ' + day(s?.date) + ' · MOEX');
    add('ОИ по всем контрактам', int(p?.openInterest), p ? 'на ' + day(p.date) + ' · за день ' + signed(p.change.openInterest) + (p.change.weekDate ? ' · с ' + day(p.change.weekDate) + ' ' + signed(p.change.openInterestWeek) : '') + ' · MOEX' : 'нет данных');
    add('Экспирация', i.contract?.expiry?.startsWith('2100') ? 'бессрочный' : day(i.contract?.expiry), i.contract?.secid || '');
    box.append(facts);
    if (p) {
      const groups = el('div', 'markets-groups'); groups.append(groupBlock('Физлица', p.fiz), groupBlock('Юрлица', p.yur)); box.append(groups);
      box.append(el('p', 'o-small', 'Открытые позиции · данные на ' + day(p.date) + ' (последняя завершённая сессия) · MOEX. Доли — от общего числа открытых контрактов.'));
    } else box.append(el('p', 'o-empty', 'Статистика открытых позиций по этому активу ещё не получена.'));
    const charts = el('div', 'markets-charts');
    charts.append(combined(i), chart(i.history, 'openInterest', 'Открытый интерес, контр.', 'var(--o-muted)'));
    if (i.sentiment) box.append(el('p', 'markets-crowd', `Толпа (физлица): ${crowdLabel(i.sentiment)} — нетто ${signed(i.sentiment.last)} при среднем ${signed(i.sentiment.mean)} за ${i.sentiment.sessions} сессий (${i.sentiment.z > 0 ? '+' : ''}${String(i.sentiment.z).replace('.', ',')}σ). Крайние значения часто сопровождают перегретое движение, но это статистика, а не сигнал.`));
    box.append(charts);
    const ideas = el('div', 'markets-ideas'); ideas.append(el('h3', '', 'Идеи ORBITA по инструменту'));
    if (i.ideas?.length) for (const idea of i.ideas) { const a = el('a', 'o-btn o-btn-tertiary', `${idea.dir === 'ШОРТ' ? 'SHORT' : 'LONG'} · ${idea.tier === 'exclusive' ? 'EXCLUSIVE' : 'PRO'} · ${idea.status || ''}`); a.href = '/app.html?idea=' + encodeURIComponent(idea.id); ideas.append(a); }
    else ideas.append(el('p', 'o-small', 'Открытых идей нет.'));
    box.append(ideas);
    for (const row of document.querySelectorAll('#marketsRows tr')) row.toggleAttribute('aria-selected', row.dataset.asset === selected);
  }
  function open(asset) { selected = asset; detail(); $('marketsDetail').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' }); }
  async function load() {
    clearTimeout(timer);
    try {
      const r = await fetch('/api/markets', { credentials: 'same-origin', cache: 'no-store' });
      const body = await r.json().catch(() => ({}));
      if (r.status === 401 || r.status === 403) { lock(r.status, body.error); return; }
      if (!r.ok) throw Error(body.error || 'Не удалось загрузить рыночные данные.');
      data = body; $('marketsLocked').hidden = true; $('marketsWorkspace').hidden = false; $('marketsError').hidden = true; $('marketsSkeleton').hidden = true;
      sourceLine(); render();
    } catch (e) { $('marketsWorkspace').hidden = false; $('marketsSkeleton').hidden = true; $('marketsError').hidden = false; $('marketsError').textContent = e.message + ' Последние загруженные значения не изменены.'; }
    finally { if (!document.hidden && $('marketsLocked').hidden) timer = setTimeout(load, 120000); }
  }
  for (const id of ['marketsSearch', 'marketsGroup', 'marketsSort']) $(id).addEventListener('input', () => data && render());
  $('marketsFilters').addEventListener('submit', e => e.preventDefault());
  document.addEventListener('visibilitychange', () => { if (!document.hidden && data) load(); });
  $('marketsWorkspace').hidden = false; load();
})();
