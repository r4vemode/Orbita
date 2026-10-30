(() => {
  'use strict';
  const $=id=>document.getElementById(id),A=window.OrbitaAccess;
  let config=null,userId=null,coverage=[],indexMembership=null,instruments=[],watchlist=[],view='stocks',isDemo=false,snapshot=null,visibleLimit=12,busy=false,watchBusy=false,restricted=false,suspended=false,epoch=0,feedSequence=0,detailSequence=0,feedController=null,detailController=null,accessTimer=null,refreshTimer=null,searchTimer=null,lastFocus=null,detailSymbol=null;
  const el=(tag,className,text)=>{const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=String(text);return node;};
  const finite=value=>typeof value==='number'&&Number.isFinite(value);
  const count=value=>finite(value)?new Intl.NumberFormat('ru-RU',{maximumFractionDigits:0}).format(value):'Нет данных';
  const percent=value=>finite(value)&&value>=0&&value<=100?new Intl.NumberFormat('ru-RU',{maximumFractionDigits:1}).format(value)+'%':'Нет данных';
  const net=value=>finite(value)?(value>0?'+':'')+count(value):'Нет данных';
  const date=value=>Number.isFinite(Date.parse(value))?new Intl.DateTimeFormat('ru-RU',{timeZone:'Europe/Moscow',day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit'}).format(new Date(value))+' МСК':'Нет снимка';
  const membershipDate=()=>indexMembership?.verified===true&&/^\d{4}-\d{2}-\d{2}$/.test(indexMembership.asOf||'')&&Number.isFinite(Date.parse(indexMembership.asOf))?new Intl.DateTimeFormat('ru-RU',{timeZone:'Europe/Moscow',day:'numeric',month:'short',year:'numeric'}).format(new Date(indexMembership.asOf+'T12:00:00+03:00')):null;
  const ticker=item=>item?.underlyingTicker||item?.stockTicker||item?.symbol||'Инструмент';
  const future=item=>item?.futuresCode||item?.futureCode||null;
  const group=item=>item?.group||'stocks';
  function sourceLink(value){try{const url=new URL(value),host=url.hostname.toLowerCase();if(url.protocol!=='https:'||url.username||url.password||!(host==='moex.com'||host.endsWith('.moex.com'))||[...url.searchParams.keys()].some(key=>/token|password|api.?key|authorization/i.test(key)))return null;return url;}catch{return null;}}
  function action(text,error=false){$('participantsActionStatus').textContent=text;$('participantsActionStatus').classList.toggle('error',error);}
  function stopTimers(){clearTimeout(accessTimer);clearTimeout(refreshTimer);clearTimeout(searchTimer);}
  function closeDetail(){detailSequence++;detailController?.abort();detailController=null;detailSymbol=null;if($('participantsDetail').open)$('participantsDetail').close();$('participantsDetailContent').replaceChildren();$('participantsDetailStatus').textContent='';if(lastFocus?.isConnected&&!restricted)lastFocus.focus();lastFocus=null;}
  function clear(){instruments=[];coverage=[];indexMembership=null;watchlist=[];snapshot=null;isDemo=false;closeDetail();$('participantsCards').replaceChildren();$('participantsTrackedCount').textContent='0';$('participantsResultCount').textContent='';$('participantsSourceText').textContent='';$('participantsSnapshotTime').textContent='';$('participantsDemoNotice').hidden=true;$('participantsGroup').querySelector('[value=imoex]').disabled=true;if($('participantsGroup').value==='imoex')$('participantsGroup').value='all';}
  function lock({guest=false,disabled=false,message}={}){
    restricted=true;epoch++;feedSequence++;feedController?.abort();feedController=null;stopTimers();clear();busy=false;watchBusy=false;
    $('participantsWorkspace').hidden=true;$('participantsInitialStatus').textContent='';$('participantsLocked').hidden=false;
    $('participantsLockedTitle').textContent=disabled?'Раздел временно отключён':guest?'Войдите в аккаунт':'Нужна действующая подписка';
    $('participantsLockedText').textContent=message||(disabled?'Вернитесь позже.':guest?'Открытые позиции и отслеживаемые инструменты доступны после входа.':'Позиции участников доступны по Pro или Exclusive.');
    $('participantsAccessLink').hidden=disabled;$('participantsAccessLink').href=guest?'account.html?next=%2Fparticipants.html':'subscriptions.html?next=%2Fparticipants.html';$('participantsAccessLink').textContent=guest?'Войти ↗':'Выбрать подписку ↗';
  }
  async function api(path,options={}){
    let response;try{response=await fetch(path,{credentials:'same-origin',cache:'no-store',...options,headers:{'Content-Type':'application/json',...options.headers}});}catch(cause){if(cause.name==='AbortError')throw cause;throw Error('Нет связи с сервером. Повторите загрузку.');}
    let data;try{data=await response.json();}catch{throw Error('Не удалось получить данные позиций. Повторите попытку.');}
    if(response.status===401){lock({guest:true});throw Object.assign(Error('Войдите в аккаунт.'),{status:401});}
    if(response.status===403){lock({disabled:config?.enabled===false||/DISABLED/.test(data.code||''),message:data.error});throw Object.assign(Error(data.error||'Доступ к позициям завершён.'),{status:403});}
    if(!response.ok)throw Object.assign(Error(A?.supportMessage(data,'Не удалось загрузить позиции.')||data.error||'Не удалось загрузить позиции.'),{status:response.status,code:data.code});return data;
  }
  function showError(text){$('participantsErrorText').textContent=text;$('participantsError').hidden=false;}
  function buttons(){for(const id of ['participantsRefresh','participantsDemo','participantsLive','participantsRetry'])$(id).disabled=busy||restricted;$('participantsMore').disabled=busy;for(const button of document.querySelectorAll('[data-participants-follow]'))button.disabled=watchBusy||!button.dataset.participantsFollow;}
  function dataset(){
    const map=new Map();for(const item of coverage)if(item&&typeof item.symbol==='string')map.set(item.symbol,{...item,_snapshot:false});
    for(const item of instruments)if(item&&typeof item.symbol==='string')map.set(item.symbol,{...(map.get(item.symbol)||{}),...item,_snapshot:true});
    return [...map.values()];
  }
  function visible(){
    const query=$('participantsSearch').value.trim().toLocaleLowerCase('ru-RU'),selected=$('participantsGroup').value;
    return dataset().filter(item=>(view!=='tracked'||watchlist.includes(item.symbol))&&(view!=='stocks'||['stocks','index'].includes(group(item)))&&(selected==='all'||selected==='imoex'&&!isDemo&&membershipDate()&&item.indexMembership?.verified===true&&item.indexMembership.inIndex===true||group(item)===selected)&&(!query||[ticker(item),item.name,item.symbol,future(item)].filter(Boolean).join(' ').toLocaleLowerCase('ru-RU').includes(query))).sort((a,b)=>Number(watchlist.includes(b.symbol))-Number(watchlist.includes(a.symbol))||ticker(a).localeCompare(ticker(b),'ru-RU'));
  }
  function measure(item,side){
    const long=side==='long',shares=long?item.longShares:item.shortShares,total=long?item.totalLong:item.totalShort,legal=shares?.legal,individual=shares?.individual;
    const section=el('div','participants-measure'),head=el('div','participants-measure-head');head.append(el('strong','',long?'ЛОНГ':'ШОРТ'),el('span','',finite(total)?count(total)+' контрактов':'Нет данных'));section.append(head);
    if(finite(legal)&&finite(individual)&&legal>=0&&individual>=0&&legal<=100&&individual<=100&&Math.abs(legal+individual-100)<.2){
      const bar=el('div','participants-bar');bar.setAttribute('role','img');bar.setAttribute('aria-label',(long?'Лонг':'Шорт')+': юрлица '+percent(legal)+', физлица '+percent(individual));bar.dataset.side=side;
      const jur=el('span','legal'),fiz=el('span','individual');jur.style.width=legal+'%';fiz.style.width=individual+'%';bar.append(jur,fiz);section.append(bar);
      const legend=el('div','participants-measure-legend'),jurText=el('span',''),fizText=el('span','');jurText.append('Юрлица ',el('b','',percent(legal)));fizText.append('Физлица ',el('b','',percent(individual)));legend.append(jurText,fizText);section.append(legend);
    }else{section.append(el('div','participants-bar-unavailable'),el('p','participants-no-data',finite(total)&&total===0?'Открытых контрактов нет; доли не рассчитываются.':'Нет сопоставимого снимка обеих групп. Доли не рассчитываются.'));}
    return section;
  }
  function followButton(item){
    const followed=watchlist.includes(item.symbol),button=el('button','participants-follow',followed?'★':'☆');button.type='button';button.dataset.participantsFollow=item.symbol||'';button.setAttribute('aria-pressed',String(followed));button.setAttribute('aria-label',(followed?'Не отслеживать ':'Отслеживать ')+ticker(item));button.title=followed?'Убрать из отслеживаемых':'Отслеживать инструмент';button.disabled=watchBusy||!item.symbol;button.addEventListener('click',()=>{void toggleFollow(item.symbol);});return button;
  }
  function renderCard(item){
    const card=el('article','participants-card');card.dataset.participantsSymbol=item.symbol;card.dataset.stale=String(!isDemo&&(item.stale===true||snapshot?.stale===true));
    const head=el('div','participants-card-head'),identity=el('div','participants-card-identity'),heading=el('h2'),open=el('button','',ticker(item));open.type='button';open.addEventListener('click',()=>{void openDetail(item.symbol,open);});heading.append(open);identity.append(heading,el('p','',item.name||'Название уточняется'),el('div','participants-proxy',future(item)?'Связанный фьючерс · '+future(item):'Данные по связанному фьючерсу пока недоступны'));head.append(identity,followButton(item));card.append(head,measure(item,'long'),measure(item,'short'));
    if(!isDemo&&membershipDate()&&item.indexMembership?.verified===true&&item.indexMembership.inIndex===true)identity.append(el('div','participants-proxy','Индекс Мосбиржи · состав на '+membershipDate()));
    const position=el('div','participants-card-net');for(const [key,label]of [['legal','Юрлица · чистая позиция'],['individual','Физлица · чистая позиция']]){const box=el('div','');box.append(el('span','',label),el('strong','',finite(item.net?.[key])?net(item.net[key])+' контр.':'Нет данных'));position.append(box);}card.append(position);
    if(item.status==='unbalanced'||item.status==='incomplete')card.append(el('p','participants-card-note',item.status==='unbalanced'?'В исходном снимке объёмы лонга и шорта не совпадают. Доли требуют проверки.':'Не все категории есть в исходном снимке. Пропуски не подменяются нулём.'));
    const foot=el('div','participants-card-foot'),time=el('time','',item._snapshot?date(item.dataAsOf):'Снимок не получен');if(Number.isFinite(Date.parse(item.dataAsOf)))time.dateTime=item.dataAsOf;
    const tag=el('span',isDemo||item.isDemo?'participants-demo-label':'',isDemo||item.isDemo?'ДЕМОНСТРАЦИЯ':!item._snapshot?'НЕТ ДАННЫХ':item.stale||snapshot?.stale?'СНИМОК УСТАРЕЛ':'MOEX FUTOI');const more=el('button','',item._snapshot?'Разобраться →':'Об инструменте →');more.type='button';more.addEventListener('click',()=>{void openDetail(item.symbol,more);});foot.append(tag,time,more);card.append(foot);return card;
  }
  function render(){
    if(restricted)return;const rows=visible(),fragment=document.createDocumentFragment();for(const item of rows.slice(0,visibleLimit))fragment.append(renderCard(item));$('participantsCards').replaceChildren(fragment);$('participantsCards').setAttribute('aria-busy',String(busy));$('participantsSkeleton').hidden=!busy||dataset().length>0;
    $('participantsTrackedCount').textContent=String(watchlist.length);$('participantsResultCount').textContent='Инструментов: '+rows.length;$('participantsMore').hidden=rows.length<=visibleLimit;$('participantsEmpty').hidden=rows.length>0;
    $('participantsEmptyTitle').textContent=view==='tracked'?'Выберите свои инструменты':'По этому запросу ничего нет';$('participantsEmptyText').textContent=view==='tracked'?'Нажмите звезду у интересующего инструмента. Отслеживание сохранится в вашем аккаунте.':'Попробуйте другой тикер, название или рынок.';
    for(const button of document.querySelectorAll('[data-participants-view]'))button.setAttribute('aria-pressed',String(button.dataset.participantsView===view));buttons();
  }
  function renderSource(){
    const stale=!isDemo&&(snapshot?.stale??config?.stale)===true,connected=!isDemo&&(snapshot?.configured??config?.configured)===true,status=snapshot?.status||config?.status,failed=connected&&status==='error',waiting=connected&&!instruments.length&&!failed;
    $('participantsSourceState').textContent=isDemo?'Учебный пример':stale&&instruments.length?'Последний снимок устарел':failed?'Источник временно недоступен':waiting?'Ожидаем биржевой снимок':connected?'Биржевой источник MOEX FUTOI':'Биржевой источник не подключён';$('participantsSourceState').dataset.state=isDemo?'demo':stale?'stale':failed?'error':waiting?'waiting':connected?'live':'off';
    $('participantsSourceText').textContent=isDemo?'Все значения в этом режиме созданы для знакомства с индикатором. Они не получены от Мосбиржи.':stale&&instruments.length?'Показан последний полученный снимок с его исходным временем. Обновление источника временно недоступно.':failed?'Пока не удалось получить сопоставимые позиции от Мосбиржи. Сервис повторит подключение; вымышленные значения не используются.':waiting?'Источник настроен. Первый сопоставимый снимок пока не получен; значения появятся после успешной загрузки.':connected?'Показаны доступные снимки открытых позиций во фьючерсах. Новые значения появляются по мере публикации источником.':'Позиции появятся после подключения источника. Для знакомства с интерфейсом откройте явно обозначенный учебный пример.';
    const at=snapshot?.dataAsOf,received=snapshot?.receivedAt;$('participantsSnapshotTime').textContent=at?'Снимок: '+date(at)+(received?' · Получен Orbita: '+date(received):''):isDemo?'Учебные времена не являются биржевой статистикой.':'Биржевой снимок пока не получен.';
    $('participantsDemoNotice').hidden=!isDemo;$('participantsDemo').hidden=isDemo;$('participantsLive').hidden=!isDemo;
    const verifiedDate=!isDemo&&membershipDate();$('participantsGroup').querySelector('[value=imoex]').disabled=!verifiedDate;if(!verifiedDate&&$('participantsGroup').value==='imoex')$('participantsGroup').value='all';
    $('participantsCoverageNote').textContent=(snapshot?.coverageNote||config?.coverageNote||'Доступность определяется справочником и источником FUTOI.')+' Для акции показан связанный фьючерс; это не распределение позиций в самой акции. '+(isDemo?'Учебный каталог не подтверждает состав индекса.':verifiedDate?'Состав индекса Мосбиржи подтверждён на '+verifiedDate+'.':'Текущий состав индекса Мосбиржи не подтверждён; фильтр индекса пока недоступен.');
  }
  async function loadFeed({demo=isDemo}={}){
    if(restricted||suspended)return;const current=++feedSequence,lifecycle=epoch;feedController?.abort();feedController=new AbortController();busy=true;$('participantsError').hidden=true;$('participantsSkeleton').hidden=dataset().length>0;buttons();
    try{const [data,catalog]=await Promise.all([api(demo?'/api/participants/demo':'/api/participants',{signal:feedController.signal}),demo?null:api('/api/participants/coverage',{signal:feedController.signal})]);if(current!==feedSequence||lifecycle!==epoch||restricted||suspended)return;if(!Array.isArray(data.instruments)||catalog&&!Array.isArray(catalog.instruments))throw Error('Сервер вернул неполный ответ. Повторите загрузку.');if(data.isDemo!==demo||data.instruments.some(item=>!item||typeof item.symbol!=='string'||item.isDemo!==demo))throw Error('Режим данных не подтверждён сервером. Повторите загрузку.');if(catalog){coverage=catalog.instruments;indexMembership=catalog.indexMembership||null;}instruments=data.instruments;snapshot=data;isDemo=demo;visibleLimit=12;renderSource();}
    catch(cause){if(cause.name!=='AbortError'&&![401,403].includes(cause.status)&&current===feedSequence&&!restricted)showError(cause.message);}
    finally{if(current===feedSequence&&!restricted){busy=false;$('participantsSkeleton').hidden=true;render();}}
  }
  async function toggleFollow(symbol){
    if(watchBusy||restricted||!symbol)return;watchBusy=true;buttons();action('Сохраняем отслеживание…');const lifecycle=epoch;
    try{const current=await api('/api/participants/watchlist');if(lifecycle!==epoch||restricted)return;const currentSymbols=Array.isArray(current.symbols)?current.symbols:[],next=currentSymbols.includes(symbol)?currentSymbols.filter(value=>value!==symbol):[...currentSymbols,symbol];const response=await api('/api/participants/watchlist',{method:'PUT',body:JSON.stringify({symbols:next})});if(lifecycle!==epoch||restricted)return;if(!Array.isArray(response.symbols))throw Error('Не удалось подтвердить сохранение. Обновите страницу.');watchlist=response.symbols;action(watchlist.includes(symbol)?'Инструмент добавлен в отслеживаемые.':'Инструмент убран из отслеживаемых.');render();if(detailSymbol===symbol)renderDetail(dataset().find(item=>item.symbol===symbol),[]);}
    catch(cause){if(![401,403].includes(cause.status))action(cause.message,true);}
    finally{watchBusy=false;if(!restricted)buttons();}
  }
  function renderDetail(item,history){
    const content=$('participantsDetailContent');content.replaceChildren();if(!item)return;
    const heading=el('h2','',ticker(item));heading.id='participantsDetailTitle';content.append(heading,el('p','',item.name||'Инструмент'));
    const tags=el('div','participants-detail-tags');tags.append(el('span','participants-detail-tag',future(item)?'Фьючерс '+future(item):'Связанный фьючерс не определён'));if(isDemo||item.isDemo)tags.append(el('span','participants-demo-label','ДЕМОНСТРАЦИЯ · все числа вымышлены'));if(!isDemo&&(item.stale||snapshot?.stale))tags.append(el('span','participants-detail-tag','Снимок устарел'));tags.append(followButton(item));content.append(tags);
    content.append(el('p','',"Доли рассчитаны по объёму открытых контрактов. Для лонга и шорта используются разные знаменатели; это не процент отдельных людей или компаний."),measure(item,'long'),measure(item,'short'));
    const table=el('table','participants-detail-table'),thead=el('thead'),header=el('tr');for(const title of ['Группа','Лонг, контр.','Шорт, контр.','Чистая'])header.append(el('th','',title));thead.append(header);const tbody=el('tbody');for(const [key,label]of [['legal','Юрлица'],['individual','Физлица']]){const row=el('tr');row.append(el('td','',label),el('td','',count(item[key]?.long)),el('td','',count(item[key]?.short)),el('td','',net(item.net?.[key])));tbody.append(row);}table.append(thead,tbody);content.append(table);
    const times=el('dl','participants-detail-times');for(const [label,value]of [['Биржевой снимок',item.dataAsOf],['Получен Orbita',item.receivedAt]]){const box=el('div');box.append(el('dt','',label),el('dd','',date(value)));times.append(box);}content.append(times,el('p','',"Позиции относятся к связанному фьючерсу. По самой акции распределение юрлиц/физлиц в лонге и шорте из этих данных определить нельзя."));
    if(item.status==='unbalanced'||item.status==='incomplete')content.append(el('p','participants-card-note','Исходный снимок неполный или несопоставимый. Пропуски не заменяются нулём; точные доли для них не показываются.'));
    content.append(el('h3','', 'История снимков'),el('p','',Array.isArray(history)&&history.length?'Исторические снимки доступны у источника. Индикатор выше показывает выбранный последний снимок.':'История ещё не накоплена. Изменения позиций не моделируются.'));
    const url=sourceLink(item.sourceUrl);if(url){const link=el('a','participants-detail-source',isDemo||item.isDemo?'Об источнике MOEX FUTOI ↗':'Открыть источник Мосбиржи ↗');link.href=url.href;link.target='_blank';link.rel='noopener noreferrer';content.append(link);}
  }
  async function openDetail(symbol,focus){
    if(restricted)return;const item=dataset().find(value=>value.symbol===symbol);if(!item)return;lastFocus=focus;detailSymbol=symbol;const sequence=++detailSequence,lifecycle=epoch;detailController?.abort();detailController=new AbortController();renderDetail(item,[]);$('participantsDetailStatus').textContent=item._snapshot?'Загружаем подробности…':'Биржевой снимок пока не получен.';if(!$('participantsDetail').open)$('participantsDetail').showModal();
    if(!item._snapshot)return;
    try{const data=await api('/api/participants/'+encodeURIComponent(symbol)+(isDemo?'?demo=1':''),{signal:detailController.signal});if(sequence!==detailSequence||lifecycle!==epoch||restricted||suspended)return;if(!data.instrument||data.instrument.symbol!==symbol)throw Error('Не удалось подтвердить снимок инструмента.');renderDetail(data.instrument,data.history);$('participantsDetailStatus').textContent='';}
    catch(cause){if(cause.name!=='AbortError'&&![401,403].includes(cause.status)&&sequence===detailSequence&&!restricted)$('participantsDetailStatus').textContent=cause.message;}
  }
  async function checkAccess(){
    if(restricted||suspended||document.hidden)return;try{const response=await api('/api/me'),user=response.user;if(!user){lock({guest:true});return;}if(!user.access?.hasSubscription){lock();return;}if(user.id!==userId){clear();await bootstrap();}}catch(cause){if(![401,403].includes(cause.status))action('Не удалось проверить доступ. Повторим запрос.',true);}
    finally{if(!restricted&&!suspended&&!document.hidden)accessTimer=setTimeout(()=>{void checkAccess();},5000);}
  }
  function scheduleRefresh(){clearTimeout(refreshTimer);if(!restricted&&!suspended&&!document.hidden)refreshTimer=setTimeout(async()=>{try{await loadFeed();}finally{scheduleRefresh();}},60000);}
  async function bootstrap(){
    stopTimers();suspended=false;restricted=false;config=null;busy=false;watchBusy=false;clear();const lifecycle=++epoch;$('participantsInitialStatus').textContent='Проверяем доступ к данным…';$('participantsWorkspace').hidden=true;$('participantsLocked').hidden=true;
    try{const user=await A.requireSubscription();if(lifecycle!==epoch||!user)return;userId=user.id;const [settings,catalog,following]=await Promise.all([api('/api/participants/config'),api('/api/participants/coverage'),api('/api/participants/watchlist')]);if(lifecycle!==epoch||restricted)return;config=settings;if(!config.enabled){lock({disabled:true});return;}if(!Array.isArray(catalog.instruments)||!Array.isArray(following.symbols))throw Error('Не удалось загрузить справочник инструментов.');coverage=catalog.instruments;indexMembership=catalog.indexMembership||null;watchlist=following.symbols;$('participantsWorkspace').hidden=false;$('participantsInitialStatus').textContent='';await loadFeed();if(lifecycle!==epoch||restricted)return;accessTimer=setTimeout(()=>{void checkAccess();},5000);scheduleRefresh();}
    catch(cause){if(![401,403].includes(cause.status)&&!restricted){$('participantsInitialStatus').textContent='Не удалось загрузить раздел. Нажмите «Обновить», чтобы повторить.';$('participantsWorkspace').hidden=false;$('participantsSkeleton').hidden=true;showError(cause.message);}}
  }
  $('participantsFilters').addEventListener('submit',event=>{event.preventDefault();visibleLimit=12;render();});$('participantsSearch').addEventListener('input',()=>{clearTimeout(searchTimer);searchTimer=setTimeout(()=>{visibleLimit=12;render();},180);});$('participantsGroup').addEventListener('change',()=>{visibleLimit=12;render();});
  for(const button of document.querySelectorAll('[data-participants-view]'))button.addEventListener('click',()=>{view=button.dataset.participantsView;visibleLimit=12;render();});
  $('participantsMore').addEventListener('click',()=>{visibleLimit+=12;render();});$('participantsReset').addEventListener('click',()=>{$('participantsFilters').reset();view='all';visibleLimit=12;render();});
  $('participantsDemo').addEventListener('click',()=>{closeDetail();void loadFeed({demo:true});});$('participantsLive').addEventListener('click',()=>{closeDetail();void loadFeed({demo:false});});
  $('participantsRefresh').addEventListener('click',()=>{if(!config||restricted)void bootstrap();else void loadFeed();});$('participantsRetry').addEventListener('click',()=>{if(!config||!coverage.length)void bootstrap();else void loadFeed();});
  $('participantsDetailClose').addEventListener('click',closeDetail);$('participantsDetail').addEventListener('cancel',event=>{event.preventDefault();closeDetail();});$('participantsDetail').addEventListener('click',event=>{if(event.target===$('participantsDetail')){const rect=event.target.getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)closeDetail();}});
  document.addEventListener('visibilitychange',()=>{if(document.hidden){suspended=true;stopTimers();feedController?.abort();detailController?.abort();$('participantsWorkspace').hidden=true;closeDetail();}else void bootstrap();});
  window.addEventListener('pagehide',()=>{suspended=true;epoch++;feedSequence++;feedController?.abort();detailController?.abort();stopTimers();clear();$('participantsWorkspace').hidden=true;});window.addEventListener('pageshow',event=>{if(event.persisted)location.reload();});
  void bootstrap();
})();
