(() => {
  'use strict';
  const $ = id => document.getElementById(id), labels = { quotes: 'Котировки фьючерсов (ISS marketdata)', daily: 'Итоги сессий (ISS history)', positions: 'Открытые позиции физ/юрлиц (ISS openpositions)' };
  const states = { ok: 'Работает', running: 'Выполняется', waiting: 'Ждёт первого запуска', error: 'Ошибка', off: 'Выключен', license: 'Выключен до подтверждения условий MOEX' };
  const time = iso => Number.isFinite(Date.parse(iso)) ? new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(iso)) + ' МСК' : '—';
  const el = (tag, text, cls) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = String(text); return n; };
  let busy = false;
  async function api(path, options) {
    const r = await fetch(path, { credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, ...options });
    const data = await r.json().catch(() => ({}));
    if (r.status === 401) { location.replace('/account.html?next=%2Fmarkets-admin.html'); throw Error('Войдите в аккаунт.'); }
    if (!r.ok) throw Error(data.error || 'Запрос не выполнен.');
    return data;
  }
  function paint(d) {
    $('adminMarketsConfig').textContent = `Режим: ${d.mode === 'moex' ? 'MOEX ISS' : 'выключен'}${d.blockedByLicense ? ' (нужно MARKETS_LICENSE_CONFIRMED=true)' : ''} · ключ AlgoPack: ${d.keyConfigured ? 'задан' : 'нет, задержка ~15 мин'} · активы: ${d.assets.join(', ')} · котировки каждые ${d.intervals.quotesSeconds} с, итоги и позиции каждые ${d.intervals.dailySeconds} с`;
    const rows = $('adminMarketsRows'); rows.replaceChildren();
    for (const [kind, s] of Object.entries(d.sources)) {
      const tr = el('tr'); tr.append(el('td', labels[kind]), el('td', states[s.status] || s.status, s.status === 'error' ? 'down' : s.status === 'ok' ? 'up' : ''), el('td', time(s.lastSuccess)), el('td', kind === 'quotes' ? time(s.providerTime) : (s.providerTime || '').slice(0, 10) || '—'), el('td', s.records, 'num'), el('td', s.lastError || '—'));
      const td = el('td'), b = el('button', 'Запустить', 'o-btn o-btn-secondary'); b.type = 'button'; b.disabled = busy || d.mode !== 'moex' || s.status === 'running'; b.onclick = () => refresh(kind); td.append(b); tr.append(td); rows.append(tr);
    }
    $('adminMarketsAll').disabled = busy || d.mode !== 'moex';
    const runs = $('adminMarketsRuns'); runs.replaceChildren();
    for (const r of d.runs || []) { const tr = el('tr'); tr.append(el('td', labels[r.kind] || r.kind), el('td', time(r.startedAt)), el('td', r.ok ? 'успех' : 'ошибка', r.ok ? 'up' : 'down'), el('td', r.records, 'num'), el('td', r.trigger || ''), el('td', r.error || '—')); runs.append(tr); }
  }
  async function load() { try { paint(await api('/api/admin/markets')); $('adminMarketsError').hidden = true; } catch (e) { $('adminMarketsError').hidden = false; $('adminMarketsError').textContent = e.message; } }
  async function refresh(kind) {
    if (busy) return; busy = true; $('adminMarketsStatus').textContent = 'Обновление запущено…'; await load();
    try { const r = await api('/api/admin/markets/refresh', { method: 'POST', body: JSON.stringify({ kind }) }); $('adminMarketsStatus').textContent = Object.entries(r.results).map(([k, v]) => `${labels[k]}: ${v.ok ? 'обновлено, записей ' + v.records : 'ошибка — ' + v.error}`).join(' · '); }
    catch (e) { $('adminMarketsStatus').textContent = e.message; }
    finally { busy = false; await load(); }
  }
  $('adminMarketsAll').onclick = () => refresh('all');
  load(); setInterval(load, 30000);
})();
