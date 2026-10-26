(async () => {
  if (new URLSearchParams(location.search).has('embed') || !window.OrbitaStore || !document.querySelector('header')) return;
  const S = window.OrbitaStore, esc = S.escape;
  const initial = () => ({ initialized: false, seen: [], itemIds: [], readIds: [], strategies: [], popups: true });
  let user = null, key = null, state = initial(), items = [], records = [], watched = new Set(), personal = new Set();
  let allowedStrategies = [], busy = false, queued = false, timer, active = false;

  // Older versions saved signal text. Keep only preferences and event IDs from now on.
  try {
    for (const name of Object.keys(localStorage)) if (name.startsWith('orbita.idea-alerts.v1.')) localStorage.removeItem(name);
  } catch {}

  async function api(url) {
    const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(OrbitaAccess.supportMessage(body,'Обновления временно недоступны.')), { status: response.status });
    return body;
  }
  function entitled(account) {
    return !!account && (!!account.access?.isAdmin || account.role === 'admin' || !!account.access?.hasSubscription);
  }
  function load() {
    try {
      const saved = JSON.parse(localStorage.getItem(key) || 'null');
      if (!saved || !['seen', 'itemIds', 'readIds', 'strategies'].every(field => Array.isArray(saved[field]))) return initial();
      return { initialized: !!saved.initialized, popups: saved.popups !== false, ...Object.fromEntries(['seen', 'itemIds', 'readIds', 'strategies'].map(field => [field, saved[field].filter(value => typeof value === 'string')])) };
    } catch { return initial(); }
  }
  function save() {
    if (!key) return;
    try { localStorage.setItem(key, JSON.stringify(state)); } catch {}
  }
  const number = value => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value).toLocaleString('ru-RU', { maximumFractionDigits: 8 }) : null;
  function eventId(record, event, index) {
    if (event[3]?.id) return record.id + ':' + event[3].id;
    // Legacy events still get a stable ID without saving their paid text.
    let hash = 2166136261;
    for (const char of JSON.stringify(event.slice(0, 3))) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
    return record.id + ':' + index + ':' + (hash >>> 0).toString(36);
  }
  function title(record, event) {
    const info = event[3] || {}, d = record.d || {}, ticker = String(d.ticker || 'Идея'), unit = d.unit ? ' ' + d.unit : '';
    const oldStop = number(info.before?.stop), newStop = number(info.after?.stop);
    if (info.type === 'stop-change' && oldStop && newStop) return `${ticker}: стоп изменён с ${oldStop} до ${newStop}${unit}`;
    if (info.type === 'activate') return `${ticker}: вход подтверждён${number(d.entry) ? ' · ' + number(d.entry) + unit : ''}`;
    if (['target', 'stop', 'manual'].includes(info.type)) return `${ticker}: ${String(event[1] || 'сделка закрыта').toLocaleLowerCase('ru')}${number(info.after?.exit) ? ' · выход ' + number(info.after.exit) + unit : ''}`;
    if (isNewSignal(event)) return `${ticker}: новый сигнал${d.dir ? ' · ' + d.dir : ''}`;
    return `${ticker}: ${String(event[1] || 'новый комментарий').toLocaleLowerCase('ru')}`;
  }
  function isNewSignal(event) {
    return ['published', 'publish', 'announce', 'announced'].includes(event[3]?.type) || /^(Идея опубликована|Новый сигнал|Сигнал анонсирован|Анонс сигнала)$/i.test(String(event[1] || ''));
  }

  const trigger = document.createElement('button');
  trigger.className = 'alerts-trigger'; trigger.type = 'button'; trigger.hidden = true;
  trigger.innerHTML = 'Обновления идей <b>0</b>';
  document.querySelector('header').append(trigger);
  const dialog = document.createElement('dialog'); dialog.className = 'alerts-dialog';
  dialog.setAttribute('aria-labelledby', 'ideaAlertsTitle');
  dialog.innerHTML = '<div class="alerts-head"><h2 id="ideaAlertsTitle">Обновления идей</h2><button class="alerts-close" aria-label="Закрыть обновления">×</button></div><p>Изменения отслеживаемых идей и ваших позиций. Новые сигналы — по выбранным стратегиям вашей подписки. Обновления появляются, пока сайт открыт.</p><details class="alerts-settings"><summary>Настроить уведомления</summary><label><input id="ideaPopups" type="checkbox">Показывать сообщения на открытом сайте</label><p>Новые сигналы по стратегиям:</p><div id="strategySubscriptions"></div></details><div class="alerts-tools"><button id="alertsRead">Прочитать всё</button><span role="status" id="alertsStatus"></span></div><div id="ideaAlertsFeed"></div>';
  document.body.append(dialog);
  const toast = document.createElement('aside'); toast.className = 'idea-alert-toast'; toast.hidden = true;
  toast.setAttribute('role', 'status'); document.body.append(toast);

  function restrict(account) {
    user = account || null; active = false; items = []; records = []; watched.clear(); personal.clear(); allowedStrategies = [];
    trigger.hidden = true; trigger.querySelector('b').textContent = '0';
    clearTimeout(timer); toast.hidden = true; toast.innerHTML = '';
    dialog.querySelector('#ideaAlertsFeed').innerHTML = ''; dialog.querySelector('#strategySubscriptions').innerHTML = '';
    if (dialog.open) dialog.close();
  }
  function configure(account) {
    const nextKey = 'orbita.idea-alerts.v2.' + account.id;
    if (key !== nextKey) { key = nextKey; state = load(); items = []; }
    user = account; active = true;
    const plans = account.access?.activePlans || [];
    allowedStrategies = (window.ORBITA_STRATEGIES || []).filter(strategy => account.access?.isAdmin || account.role === 'admin' || plans.includes(strategy.plan || (strategy.exclusive ? 'exclusive' : 'pro'))).map(strategy => strategy.name);
    // Custom strategies returned by the server are authorized by the same request.
    for (const record of records) if (record.d?.strategy && !allowedStrategies.includes(record.d.strategy)) allowedStrategies.push(record.d.strategy);
    state.strategies = state.strategies.filter(strategy => allowedStrategies.includes(strategy));
    trigger.hidden = false;
  }
  function render() {
    if (!active) return;
    const unread = items.filter(item => !item.read).length;
    trigger.querySelector('b').textContent = unread;
    trigger.setAttribute('aria-label', `Обновления идей: ${unread} непрочитанных`);
    dialog.querySelector('#ideaPopups').checked = state.popups;
    dialog.querySelector('#ideaAlertsFeed').innerHTML = items.length ? items.map(item => `<article class="alert-item ${item.read ? '' : 'unread'}"><a href="app.html?idea=${encodeURIComponent(item.ideaId)}" data-alert="${esc(item.id)}">${esc(item.title)} →</a><small>${esc(item.date)} МСК · ${esc(item.strategy)}</small><p>${esc(item.body)}</p></article>`).join('') : '<p class="alerts-empty">Пока нет обновлений. Следите за идеями или выберите стратегии в настройках. Предыдущие события не рассылаются повторно.</p>';
    dialog.querySelectorAll('[data-alert]').forEach(link => { link.onclick = () => { state.readIds = [...new Set([...state.readIds, link.dataset.alert])].slice(-200); items.forEach(item => { item.read = state.readIds.includes(item.id); }); save(); render(); }; });
    dialog.querySelector('#strategySubscriptions').innerHTML = allowedStrategies.map(name => `<label><input type="checkbox" value="${esc(name)}" ${state.strategies.includes(name) ? 'checked' : ''}>${esc(name)}</label>`).join('');
    dialog.querySelectorAll('#strategySubscriptions input').forEach(input => { input.onchange = () => { state.strategies = input.checked ? [...new Set([...state.strategies, input.value])] : state.strategies.filter(name => name !== input.value); save(); }; });
  }
  function popup(item) {
    clearTimeout(timer);
    toast.innerHTML = `<a href="app.html?idea=${encodeURIComponent(item.ideaId)}">${esc(item.title)} →</a><button aria-label="Закрыть уведомление">×</button>`;
    toast.hidden = false; toast.querySelector('button').onclick = () => { toast.hidden = true; };
    timer = setTimeout(() => { toast.hidden = true; }, 10000);
  }
  function scan(showPopup) {
    if (!active) return;
    state = load();
    state.strategies = state.strategies.filter(strategy => allowedStrategies.includes(strategy));
    const seen = new Set(state.seen), available = new Map(), incoming = [];
    for (const record of records) {
      if (!record.published || !record.d || !Array.isArray(record.meta?.events)) continue;
      for (const [index, event] of record.meta.events.entries()) {
        if (!Array.isArray(event)) continue;
        const id = eventId(record, event, index);
        const at = event[3]?.at || record.meta.updatedAt || record.meta.publishedAt || '';
        const notification = { id, ideaId: record.id, title: title(record, event), body: String(event[2] || ''), date: String(event[0] || ''), strategy: String(record.d.strategy || ''), at, read: state.readIds.includes(id) };
        available.set(id, notification);
        if (!seen.has(id) && state.initialized && (watched.has(record.id) || personal.has(record.id) || (isNewSignal(event) && state.strategies.includes(record.d.strategy)))) incoming.push(notification);
        seen.add(id);
      }
    }
    const incomingIds = new Set(incoming.map(item => item.id));
    state.itemIds = [...new Set([...incoming.map(item => item.id), ...state.itemIds])].filter(id => available.has(id)).slice(0, 200);
    state.readIds = state.readIds.filter(id => state.itemIds.includes(id));
    state.seen = [...seen].slice(-10000); state.initialized = true;
    items = state.itemIds.map(id => available.get(id)).sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0));
    save(); render();
    if (showPopup && state.popups && !dialog.open && !document.hidden) {
      const latest = items.find(item => incomingIds.has(item.id));
      if (latest) popup(latest);
    }
  }
  async function refresh(showPopup = true) {
    if (document.hidden) return;
    if (busy) { queued = true; return; }
    busy = true;
    try {
      const { user: current } = await api('/api/me');
      if (!entitled(current)) { restrict(current); return; }
      const [, watch, positions] = await Promise.all([S.refresh(), api('/api/watchlist'), api('/api/positions')]);
      records = S.read().records.filter(record => record.published);
      watched = new Set(Array.isArray(watch.ids) ? watch.ids : []);
      personal = new Set(Array.isArray(positions.positions) ? positions.positions.map(position => position.ideaId) : []);
      configure(current); scan(showPopup);
      dialog.querySelector('#alertsStatus').textContent = '';
    } catch (error) {
      // A failed authority check never leaves previously fetched paid messages visible.
      restrict(user);
    } finally {
      busy = false;
      if (queued) { queued = false; queueMicrotask(() => refresh(showPopup)); }
    }
  }
  trigger.onclick = () => { render(); dialog.showModal(); refresh(false); };
  dialog.querySelector('.alerts-close').onclick = () => dialog.close();
  dialog.querySelector('#alertsRead').onclick = () => { state.readIds = state.itemIds.slice(); items.forEach(item => { item.read = true; }); save(); render(); };
  dialog.querySelector('#ideaPopups').onchange = event => { state.popups = event.target.checked; toast.hidden = true; save(); };
  window.addEventListener('storage', event => { if (event.key === key || event.key === null) refresh(false); });
  for (const event of ['orbita:watch-change', 'orbita:positions-change']) window.addEventListener(event, () => refresh());
  window.addEventListener('orbita:store-change', () => {
    if (busy || !active) return;
    // Recheck the session as well as the newly fetched records before showing text.
    refresh();
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); else toast.hidden = true; });
  await refresh(false);
  setInterval(() => refresh(), 10000);
})();
