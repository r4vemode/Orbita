(async () => {
  'use strict';
  const A=window.OrbitaAccess,$=id=>document.getElementById(id),form=$('radarEventForm');
  const types={DIVIDEND:'Дивиденды',EARNINGS:'Отчётность',GUIDANCE:'Прогноз',BUYBACK:'Выкуп акций',SPO:'SPO',SECONDARY_OFFERING:'Вторичное размещение',SHARE_ISSUE:'Дополнительная эмиссия',M_AND_A:'Слияния и поглощения',CONTRACT:'Контракт',BOARD_MEETING:'Заседание совета директоров',BOARD_DECISION:'Решение совета директоров',MANAGEMENT_CHANGE:'Смена руководства',CREDIT_RATING:'Кредитный рейтинг',DEFAULT:'Дефолт',TECHNICAL_DEFAULT:'Технический дефолт',BANKRUPTCY:'Банкротство',DEBT:'Долговые обязательства',BOND_COUPON:'Купон облигации',BOND_OFFER:'Оферта по облигации',BOND_REDEMPTION:'Погашение облигации',CAPEX:'Капитальные затраты',CORPORATE_ACTION:'Корпоративное действие',LEGAL:'Правовое событие',OTHER:'Другое'};
  const statusNames={published:'Опубликовано',draft:'Черновик / неразобранное',hidden:'Скрыто',duplicate:'Дубль'};
  const impactNames={POSITIVE:'Положительное',NEGATIVE:'Отрицательное',NEUTRAL:'Нейтральное',MIXED:'Смешанное'};
  const providerStatuses={disabled:'ОТКЛЮЧЁН',idle:'ОЖИДАНИЕ',online:'ДОСТУПЕН',error:'ОШИБКА',running:'ПРОВЕРКА'};
  let state={events:[],companies:[],providers:[],revision:0,nextCursor:null},selected=null,dirty=false,busy=false,ready=false;
  let activeQuery=new URLSearchParams(),mergeCandidates=[];
  const date=value=>{const parsed=new Date(value);return value&&Number.isFinite(parsed.getTime())?new Intl.DateTimeFormat('ru-RU',{dateStyle:'short',timeStyle:'medium',timeZone:'Europe/Moscow'}).format(parsed)+' МСК':'—';};
  function node(tag,className,text){const result=document.createElement(tag);if(className)result.className=className;if(text!==undefined)result.textContent=String(text);return result;}
  function message(text,error=false){$('radarAdminMessage').textContent=text;$('radarAdminMessage').classList.toggle('error',error);}
  function markDirty(value=true){dirty=value;$('radarUnsaved').hidden=!dirty;}
  function localMoscow(value){const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(value));const values=Object.fromEntries(parts.map(part=>[part.type,part.value]));return `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}`;}
  function safeSource(value){try{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password?url.href:null;}catch{return null;}}
  function syncBusy(){
    $('radarEventFields').disabled=busy||!ready;
    for(const id of ['newRadarEvent','refreshRadarAdmin','retryRadarAdmin','loadLatestRadar','saveRadarDraft','publishRadarEvent','hideRadarEvent','duplicateRadarEvent','openRadarMerge','syncRadarProviders','moreRadarAdmin','applyRadarFilters','confirmRadarMerge','cancelRadarMerge'])$(id).disabled=busy||!ready;
    for(const button of $('radarAdminList').querySelectorAll('button'))button.disabled=busy;
    $('radarEventCompany').disabled=busy||!ready||!!selected;
    $('radarEventSource').required=!selected;$('radarEventPublishedAt').required=!selected;
    if(selected?.status==='duplicate')for(const id of ['saveRadarDraft','publishRadarEvent','hideRadarEvent','duplicateRadarEvent','openRadarMerge'])$(id).disabled=true;
  }
  async function api(url,options={}){
    try{return await A.request(url,options);}catch(error){
      if(error.status===401)location.replace('account.html?next=%2Fradar-admin.html');
      if(error.status===403){ready=false;$('radarAdminMain').hidden=true;$('radarAdminAuth').hidden=false;$('radarAdminAuth').replaceChildren(node('h1','','Доступ к редакции закрыт'),node('p','','Права аккаунта изменились. Войдите с аккаунтом администратора.'));}
      throw error;
    }
  }
  function guard(action){if(busy)return;if(!dirty||confirm('В форме есть несохранённые правки. Продолжить без сохранения?'))return action();}
  function fillTypes(){
    for(const [value,label]of Object.entries(types))for(const id of ['radarEventType','radarAdminType']){const option=node('option','',label);option.value=value;$(id).append(option);}
    $('radarEventType').value='OTHER';
  }
  function fillCompanies(){
    const value=$('radarEventCompany').value;$('radarEventCompany').replaceChildren(node('option','','Выберите компанию'));
    $('radarEventCompany').firstChild.value='';
    for(const company of state.companies){const option=node('option','',(company.ticker||'—')+' · '+(company.shortName||company.name||company.id));option.value=company.id;$('radarEventCompany').append(option);}
    $('radarEventCompany').value=value;
  }
  function renderProviders(){
    const root=$('radarProviders');root.replaceChildren();
    if(!state.providers.length){root.append(node('p','empty','Источники ещё не подключены. Ручные события и демонстрационный импорт работают независимо.'));return;}
    for(const provider of state.providers){
      const card=node('article','radar-provider'),top=node('div','radar-provider-top');top.append(node('h3','',provider.name||provider.id),node('span','radar-provider-status '+(Object.hasOwn(providerStatuses,provider.status)?provider.status:''),providerStatuses[provider.status]||'НЕИЗВЕСТНО'));
      const list=node('dl');const delay=typeof provider.averageDelay==='number'&&Number.isFinite(provider.averageDelay)?provider.averageDelay.toLocaleString('ru-RU',{maximumFractionDigits:1})+' мс':'—';
      for(const [label,value]of [['Последняя попытка',date(provider.lastFetch)],['Успешная проверка',date(provider.lastSuccess)],['Событий сегодня',provider.eventsToday??0],['Ошибок сегодня',provider.errorsToday??0],['Средняя задержка',delay],['Следующая попытка',date(provider.nextAttemptAt)]])list.append(node('dt','',label),node('dd','',value));
      card.append(top,list);if(provider.error)card.append(node('p','provider-error','Код ошибки: '+String(provider.error).slice(0,120)));root.append(card);
    }
  }
  function renderList(){
    const root=$('radarAdminList');root.replaceChildren();$('radarAdminCount').textContent=String(state.events.length)+(state.nextCursor?'+':'');$('radarAdminEmpty').hidden=state.events.length>0;$('moreRadarAdmin').hidden=!state.nextCursor;
    for(const event of state.events){
      const button=node('button','content-item radar-admin-item'+(selected?.id===event.id?' active':'')+(event.isDemo?' is-demo':''));button.type='button';button.dataset.radarEvent=event.id;button.setAttribute('aria-pressed',String(selected?.id===event.id));
      const top=node('div','radar-item-heading');top.append(node('strong','',(event.ticker||'Не сопоставлено')+' · '+(event.headline||'Без заголовка')),node('span','radar-item-score',Number.isFinite(event.importanceScore)?event.importanceScore.toFixed(1)+'/10':'—'));
      button.append(top,node('span','radar-item-type',(types[event.eventType]||event.eventType||'Не определено')+' · '+(impactNames[event.impact]||'—')),node('small','',(statusNames[event.status]||event.status||'—')+(event.isDemo?' · ДЕМО':'')+' · '+date(event.publishedAt)));button.disabled=busy;button.addEventListener('click',()=>guard(()=>select(event)));root.append(button);
    }
  }
  function renderSourceDetails(event){
    $('radarSourceDetails').hidden=!event;$('radarAnalysisDetails').hidden=!event;
    const sources=$('radarEventSources');sources.replaceChildren();
    for(const source of event?.sources||[]){const href=safeSource(source.url);if(!href)continue;const link=node('a','',(source.provider||'Первоисточник')+' ↗');link.href=href;link.target='_blank';link.rel='noopener noreferrer';sources.append(link);}
    if(event&&!sources.childElementCount)sources.append(node('p','empty','Ссылка на первоисточник не указана.'));
    $('radarEventRaw').textContent=event?.rawText||'';
    const method={rules:'Анализ по правилам',ai:'Внешний AI-анализ',manual:'Ручной анализ'}[event?.analysisMethod]||'Метод анализа не указан';
    $('radarAnalysisMeta').textContent=event?method+' · Уверенность '+(typeof event.confidence==='number'?(event.confidence*100).toLocaleString('ru-RU',{maximumFractionDigits:1})+'%':'не указана')+(event.aiIncorrect?' · Отмечена ошибка исходного анализа':''):'';
    const trace=$('radarEventTrace');trace.replaceChildren();for(const item of event?.trace||[])trace.append(node('li','',String(item.stage||item.action||'Обработка')+' · '+date(item.at)));
    $('radarOriginalAnalysis').textContent=event?.originalAnalysis?JSON.stringify(event.originalAnalysis,null,2):event?.audit?.length?JSON.stringify(event.audit,null,2):'';
  }
  function select(event=null){
    selected=event?structuredClone(event):null;
    form.elements.companyId.value=event?.companyId||'';form.elements.eventType.value=Object.hasOwn(types,event?.eventType)?event.eventType:'OTHER';form.elements.headline.value=event?.headline||'';form.elements.summary.value=event?.summary||'';form.elements.whyImportant.value=event?.whyImportant||'';form.elements.impact.value=Object.hasOwn(impactNames,event?.impact)?event.impact:'NEUTRAL';form.elements.importanceScore.value=event?.importanceScore??6;form.elements.source.value='';form.elements.publishedAt.value=localMoscow(event?.publishedAt||Date.now());form.elements.aiIncorrect.checked=event?.aiIncorrect===true;
    $('radarManualSource').hidden=!!event;$('radarIncorrectLabel').hidden=!event;$('radarExistingActions').hidden=!event;$('hideRadarEvent').hidden=!event||event.status!=='published';
    $('saveRadarDraft').textContent=event?'Сохранить изменения':'Сохранить черновик';$('publishRadarEvent').hidden=event?.status==='published';
    $('radarEditorState').textContent=event?(statusNames[event.status]||event.status).toUpperCase()+(event.isDemo?' / ДЕМО':''):'РУЧНОЕ СОБЫТИЕ';$('radarEditorHeading').textContent=event?'Проверить и исправить':'Подготовить событие';
    $('radarEventMeta').textContent=event?'Источник опубликовал '+date(event.publishedAt)+' · Обнаружено '+date(event.detectedAt)+' · Обработано '+date(event.processedAt)+' · Версия '+event.revision:'';
    $('viewRadarEvent').href='radar.html'+(event?'?event='+encodeURIComponent(event.id):'');
    $('radarConflict').hidden=true;markDirty(false);renderSourceDetails(event);renderList();syncBusy();
  }
  function queryFromFilters(){const query=new URLSearchParams();const values={q:$('radarAdminSearch').value.trim(),status:$('radarAdminStatus').value,type:$('radarAdminType').value};for(const [key,value]of Object.entries(values))if(value)query.set(key,value);query.set('limit','50');return query;}
  function showSkeleton(){const root=$('radarAdminList');root.replaceChildren();for(let i=0;i<3;i++)root.append(node('div','radar-list-skeleton'));}
  async function refresh({append=false,keepSelected=false}={}){
    if(busy)return;busy=true;syncBusy();$('radarAdminList').setAttribute('aria-busy','true');$('radarAdminRetry').hidden=true;if(!append&&!state.events.length)showSkeleton();
    try{
      const query=new URLSearchParams(append?activeQuery:queryFromFilters());if(append&&state.nextCursor)query.set('cursor',state.nextCursor);const result=await api('/api/admin/radar?'+query);
      if(!Array.isArray(result.events)||!Array.isArray(result.companies)||!Array.isArray(result.providers))throw Error('Сервер вернул некорректные данные Radar.');
      const current=selected?.id,seen=new Set();state={...result,events:(append?[...state.events,...result.events]:result.events).filter(event=>{if(seen.has(event.id))return false;seen.add(event.id);return true;})};if(!append){activeQuery=new URLSearchParams(query);activeQuery.delete('cursor');}
      fillCompanies();renderProviders();
      if(!keepSelected&&!append)select(state.events.find(event=>event.id===current)||null);else renderList();
      message('Редакция Radar обновлена.');
    }catch(error){message(error.message,true);$('radarAdminRetry').hidden=false;renderList();}
    finally{busy=false;syncBusy();$('radarAdminList').setAttribute('aria-busy','false');}
  }
  function readEditor(){return {headline:form.elements.headline.value.trim(),summary:form.elements.summary.value.trim(),whyImportant:form.elements.whyImportant.value.trim(),eventType:form.elements.eventType.value,impact:form.elements.impact.value,importanceScore:Number(form.elements.importanceScore.value)};}
  async function mutate(route,method,payload,success){
    if(busy)return false;busy=true;syncBusy();message('Сохраняем событие…');
    try{
      const result=await api(route,{method,body:JSON.stringify(payload)});const event=result.event;
      if(event?.id){const index=state.events.findIndex(value=>value.id===event.id);if(index<0)state.events.unshift(event);else state.events[index]=event;select(event);}else markDirty(false);
      if(Number.isSafeInteger(result.revision))state.revision=result.revision;message(success);return true;
    }catch(error){
      if(error.status===409){$('radarConflict').hidden=false;message('Сохранение остановлено: событие изменилось. Ваши правки остались в форме.',true);}else message(error.message,true);return false;
    }finally{busy=false;syncBusy();}
  }
  async function save(action){
    if(busy||!ready||!form.reportValidity())return;
    const payload=readEditor();if(!payload.headline||!payload.summary){message('Заполните заголовок и краткое описание.',true);return;}
    if(!selected){
      const source=safeSource(form.elements.source.value.trim());if(!source){message('Укажите HTTPS-ссылку на первоисточник без логина и пароля.',true);return;}
      const publishedAt=new Date(form.elements.publishedAt.value+':00+03:00');if(!Number.isFinite(publishedAt.getTime())){message('Проверьте время публикации первоисточника.',true);return;}
      Object.assign(payload,{companyId:form.elements.companyId.value,source,publishedAt:publishedAt.toISOString(),status:action==='publish'?'published':'draft'});
    }else{payload.revision=selected.revision;payload.aiIncorrect=form.elements.aiIncorrect.checked;if(action==='publish')payload.status='published';else if(action==='hide')payload.status='hidden';}
    await mutate('/api/admin/radar'+(selected?'/'+encodeURIComponent(selected.id):''),selected?'PATCH':'POST',payload,action==='publish'?'Событие опубликовано. Торговый сигнал автоматически не создаётся.':action==='hide'?'Событие скрыто из клиентской ленты. Запись и история сохранены.':selected?'Изменения сохранены.':'Черновик события сохранён.');
  }
  function openMerge(){
    if(busy||!selected)return;if(dirty){message('Перед объединением сохраните или сбросьте правки текущего события.',true);return;}
    mergeCandidates=state.events.filter(event=>event.id!==selected.id&&event.status!=='duplicate'&&event.companyId===selected.companyId);const select=$('radarMergeTarget');select.replaceChildren(node('option','','Выберите другое событие той же компании'));select.firstChild.value='';
    for(const event of mergeCandidates){const option=node('option','',(event.ticker||'—')+' · '+event.headline+' · '+date(event.publishedAt));option.value=event.id;select.append(option);}
    $('radarMergeMessage').textContent=mergeCandidates.length?'':'В текущем списке нет другого события этой компании. Измените фильтры или загрузите следующую страницу.';$('radarMergeDialog').showModal();select.focus();
  }
  async function merge(){
    if(busy||!selected||!$('radarMergeForm').reportValidity())return;const target=mergeCandidates.find(event=>event.id===$('radarMergeTarget').value);if(!target)return;
    if(!confirm('Объединить источники с «'+target.headline+'» и пометить текущее событие дублем?'))return;
    const ok=await mutate('/api/admin/radar/'+encodeURIComponent(selected.id)+'/merge','POST',{revision:selected.revision,targetId:target.id,targetRevision:target.revision},'Источники объединены. Исходное событие сохранено как дубль.');
    if(ok){$('radarMergeDialog').close();await refresh();}else{$('radarMergeMessage').textContent='Объединение не выполнено. Проверьте сообщение редакции.';}
  }
  async function duplicate(){
    if(busy||!selected)return;if(dirty){message('Сохраните правки перед отметкой дубля либо загрузите актуальную версию.',true);return;}
    if(!confirm('Пометить событие «'+selected.headline+'» дублем? Оно исчезнет из клиентской ленты, а исходная запись останется в истории.'))return;
    const ok=await mutate('/api/admin/radar/'+encodeURIComponent(selected.id),'DELETE',{revision:selected.revision},'Событие помечено дублем. Исходная запись сохранена.');if(ok)await refresh();
  }
  async function syncProviders(){
    if(busy)return;busy=true;syncBusy();message('Проверяем подключённые источники…');
    try{const result=await api('/api/admin/radar/sync',{method:'POST',body:'{}'});if(Array.isArray(result.providers))state.providers=result.providers;renderProviders();message('Проверка источников завершена. Отключённые источники не опрашиваются.');}
    catch(error){message(error.message,true);return;}finally{busy=false;syncBusy();}
    // Retain the current editor values and revision. A concurrent provider
    // update must never silently replace an administrator's unsaved work.
    if(ready)await refresh({keepSelected:true});
  }
  fillTypes();
  form.addEventListener('submit',event=>{event.preventDefault();void save(event.submitter?.dataset.action||'draft');});form.addEventListener('input',()=>markDirty());form.addEventListener('change',()=>markDirty());
  $('radarAdminFilters').addEventListener('submit',event=>{event.preventDefault();guard(()=>refresh());});
  $('newRadarEvent').addEventListener('click',()=>guard(()=>{select();message('Подготовьте событие по первоисточнику. Сначала его можно сохранить в черновик.');$('radarEventCompany').focus();}));
  $('refreshRadarAdmin').addEventListener('click',()=>guard(()=>refresh()));$('retryRadarAdmin').addEventListener('click',()=>guard(()=>refresh()));$('loadLatestRadar').addEventListener('click',()=>guard(()=>refresh()));
  $('moreRadarAdmin').addEventListener('click',()=>refresh({append:true}));$('hideRadarEvent').addEventListener('click',()=>{if(confirm('Скрыть событие из клиентской ленты и сохранить текущие правки?'))void save('hide');});
  $('duplicateRadarEvent').addEventListener('click',()=>void duplicate());$('openRadarMerge').addEventListener('click',openMerge);$('cancelRadarMerge').addEventListener('click',()=>$('radarMergeDialog').close());$('radarMergeForm').addEventListener('submit',event=>{event.preventDefault();void merge();});
  $('syncRadarProviders').addEventListener('click',()=>void syncProviders());
  $('radarMergeDialog').addEventListener('cancel',event=>{if(busy)event.preventDefault();});
  window.addEventListener('beforeunload',event=>{if(dirty){event.preventDefault();event.returnValue='';}});
  try{const user=await A.requireAdmin();if(!user)return;ready=true;$('radarAdminAuth').hidden=true;$('radarAdminMain').hidden=false;select();await refresh();}
  catch(error){$('radarAdminAuth').replaceChildren(node('h1','','Не удалось открыть редакцию Radar'),node('p','',error.message));}
})();
