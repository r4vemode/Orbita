import {activePlans, canReadStrategy, canReadTier, effectiveTier, PLANS, tierOf} from '../access.mjs';
import {safeSourceUrl} from '../radar/model.mjs';

const HOME = 'tc:home';
const DEFAULT_SIGNALS = 'tc:s:a:a:a:a:0';
const PAGE_SIZE = 5;
const ID = /^[A-Za-z0-9_-]{1,100}$/;
const SIGNALS = /^tc:([sf]):([apx]):([asfc]):([anwocx]):([als]):(\d{1,4})$/;
const PAGE = /^tc:([ha]):(\d{1,4})$/;
const DETAIL = /^tc:([ijed]):([A-Za-z0-9_-]+)$/;
const PREFERENCE = /^tc:p:([A-Za-z]+):([01])$/;
const SECTIONS = new Set([HOME, 'tc:sub', 'tc:prefs', 'tc:help', 'tc:r:a', 'tc:r:f']);
const TIERS = {a:'Все стратегии', p:'PRO', x:'EXCLUSIVE'};
const MARKETS = {a:'Все рынки', s:'Акции', f:'Фьючерсы', c:'Крипто'};
const MARKET_KEYS = {s:'stocks', f:'futures', c:'crypto'};
const STATES = {a:'Все статусы', n:'Объявлен', w:'Ожидает входа', o:'Активна', c:'Завершена', x:'Отменена'};
const STATE_KEYS = {n:'announced', w:'waiting', o:'active', c:'closed', x:'cancelled'};
const DIRECTIONS = {a:'Оба', l:'LONG', s:'SHORT'};
const DIRECTION_KEYS = {l:'ЛОНГ', s:'ШОРТ'};
const FLAGS = {
  proSignals:'Сигналы PRO',
  exclusiveSignals:'Сигналы EXCLUSIVE',
  levelChanges:'Изменения уровней',
  ideaClosures:'Досрочные выходы и закрытия',
  radarImportant:'Важный Radar',
  radarAll:'Весь Radar',
  articles:'Новые статьи',
  subscriptionEvents:'Статус подписки'
};
const PRICE_ORIGINS = {admin:'введена редакцией', 'market-reference':'рыночный ориентир', 'configured-level':'уровень идеи'};
const dateFormat = new Intl.DateTimeFormat('ru-RU', {
  timeZone:'Europe/Moscow', day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit'
});
const numberFormat = new Intl.NumberFormat('ru-RU', {maximumFractionDigits:8});
const percentFormat = new Intl.NumberFormat('ru-RU', {maximumFractionDigits:2, signDisplay:'exceptZero'});
const amountFormat = new Intl.NumberFormat('ru-RU', {maximumFractionDigits:0});
const tidy = (value, limit=150) => typeof value==='string' ? Array.from(value.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g,' ').trim()).slice(0,limit).join('') : '';
const number = value => Number.isFinite(value) ? numberFormat.format(value) : '—';
const percent = value => Number.isFinite(value) ? percentFormat.format(value)+'%' : '—';
const stamp = value => Number.isFinite(Date.parse(value)) ? dateFormat.format(new Date(value))+' МСК' : '—';
const tierLabel = strategy => tierOf(strategy)==='exclusive' ? 'EXCLUSIVE' : 'PRO';
const directionLabel = value => value==='ШОРТ' ? 'SHORT' : 'LONG';
const timeOf = value => Date.parse(value)||0;
const button = (text,action) => ({text,callback_data:action});
const link = (text,url) => url ? {text,url} : null;
const home = () => [button('В главное меню',HOME)];
const response = (text,rows=[]) => ({text:text.slice(0,3900).replace(/[\uD800-\uDBFF]$/,''),keyboard:rows.map(row=>row.filter(Boolean)).filter(row=>row.length)});
const byDate = (left,right) => timeOf(right)-timeOf(left);

export function isTelegramClientAction(value){
  if(typeof value!=='string'||Buffer.byteLength(value)>64)return false;
  if(SECTIONS.has(value)||SIGNALS.test(value)||PAGE.test(value)||DETAIL.test(value))return true;
  const preference=value.match(PREFERENCE);
  return !!preference&&Object.hasOwn(FLAGS,preference[1]);
}

function parseOrigin(value){
  try{
    const url=new URL(value);
    if(url.protocol==='https:'&&!url.username&&!url.password&&url.pathname==='/'&&!url.search&&!url.hash)return url.origin;
  }catch{}
  return null;
}

function visibleIdea(record,user,at){
  return !!(record?.published&&!record.archived&&!record.demo&&!record.isDemo&&!record.localMarketHistory&&
    typeof record.id==='string'&&ID.test(record.id)&&!record.id.startsWith('demo-')&&typeof record?.d?.strategy==='string'&&canReadStrategy(user,record.d.strategy,at));
}

function visibleArticle(article,user,at){
  if(article?.published!==true||typeof article.id!=='string'||!ID.test(article.id))return false;
  if(Date.parse(article.publication?.publishedAt||article.scheduledAt)>at)return false;
  if(['public','all'].includes(article.access))return true;
  if(article.access==='exclusive')return canReadTier(user,'exclusive',at);
  return ['pro','member'].includes(article.access)&&canReadTier(user,'pro',at);
}

function routeFor(variant,filters,page=0){
  return ['tc',variant,filters.tier,filters.market,filters.state,filters.dir,page].join(':');
}

function partition(items,requested){
  const page=Math.min(requested,Math.floor(Math.max(0,items.length-1)/PAGE_SIZE));
  return {page,items:items.slice(page*PAGE_SIZE,(page+1)*PAGE_SIZE),pages:Math.max(1,Math.ceil(items.length/PAGE_SIZE))};
}

function paging({page,pages},build){
  return [page>0&&button('← Назад',build(page-1)),page+1<pages&&button('Дальше →',build(page+1))];
}

function detailButton(label,kind,id,web){
  const action='tc:'+kind+':'+id;
  return isTelegramClientAction(action)?button(label,action):link(label,web);
}

function formatIdea(record){
  const d=record.d,m=record.meta||{},lines=[
    `ORBITA · ${tierLabel(d.strategy)} | ${tidy(d.ticker,30)} | ${directionLabel(d.dir)}`,
    record.erroneous?'Ошибочная публикация':tidy(d.status||d.state,65),
    `Опубликована ${stamp(m.publishedAt)}`
  ];
  if(Number.isFinite(d.entry)&&Number.isFinite(d.stop)&&Number.isFinite(d.target)){
    const targets=[d.target,...(d.targets||[])].filter(Number.isFinite).map(number).join(', ');
    lines.push(`Вход ${number(d.entry)} · Стоп ${number(d.stop)} · Цели ${targets}${d.unit?' '+tidy(d.unit,12):''}`);
  }
  if(record.erroneous&&m.errorReason)lines.push('Причина '+tidy(m.errorReason,180));
  if(d.horizon)lines.push('Горизонт '+tidy(d.horizon,65));
  if(d.summary||d.thesis)lines.push('',tidy(d.summary||d.thesis,400));
  if(Array.isArray(m.closures)&&m.closures.length){
    lines.push('', 'Выходы из идеи');
    const closures=m.closures.slice(-5);
    if(m.closures.length>closures.length)lines.push('Ранние выходы доступны в истории на сайте.');
    for(const closure of closures){
      const source=PRICE_ORIGINS[closure.priceOrigin];
      const reason=tidy(closure.reason,100);
      const sourceLink=validatedSource(closure.priceSource?.url);
      lines.push(`• ${number(closure.percent)}% по ${number(closure.price)} · ${stamp(closure.occurredAt)}${source?' · '+source:''}`,
        `  ${reason?reason+' · ':''}Результат части ${percent(closure.resultPct)} · вклад ${percent(closure.contributionPct)}`);
      if(sourceLink&&closure.priceOrigin==='market-reference')lines.push('  '+new URL(sourceLink).hostname+' · '+stamp(closure.priceSource.observedAt));
    }
    lines.push(`Остаток ${number(m.remainingPct)}%`);
    if(Number.isFinite(m.finalResultPct))lines.push('Итог идеи '+percent(m.finalResultPct));
    else if(Number.isFinite(m.realizedPct))lines.push('Вклад закрытых частей '+percent(m.realizedPct));
  }else if(d.state==='closed'||d.state==='cancelled'){
    lines.push('',tidy(d.outcome||d.status,100));
    const exitEvent=(m.events||[]).findLast(entry=>['manual','target','stop','cancel'].includes(entry[3]?.type));
    if(m.closedAt||exitEvent?.[3]?.at)lines.push('Завершена '+stamp(m.closedAt||exitEvent[3].at));
    if(Number.isFinite(m.exit)){
      const entry=m.initialLevels?.entry??m.initial?.entry??d.entry;
      const calculated=entry>0?(m.exit/entry-1)*100*(d.dir==='ШОРТ'?-1:1):null;
      lines.push('Цена выхода '+number(m.exit)+(Number.isFinite(calculated)?' · Итог идеи '+percent(calculated):''));
    }
    const reason=tidy(exitEvent?.[3]?.note,140);
    if(reason)lines.push('Причина '+reason);
  }
  if(m.closures?.length||d.state==='closed')lines.push('Расчёт по уровням идеи без комиссий и проскальзывания.');
  return lines.filter(value=>value!==undefined).join('\n');
}

function validatedSource(value){
  try{return safeSourceUrl(value);}catch{return null;}
}

export function createTelegramClientMenu({ideas,radar,content,publicOrigin,now=Date.now}={}){
  const origin=parseOrigin(publicOrigin);
  function site(path,query=null){
    if(!origin)return null;
    const url=new URL(path,origin);
    if(query)url.search=new URLSearchParams(query).toString();
    return url.href;
  }
  const ideaUrl=id=>site('/app.html',{idea:id});
  const radarUrl=(id=null)=>site('/radar.html',id?{event:id}:null);
  const articleUrl=article=>article.kind==='article'?site('/article.html',{id:article.id}):site('/learn.html',{lesson:article.id});
  const unavailable = () => response('Материал недоступен. Проверьте привязку аккаунта и срок подписки.',[home()]);
  const menu = user=>response(user?'ORBITA\nВыберите раздел.':'ORBITA\nЧтобы получать материалы согласно подписке, подключите Telegram в разделе уведомлений на сайте.',[
    [button('Сигналы',DEFAULT_SIGNALS),button('Radar','tc:r:a')],
    [button('Статьи','tc:a:0'),button('История идей','tc:h:0')],
    [button('Моя подписка','tc:sub'),button('Уведомления','tc:prefs')],
    [button('Помощь','tc:help')],
    !user?[link('Настройки уведомлений на сайте',site('/notifications.html'))]:[]
  ]);
  const allowedFlag=(user,key)=>{
    if(!user)return false;
    if(key==='exclusiveSignals')return canReadTier(user,'exclusive',now());
    if(key==='radarImportant'||key==='radarAll')return !!radar?.canRealtime?.(user);
    if(key==='articles'||key==='subscriptionEvents')return true;
    return canReadTier(user,'pro',now());
  };

  function subscription(user){
    if(!user)return response('Telegram ещё не связан с аккаунтом ORBITA.',[[link('Подключение на сайте',site('/notifications.html'))],home()]);
    const tier=effectiveTier(user,now()),plans=activePlans(user,now());
    const lines=['Моя подписка','Telegram связан с аккаунтом ORBITA.'];
    if(!tier)lines.push('Активной подписки нет.');
    else{
      lines.push(user.role==='admin'?'Доступ редакции.':`Текущий доступ ${tier==='exclusive'?'EXCLUSIVE':'PRO'}.`);
      for(const plan of plans){
        const expires=Math.max(...user.subscriptions.filter(item=>item.plan===plan).map(item=>Date.parse(item.expiresAt)).filter(Number.isFinite));
        lines.push(`${PLANS[plan].name} до ${stamp(new Date(expires).toISOString())}`);
      }
      lines.push('Доступны сигналы по тарифу, история идей, материалы и Radar по настройкам аккаунта.');
    }
    lines.push('','Цена новой подписки',`PRO — ${amountFormat.format(PLANS.pro.price)} ₽ за ${PLANS.pro.days} дней.`,
      `EXCLUSIVE — ${amountFormat.format(PLANS.exclusive.price)} ₽ за ${PLANS.exclusive.days} дней. Включает доступ PRO.`);
    return response(lines.join('\n'),[home()]);
  }

  function preferencesView(user,preferences){
    if(!user)return response('Подключите Telegram к аккаунту, чтобы управлять уведомлениями.',[[link('Настройки на сайте',site('/notifications.html'))],home()]);
    const rows=Object.entries(FLAGS).filter(([key])=>allowedFlag(user,key)).map(([key,label])=>{
      const on=preferences?.[key]===true;
      return [button((on?'Вкл · ':'Выкл · ')+label,'tc:p:'+key+':'+(on?'0':'1'))];
    });
    return response('Уведомления\nВыберите, какие сообщения получать.',[...rows,[link('Все настройки на сайте',site('/notifications.html'))],home()]);
  }

  async function ideaList(user,filters,requested,{history=false}={}){
    if(!canReadTier(user,'pro',now()))return unavailable();
    const {records=[]}=await ideas.list(user);
    const selected=records.filter(record=>{
      if(!visibleIdea(record,user,now()))return false;
      const d=record.d;
      if(history)return ['closed','cancelled'].includes(d.state)||record.erroneous||record.meta?.closures?.length>0;
      if(record.erroneous)return false;
      if(filters.tier!=='a'&&tierOf(d.strategy)!==(filters.tier==='p'?'pro':'exclusive'))return false;
      if(filters.state!=='a'&&d.state!==STATE_KEYS[filters.state])return false;
      if(filters.market!=='a'&&d.market!==MARKET_KEYS[filters.market])return false;
      return filters.dir==='a'||d.dir===DIRECTION_KEYS[filters.dir];
    });
    const ordering=record=>history?record.meta?.closedAt||record.meta?.updatedAt||record.meta?.publishedAt:record.meta?.publishedAt;
    selected.sort((a,b)=>byDate(ordering(a),ordering(b)));
    const section=partition(selected,requested);
    const rows=section.items.map(record=>{
      const label=`${tidy(record.d.ticker,18)} · ${directionLabel(record.d.dir)} · ${tierLabel(record.d.strategy)}`;
      return [detailButton(label,history?'j':'i',record.id,ideaUrl(record.id))];
    });
    const lines=[history?'История идей':'Сигналы'];
    if(!history)lines.push([TIERS[filters.tier],MARKETS[filters.market],STATES[filters.state],DIRECTIONS[filters.dir]].join(' · '));
    if(!section.items.length)lines.push('По этому выбору идей пока нет.');
    else{
      lines.push(`Страница ${section.page+1}/${section.pages}`);
      for(const r of section.items)lines.push(`• ${tidy(r.d.ticker,24)} · ${(r.erroneous?'Ошибочная публикация':tidy(r.d.status||r.d.state,45))}${r.meta?.closures?.length&&r.d.state==='active'?' · частичный выход':''}`);
    }
    rows.push(paging(section,history?page=>'tc:h:'+page:page=>routeFor('s',filters,page)));
    if(!history)rows.push([button('Фильтры',routeFor('f',filters,0))]);
    rows.push(home());
    return response(lines.join('\n'),rows);
  }

  function filterMenu(user,filters){
    if(!canReadTier(user,'pro',now()))return unavailable();
    const choices=(group,values)=>Object.entries(values).map(([value,label])=>button((filters[group]===value?'✓ ':'')+label,routeFor('f',{...filters,[group]:value})));
    const tierChoices=canReadTier(user,'exclusive',now())?TIERS:{a:TIERS.a,p:TIERS.p};
    const statusChoices=choices('state',STATES);
    return response('Фильтры сигналов',[
      choices('tier',tierChoices),choices('market',MARKETS),statusChoices.slice(0,3),statusChoices.slice(3),
      choices('dir',DIRECTIONS),[button('Показать сигналы',routeFor('s',filters))],[button('Сбросить фильтры',DEFAULT_SIGNALS)],home()
    ]);
  }

  async function ideaDetail(user,kind,id){
    if(!canReadTier(user,'pro',now()))return unavailable();
    const record=await ideas.get(id,user);
    if(!visibleIdea(record,user,now())||record.erroneous&&kind!=='j')return unavailable();
    const quote=record.meta?.closures?.findLast(closure=>closure.priceOrigin==='market-reference'&&validatedSource(closure.priceSource?.url));
    return response(formatIdea(record),[
      [link('Открыть идею на сайте',ideaUrl(id)),link('Источник цены',validatedSource(quote?.priceSource?.url))],
      [button(kind==='j'?'К истории':'К сигналам',kind==='j'?'tc:h:0':DEFAULT_SIGNALS)],home()
    ]);
  }

  async function radarList(user,following){
    if(!user||!radar?.canAccess?.(user)||following&&!radar.canRealtime?.(user))return unavailable();
    const query=new URLSearchParams({limit:'5'});
    if(following)query.set('watchlist','1');
    const {events=[]}=await radar.overview(user,query);
    if(!radar.canAccess(user)||following&&!radar.canRealtime?.(user))return unavailable();
    const list=events.filter(event=>!event.isDemo&&ID.test(event.id||'')&&(!following||event.following)).slice(0,5);
    const lines=[following?'Radar · отслеживаемые инструменты':'Radar · последние события'];
    if(!list.length)lines.push('Свежих событий в этом списке пока нет.');
    const paid=!!radar.canRealtime?.(user),rows=[];
    for(const event of list){
      const title=tidy(event.headline,145),ticker=tidy(event.ticker,24);
      lines.push(`• ${ticker} · ${title}`);
      if(paid)rows.push([detailButton(ticker+' · '+tidy(event.headline,30),'e',event.id,radarUrl(event.id))]);
    }
    if(paid)rows.push([button(following?'Все инструменты':'Отслеживаемые',following?'tc:r:a':'tc:r:f')]);
    rows.push([link('Открыть Radar на сайте',radarUrl())],home());
    return response(lines.join('\n'),rows);
  }

  async function radarDetail(user,id){
    if(!user||!radar?.canRealtime?.(user))return unavailable();
    if(typeof radar.detail!=='function')return response('Подробности события доступны на сайте.',[[link('Открыть Radar',radarUrl(id))],[button('К Radar','tc:r:a')],home()]);
    const {event}=await radar.detail(user,id);
    if(!event||event.isDemo||!radar.canRealtime(user))return unavailable();
    const source=event.sources?.map(item=>validatedSource(item.url)).find(Boolean),lines=[
      `Radar · ${tidy(event.ticker,24)}${Number.isFinite(event.importanceScore)?' · '+number(event.importanceScore)+'/10':''}`,
      tidy(event.headline,250),tidy(event.summary,850),
      'Опубликовано '+(tidy(event.publicationDay,20)||stamp(event.publishedAt))
    ];
    return response(lines.join('\n'),[[link('Первоисточник',source),link('Карточка на сайте',radarUrl(id))],[button('К Radar','tc:r:a')],home()]);
  }

  async function articles(user){
    if(typeof content?.readArticles==='function'){
      const result=await content.readArticles(user);
      return (result.lessons||[]).filter(article=>visibleArticle(article,user,now()));
    }
    if(!canReadTier(user,'pro',now())||typeof content?.readPublished!=='function')return [];
    const result=await content.readPublished(user);
    return (result.lessons||[]).filter(article=>visibleArticle(article,user,now()));
  }

  async function articleList(user,requested){
    const list=(await articles(user)).sort((a,b)=>byDate(a.publication?.publishedAt||a.updatedAt,b.publication?.publishedAt||b.updatedAt));
    const section=partition(list,requested);
    const rows=section.items.map(article=>[detailButton(tidy(article.title,52),'d',article.id,articleUrl(article))]);
    const text=section.items.length?`Статьи\nСтраница ${section.page+1}/${section.pages}\n`+section.items.map(article=>'• '+tidy(article.title,110)).join('\n'):
      'Нет опубликованных статей для вашего доступа.';
    rows.push(paging(section,page=>'tc:a:'+page),home());
    return response(text,rows);
  }

  async function articleDetail(user,id){
    const article=(await articles(user)).find(value=>value.id===id);
    if(!article||!visibleArticle(article,user,now()))return unavailable();
    return response([tidy(article.title,130),tidy(article.category,70),'',tidy(article.intro,600)].join('\n'),[
      [link('Читать полностью на сайте',articleUrl(article))],[button('К статьям','tc:a:0')],home()
    ]);
  }

  async function render({action=HOME,user=null,preferences={},updatePreferences}={}){
    if(!isTelegramClientAction(action))return response('Эта кнопка больше недоступна. Откройте меню.',[home()]);
    try{
      if(action===HOME)return menu(user);
      if(action==='tc:help')return response('Помощь ORBITA\nДля привязки аккаунта используйте одноразовую ссылку из настроек на сайте.\nЧтобы отключить Telegram, отправьте /stop.',[
        [link('Частые вопросы',site('/#faq')),link('Поддержка',site('/support.html'))],home()
      ]);
      if(action==='tc:sub')return subscription(user);
      if(action==='tc:prefs')return preferencesView(user,preferences);
      const setting=action.match(PREFERENCE);
      if(setting){
        const [,key,on]=setting;
        if(!allowedFlag(user,key)||typeof updatePreferences!=='function')return unavailable();
        const next=await updatePreferences({[key]:on==='1'});
        return preferencesView(user,next??{...preferences,[key]:on==='1'});
      }
      const signal=action.match(SIGNALS);
      if(signal){
        const [,variant,tier,market,state,dir,page]=signal,filters={tier,market,state,dir};
        return variant==='f'?filterMenu(user,filters):await ideaList(user,filters,Number(page));
      }
      const page=action.match(PAGE);
      if(page)return page[1]==='h'?await ideaList(user,{},Number(page[2]),{history:true}):await articleList(user,Number(page[2]));
      const detail=action.match(DETAIL);
      if(detail){
        if(detail[1]==='e')return await radarDetail(user,detail[2]);
        if(detail[1]==='d')return await articleDetail(user,detail[2]);
        return await ideaDetail(user,detail[1],detail[2]);
      }
      return await radarList(user,action==='tc:r:f');
    }catch(cause){
      if([401,403,404].includes(cause?.status))return unavailable();
      throw cause;
    }
  }

  return {render};
}
