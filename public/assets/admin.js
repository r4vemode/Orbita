(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
  const format = new Intl.DateTimeFormat('ru-RU', {timeZone:'Europe/Moscow',day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'});
  const stamp = value => { const date = new Date(value); return value && Number.isFinite(date.getTime()) ? format.format(date) : String(value || 'Дата не указана'); };
  const number = value => value === null || value === undefined || value === '' ? '—' : Number(value).toLocaleString('ru-RU',{maximumFractionDigits:8});
  const fields = ['ticker','name','market','dir','title','summary','entry','stop','target','horizon','strategy','thesis','entryRule','cancelRule'];
  const numericFields = ['entry','stop','target'];
  const ideaSummary = d => window.OrbitaIdeaCopy?.summary?.(d) ?? d.summary ?? '';
  let db = {revision:0,records:[]}, users = [], current = null, draftId = null, dirty = false, mutating = false, accountsRevision;
  const form = $('ideaForm');
  function message(text, error = false) { $('message').textContent = text; $('message').classList.toggle('error', error); }
  async function api(path, options = {}) {
    let response;
    try { response = await fetch(path,{credentials:'same-origin',cache:'no-store',...options,headers:{...(options.body ? {'Content-Type':'application/json'} : {}),...options.headers}}); }
    catch { throw new Error('Не удалось подключиться к серверу. Проверьте соединение и повторите попытку.'); }
    let data;
    try { data = await response.json(); } catch { throw new Error('Сервер вернул неожиданный ответ. Обновите страницу и попробуйте снова.'); }
    if (!response.ok) {
      if (response.status === 401) location.replace('account.html?next=%2Fadmin.html');
      if (response.status === 403) { $('adminMain').hidden = true; showForbidden(); }
      const error = new Error(response.status === 409 ? 'Список изменился в другой вкладке. Нажмите «Обновить» и повторите действие после проверки данных.' : OrbitaAccess.supportMessage(data,'Не удалось сохранить изменение.'));
      error.status = response.status;
      throw error;
    }
    return data;
  }
  function showForbidden() { $('authState').hidden = false; $('authState').innerHTML = '<h1>Редакция доступна администратору.</h1><p>В вашем аккаунте нет прав на публикацию и управление доступом.</p><a href="app.html">Открыть кабинет →</a>'; }
  async function mutation(work) {
    if (mutating) return;
    mutating = true;
    document.querySelectorAll('[data-mutation]').forEach(button => button.disabled = true);
    try { await work(); } catch (error) { message(error.message,true); }
    finally { mutating = false; document.querySelectorAll('[data-mutation]').forEach(button => button.disabled = false); }
  }
  function readFullData() { return Object.fromEntries(fields.map(key => { const value = form.elements[key].value.trim(); return [key,numericFields.includes(key) ? value === '' ? null : Number(value) : value]; })); }
  function validateLevels(data) {
    if (![data.entry,data.stop,data.target].every(value => Number.isFinite(value) && value > 0)) throw new Error('Вход, стоп и цель должны быть положительными числами.');
    if (data.dir === 'ЛОНГ' && !(data.stop < data.entry && data.entry < data.target)) throw new Error('Для лонга: стоп < вход < цель.');
    if (data.dir === 'ШОРТ' && !(data.target < data.entry && data.entry < data.stop)) throw new Error('Для шорта: цель < вход < стоп.');
  }
  function strategyOptions() {
    const names = (window.ORBITA_STRATEGIES || []).map(strategy => strategy.name);
    if (!names.length) names.push('Momentum RU','Trend RU','Импульс','Crypto Momentum','Crypto Trend','Orbita Exclusive');
    for (const id of ['quickStrategy','fullStrategy']) $(id).innerHTML = names.map(name => `<option>${escape(name)}</option>`).join('');
  }
  function ideaCard(record) {
    const d = record.d || {};
    const levels = [d.entry,d.stop,d.target].every(value => Number.isFinite(value) && value > 0);
    return `<div class="selected-identity"><span class="preview-tag">${escape(d.dir)} · ${escape(d.strategy)}</span><h2>${escape(d.ticker || 'Черновик')}</h2>${d.name ? `<p>${escape(d.name)}</p>` : ''}${d.title ? `<h3>${escape(d.title)}</h3>` : ''}${d.summary ? `<p>${escape(ideaSummary(d))}</p>` : ''}${levels ? `<div class="selected-levels"><span>Вход<b>${escape(number(d.entry))}</b></span><span>Стоп<b>${escape(number(d.stop))}</b></span><span>Цель<b>${escape(number(d.target))}</b></span></div>` : `<p class="no-levels">${record.published ? 'Тикер и направление опубликованы. Уровни ещё не заданы.' : 'Укажите уровни для полного сценария. Черновик можно сохранить без них.'}</p>`}${record.demo ? '<p class="demo-label">Учебный пример</p>' : ''}${record.erroneous ? '<p class="error-label">Ошибочная публикация · сохранена в истории</p>' : ''}</div>`;
  }
  function preview() {
    const data = readFullData();
    $('fullPreview').innerHTML = data.ticker ? ideaCard({d:data,published:false}) + (window.TradeScheme ? TradeScheme.markup(data) : '') : '';
  }
  function renderList() {
    $('count').textContent = String(db.records.length);
    $('ideaList').innerHTML = db.records.length ? db.records.map(record => `<button type="button" class="list-item${record.id === current ? ' active' : ''}" data-id="${escape(record.id)}" aria-pressed="${record.id === current}"><strong>${escape(record.d?.ticker || 'Черновик')}<span>${record.d?.dir === 'ШОРТ' ? '↘' : '↗'}</span></strong><small>${escape(record.erroneous ? 'Ошибочная публикация' : record.published ? record.d?.status || record.d?.state : 'Черновик')}</small><small>${escape(record.d?.strategy || '')}</small></button>`).join('') : '<p class="empty-list">Пока нет идей. Опубликуйте первый сигнал.</p>';
    $('ideaList').querySelectorAll('[data-id]').forEach(button => button.addEventListener('click', () => select(button.dataset.id)));
  }
  function eventFields() {
    const action = $('eventAction').value;
    $('levelsFields').hidden = action !== 'levels';
    for (const id of ['levelEntry','levelStop','levelTarget','levelEntryRule','levelCancelRule']) $(id).required = action === 'levels';
    $('exitField').hidden = !['manual','stop-change'].includes(action);
    $('exitPrice').required = ['manual','stop-change'].includes(action);
    $('exitLabel').textContent = action === 'stop-change' ? 'Новый стоп' : 'Цена закрытия';
    $('eventNote').placeholder = action === 'error' ? 'Почему публикация ошибочна? Причина останется в истории.' : 'Что произошло и что это меняет?';
  }
  function audit(record) {
    const initial = record.meta?.initial;
    const initialLevels = initial && [initial.entry,initial.stop,initial.target].every(value => Number.isFinite(value) && value > 0);
    $('initialSnapshot').innerHTML = `<h3>Первоначальная публикация</h3>${initial ? `<p>${escape(initial.ticker || record.d.ticker)} · ${escape(initial.dir)} · ${escape(initial.strategy)}<br>${initialLevels ? `Вход ${escape(number(initial.entry))} · Стоп ${escape(number(initial.stop))} · Цель ${escape(number(initial.target))}` : 'Тикер и направление опубликованы без уровней.'}${initial.entryRule ? `<br>${escape(initial.entryRule)}` : ''}${initial.cancelRule ? `<br>${escape(initial.cancelRule)}` : ''}</p>${initial.publishedAt ? `<small>${escape(stamp(initial.publishedAt))} МСК</small>` : ''}${initial.reconstructed ? `<small>${escape(initial.reconstructedReason || 'Первоначальные данные восстановлены из прежней версии.')}</small>` : ''}` : '<p>Смотрите первое событие в журнале публикации.</p>'}`;
    $('eventHistory').innerHTML = (record.meta?.events || []).slice().reverse().map(event => {
      const at = Array.isArray(event) ? event[3]?.at || event[0] : event.at;
      const title = Array.isArray(event) ? event[1] : event.title || event.action;
      const body = Array.isArray(event) ? event[2] : event.body || event.note;
      return `<article class="history-event"><small>${escape(stamp(at))} МСК</small><strong>${escape(title)}</strong><p>${escape(body)}</p></article>`;
    }).join('');
  }
  function select(id) {
    const record = db.records.find(item => item.id === id);
    if (record && !record.published && dirty && draftId !== record.id && !confirm('Открыть черновик без сохранения текущей формы?')) return;
    current = id;
    $('deleteIdea').hidden = !record || !!record.published;
    $('publishedActions').hidden = !record?.published;
    $('editorStatus').textContent = !record ? 'ВЫБЕРИТЕ ИДЕЮ' : record.erroneous ? 'ОШИБОЧНАЯ ПУБЛИКАЦИЯ' : record.published ? record.d.status || record.d.state : 'ЧЕРНОВИК';
    $('selectedIdea').innerHTML = record ? ideaCard(record) : '<p>Выберите идею слева или опубликуйте новый сигнал.</p>';
    if (record?.published) {
      const state = record.d.state, active = !record.erroneous;
      const actions = [['note','Комментарий автора'],...(active && state === 'announced' ? [['levels','Добавить уровни входа, стопа и цели']] : []),...(active && ['waiting','active'].includes(state) ? [['stop-change','Изменить стоп']] : []),...(active && state === 'waiting' ? [['activate','Подтвердить вход']] : []),...(active && ['announced','waiting'].includes(state) ? [['cancel','Отменить до входа']] : []),...(active && state === 'active' ? [['target','Закрыть по цели'],['stop','Закрыть по стопу'],['manual','Закрыть вручную']] : []),...(active ? [['error','Пометить ошибочную публикацию']] : [])];
      $('eventAction').innerHTML = actions.map(([value,label]) => `<option value="${value}">${label}</option>`).join('');
      $('eventForm').reset();
      eventFields();
      audit(record);
    } else if (record && !(dirty && draftId === record.id)) {
      draftId = record.id;
      form.reset();
      fields.forEach(key => { if (record.d[key] !== null && record.d[key] !== undefined) form.elements[key].value = record.d[key]; });
      dirty = false;
      $('fullComposer').open = true;
      $('fullFormTitle').textContent = `Черновик ${record.d.ticker || ''}`;
      preview();
    }
    renderList();
  }
  function clearFull() { draftId = null; dirty = false; form.reset(); $('fullFormTitle').textContent = 'Подготовить полный сценарий'; preview(); }
  async function loadIdeas(preferred = current) {
    const result = await api('/api/admin/ideas');
    if (!Array.isArray(result.records) || !Number.isInteger(result.revision)) throw new Error('Сервер не вернул список идей.');
    db = {revision:result.revision,records:result.records};
    const id = db.records.some(record => record.id === preferred) ? preferred : null;
    select(id);
  }
  function acceptChange(result) {
    if (!result.record || !Number.isInteger(result.revision)) throw new Error('Не удалось подтвердить сохранение. Обновите список перед следующим изменением.');
    db.revision = result.revision;
    const index = db.records.findIndex(record => record.id === result.record.id);
    if (index < 0) db.records.unshift(result.record); else db.records[index] = result.record;
    select(result.record.id);
  }
  $('quickForm').addEventListener('submit', event => {
    event.preventDefault();
    mutation(async () => {
      const d = {ticker:$('quickTicker').value.trim().toUpperCase(),dir:$('quickDirection').value,market:$('quickMarket').value,strategy:$('quickStrategy').value};
      if (!d.ticker) throw new Error('Укажите тикер.');
      const result = await api('/api/admin/ideas',{method:'POST',body:JSON.stringify({revision:db.revision,mode:'quick',d})});
      acceptChange(result);
      $('quickTicker').value = '';
      $('quickTicker').focus();
      message(`${d.ticker}: ${d.dir.toLowerCase()} опубликован. Уровни и комментарий можно добавить ниже.`);
    });
  });
  $('quickMarket').addEventListener('change', () => { $('quickStrategy').value = {stocks:'Momentum RU',futures:'Импульс',crypto:'Crypto Momentum'}[$('quickMarket').value]; });
  form.addEventListener('input', () => { dirty = true; preview(); });
  form.addEventListener('change', () => { dirty = true; preview(); });
  async function saveFull(mode) {
    const d = readFullData();
    if (mode === 'full') validateLevels(d);
    const result = await api(draftId ? `/api/admin/ideas/${encodeURIComponent(draftId)}` : '/api/admin/ideas',{method:draftId ? 'PUT' : 'POST',body:JSON.stringify({revision:db.revision,mode,d})});
    dirty = false;
    if (mode === 'full') clearFull();
    acceptChange(result);
    if (mode === 'full') $('fullComposer').open = false;
    message(mode === 'draft' ? 'Черновик сохранён на сервере. Он виден только редакции.' : 'Полный сценарий опубликован. Первоначальные условия сохранены.');
  }
  form.addEventListener('submit', event => { event.preventDefault(); mutation(() => saveFull('full')); });
  $('saveDraft').addEventListener('click', () => mutation(() => saveFull('draft')));
  $('clearFullForm').addEventListener('click', () => { if (!dirty || confirm('Очистить несохранённую форму?')) clearFull(); });
  $('newIdea').addEventListener('click', () => { $('quickTicker').focus(); $('quickForm').scrollIntoView({behavior:'smooth',block:'center'}); });
  $('eventAction').addEventListener('change', eventFields);
  $('eventForm').addEventListener('submit', event => {
    event.preventDefault();
    mutation(async () => {
      const record = db.records.find(item => item.id === current);
      if (!record?.published) throw new Error('Выберите опубликованную идею.');
      const action = $('eventAction').value, note = $('eventNote').value.trim();
      if (!note) throw new Error('Добавьте пояснение к изменению.');
      const payload = {revision:db.revision,action,note};
      if (['manual','stop-change'].includes(action)) {
        payload.price = Number($('exitPrice').value);
        if (!Number.isFinite(payload.price) || payload.price <= 0) throw new Error('Укажите положительную цену.');
      }
      if (action === 'levels') {
        payload.d = {entry:Number($('levelEntry').value),stop:Number($('levelStop').value),target:Number($('levelTarget').value),horizon:$('levelHorizon').value.trim(),entryRule:$('levelEntryRule').value.trim(),cancelRule:$('levelCancelRule').value.trim()};
        validateLevels({...payload.d,dir:record.d.dir});
        if (!payload.d.entryRule || !payload.d.cancelRule) throw new Error('Укажите условия входа, отмены и выхода.');
        if (!payload.d.horizon) delete payload.d.horizon;
      }
      const result = await api(`/api/admin/ideas/${encodeURIComponent(current)}/events`,{method:'POST',body:JSON.stringify(payload)});
      acceptChange(result);
      message('Обновление опубликовано. Первоначальная запись и предыдущая история сохранены.');
    });
  });
  $('deleteIdea').addEventListener('click', () => {
    const record = db.records.find(item => item.id === current);
    if (!record || record.published || !confirm(`Удалить черновик «${record.d.ticker || 'Новая идея'}»?`)) return;
    mutation(async () => {
      const result = await api(`/api/admin/ideas/${encodeURIComponent(record.id)}`,{method:'DELETE',body:JSON.stringify({revision:db.revision})});
      if (Number.isInteger(result.revision)) db.revision = result.revision;
      db.records = db.records.filter(item => item.id !== record.id);
      if (draftId === record.id) clearFull();
      select(null);
      message('Черновик удалён.');
    });
  });
  $('refreshIdeas').addEventListener('click', async () => { try { await loadIdeas(); message('Список идей обновлён.'); } catch (error) { message(error.message,true); } });
  function planName(plan) { return plan === 'exclusive' ? 'Orbita Exclusive' : plan === 'pro' ? 'Orbita Pro' : plan; }
  function subscriptionsText(user) {
    return (user.subscriptions || []).map(subscription => `${planName(subscription.plan)}: ${subscription.expiresAt ? `до ${stamp(subscription.expiresAt)} МСК${new Date(subscription.expiresAt).getTime() <= Date.now() ? ' · истёк' : ''}` : 'доступ отозван'}`).join(' · ') || 'Активных подписок нет';
  }
  function selectedUser() {
    const user = users.find(item => item.id === $('subscriptionUser').value);
    $('selectedUserAccess').textContent = user ? `${user.email} · ${user.role === 'admin' ? 'Администратор · ' : ''}${subscriptionsText(user)}` : '';
  }
  async function loadUsers() {
    const result = await api('/api/admin/users');
    if (!Array.isArray(result.users)) throw new Error('Сервер не вернул список клиентов.');
    users = result.users;
    accountsRevision = result.revision;
    const chosen = $('subscriptionUser').value;
    $('subscriptionUser').innerHTML = '<option value="">Выберите email</option>' + users.map(user => `<option value="${escape(user.id)}">${escape(user.email)}${user.role === 'admin' ? ' · администратор' : ''}</option>`).join('');
    if (users.some(user => user.id === chosen)) $('subscriptionUser').value = chosen;
    $('usersStatus').textContent = users.length ? `Клиентов в базе: ${users.length}` : 'В базе пока нет клиентов. Клиент появится после регистрации.';
    $('usersOverview').innerHTML = users.map(user => `<article class="user-row"><strong>${escape(user.email)}${user.role === 'admin' ? ' <span>Администратор</span>' : ''}</strong><p>${escape(subscriptionsText(user))}</p></article>`).join('');
    selectedUser();
  }
  $('subscriptionUser').addEventListener('change', selectedUser);
  $('subscriptionAction').addEventListener('change', () => {
    const revoke = $('subscriptionAction').value === 'revoke';
    $('subscriptionExpiryField').hidden = revoke;
    $('subscriptionExpiry').required = !revoke;
  });
  $('refreshUsers').addEventListener('click', async () => { try { await loadUsers(); message('Список клиентов обновлён.'); } catch (error) { message(error.message,true); } });
  $('subscriptionForm').addEventListener('submit', event => {
    event.preventDefault();
    mutation(async () => {
      const userId = $('subscriptionUser').value, plan = $('subscriptionPlan').value, action = $('subscriptionAction').value, reason = $('subscriptionReason').value.trim();
      if (!userId || !reason) throw new Error('Выберите клиента и укажите причину изменения доступа.');
      let expiresAt = null;
      if (action !== 'revoke') {
        const date = new Date(`${$('subscriptionExpiry').value}:00+03:00`);
        if (!Number.isFinite(date.getTime()) || date.getTime() <= Date.now()) throw new Error('Укажите будущую дату окончания доступа по московскому времени.');
        expiresAt = date.toISOString();
      }
      const payload = {userId,plan,expiresAt,reason,action};
      if (accountsRevision !== undefined) payload.revision = accountsRevision;
      await api('/api/admin/subscriptions',{method:'POST',body:JSON.stringify(payload)});
      $('subscriptionReason').value = '';
      await loadUsers();
      message(action === 'revoke' ? 'Доступ отозван. Изменение сохранено на сервере.' : 'Доступ сохранён. Клиенту достаточно обновить страницу кабинета.');
    });
  });
  window.addEventListener('beforeunload', event => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
  async function start() {
    try {
      const data = await api('/api/me');
      if (!data.user) { location.replace('account.html?next=%2Fadmin.html'); return; }
      if (!(data.user.role === 'admin' || data.user.access?.isAdmin)) { showForbidden(); return; }
      $('authState').hidden = true;
      $('adminMain').hidden = false;
      $('adminIdentity').textContent = ` / ${data.user.email}`;
      strategyOptions();
      const expiry = new Date(Date.now() + 30 * 86400000 + 3 * 3600000);
      $('subscriptionExpiry').value = expiry.toISOString().slice(0,16);
      const results = await Promise.allSettled([loadIdeas(),loadUsers()]);
      results.forEach(result => { if (result.status === 'rejected') message(result.reason.message,true); });
      $('quickTicker').focus();
    } catch (error) {
      $('authState').innerHTML = `<h1>Не удалось открыть редакцию.</h1><p>${escape(error.message)}</p><button type="button" id="retryAdmin">Повторить</button>`;
      $('retryAdmin').addEventListener('click',start);
    }
  }
  start();
})();
