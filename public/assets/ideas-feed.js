/* «Стратегии»: one section, two tiers, a compact list built for 20+ ideas a day.
   The server decides what is readable; a locked tier arrives without records. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ok = v => typeof v === 'number' && Number.isFinite(v) && v > 0;
  const num = v => ok(v) ? v.toLocaleString('ru-RU', { maximumFractionDigits: 8 }) : '—';
  const MSK = { timeZone: 'Europe/Moscow' };
  const dayKey = iso => Number.isFinite(Date.parse(iso)) ? new Intl.DateTimeFormat('en-CA', { ...MSK, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso)) : '';
  const hhmm = iso => Number.isFinite(Date.parse(iso)) ? new Intl.DateTimeFormat('ru-RU', { ...MSK, hour: '2-digit', minute: '2-digit' }).format(new Date(iso)) : '—';
  const OPEN = ['announced', 'waiting', 'active'];
  const STATES = { announced: ['Объявлена', 'Уровни скоро'], waiting: ['Ждёт входа', 'Цена ещё не дошла до входа'], active: ['В сделке', 'Вход выполнен, ждём цель или стоп'], closed: ['Закрыта', ''], cancelled: ['Отменена', 'Вход не состоялся'] };
  const params = new URLSearchParams(location.search);
  let tier = params.get('tab') === 'exclusive' ? 'exclusive' : 'pro', quick = 'open', feed = null, user = null, stats = null, timer = null;
  const expanded = new Set();
  const tierOf = r => r.tier || (r.d?.strategy === 'Orbita Exclusive' ? 'exclusive' : 'pro');
  const rr = d => ok(d.entry) && ok(d.stop) && ok(d.target) ? Math.abs(d.target - d.entry) / Math.abs(d.entry - d.stop) : null;
  const result = r => r.d.state === 'closed' && !r.erroneous && ok(r.d.entry) && ok(r.meta?.exit) ? (r.meta.exit / r.d.entry - 1) * (r.d.dir === 'ШОРТ' ? -100 : 100) : null;
  const pct = v => (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toLocaleString('ru-RU', { maximumFractionDigits: 2 }) + '%';
  const store = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch {} } };

  function dayLabel(key) {
    const today = dayKey(new Date().toISOString()), yesterday = dayKey(new Date(Date.now() - 86400000).toISOString());
    const [y, m, d] = key.split('-');
    return (key === today ? 'Сегодня, ' : key === yesterday ? 'Вчера, ' : '') + `${d}.${m}.${y}`;
  }
  function row(r) {
    const d = r.d, long = d.dir !== 'ШОРТ', t = tierOf(r), ratio = rr(d), res = result(r), targets = [d.target, ...(d.targets || [])].filter(ok), open = expanded.has(r.id);
    const [state, hint] = r.erroneous ? ['Ошибка публикации', ''] : STATES[d.state] || [d.status, ''];
    const tgt = targets.length ? num(targets[0]) + (targets.length > 1 ? ` <span class="o-small">+${targets.length - 1}</span>` : '') : '—';
    return `<article class="irow${open ? ' open' : ''}${r.erroneous ? ' erroneous' : ''}" data-id="${esc(r.id)}" data-tier="${t}">
      <button type="button" class="irow-main" aria-expanded="${open}" aria-controls="ix-${esc(r.id)}">
        <span class="c-time">${hhmm(r.meta?.publishedAt)}</span>
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
  function detail(r, targets) {
    const d = r.d, t = tierOf(r);
    const facts = [['Стратегия', `<span class="o-tag ${t}">${t === 'exclusive' ? 'EXCLUSIVE' : 'PRO'}</span> ${esc(d.strategy)}`], ['Горизонт', esc(d.horizon || '—')], ['Цели', targets.map(num).join(' → ') || '—'], ['Единица', esc(d.unit || '—')]];
    return `<div class="irow-detail" id="ix-${esc(r.id)}">
      <div class="ix-text">${d.summary ? `<p>${esc(d.summary)}</p>` : ''}${d.entryRule ? `<p><b>Условие входа:</b> ${esc(d.entryRule)}</p>` : ''}${d.cancelRule ? `<p><b>Отмена и выход:</b> ${esc(d.cancelRule)}</p>` : ''}
        <dl class="ix-facts">${facts.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>
        ${sizer(r)}<a class="o-btn o-btn-secondary" href="/app.html?idea=${encodeURIComponent(r.id)}">Полный разбор и история →</a></div>
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
  function filtered(rows) {
    const q = $('fTicker').value.trim().toUpperCase(), dir = $('fDir').value, strategy = $('fStrategy').value, from = $('fFrom').value;
    return rows.filter(r => quickMatch(r, quick) && (!q || String(r.d.ticker).toUpperCase().includes(q) || String(r.d.name || '').toUpperCase().includes(q)) && (!dir || r.d.dir === dir) && (!strategy || r.d.strategy === strategy) && (!from || dayKey(r.meta?.publishedAt) >= from));
  }
  function renderStats() {
    const box = $('feedStats'), s = stats?.[tier];
    if (!s || !s.closed) { box.hidden = true; return; }
    box.hidden = false;
    box.innerHTML = `<div><span class="o-small">Закрыто идей ${tier === 'exclusive' ? 'EXCLUSIVE' : 'PRO'}</span><b>${s.closed}</b></div><div><span class="o-small">Закрыты в плюсе</span><b>${s.winRate.toLocaleString('ru-RU', { maximumFractionDigits: 0 })}%</b></div><div><span class="o-small">Средний результат</span><b class="${s.avgPct >= 0 ? 'up' : 'down'}">${pct(s.avgPct)}</b></div><div><span class="o-small">Средний итог в рисках</span><b>${s.avgR === null ? '—' : (s.avgR > 0 ? '+' : '') + s.avgR.toLocaleString('ru-RU', { maximumFractionDigits: 2 }) + 'R'}</b></div><p class="o-small">По всем закрытым идеям с ценой выхода, без комиссий. Прошлые результаты не гарантируют будущих. <a href="/results.html">Все идеи с уровнями →</a></p>`;
  }
  function render() {
    for (const tab of document.querySelectorAll('.o-tab')) { const on = tab.dataset.tier === tier; tab.setAttribute('aria-selected', String(on)); tab.tabIndex = on ? 0 : -1; }
    for (const b of document.querySelectorAll('[data-quick]')) b.setAttribute('aria-pressed', String(b.dataset.quick === quick));
    $('feedPanel').setAttribute('aria-labelledby', 'tab-' + tier);
    $('feedSkeleton').hidden = true; $('feedLocked').hidden = true; $('feedEmpty').hidden = true; $('feedList').innerHTML = '';
    renderStats();
    const hideTools = () => { $('feedFilters').hidden = true; $('feedQuick').hidden = true; };
    if (!user) { hideTools(); locked('guest'); return; }
    if (!feed) { hideTools(); locked('none'); return; }
    for (const t of ['pro', 'exclusive']) document.querySelector(`[data-count="${t}"]`).textContent = feed.locked?.includes(t) ? '🔒' : String(feed.records.filter(r => r.published && !r.archived && tierOf(r) === t && OPEN.includes(r.d.state) && !r.erroneous).length);
    if (feed.locked?.includes(tier)) { hideTools(); locked(tier === 'pro' ? 'none' : 'upgrade'); return; }
    const all = feed.records.filter(r => r.published && !r.archived && tierOf(r) === tier);
    for (const q of ['open', 'active', 'waiting', 'history']) document.querySelector(`[data-qc="${q}"]`).textContent = all.filter(r => quickMatch(r, q)).length;
    const strategies = [...new Set(all.map(r => r.d.strategy))].sort(), select = $('fStrategy'), current = select.value;
    select.innerHTML = '<option value="">Все</option>' + strategies.map(s => `<option${s === current ? ' selected' : ''}>${esc(s)}</option>`).join('');
    $('feedFilters').hidden = false; $('feedQuick').hidden = false;
    const rows = filtered(all).sort((a, b) => String(b.meta?.publishedAt || '').localeCompare(String(a.meta?.publishedAt || '')));
    $('feedEmpty').hidden = rows.length > 0;
    if (!rows.length) $('feedEmpty').textContent = quick === 'open' && !all.length ? 'Новых идей пока нет. Мы пришлём уведомление, когда автор опубликует идею — настройте его в разделе «Уведомления».' : 'Нет идей по выбранным условиям.';
    const groups = new Map(); for (const r of rows) { const k = dayKey(r.meta?.publishedAt); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
    $('feedList').innerHTML = [...groups].map(([k, list]) => `<section class="iday"><h2 class="iday-head">${k ? dayLabel(k) : 'Без даты'} <span class="o-small">${list.length}</span></h2><div class="iday-head-cols" aria-hidden="true"><span>Время</span><span>Инструмент</span><span></span><span>Вход</span><span>Стоп</span><span>Цель</span><span>R/R</span><span>Статус</span><span>Итог</span><span></span></div>${list.map(row).join('')}</section>`).join('');
  }
  function welcome() {
    const kind = params.get('welcome'), box = $('feedWelcome'); if (!kind || !user) return;
    const plan = params.get('plan');
    if (kind === 'paid') box.innerHTML = '<b>Оплата прошла — доступ открыт.</b> Ниже ваши идеи. Начните с вкладки «Открытые»: там идеи, по которым ещё можно войти.';
    else box.innerHTML = `<b>Аккаунт создан.</b> ${user.emailVerified ? '' : 'Подтвердите email (ссылка в письме или в <a href="/security.html">Настройках</a>) — это нужно для оплаты. '}Чтобы видеть идеи, <a href="/subscriptions.html${plan ? '?plan=' + encodeURIComponent(plan) : ''}">подключите тариф</a>.`;
    box.hidden = false; history.replaceState(null, '', location.pathname + (tier === 'exclusive' ? '?tab=exclusive' : ''));
  }
  function catalog() {
    const list = window.ORBITA_STRATEGIES || [];
    $('feedCatalog').innerHTML = '<ul class="feed-catalog">' + list.map(s => `<li><a href="/strategy.html?strategy=${encodeURIComponent(s.slug)}">${esc(s.name)}</a> <span class="o-tag ${s.exclusive ? 'exclusive' : 'pro'}">${s.exclusive ? 'EXCLUSIVE' : 'PRO'}</span> <span class="o-small">${esc(s.horizon)} · ${esc(s.description)}</span></li>`).join('') + '</ul>';
  }
  async function load() {
    clearTimeout(timer);
    try {
      const [me, st] = await Promise.all([fetch('/api/me', { credentials: 'same-origin', cache: 'no-store' }).then(r => r.ok ? r.json() : { user: null }), fetch('/api/public/stats', { cache: 'no-store' }).then(r => r.ok ? r.json() : null).catch(() => null)]);
      user = me.user; stats = st?.stats || null;
      if (user) {
        const r = await fetch('/api/ideas', { credentials: 'same-origin', cache: 'no-store' }), body = await r.json().catch(() => ({}));
        if (r.status === 403) feed = null; else if (!r.ok) throw Error(body.error || 'Не удалось загрузить идеи.'); else feed = body;
      }
      $('feedError').hidden = true; $('feedUpdated').textContent = 'Обновлено в ' + new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' }).format(new Date());
    } catch (e) { $('feedError').hidden = false; $('feedError').textContent = e.message + ' Показаны последние загруженные данные.'; }
    welcome(); render();
    if (!document.hidden) timer = setTimeout(load, 60000);
  }
  if (store.get('orbita.howto.hidden') === '1' && !params.get('welcome')) $('feedHowto').open = false;
  $('howtoHide').addEventListener('click', () => { $('feedHowto').open = false; store.set('orbita.howto.hidden', '1'); });
  document.querySelector('.o-tabs').addEventListener('click', e => { const tab = e.target.closest('.o-tab'); if (!tab) return; tier = tab.dataset.tier; history.replaceState(null, '', tier === 'exclusive' ? '?tab=exclusive' : location.pathname); render(); });
  document.querySelector('.o-tabs').addEventListener('keydown', e => { if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return; tier = tier === 'pro' ? 'exclusive' : 'pro'; render(); $('tab-' + tier).focus(); });
  $('feedQuick').addEventListener('click', e => { const b = e.target.closest('[data-quick]'); if (!b) return; quick = b.dataset.quick; render(); });
  $('feedList').addEventListener('click', e => { const b = e.target.closest('.irow-main'); if (!b) return; const id = b.closest('.irow').dataset.id; expanded.has(id) ? expanded.delete(id) : expanded.add(id); render(); document.querySelector(`.irow[data-id="${CSS.escape(id)}"] .irow-main`)?.focus(); });
  $('feedList').addEventListener('input', e => {
    const box = e.target.closest('.sizer'); if (!box) return;
    const capital = box.querySelector('[name=capital]').value, risk = box.querySelector('[name=risk]').value;
    try { localStorage.setItem('orbita.calc.v1', JSON.stringify({ capital: capital ? Number(capital) : null, risk: risk ? Number(risk) : 1 })); } catch {}
    const r = feed?.records.find(x => x.id === box.dataset.id); if (r) box.querySelector('.sizer-out').innerHTML = sizerText(r, Number(capital), Number(risk));
  });
  $('feedFilters').addEventListener('input', render); $('feedFilters').addEventListener('submit', e => e.preventDefault());
  document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
  $('feedFiltersBox').open = matchMedia('(min-width: 768px)').matches;
  catalog(); load();
})();
