(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
  const format = new Intl.DateTimeFormat('ru-RU', {timeZone:'Europe/Moscow',day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'});
  const stamp = value => { const date = new Date(value); return value && Number.isFinite(date.getTime()) ? format.format(date) : String(value || 'Дата не указана'); };
  const number = value => value === null || value === undefined || value === '' ? '—' : Number(value).toLocaleString('ru-RU',{maximumFractionDigits:8});
  const fields = ['ticker','name','market','dir','title','summary','entry','stop','target','horizon','strategy','thesis','entryRule','cancelRule'];
  const numericFields = ['entry','stop','target'];
  const strategyMarkets={'Momentum RU':'stocks','Trend RU':'stocks','Импульс':'futures','Crypto Momentum':'crypto','Crypto Trend':'crypto','Orbita Exclusive':'stocks'};
  const defaultStrategies={stocks:'Momentum RU',futures:'Импульс',crypto:'Crypto Momentum'};
  const eventFieldIds=['levelEntry','levelStop','levelTarget','levelHorizon','levelEntryRule','levelCancelRule','exitPrice','eventNote','descriptionName','descriptionTitle','descriptionSummary','descriptionThesis','descriptionHorizon','descriptionChart'];
  const eventDrafts=new Map();let eventDirty=false;
  const ideaSummary = d => window.OrbitaIdeaCopy?.summary?.(d) ?? d.summary ?? '';
  let db = {revision:0,records:[]}, users = [], current = null, draftId = null, dirty = false, mutating = false, accountsRevision,privateSession;
  const form = $('ideaForm');
  let radarDraft=null;
  const radarPanel=document.createElement('section');radarPanel.id='radarSourcePanel';radarPanel.className='radar-source-panel';radarPanel.hidden=true;form.before(radarPanel);
  function clearRadar({release=true}={}){const previous=radarDraft;radarDraft=null;radarPanel.replaceChildren();radarPanel.hidden=true;$('saveDraft').hidden=false;form.elements.ticker.readOnly=false;form.elements.market.disabled=false;if(release&&previous)void api('/api/admin/radar-workflow/'+encodeURIComponent(previous.event.id)+'/release',{method:'POST',body:JSON.stringify({draftToken:previous.draftToken})}).catch(()=>{});}
  async function openRadar(id){
    if(!/^[A-Za-z0-9_-]{1,100}$/.test(id))throw Error('Некорректное событие Radar.');if(dirty&&!confirm('Заменить несохранённую форму сценарием Radar?'))return;
    const info=await api('/api/admin/radar-workflow/'+encodeURIComponent(id));if(!info.instruments.length)throw Error('Инструмент события не поддерживается для сигналов. Событие остаётся в Radar.');const allowAnother=info.relatedSignals.length>0;if(allowAnother&&!confirm('По событию уже есть '+info.relatedSignals.length+' сигнал(а). Создать ещё один?'))return;
    const result=await api('/api/admin/radar-workflow/'+encodeURIComponent(info.event.id)+'/draft',{method:'POST',body:JSON.stringify({requestId:crypto.randomUUID(),allowAnother,instrumentId:info.instruments[0].id})});clearFull();radarDraft=result;radarPanel.hidden=false;
    radarPanel.innerHTML='<p class="preview-tag">ИСТОЧНИК / RADAR</p><h3>'+escape(result.event.headline)+'</h3><p>'+escape(result.event.summary)+'</p><p class="form-note">Контекст события не определяет направление сделки. Укажите собственные уровни и условия. После проверки подтвердите публикацию.</p>';
    const links=document.createElement('div');links.className='radar-source-links';for(const source of result.event.sources||[]){let url;try{url=new URL(source.url);}catch{continue;}if(url.protocol!=='https:'||url.username||url.password)continue;const link=document.createElement('a');link.href=url.href;link.target='_blank';link.rel='noopener noreferrer';link.textContent='Первоисточник ↗';links.append(link);}radarPanel.append(links);
    for(const record of result.relatedSignals){const link=document.createElement('a');link.href='admin.html?idea='+encodeURIComponent(record.id);link.textContent='Связанный сигнал: '+record.ticker+' · '+record.state;radarPanel.append(link);}
    form.elements.ticker.value=result.instrument.ticker;form.elements.ticker.readOnly=true;form.elements.name.value=result.instrument.name;form.elements.market.value='stocks';form.elements.market.disabled=true;compatibleStrategies('stocks',$('fullStrategy'));form.elements.title.value='Новый сценарий '+result.instrument.ticker;form.elements.horizon.value='1–5 дней';$('saveDraft').hidden=true;$('fullFormTitle').textContent='Сценарий по событию Radar';$('fullComposer').open=true;dirty=true;preview();form.elements.entry.focus();radarPanel.scrollIntoView({block:'center',behavior:'smooth'});message('Тикер выбран. Заполните уровни и условия, затем подтвердите полный сценарий.');
  }

  const eventDraftStatus=document.createElement('p');eventDraftStatus.id='eventDraftStatus';eventDraftStatus.className='form-note';eventDraftStatus.setAttribute('role','status');$('eventForm').prepend(eventDraftStatus);
  const discardEvent=document.createElement('button');discardEvent.type='button';discardEvent.id='discardEvent';discardEvent.className='text-button';discardEvent.textContent='Сбросить черновик обновления';discardEvent.hidden=true;$('eventForm').append(discardEvent);
  discardEvent.addEventListener('click',()=>{if(mutating||!current||!confirm('Сбросить несохранённое обновление этой идеи?'))return;eventDrafts.delete(current);eventDirty=false;select(current);});
  function rememberEvent(){
    if(!current||!eventDirty)return;
    const previous=eventDrafts.get(current);
    eventDrafts.set(current,{action:$('eventAction').value||previous?.action||'',values:Object.fromEntries(eventFieldIds.map(id=>[id,$(id).value]))});
    discardEvent.hidden=false;
    eventDraftStatus.textContent=$('eventAction').value?'Есть несохранённое обновление. Оно сохранится в форме при переключении идей и обновлении списка.':'Действие из черновика больше недоступно: статус идеи изменился. Поля сохранены; выберите подходящее действие перед публикацией.';
  }
  function message(text, error = false) { $('message').textContent = text; $('message').classList.toggle('error', error); }
  async function api(path, options = {}) {
    if(privateSession)await privateSession.ensure();
    let response;
    try { response = await fetch(path,{credentials:'same-origin',cache:'no-store',...options,headers:{...(options.body ? {'Content-Type':'application/json'} : {}),...options.headers}}); }
    catch { throw new Error('Не удалось подключиться к серверу. Проверьте соединение и повторите попытку.'); }
    let data;
    try { data = await response.json(); } catch { throw new Error('Сервер вернул неожиданный ответ. Обновите страницу и попробуйте снова.'); }
    if(privateSession)await privateSession.ensure();
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
    const controls=[...document.querySelectorAll('[data-mutation],#ideaList button,#refreshIdeas,#refreshUsers,#clearFullForm,#newIdea,#quickForm input,#quickForm select,#ideaForm input,#ideaForm textarea,#ideaForm select,#eventForm input,#eventForm textarea,#eventForm select,#eventForm button,#subscriptionForm input,#subscriptionForm select,#subscriptionForm textarea')].filter(control=>!control.disabled);
    controls.forEach(control=>control.disabled=true);
    try { await work(); } catch (error) { message(error.message,true); }
    finally { mutating = false;controls.forEach(control=>control.disabled=false);for(const button of $('ideaList').querySelectorAll('button'))button.disabled=false; }
  }
  const parseTargets=value=>String(value||'').split(/[;\s]+/).map(item=>item.trim().replace(',','.')).filter(Boolean).map(Number);
  function readFullData() { const data=Object.fromEntries(fields.map(key => { const value = form.elements[key].value.trim(); return [key,numericFields.includes(key) ? value === '' ? null : Number(value) : value]; }));const extra=parseTargets($('fullTargets')?.value);if(extra.length)data.targets=extra;return data; }
  function validateLevels(data) {
    if (![data.entry,data.stop,data.target].every(value => Number.isFinite(value) && value > 0)) throw new Error('Вход, стоп и цель должны быть положительными числами.');
    if (data.dir === 'ЛОНГ' && !(data.stop < data.entry && data.entry < data.target)) throw new Error('Для лонга: стоп < вход < цель.');
    if (data.dir === 'ШОРТ' && !(data.target < data.entry && data.entry < data.stop)) throw new Error('Для шорта: цель < вход < стоп.');
  }
  function compatibleStrategies(market,select,preferred=select.value) {
    const names = (window.ORBITA_STRATEGIES || []).map(strategy => strategy.name);
    if (!names.length) names.push(...Object.keys(strategyMarkets));
    // EXCLUSIVE is available for every market; the strategy sets the access tier.
    const compatible=names.filter(name=>name==='Orbita Exclusive'||strategyMarkets[name]===market),pro=compatible.filter(name=>name!=='Orbita Exclusive');
    select.innerHTML=`<optgroup label="PRO / Дейтрейдинг">${pro.map(name=>`<option value="${escape(name)}">${escape(name)} · PRO</option>`).join('')}</optgroup>${compatible.includes('Orbita Exclusive')?'<optgroup label="EXCLUSIVE"><option value="Orbita Exclusive">Orbita Exclusive · EXCLUSIVE</option></optgroup>':''}`;
    select.value=compatible.includes(preferred)?preferred:defaultStrategies[market];
  }
  function strategyOptions() {
    compatibleStrategies($('quickMarket').value,$('quickStrategy'));
    compatibleStrategies(form.elements.market.value,$('fullStrategy'));
  }
  function ideaCard(record) {
    const d = record.d || {};
    const levels = [d.entry,d.stop,d.target].every(value => Number.isFinite(value) && value > 0);
    return `<div class="selected-identity"><span class="preview-tag">${escape(d.dir)} · ${escape(d.strategy)}</span><h2>${escape(d.ticker || 'Черновик')}</h2>${d.name ? `<p>${escape(d.name)}</p>` : ''}${d.title ? `<h3>${escape(d.title)}</h3>` : ''}${d.summary ? `<p>${escape(ideaSummary(d))}</p>` : ''}${levels ? `<div class="selected-levels"><span>Вход<b>${escape(number(d.entry))}</b></span><span>Стоп<b>${escape(number(d.stop))}</b></span><span>Цель<b>${escape(number(d.target))}</b></span></div>` : `<p class="no-levels">${record.published ? 'Тикер и направление опубликованы. Уровни ещё не заданы.' : 'Укажите уровни для полного сценария. Черновик можно сохранить без них.'}</p>`}${record.createdVia === 'TELEGRAM' ? '<p class="preview-tag">Источник: Telegram</p>' : ''}${record.radarSource ? '<p class="preview-tag">Контекст: Radar · '+escape(record.radarSource.headline)+'</p>' : ''}${record.demo ? '<p class="demo-label">Учебный пример</p>' : ''}${record.erroneous ? '<p class="error-label">Ошибочная публикация · сохранена в истории</p>' : ''}</div>`;
  }
  function preview() {
    const data = readFullData();
    $('fullPreview').innerHTML = data.ticker ? ideaCard({d:data,published:false}) + (window.OrbitaIdeaChart ? OrbitaIdeaChart.svg({id:draftId||'preview-'+data.ticker,d:data}) : window.TradeScheme ? TradeScheme.markup(data) : '') + `<p class="form-note">Доступ: ${data.strategy==='Orbita Exclusive'?'EXCLUSIVE (только подписчики EXCLUSIVE)':'PRO (подписчики PRO и EXCLUSIVE)'}</p>` : '';
  }
  function renderList() {
    $('count').textContent = String(db.records.length);
    const tierOf=record=>record.tier||(record.d?.strategy==='Orbita Exclusive'?'exclusive':'pro'),tierFilter=$('listTier')?.value||'',stateFilter=$('listState')?.value||'';
    const visible=db.records.filter(record=>(!tierFilter||tierOf(record)===tierFilter)&&(!stateFilter||(stateFilter==='draft'?!record.published:stateFilter==='archived'?record.archived:stateFilter==='open'?record.published&&!record.archived&&['announced','waiting','active'].includes(record.d?.state):record.published&&!record.archived&&['closed','cancelled'].includes(record.d?.state))));
    $('ideaList').innerHTML = visible.length ? visible.map(record => `<button type="button" class="list-item${record.id === current ? ' active' : ''}" data-id="${escape(record.id)}" aria-pressed="${record.id === current}"><strong>${escape(record.d?.ticker || 'Черновик')}<span>${record.d?.dir === 'ШОРТ' ? '↘' : '↗'}</span></strong><small>${escape(record.erroneous ? 'Ошибочная публикация' : record.published ? record.d?.status || record.d?.state : 'Черновик')}</small><small>${tierOf(record)==='exclusive'?'EXCLUSIVE':'PRO'} · ${escape(record.d?.strategy || '')}${record.createdVia === 'TELEGRAM' ? ' · Telegram' : ''}${record.archived?' · архив':''}${record.showcase?' · пример на лендинге':''}</small></button>`).join('') : `<p class="empty-list">${db.records.length?'Нет идей по фильтру.':'Пока нет идей. Опубликуйте первый сигнал.'}</p>`;
    $('ideaList').querySelectorAll('[data-id]').forEach(button => {button.disabled=mutating;button.addEventListener('click', () => {if(!mutating)select(button.dataset.id);});});
  }
  function eventFields() {
    const action = $('eventAction').value;
    $('levelsFields').hidden = !['levels','terms-change'].includes(action);
    $('levelHorizon').parentElement.hidden = action === 'terms-change';
    $('descriptionFields').hidden = action !== 'description';
    for (const id of ['levelEntry','levelStop','levelTarget','levelEntryRule','levelCancelRule']) $(id).required = ['levels','terms-change'].includes(action);
    $('strategyChangeField').hidden = action !== 'strategy-change';
    if(action==='strategy-change'){const record=db.records.find(item=>item.id===current);if(record){compatibleStrategies(record.d.market,$('strategyChangeSelect'),record.d.strategy);}}
    $('exitField').hidden = !['manual','stop-change','target-change'].includes(action);
    $('exitPrice').required = ['manual','stop-change','target-change'].includes(action);
    $('exitLabel').textContent = action === 'stop-change' ? 'Новый стоп' : action === 'target-change' ? 'Новая цель' : 'Цена закрытия';
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
    rememberEvent();eventDirty=false;eventDraftStatus.textContent='';discardEvent.hidden=true;
    current = id;
    $('deleteIdea').hidden = !record || !!record.published;
    $('publishedActions').hidden = !record?.published;
    $('editorStatus').textContent = !record ? 'ВЫБЕРИТЕ ИДЕЮ' : record.erroneous ? 'ОШИБОЧНАЯ ПУБЛИКАЦИЯ' : record.published ? record.d.status || record.d.state : 'ЧЕРНОВИК';
    $('selectedIdea').innerHTML = record ? ideaCard(record) : '<p>Выберите идею слева или опубликуйте новый сигнал.</p>';
    if (record?.published) {
      const state = record.d.state, active = !record.erroneous;
      const actions = [['note','Комментарий автора'],...(active ? [['description','Изменить описание и разбор']] : []),...(active && state === 'waiting' ? [['terms-change','Уточнить вход и условия до входа']] : []),...(active && state === 'announced' ? [['levels','Добавить уровни входа, стопа и цели']] : []),...(active && ['waiting','active'].includes(state) ? [['stop-change','Изменить стоп'],['target-change','Изменить цель']] : []),...(active && state === 'waiting' ? [['activate','Подтвердить вход']] : []),...(active && ['announced','waiting'].includes(state) ? [['cancel','Отменить до входа']] : []),...(active && state === 'active' ? [['target','Закрыть по цели'],['stop','Закрыть по стопу'],['manual','Закрыть вручную']] : []),...(active ? [['error','Пометить ошибочную публикацию']] : [])];
      if(active)actions.push(['strategy-change','Перенести в другую стратегию (PRO ↔ EXCLUSIVE)']);
      actions.push(record.archived?['unarchive','Вернуть из архива']:['archive','Перенести в архив (скрыть у клиентов)']);
      if(record.showcase)actions.push(['unshowcase','Снять публичный пример с лендинга']);else if(active&&!record.archived&&record.tier!=='exclusive'&&record.d.strategy!=='Orbita Exclusive'&&['announced','waiting','active'].includes(state))actions.push(['showcase','Показать на лендинге как пример PRO']);
      $('eventAction').innerHTML = actions.map(([value,label]) => `<option value="${value}">${label}</option>`).join('');
      $('eventForm').reset();
      $('eventAction').required=true;
      const pending=eventDrafts.get(record.id);
      if(pending){
        for(const fieldId of eventFieldIds)$(fieldId).value=pending.values[fieldId]||'';
        if(actions.some(([value])=>value===pending.action))$('eventAction').value=pending.action;
        else{const placeholder=document.createElement('option');placeholder.value='';placeholder.textContent='Выберите действие для нового статуса';placeholder.disabled=true;$('eventAction').prepend(placeholder);$('eventAction').value='';}
        eventDirty=true;rememberEvent();
      }
      eventFields();
      audit(record);
    } else if (record && !(dirty && draftId === record.id)) {
      if(radarDraft)clearRadar();
      draftId = record.id;
      form.reset();
      form.elements.market.value=record.d.market||'stocks';compatibleStrategies(form.elements.market.value,$('fullStrategy'),record.d.strategy);
      fields.forEach(key => { if (record.d[key] !== null && record.d[key] !== undefined) form.elements[key].value = record.d[key]; });
      if(!$('fullStrategy').value){$('fullStrategy').required=true;message('Рынок старого черновика не соответствует стратегии. Выберите подходящую стратегию перед сохранением.',true);}
      dirty = false;
      $('fullComposer').open = true;
      $('fullFormTitle').textContent = `Черновик ${record.d.ticker || ''}`;
      preview();
    }
    renderList();
  }
  function clearFull() { clearRadar();draftId = null; dirty = false; form.reset();compatibleStrategies(form.elements.market.value,$('fullStrategy')); $('fullFormTitle').textContent = 'Подготовить полный сценарий'; preview(); }
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
      const radarEvent=new URLSearchParams(location.search).get('radarEvent');if(radarEvent)await mutation(()=>openRadar(radarEvent));else $('quickTicker').focus();
      message(`${d.ticker}: ${d.dir.toLowerCase()} опубликован. Уровни и комментарий можно добавить ниже.`);
    });
  });
  $('quickMarket').addEventListener('change', () => compatibleStrategies($('quickMarket').value,$('quickStrategy')));
  form.elements.market.addEventListener('change',()=>{compatibleStrategies(form.elements.market.value,$('fullStrategy'));preview();});
  form.addEventListener('input', () => { dirty = true; preview(); });
  form.addEventListener('change', () => { dirty = true; preview(); });
  async function saveFull(mode) {
    const d = readFullData();
    if (mode === 'full') validateLevels(d);
    if(radarDraft){if(mode!=='full')throw Error('Сценарий Radar публикуется после проверки полного плана.');if(!confirm(`${d.ticker} · ${d.dir}\nВход ${number(d.entry)} · Стоп ${number(d.stop)} · Цель ${number(d.target)}\n\nОпубликовать сигнал по событию Radar?`))return;}
    const result = await api(draftId ? `/api/admin/ideas/${encodeURIComponent(draftId)}` : '/api/admin/ideas',{method:draftId ? 'PUT' : 'POST',body:JSON.stringify({revision:db.revision,mode,d,...(radarDraft?{radarDraftToken:radarDraft.draftToken}:{})})});
    dirty = false;
    if(radarDraft)clearRadar({release:false});
    if (mode === 'full') clearFull();
    acceptChange(result);
    if (mode === 'full') $('fullComposer').open = false;
    message(mode === 'draft' ? 'Черновик сохранён на сервере. Он виден только редакции.' : 'Полный сценарий опубликован. Первоначальные условия сохранены.');
  }
  form.addEventListener('submit', event => { event.preventDefault(); mutation(() => saveFull('full')); });
  $('saveDraft').addEventListener('click', () => mutation(() => saveFull('draft')));
  $('clearFullForm').addEventListener('click', () => { if (!dirty || confirm('Очистить несохранённую форму?')) clearFull(); });
  $('newIdea').addEventListener('click', () => { $('quickTicker').focus(); $('quickForm').scrollIntoView({behavior:'smooth',block:'center'}); });
  for(const id of ['listTier','listState'])$(id)?.addEventListener('change',renderList);
  $('eventAction').addEventListener('change',()=>{
    const record=db.records.find(item=>item.id===current),action=$('eventAction').value;
    if(record&&action==='terms-change')$('levelTargets').value=(record.d.targets||[]).join('; ');
    if(record&&action==='terms-change')for(const [id,field]of [['levelEntry','entry'],['levelStop','stop'],['levelTarget','target'],['levelEntryRule','entryRule'],['levelCancelRule','cancelRule']])$(id).value=record.d[field]??'';
    if(record&&action==='description')for(const [id,field]of [['descriptionName','name'],['descriptionTitle','title'],['descriptionSummary','summary'],['descriptionThesis','thesis'],['descriptionHorizon','horizon'],['descriptionChart','chartUrl']])$(id).value=record.d[field]??'';
    eventFields();
  });
  $('eventForm').addEventListener('input',()=>{eventDirty=true;rememberEvent();});
  $('eventForm').addEventListener('change',()=>{eventDirty=true;rememberEvent();});
  $('eventForm').addEventListener('submit', event => {
    event.preventDefault();
    mutation(async () => {
      const record = db.records.find(item => item.id === current);
      if (!record?.published) throw new Error('Выберите опубликованную идею.');
      const action = $('eventAction').value, note = $('eventNote').value.trim();
      if(!action)throw new Error('Выберите действие, доступное для текущего статуса идеи. Черновик полей сохранён.');
      if (!note && !['archive','unarchive','showcase','unshowcase'].includes(action)) throw new Error('Добавьте пояснение к изменению.');
      if(action==='strategy-change'){const next=$('strategyChangeSelect').value;if(!next||next===record.d.strategy)throw new Error('Выберите другую стратегию.');if(!confirm(`Перенести ${record.d.ticker} в «${next}»? Доступ клиентов изменится сразу.`))return;}
      const payload = {revision:db.revision,action,...(note?{note}:{})};
      if(action==='strategy-change')payload.d={strategy:$('strategyChangeSelect').value};
      if (['manual','stop-change','target-change'].includes(action)) {
        payload.price = Number($('exitPrice').value);
        if (!Number.isFinite(payload.price) || payload.price <= 0) throw new Error('Укажите положительную цену.');
      }
      if (['levels','terms-change'].includes(action)) {
        payload.d = {entry:Number($('levelEntry').value),stop:Number($('levelStop').value),target:Number($('levelTarget').value),...(parseTargets($('levelTargets').value).length||record.d.targets?.length?{targets:parseTargets($('levelTargets').value)}:{}),...(action==='levels'?{horizon:$('levelHorizon').value.trim()}:{}),entryRule:$('levelEntryRule').value.trim(),cancelRule:$('levelCancelRule').value.trim()};
        validateLevels({...payload.d,dir:record.d.dir});
        if (!payload.d.entryRule || !payload.d.cancelRule) throw new Error('Укажите условия входа, отмены и выхода.');
        if (!payload.d.horizon) delete payload.d.horizon;
      }
      if(action==='description')payload.d=Object.fromEntries([['name','descriptionName'],['title','descriptionTitle'],['summary','descriptionSummary'],['thesis','descriptionThesis'],['horizon','descriptionHorizon'],['chartUrl','descriptionChart']].map(([key,id])=>[key,$(id).value.trim()]));
      const result = await api(`/api/admin/ideas/${encodeURIComponent(current)}/events`,{method:'POST',body:JSON.stringify(payload)});
      eventDrafts.delete(record.id);if(current===record.id)eventDirty=false;
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
  $('refreshIdeas').addEventListener('click', () => mutation(async () => {await loadIdeas();message('Список идей обновлён.');}));
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
  $('refreshUsers').addEventListener('click', () => mutation(async () => {await loadUsers();message('Список клиентов обновлён.');}));
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
  window.addEventListener('beforeunload', event => { if (dirty||eventDirty||eventDrafts.size) { event.preventDefault(); event.returnValue = ''; } });
  async function start() {
    try {
      const data = await api('/api/me');
      if (!data.user) { location.replace('account.html?next=%2Fadmin.html'); return; }
      if (!(data.user.role === 'admin' || data.user.access?.isAdmin)) { showForbidden(); return; }
      privateSession=window.OrbitaAdminSession.watch(data.user,{workspace:'adminMain',clear(){clearRadar({release:false});db={revision:0,records:[]};users=[];current=draftId=null;dirty=eventDirty=false;eventDrafts.clear();for(const id of ['adminIdentity','ideaList','usersOverview','subscriptionUser','selectedUserAccess','selectedIdea','initialSnapshot','eventHistory','fullPreview','fullFormTitle','editorStatus','count','usersStatus'])$(id).replaceChildren();}});
      $('authState').hidden = true;
      $('adminMain').hidden = false;
      $('adminIdentity').textContent = ` / ${data.user.email}`;
      strategyOptions();
      const expiry = new Date(Date.now() + 30 * 86400000 + 3 * 3600000);
      $('subscriptionExpiry').value = expiry.toISOString().slice(0,16);
      await mutation(async()=>{const results = await Promise.allSettled([loadIdeas(new URLSearchParams(location.search).get('idea') || current),loadUsers()]);results.forEach(result => { if (result.status === 'rejected') message(result.reason.message,true); });});
      const radarEvent=new URLSearchParams(location.search).get('radarEvent');if(radarEvent)await mutation(()=>openRadar(radarEvent));else $('quickTicker').focus();
    } catch (error) {
      $('authState').innerHTML = `<h1>Не удалось открыть редакцию.</h1><p>${escape(error.message)}</p><button type="button" id="retryAdmin">Повторить</button>`;
      $('retryAdmin').addEventListener('click',start);
    }
  }
  start();
})();
