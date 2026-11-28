import {reclaimAbandonedLock} from './storage-lock.mjs';
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile,rename,rm,stat,lstat} from 'node:fs/promises';
import path from 'node:path';
import {isAdmin,hasSubscription,canReadStrategy,canReadTier,tierOf} from './access.mjs';

const strategyMarkets=Object.freeze({'Momentum RU':'stocks','Trend RU':'stocks','Импульс':'futures','Crypto Momentum':'crypto','Crypto Trend':'crypto','Orbita Exclusive':'stocks'});
const defaultStrategies=Object.freeze({stocks:'Momentum RU',futures:'Импульс',crypto:'Crypto Momentum'});
const strategies=new Set(Object.keys(strategyMarkets));
// EXCLUSIVE is a premium feed across markets; other strategies keep one market.
const multiMarketStrategies=new Set(['Orbita Exclusive']);
export const strategyAllowsMarket=(strategy,market)=>strategies.has(strategy)&&(multiMarketStrategies.has(strategy)?['stocks','futures','crypto'].includes(market):strategyMarkets[strategy]===market);
export const STRATEGY_TIERS=Object.freeze(Object.fromEntries([...strategies].map(name=>[name,tierOf(name)])));
const MAX_EXTRA_TARGETS=4;
const limits={ticker:20,name:80,title:100,summary:350,horizon:50,strategy:60,thesis:2000,entryRule:1000,cancelRule:1000};
const dataFields=[...Object.keys(limits),'market','dir','entry','stop','target','targets','chartUrl'];
const levelFields=['entry','stop','target','targets','entryRule','cancelRule','title','summary','thesis','horizon','name'];
const termFields=['entry','stop','target','targets','entryRule','cancelRule'];
const descriptionFields=['title','summary','thesis','name','horizon','chartUrl'];
const explicitCloseActions=['partial-close','early-close'];
const closeActions=['target','stop','manual',...explicitCloseActions];
const closureFields=['percent','occurredAt','reason','priceSource'];
const POSITION_UNITS=10000;
const format=new Intl.DateTimeFormat('ru-RU',{timeZone:'Europe/Moscow',day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit',hour12:false});
const stamp=at=>format.format(new Date(at)).replace(',',' ·');
const fail=(message,status=400,code)=>{throw Object.assign(new Error(message),{status,...(code?{code}:{})})};
const clone=value=>structuredClone(value);
const initialDatabase=()=>({version:1,revision:0,records:[]});
const own=(object,key)=>Object.prototype.hasOwnProperty.call(object,key);
const isObject=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const MAX_STORE_BYTES=32*1024*1024;
const MAX_TELEGRAM_OPERATIONS=1024;
const digest=value=>createHash('sha256').update(value).digest('hex');
const storeFailure=code=>Object.assign(new Error('Некорректная база идей. Сохраните резервную копию перед восстановлением.'),{code});
export function activeIdeaFingerprint(records,market,ticker){
  const symbol=typeof ticker==='string'?ticker.trim().toUpperCase():'';
  return (Array.isArray(records)?records:[]).filter(record=>record&&typeof record.id==='string'&&record.published===true&&record.erroneous!==true&&record.demo!==true&&record.isDemo!==true&&!record.id.startsWith('demo-')&&!record.id.startsWith('exclusive-')&&['announced','waiting','active'].includes(record.d?.state)&&record.d.market===market&&typeof record.d.ticker==='string'&&record.d.ticker.trim().toUpperCase()===symbol).map(record=>record.id+':'+(record.recordVersion??0)).sort().join('|');
}
export function validateIdeasDatabase(db){
  if(!isObject(db)||db.version!==1||!Number.isSafeInteger(db.revision)||db.revision<0||!Array.isArray(db.records))return false;
  const ids=new Set();
  for(const record of db.records){
    if(!isObject(record)||typeof record.id!=='string'||!/^[a-zA-Z0-9_-]{1,100}$/.test(record.id)||ids.has(record.id)||typeof record.published!=='boolean'||!isObject(record.d)||!isObject(record.meta))return false;
    ids.add(record.id);const d=record.d,m=record.meta;
    if(record.recordVersion!==undefined&&(!Number.isSafeInteger(record.recordVersion)||record.recordVersion<1))return false;
    if(record.createdVia!==undefined&&!['WEB','TELEGRAM','API'].includes(record.createdVia))return false;
    if(record.createdByUserId!==undefined&&(typeof record.createdByUserId!=='string'||!record.createdByUserId||record.createdByUserId.length>100))return false;
    if(record.radarSource!==undefined&&!radarSourceValid(record.radarSource,true))return false;
    if(record.telegram!==undefined){
      const info=record.telegram;
      if(!isObject(info)||!Array.isArray(info.operations)||info.operations.length>MAX_TELEGRAM_OPERATIONS||info.chatId!==undefined&&(typeof info.chatId!=='string'||!/^[1-9]\d{0,19}$/.test(info.chatId))||info.messageId!==undefined&&(!Number.isSafeInteger(info.messageId)||info.messageId<1))return false;
      const operations=new Set();for(const item of info.operations){if(!isObject(item)||typeof item.id!=='string'||!/^[a-f0-9]{64}$/.test(item.id)||operations.has(item.id)||typeof item.actorId!=='string'||!item.actorId||item.actorId.length>100||!['create','update'].includes(item.kind)||!/^[a-f0-9]{64}$/.test(item.fingerprint))return false;operations.add(item.id);}
    }
    if(!strategyAllowsMarket(d.strategy,d.market)||!['ЛОНГ','ШОРТ'].includes(d.dir)||!['draft','announced','waiting','active','closed','cancelled'].includes(d.state)||record.published===(d.state==='draft'))return false;
    if(Object.entries(limits).some(([field,limit])=>typeof d[field]!=='string'||d[field].length>limit))return false;
    if(own(d,'chartUrl')){try{if(chartUrl(d.chartUrl)!==d.chartUrl)return false;}catch{return false;}}
    if(['entry','stop','target'].some(field=>d[field]!==null&&(!Number.isFinite(d[field])||d[field]<=0||d[field]>1e12)))return false;
    if(['waiting','active','closed'].includes(d.state)&&['entry','stop','target'].some(field=>d[field]===null))return false;
    if(d.targets!==undefined&&(!Array.isArray(d.targets)||d.targets.length>MAX_EXTRA_TARGETS||d.targets.some(value=>!Number.isFinite(value)||value<=0||value>1e12)))return false;
    if(['archived','showcase'].some(key=>record[key]!==undefined&&typeof record[key]!=='boolean'))return false;
    if(record.showcase===true&&(!record.published||tierOf(d.strategy)!=='pro'))return false;
    if(m.exit!==undefined&&(!Number.isFinite(m.exit)||m.exit<=0||m.exit>1e12)||!Array.isArray(d.points)||d.points.some(point=>!Number.isFinite(point))||!Array.isArray(m.events)||!validClosureLedger(record))return false;
    for(const entry of m.events)if(!Array.isArray(entry)||entry.length!==4||entry.slice(0,3).some(value=>typeof value!=='string')||!isObject(entry[3])||typeof entry[3].id!=='string'||typeof entry[3].at!=='string'||!Number.isFinite(Date.parse(entry[3].at)))return false;
  }
  return true;
}
function allowed(object,keys){if(!isObject(object)||Object.keys(object).some(key=>!keys.includes(key)))fail('Запрос содержит недопустимые поля.')}
function text(value,field,{required=false,fallback=''}={}){
  if(value===undefined||value===null)value=fallback;
  if(typeof value!=='string')fail(`Поле «${field}» должно быть строкой.`);
  const normalized=value.trim();
  if(normalized.length>(limits[field]||1500)||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(normalized)||(required&&!normalized))fail(`Проверьте поле «${field}».`);
  return normalized;
}
function extraTargets(value){if(value==null||value==='')return [];if(!Array.isArray(value)||value.length>MAX_EXTRA_TARGETS)fail(`Дополнительных целей — не больше ${MAX_EXTRA_TARGETS}.`);return value.map((item,index)=>price(item,'цель '+(index+2)));}
function price(value,field){if(typeof value!=='number'||!Number.isFinite(value)||value<=0||value>1e12)fail(`Поле «${field}»: укажите положительное число до 1 000 000 000 000.`);return value}
function chartUrl(value){
  if(typeof value!=='string'||value.length>2048)fail('Ссылка на график: укажите HTTPS-адрес до 2048 символов.');
  const source=value.trim();if(!source)return '';
  if(/[\u0000-\u0020\u007f]/.test(source))fail('Ссылка на график содержит недопустимые символы.');
  let url;try{url=new URL(source);}catch{fail('Ссылка на график должна быть полным HTTPS-адресом.');}
  if(url.protocol!=='https:'||url.username||url.password||url.href.length>2048)fail('Ссылка на график должна использовать HTTPS и не содержать логин или пароль.');
  return url.href;
}
function timestamp(value){
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value))return NaN;
  const day=value.slice(0,10),midnight=new Date(day+'T00:00:00Z');
  return Number.isFinite(+midnight)&&midnight.toISOString().startsWith(day+'T')?Date.parse(value):NaN;
}
function isoTime(value,field){
  const result=timestamp(value);
  if(!Number.isFinite(result))fail(`Поле «${field}»: укажите дату и время с часовым поясом.`);
  return new Date(result).toISOString();
}
function positionUnits(percent){
  if(typeof percent!=='number'||!Number.isFinite(percent)||percent<=0||percent>100)return NaN;
  const units=Math.round(percent*100);
  return units/100===percent?units:NaN;
}
function parsePriceSource(value,occurredAt){
  if(value===undefined)return undefined;
  allowed(value,['url','observedAt']);
  const url=chartUrl(value.url),observedAt=isoTime(value.observedAt,'время котировки');
  if(!url||observedAt>occurredAt)fail('Укажите HTTPS-источник цены и время котировки не позже выхода.');
  return {url,observedAt};
}
const closeReturn=(data,exit)=>(exit/data.entry-1)*100*(data.dir==='ШОРТ'?-1:1);
function closureTotals(closures){
  let used=0,weighted=0,realized=0;
  for(const part of closures){
    const units=positionUnits(part.percent);
    used+=units;weighted+=units*part.price;realized+=part.contributionPct;
  }
  return {remainingPct:(POSITION_UNITS-used)/100,realizedPct:realized,weightedExit:weighted/used};
}
function validClosureLedger({d,meta:m}){
  if(!own(m,'closures'))return !own(m,'closureVersion');
  if(m.closureVersion!==1||!Array.isArray(m.closures)||!m.closures.length||m.closures.length>POSITION_UNITS||!['active','closed'].includes(d.state))return false;
  let previous=m.enteredAt??m.levelsPublishedAt??m.publishedAt,used=0;
  if(!Number.isFinite(timestamp(previous)))return false;
  for(const part of m.closures){
    if(!isObject(part)||!closeActions.includes(part.action)||used>=POSITION_UNITS)return false;
    const units=positionUnits(part.percent),{occurredAt,reason,note,price:exit,priceOrigin,priceSource}=part;
    if(!Number.isInteger(units)||units<1||!Number.isFinite(exit)||exit<=0||exit>1e12||!Number.isFinite(timestamp(occurredAt))||new Date(occurredAt).toISOString()!==occurredAt||Date.parse(occurredAt)<Date.parse(previous))return false;
    if(typeof reason!=='string'||!reason.trim()||reason.length>(explicitCloseActions.includes(part.action)?300:1500)||typeof note!=='string'||note.length>1500)return false;
    const expectedOrigin=['target','stop'].includes(part.action)?'configured-level':priceSource?'market-reference':'admin';
    if(priceOrigin!==expectedOrigin||part.resultPct!==closeReturn(d,exit)||!Number.isFinite(part.resultPct)||part.contributionPct!==part.resultPct*(units/POSITION_UNITS))return false;
    if(priceSource){
      if(!explicitCloseActions.includes(part.action))return false;
      try{if(JSON.stringify(parsePriceSource(priceSource,occurredAt))!==JSON.stringify(priceSource))return false;}catch{return false;}
    }
    used+=units;
    if(used>POSITION_UNITS||(part.action==='partial-close')!==(used<POSITION_UNITS))return false;
    previous=occurredAt;
  }
  const total=closureTotals(m.closures),last=m.closures.at(-1),closed=d.state==='closed';
  return total.remainingPct===m.remainingPct&&total.realizedPct===m.realizedPct&&total.weightedExit===m.weightedExit&&d.current===last.price
    &&(closed?(used===POSITION_UNITS&&m.exit===last.price&&m.closedAt===last.occurredAt&&m.finalResultPct===total.realizedPct):(used<POSITION_UNITS&&!own(m,'finalResultPct')));
}
function recordClosure(record,payload,note,exit,at){
  const {d,meta:m}=record,{action}=payload;
  const explicit=explicitCloseActions.includes(action),partial=action==='partial-close';
  const balance=positionUnits(m.remainingPct??100);
  const units=partial?positionUnits(payload.percent):balance;
  if(partial&&(!Number.isInteger(units)||units<1||units>=balance))fail('Частичный выход: укажите долю исходного объёма с точностью до 0,01%, меньше остатка.');
  const occurredAt=explicit?isoTime(payload.occurredAt,'время выхода'):at;
  const earliest=m.closures?.at(-1)?.occurredAt??m.enteredAt??m.levelsPublishedAt??m.publishedAt;
  if(!Number.isFinite(timestamp(earliest))||Date.parse(occurredAt)<Date.parse(earliest)||occurredAt>at)fail('Выход нельзя записать раньше входа, предыдущего выхода или на будущее.');
  const reason=explicit?text(payload.reason,'причина',{required:true}):note;
  if(explicit&&reason.length>300)fail('Причина выхода должна быть не длиннее 300 символов.');
  const priceSource=parsePriceSource(payload.priceSource,occurredAt);
  const priceOrigin=['target','stop'].includes(action)?'configured-level':priceSource?'market-reference':'admin';
  const resultPct=closeReturn(d,exit);
  if(!Number.isFinite(resultPct))fail('Для указанной цены нельзя вычислить расчётный результат.');
  const part={action,percent:units/100,price:exit,occurredAt,reason,note,priceOrigin,...(priceSource?{priceSource}:{}),resultPct,contributionPct:resultPct*(units/POSITION_UNITS)};
  const closures=m.closures??[];
  if(closures.some(previous=>previous.action===part.action&&previous.percent===part.percent&&previous.price===part.price&&previous.occurredAt===part.occurredAt&&previous.reason===part.reason&&previous.note===part.note&&JSON.stringify(previous.priceSource)===JSON.stringify(part.priceSource)))fail('Этот выход уже записан в историю.',409);
  m.closureVersion=1;
  m.closures=[...closures,part];
  Object.assign(m,closureTotals(m.closures));
  if(!Number.isFinite(m.realizedPct))fail('По указанным ценам нельзя вычислить итог выхода.');
  if(m.remainingPct===0)m.finalResultPct=m.realizedPct;
  return part;
}
function requireAdmin(user){if(!user)fail('Войдите в аккаунт.',401);if(!isAdmin(user))fail('Доступно только администратору.',403)}
function requireReader(user){if(!user)fail('Войдите в аккаунт.',401);if(!hasSubscription(user))fail('Для доступа к идеям нужна действующая подписка.',403)}
function idValue(id){if(typeof id!=='string'||!/^[a-zA-Z0-9_-]{1,100}$/.test(id))fail('Некорректный идентификатор идеи.');return id}
function levels(d){
  for(const field of ['entry','stop','target'])price(d[field],field);
  if(d.dir==='ЛОНГ'&&!(d.stop<d.entry&&d.entry<d.target))fail('Для лонга: стоп < вход < цель.');
  if(d.dir==='ШОРТ'&&!(d.target<d.entry&&d.entry<d.stop))fail('Для шорта: цель < вход < стоп.');
  if(d.targets?.length){const ordered=[d.target,...d.targets];if(ordered.some((value,index)=>index>0&&(d.dir==='ЛОНГ'?value<=ordered[index-1]:value>=ordered[index-1])))fail('Дополнительные цели идут по направлению сделки дальше первой цели: для лонга — выше, для шорта — ниже.');}
  if(!d.entryRule||!d.cancelRule)fail('Укажите условия входа, отмены и выхода.');
}
function configuration(input,mode){
  allowed(input,dataFields);
  let strategy=input.strategy==null?null:text(input.strategy,'strategy');
  if(strategy!==null&&!strategies.has(strategy))fail('Выберите существующую стратегию.');
  const market=input.market??(strategy&&!multiMarketStrategies.has(strategy)?strategyMarkets[strategy]:'stocks'),dir=input.dir??(mode==='draft'?'ЛОНГ':undefined);
  if(!['stocks','futures','crypto'].includes(market)||!['ЛОНГ','ШОРТ'].includes(dir))fail('Выберите рынок и направление.');
  strategy??=defaultStrategies[market];
  if(!strategyAllowsMarket(strategy,market))fail('Стратегия не соответствует выбранному рынку. Измените рынок или выберите подходящую стратегию.');
  const ticker=text(input.ticker,'ticker',{required:mode!=='draft'});
  if(ticker&&!/^[\p{L}\p{N}._:/-]+$/u.test(ticker))fail('Тикер содержит недопустимые символы.');
  const d={ticker,name:text(input.name,'name',{fallback:ticker}),market,dir,strategy,
    title:text(input.title,'title',{fallback:ticker?`Новый сигнал ${ticker} · ${dir}`:''}),
    summary:text(input.summary,'summary',{fallback:mode==='quick'?'Сигнал опубликован. Уровни и условия будут добавлены автором.':''}),
    thesis:text(input.thesis,'thesis'),horizon:text(input.horizon,'horizon',{fallback:strategy==='Orbita Exclusive'?'2–8 недель':strategy==='Импульс'?'Внутри дня':'1–5 дней'}),
    entryRule:text(input.entryRule,'entryRule'),cancelRule:text(input.cancelRule,'cancelRule'),
    entry:null,stop:null,target:null,
    unit:market==='stocks'?'₽':market==='futures'?'пт':'USDT'};
  if(own(input,'chartUrl'))d.chartUrl=chartUrl(input.chartUrl);
  if(mode==='full'){
    for(const field of ['entry','stop','target'])d[field]=price(input[field],field);
    if(own(input,'targets'))d.targets=extraTargets(input.targets);
    levels(d);
  }else if(mode==='draft'){
    for(const field of ['entry','stop','target'])if(input[field]!=null&&input[field]!=='')d[field]=price(input[field],field);
    if(own(input,'targets'))d.targets=extraTargets(input.targets);
  }else{
    // A quick signal carries no executable levels, even if the form supplied stale values.
    d.entryRule='';d.cancelRule='';
  }
  return d;
}
function setChart(d){
  if([d.entry,d.stop,d.target].every(Number.isFinite)){
    const lo=Math.min(d.entry,d.stop,d.target),hi=Math.max(d.entry,d.stop,d.target),pad=Math.max((hi-lo)*.15,d.entry*.001);
    d.min=lo-pad;d.max=hi+pad;d.current=d.entry;d.points=Array(28).fill(d.entry);
  }else{d.min=null;d.max=null;d.current=null;d.points=[]}
  d.chartPlaceholder=true;
}
function snapshot(record,at){return {...Object.fromEntries(dataFields.filter(field=>own(record.d,field)).map(field=>[field,record.d[field]])),publishedAt:at,reconstructed:false}}
function state(record){const m=record.meta;return {state:record.d.state,status:record.d.status,entry:record.d.entry,stop:record.d.stop,target:record.d.target,current:record.d.current,outcome:record.d.outcome??null,exit:m.exit??null,erroneous:!!record.erroneous,...(m.closures?{remainingPct:m.remainingPct,realizedPct:m.realizedPct,weightedExit:m.weightedExit,finalResultPct:m.finalResultPct??null}:{})}}
function event(record,{type,title,body,note=body,before=null,after=state(record),at,actor,via='WEB',closure}){
  record.meta.updated=stamp(at);record.meta.updatedAt=at;
  record.meta.events.push([stamp(at),title,body,{id:'event-'+randomUUID(),type,at,note,before:clone(before),after:clone(after),actorId:actor?.id??null,via,...(closure?{closure:clone(closure)}:{})}]);
}
function makeRecord(user,payload,id='idea-'+randomUUID(),via='WEB',at=new Date().toISOString()){
  allowed(payload,['mode','d','revision']);
  if(!['quick','full','draft'].includes(payload.mode))fail('Выберите режим публикации: quick, full или draft.');
  const d=configuration(payload.d,payload.mode),published=payload.mode!=='draft';
  d.state=!published?'draft':payload.mode==='quick'?'announced':'waiting';
  d.status=!published?'Черновик':payload.mode==='quick'?'Новый сигнал':'Ожидает входа';setChart(d);
  const record={id,published,d,createdAt:at,createdBy:user.id,createdByUserId:user.id,createdVia:via,recordVersion:1,meta:{published:null,publishedAt:null,updated:stamp(at),updatedAt:at,entryRule:d.entryRule,cancelRule:d.cancelRule,events:[]}};
  if(published){
    record.meta.published=stamp(at);record.meta.publishedAt=at;record.meta.initial=snapshot(record,at);
    event(record,{type:'published',title:'Идея опубликована',body:payload.mode==='quick'?'Новый сигнал без уровней. Вход ещё не подтверждён; условия будут добавлены отдельным событием.':'Уровни и условия зафиксированы. Ожидает подтверждения входа.',after:record.meta.initial,at,actor:user,via});
  }
  return record;
}
function applyUpdate(record,user,payload,via='WEB',at=new Date().toISOString()){
  allowed(payload,['action','note','price','revision','d',...levelFields,...closureFields]);
  const {action}=payload;
  if(typeof action!=='string')fail('Укажите действие.');
  const explicitClose=explicitCloseActions.includes(action);
  if(!explicitClose&&closureFields.some(field=>own(payload,field))||action==='early-close'&&own(payload,'percent'))fail('Проверьте поля выхода.');
  if(!['levels','terms-change','description','strategy-change'].includes(action)&&own(payload,'d')||action!=='levels'&&levelFields.some(field=>own(payload,field)))fail('Редактировать условия и описание можно только отдельным событием.');
  if(record.erroneous&&action!=='note')fail('Для ошибочной публикации доступны только комментарии.');
  const d=record.d,m=record.meta,auditFields=action==='terms-change'?termFields:action==='description'?descriptionFields:[],before={...state(record),...Object.fromEntries(auditFields.filter(field=>own(d,field)).map(field=>[field,d[field]]))};
  if(explicitClose&&!m.closures)Object.assign(before,{remainingPct:100,realizedPct:0,weightedExit:null,finalResultPct:null});
  let note=text(payload.note,'note',{required:!explicitClose&&!['levels','archive','unarchive','showcase','unshowcase'].includes(action),fallback:action==='levels'?'Автор добавил уровни и условия входа.':''}),title='Комментарий автора',body=note,closure;
  if(action==='levels'){
    if(d.state!=='announced')fail('Уровни можно добавить только к сигналу без уровней.');
    const data=payload.d??Object.fromEntries(levelFields.filter(field=>own(payload,field)).map(field=>[field,payload[field]]));allowed(data,levelFields);
    const proposed={...d};
    for(const field of ['entry','stop','target'])proposed[field]=price(data[field],field);
    if(own(data,'targets'))proposed.targets=extraTargets(data.targets);
    for(const field of levelFields.filter(field=>!['entry','stop','target','targets'].includes(field)))if(own(data,field))proposed[field]=text(data[field],field);
    levels(proposed);Object.assign(d,proposed,{state:'waiting',status:'Ожидает входа'});setChart(d);
    m.entryRule=d.entryRule;m.cancelRule=d.cancelRule;m.levelsPublishedAt=at;m.initialLevels=snapshot(record,at);
    title='Уровни и условия добавлены';body=`${d.ticker}: вход ${d.entry}, стоп ${d.stop}, цель ${d.target} ${d.unit}. ${note}`;
  }else if(action==='terms-change'){
    if(d.state!=='waiting')fail('Изменить условия можно только до подтверждения входа. После входа используйте отдельное изменение стопа или цели.');
    const data=payload.d;allowed(data,termFields);const proposed={...d};
    for(const field of termFields)if(own(data,field))proposed[field]=field==='targets'?extraTargets(data[field]):['entry','stop','target'].includes(field)?price(data[field],field):text(data[field],field);
    levels(proposed);if(!termFields.some(field=>JSON.stringify(proposed[field]??null)!==JSON.stringify(d[field]??null)))fail('Условия не изменились.');
    Object.assign(d,proposed);setChart(d);m.entryRule=d.entryRule;m.cancelRule=d.cancelRule;
    title='Условия до входа изменены';body=`${d.ticker}: вход ${d.entry}, стоп ${d.stop}, цель ${d.target} ${d.unit}. ${note}`;
  }else if(action==='description'){
    const data=payload.d;allowed(data,descriptionFields);const proposed={};
    for(const field of descriptionFields)if(own(data,field))proposed[field]=field==='chartUrl'?chartUrl(data[field]):text(data[field],field);
    if(!descriptionFields.some(field=>own(proposed,field)&&proposed[field]!== (field==='chartUrl'?d[field]??'':d[field])))fail('Описание не изменилось.');
    Object.assign(d,proposed);title='Описание идеи обновлено';body=`${d.ticker}: описание обновлено. ${note}`;
  }else if(action==='activate'){
    if(d.state!=='waiting')fail('Подтвердить вход можно только после добавления уровней ожидающей идеи.');levels(d);
    d.state='active';d.status='Активен';m.enteredAt=at;title='Вход подтверждён';
  }else if(action==='cancel'){
    if(!['announced','waiting'].includes(d.state))fail('Отмена доступна только до входа.');
    d.state='cancelled';d.status='Отменён';d.outcome='Отменён до входа';title=d.outcome;
  }else if(action==='stop-change'){
    if(!['waiting','active'].includes(d.state))fail('Изменить стоп можно только после публикации уровней и до закрытия.');
    const next=price(payload.price,'stop');
    if(next===d.stop)fail('Новый стоп совпадает с текущим.');
    if((d.dir==='ЛОНГ'&&next>=d.target)||(d.dir==='ШОРТ'&&next<=d.target))fail('Стоп должен оставаться до цели по направлению сделки.');
    if(d.state==='waiting'&&((d.dir==='ЛОНГ'&&next>=d.entry)||(d.dir==='ШОРТ'&&next<=d.entry)))fail('До входа стоп должен быть за уровнем входа.');
    const n=value=>value.toLocaleString('ru-RU',{maximumFractionDigits:8});title='Стоп изменён';body=`${d.ticker}: стоп изменён с ${n(d.stop)} до ${n(next)} ${d.unit}. ${note}`;d.stop=next;
    const lo=Math.min(d.entry,d.stop,d.target),hi=Math.max(d.entry,d.stop,d.target);d.min=lo-(hi-lo)*.15;d.max=hi+(hi-lo)*.15;
  }else if(action==='target-change'){
    if(!['waiting','active'].includes(d.state))fail('Изменить цель можно только после публикации уровней и до закрытия.');
    const next=price(payload.price,'target');
    if(next===d.target)fail('Новая цель совпадает с текущей.');
    if(d.dir==='ЛОНГ'&&next<=Math.max(d.entry,d.stop)||d.dir==='ШОРТ'&&next>=Math.min(d.entry,d.stop))fail('Цель должна оставаться за входом и стопом по направлению сделки.');
    const n=value=>value.toLocaleString('ru-RU',{maximumFractionDigits:8});title='Цель изменена';body=`${d.ticker}: цель изменена с ${n(d.target)} до ${n(next)} ${d.unit}. ${note}`;d.target=next;
    const lo=Math.min(d.entry,d.stop,d.target),hi=Math.max(d.entry,d.stop,d.target);d.min=lo-(hi-lo)*.15;d.max=hi+(hi-lo)*.15;
  }else if(closeActions.includes(action)){
    if(d.state!=='active')fail('Записать выход можно только для активной идеи.');
    const exit=price(action==='target'?d.target:action==='stop'?d.stop:payload.price,'exit');
    if(explicitClose||m.closures)closure=recordClosure(record,payload,note,exit,at);
    d.current=exit;
    if(action==='partial-close')title='Частичный выход';
    else{
      d.state='closed';d.status='Завершён';d.outcome=action==='target'?'Цель достигнута':action==='stop'?'Стоп достигнут':action==='early-close'?'Закрыто досрочно':'Закрыто вручную';
      m.exit=exit;m.closedAt=closure?.occurredAt??at;title=d.outcome;
    }
    if(closure){
      const n=value=>value.toLocaleString('ru-RU',{maximumFractionDigits:8});
      const result=m.remainingPct===0?m.finalResultPct:m.realizedPct;
      body=`${d.ticker}: закрыто ${n(closure.percent)}% по ${n(exit)} ${d.unit} (${stamp(closure.occurredAt)} МСК). Остаток ${n(m.remainingPct)}%. Расчётный результат ${result.toLocaleString('ru-RU',{maximumFractionDigits:2,signDisplay:'exceptZero'})}%. ${closure.reason}${note&&note!==closure.reason?' '+note:''}`;
      note=closure.reason;
    }
  }else if(action==='strategy-change'){
    const data=payload.d;allowed(data,['strategy']);const next=text(data?.strategy,'strategy',{required:true});
    if(!strategies.has(next))fail('Выберите существующую стратегию.');if(next===d.strategy)fail('Стратегия не изменилась.');
    if(!strategyAllowsMarket(next,d.market))fail('Стратегия не соответствует рынку идеи.');
    const from=d.strategy,fromTier=tierOf(from),toTier=tierOf(next);d.strategy=next;if(toTier!=='pro'&&record.showcase)record.showcase=false;
    title='Стратегия изменена';body=`${d.ticker}: ${from} (${fromTier.toUpperCase()}) → ${next} (${toTier.toUpperCase()}). Доступ обновлён. ${note}`;
  }else if(action==='archive'||action==='unarchive'){
    if(!record.published)fail('Архивировать можно только опубликованную идею. Черновик можно удалить.');
    if((action==='archive')===(record.archived===true))fail(action==='archive'?'Идея уже в архиве.':'Идея не в архиве.');
    record.archived=action==='archive';if(record.archived&&record.showcase)record.showcase=false;title=record.archived?'Идея перенесена в архив':'Идея возвращена из архива';
  }else if(action==='showcase'||action==='unshowcase'){
    if(action==='showcase'&&(!record.published||record.archived||record.erroneous||tierOf(d.strategy)!=='pro'||!['announced','waiting','active'].includes(d.state)))fail('Публичным примером может быть только открытая опубликованная PRO-идея.');
    record.showcase=action==='showcase';title=record.showcase?'Идея выбрана публичным примером':'Идея снята с публичного примера';
  }else if(action==='error'){
    record.erroneous=true;m.errorReason=note;m.error={reason:note,at};title='Ошибочная публикация';
  }else if(action!=='note')fail('Неизвестное действие.');
  if(record.showcase&&(record.erroneous||!['announced','waiting','active'].includes(d.state)))record.showcase=false;
  const after=action==='levels'?{...state(record),...m.initialLevels}:{...state(record),...Object.fromEntries(auditFields.filter(field=>own(d,field)).map(field=>[field,d[field]]))};
  event(record,{type:action,title,body,note,before,after,at,actor:user,via,closure});
}
function checkRevision(db,payload){if(!isObject(payload))fail('Некорректный запрос.');if(own(payload,'revision')&&(!Number.isInteger(payload.revision)||payload.revision!==db.revision))fail('Данные изменились. Обновите список перед сохранением.',409)}

// This third argument is an internal service contract, never part of a web
// request payload. Telegram must recheck the live binding/role inside the same
// idea transaction before either a write or an idempotent replay is returned.
function radarSourceValid(source,stored=false){
  if(!isObject(source))return false;
  const fields=['eventId','eventRevision','headline','ticker','draftId',...(stored?['actorId','requestHash']:[])];
  if(Object.keys(source).some(k=>!fields.includes(k))||!['eventId','draftId',...(stored?['actorId']:[])].every(k=>typeof source[k]==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(source[k]))||!Number.isSafeInteger(source.eventRevision)||source.eventRevision<1||typeof source.headline!=='string'||source.headline.length>300||typeof source.ticker!=='string'||source.ticker.length>30)return false;
  return !stored||typeof source.requestHash==='string'&&/^[a-f0-9]{64}$/.test(source.requestHash);
}
function mutationContext(value,kind){
  allowed(value,['createdVia','telegramChatId','telegramMessageId','operationId','authorize','expectedRecordVersion','expectedDuplicateFingerprint','radarSource','expectedRadarFingerprint']);
  const via=value.createdVia??'WEB';
  if(!['WEB','TELEGRAM','API'].includes(via))fail('Некорректный источник изменения.');
  if(value.authorize!==undefined&&typeof value.authorize!=='function')fail('Некорректная проверка доступа.');
  if(value.expectedRecordVersion!==undefined&&(!Number.isSafeInteger(value.expectedRecordVersion)||value.expectedRecordVersion<0))fail('Некорректная версия идеи.');
  if(value.expectedDuplicateFingerprint!==undefined&&((via!=='TELEGRAM'&&(!value.radarSource||kind!=='create'))||typeof value.expectedDuplicateFingerprint!=='string'||value.expectedDuplicateFingerprint.length>64000))fail('Некорректное подтверждение похожих идей.');
  if(value.radarSource!==undefined&&(kind!=='create'||!radarSourceValid(value.radarSource)||typeof value.authorize!=='function'||typeof value.expectedRadarFingerprint!=='string'||value.expectedRadarFingerprint.length>64000))fail('Некорректный источник Radar.');
  if(value.expectedRadarFingerprint!==undefined&&!value.radarSource)fail('Для проверки связей требуется событие Radar.');
  if(via==='TELEGRAM'){
    if(typeof value.authorize!=='function'||typeof value.operationId!=='string'||!/^[A-Za-z0-9:_-]{1,128}$/.test(value.operationId))fail('Для Telegram требуется проверка доступа и идентификатор операции.');
    if((kind==='create'||value.telegramChatId!==undefined)&&(typeof value.telegramChatId!=='string'||!/^[1-9]\d{0,19}$/.test(value.telegramChatId)))fail('Некорректный Telegram chat ID.');
    if((kind==='create'||value.telegramMessageId!==undefined)&&(!Number.isSafeInteger(value.telegramMessageId)||value.telegramMessageId<1))fail('Некорректный Telegram message ID.');
  }else if(['telegramChatId','telegramMessageId','operationId'].some(key=>own(value,key)))fail('Telegram-метаданные допустимы только для внутренней операции Telegram.');
  return {...value,createdVia:via,operationHash:via==='TELEGRAM'?digest(value.operationId):null};
}
async function currentActor(user,context){
  const current=context.authorize?await context.authorize():user;requireAdmin(current);
  if(typeof current.id!=='string'||!current.id||current.id!==user.id)fail('Аккаунт администратора изменился.',403);
  return current;
}
function canonical(value){if(Array.isArray(value))return value.map(canonical);if(isObject(value))return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])]));return value;}
const fingerprint=(kind,id,payload)=>digest(JSON.stringify(canonical({kind,id,payload:Object.fromEntries(Object.entries(payload).filter(([key])=>key!=='revision'))})));
function replay(db,user,context,kind,id,requestFingerprint){
  if(!context.operationHash)return null;
  for(const record of db.records){
    const operation=record.telegram?.operations.find(item=>item.id===context.operationHash);
    if(!operation)continue;
    if(operation.actorId!==user.id||operation.kind!==kind||operation.fingerprint!==requestFingerprint||id!==null&&record.id!==id)fail('Идентификатор операции уже использован с другими данными.',409);
    return {unchanged:true,value:{record:clone(record)}};
  }
  return null;
}
function rememberOperation(record,user,context,kind,requestFingerprint){
  if(!context.operationHash)return;
  record.telegram??={operations:[]};
  if(record.telegram.operations.length>=MAX_TELEGRAM_OPERATIONS)fail('Достигнут предел операций Telegram для идеи. Продолжите сопровождение в веб-редакции.',409);
  record.telegram.operations.push({id:context.operationHash,actorId:user.id,kind,fingerprint:requestFingerprint});
  if(kind==='create'){record.telegram.chatId=context.telegramChatId;record.telegram.messageId=context.telegramMessageId;}
}
function projectRecord(record,user){
  const value=clone(record);
  if(!isAdmin(user)){delete value.telegram;delete value.createdByUserId;delete value.radarSource;}
  return value;
}
function ledgerResultR(record,exit){
  const {d,meta:m}=record;
  const activation=m.events.find(entry=>entry[3]?.type==='activate')?.[3]?.before;
  const stop=activation?.stop??m.initialLevels?.stop??m.initial?.stop;
  const risk=Math.abs(d.entry-stop);
  return Number.isFinite(risk)&&risk>0?(exit-d.entry)*(d.dir==='ШОРТ'?-1:1)/risk:null;
}
const publishedResultRecord=record=>record.published&&!record.demo&&!record.isDemo&&!record.id.startsWith('demo-');
function projectResult(record,{localMarketHistory=false}={}){
  const {d,meta:m}=record,first=m.initialLevels||m.initial||{},sign=d.dir==='ШОРТ'?-1:1;
  const entry=Number.isFinite(first.entry)?first.entry:d.entry,stop0=Number.isFinite(first.stop)?first.stop:d.stop;
  const exit=Number.isFinite(m.exit)?m.exit:null;
  const pct=d.state==='closed'&&exit&&entry?m.finalResultPct??(exit/entry-1)*100*sign:null;
  const risk=Number.isFinite(stop0)&&Number.isFinite(entry)?Math.abs(entry-stop0):null;
  const inR=pct===null?null:m.closures?ledgerResultR(record,m.weightedExit):risk?(exit-entry)*sign/risk:null;
  const closes=d.state==='closed'&&m.closures&&!record.erroneous
    ?{weightedExit:m.weightedExit,closures:m.closures.map(({action,percent,price,occurredAt,priceOrigin,resultPct,contributionPct})=>({action,percent,price,occurredAt,priceOrigin,resultPct,contributionPct}))}
    :{};
  return {id:record.id,ticker:d.ticker,name:d.name,market:d.market,dir:d.dir,tier:tierOf(d.strategy),strategy:d.strategy,
    publishedAt:m.publishedAt,enteredAt:m.enteredAt??null,closedAt:m.closedAt??m.updatedAt??null,
    initial:{entry:first.entry??null,stop:first.stop??null,target:first.target??null},
    final:{entry:d.entry,stop:d.stop,target:d.target,targets:d.targets||[]},exit,
    outcome:record.erroneous?'Ошибочная публикация':d.outcome||d.status,state:d.state,
    erroneous:!!record.erroneous,errorReason:record.erroneous?(m.errorReason||m.error?.reason||null):null,
    pct,r:inR,unit:d.unit,changes:(m.events||[]).filter(e=>['stop-change','target-change','terms-change'].includes(e[3]?.type)).length,
    ...closes,...(localMarketHistory?{sourceUrl:d.chartUrl}:{})};
}

// Explicitly imported demonstration records are never part of normal startup.
function demoRecord(source,user,importedAt){
  const record=clone(source);record.demo=true;record.importedAt=importedAt;record.importedBy=user.id;
  const m=record.meta;
  const parse=value=>{const p=String(value).match(/^(\d{2})\.(\d{2})(?:\.(\d{4}))?\s*·\s*(\d{2}):(\d{2})$/);return p?new Date(`${p[3]||m.published.match(/\d{2}\.\d{2}\.(\d{4})/)[1]}-${p[2]}-${p[1]}T${p[4]}:${p[5]}:00+03:00`).toISOString():null};
  m.publishedAt=parse(m.published);m.updatedAt=parse(m.updated);
  m.initial=snapshot(record,m.publishedAt);m.initial.entryRule=m.entryRule;m.initial.cancelRule=m.cancelRule;
  record.d.entryRule=m.entryRule;record.d.cancelRule=m.cancelRule;
  m.events=m.events.map(([time,title,body])=>{
    const at=parse(time),type=/публик/i.test(title)?'published':/вход подтвержд/i.test(title)?'activate':/цели|цель достиг/i.test(title)?'target':/стопу|стоп достиг/i.test(title)?'stop':'note';
    if(type==='activate')m.enteredAt=at;if(['target','stop'].includes(type))m.closedAt=at;
    return [stamp(at),title,body,{id:'event-'+randomUUID(),type,at,demo:true}];
  });
  return record;
}

// Build local scenario records in memory. Published results still use the persistent store.
function buildLocalMarketHistory(fixture){
  if(fixture?.version!==1||fixture.source!=='MOEX ISS'||fixture.intervalMinutes!==60||!isObject(fixture.instruments)||!Array.isArray(fixture.trades)||fixture.trades.length>1000)fail('Некорректная локальная история Мосбиржи.');
  const user={id:'local-market-history'},ids=new Set();
  return fixture.trades.map(({ticker,dir,bars})=>{
    if(typeof ticker!=='string'||!/^[A-Z0-9]{1,12}$/.test(ticker)||!own(fixture.instruments,ticker)||!Array.isArray(bars)||bars.length<2||bars.length>24)fail('Некорректный сценарий Мосбиржи.');
    const instrument=fixture.instruments[ticker],market=instrument.market;
    const source=chartUrl(instrument.url),board=market==='stocks'?'stock/markets/shares/boards/TQBR':market==='futures'?'futures/markets/forts/boards/RFUD':null;
    if(!board||!source.startsWith('https://iss.moex.com/iss/engines/'+board+'/securities/'+ticker+'/candles.json?'))fail('Некорректный источник свечей Мосбиржи.');
    const date=String(bars[0]?.[0]).slice(0,10);
    const sessionSource=new URL(source);
    sessionSource.searchParams.set('from',date);
    sessionSource.searchParams.set('till',date);
    let previous=-Infinity;
    for(const bar of bars){
      if(!Array.isArray(bar)||bar.length!==4)fail('Некорректная свеча Мосбиржи.');
      const [begin,end,open,close]=bar;
      if(typeof begin!=='string'||typeof end!=='string'||!begin.startsWith(date+'T')||!end.startsWith(date+'T')||!begin.endsWith('+03:00')||!end.endsWith('+03:00'))fail('Проверьте время свечи по Москве.');
      const start=Date.parse(begin),finish=Date.parse(end);
      if(!Number.isFinite(start)||!Number.isFinite(finish)||start<=previous||finish<=start)fail('Нарушена последовательность свечей.');
      price(open,'открытие');price(close,'закрытие');previous=finish;
    }
    const entry=bars[0][2],exit=bars.at(-1)[3],move=Math.abs(exit/entry-1);
    if(move<0.01-1e-10||move>0.05+1e-10)fail('Движение цены должно быть от 1 до 5 процентов.');
    const sign=dir==='ШОРТ'?-1:1,id='demo-moex-'+date.replaceAll('-','')+'-'+ticker;
    if(ids.has(id))fail('Сценарий Мосбиржи за этот день уже существует.');
    ids.add(id);
    const at=new Date(bars[0][0]).toISOString(),closedAt=new Date(bars.at(-1)[1]).toISOString();
    const record=makeRecord(user,{mode:'full',d:{
      ticker,name:instrument.name,market,dir,strategy:defaultStrategies[market],title:ticker+' · Сценарий по свечам Мосбиржи',
      summary:'Локальная симуляция по часовым свечам MOEX ISS. Направление задано предыдущей свечой, цены взяты из биржевых данных.',
      horizon:'Внутри дня',entry,stop:Number((entry*(1-sign*0.01)).toFixed(8)),target:Number((entry*(1+sign*0.03)).toFixed(8)),
      entryRule:'После растущей свечи — LONG, после падающей — SHORT. Вход по открытию следующей свечи.',
      cancelRule:'Выход по закрытию второй свечи после сигнала. Стоп и цель — справочные уровни.',chartUrl:sessionSource.href
    }},id,'API',at);
    record.demo=true;record.localMarketHistory=true;
    record.meta.events[0][1]='Локальный сценарий';
    record.meta.events[0][2]='Сценарий построен ретроспективно по свечам MOEX ISS.';
    applyUpdate(record,user,{action:'activate',note:'Условный вход по открытию часовой свечи.'},'API',at);
    applyUpdate(record,user,{action:'manual',price:exit,note:'Условный выход по закрытию часовой свечи.'},'API',closedAt);
    record.d.points=[entry,...bars.map(bar=>bar[3])];
    record.d.min=Math.min(record.d.stop,record.d.target,...record.d.points);
    record.d.max=Math.max(record.d.stop,record.d.target,...record.d.points);
    record.d.chartPlaceholder=false;
    return record;
  });
}

export async function createIdeas(directory,{localMarketHistory=false}={}){
  const localFixture=localMarketHistory?JSON.parse(await readFile(new URL('../fixtures/local-market-history.json',import.meta.url),'utf8')):null;
  const localRecords=localFixture?buildLocalMarketHistory(localFixture):[];
  await mkdir(directory,{recursive:true,mode:0o700});
  const file=path.join(directory,'ideas.json'),lock=file+'.lock';let queue=Promise.resolve();
  async function load(){
    try{const info=await lstat(file);if(!info.isFile()||info.isSymbolicLink()||info.size>MAX_STORE_BYTES)throw storeFailure('DATA_UNSAFE');const bytes=await readFile(file);if(bytes.length>MAX_STORE_BYTES)throw storeFailure('DATA_UNSAFE');const db=JSON.parse(bytes.toString('utf8'));if(!validateIdeasDatabase(db))throw storeFailure('DATA_INVALID');return db;}
    catch(error){if(error.code==='ENOENT')return initialDatabase();if(error instanceof SyntaxError)throw storeFailure('DATA_INVALID');throw error;}
  }
  await load();
  async function acquire(){
    const deadline=Date.now()+5000;
    while(true){
      try{await mkdir(lock,{mode:0o700});try{await writeFile(path.join(lock,'owner.json'),JSON.stringify({pid:process.pid,at:Date.now()}),{mode:0o600})}catch(error){await rm(lock,{recursive:true,force:true});throw error}return}
      catch(error){
        if(error.code!=='EEXIST')throw error;
        // A crashed CLI/server must not leave the database locked permanently.
        try{const owner=JSON.parse(await readFile(path.join(lock,'owner.json'),'utf8'));try{process.kill(owner.pid,0)}catch(gone){if(gone.code==='ESRCH'&&await reclaimAbandonedLock(lock)){continue}}}
        catch(missing){if(missing.code==='ENOENT'){try{if(Date.now()-(await stat(lock)).mtimeMs>30000&&await reclaimAbandonedLock(lock)){continue}}catch{}}}
        if(Date.now()>=deadline)fail('База идей занята. Повторите действие.',409);
        await new Promise(resolve=>setTimeout(resolve,25));
      }
    }
  }
  function transaction(mutate){
    const job=queue.then(async()=>{
      await acquire();let temp;
      try{
        const db=await load(),result=await mutate(db);
        if(result.unchanged)return {revision:db.revision,...result.value};
        if(db.revision>=Number.MAX_SAFE_INTEGER)fail('Достигнут предел версий базы идей. История сохранена.',409);
        db.revision++;if(!validateIdeasDatabase(db))throw storeFailure('DATA_INVALID');const bytes=JSON.stringify(db);if(Buffer.byteLength(bytes)>MAX_STORE_BYTES)fail('Хранилище идей заполнено. История сохранена.',409);temp=file+`.tmp-${process.pid}-${randomUUID()}`;
        await writeFile(temp,bytes,{mode:0o600});await rename(temp,file);temp=null;
        return {revision:db.revision,...result.value};
      }finally{if(temp)await rm(temp,{force:true});await rm(lock,{recursive:true,force:true})}
    });
    queue=job.catch(()=>{});return job;
  }
  // Server-side entitlement filter: records of a tier the user cannot read are
  // never serialized (no levels, comments or IDs); only the lock state is sent.
  const visible=(record,user)=>isAdmin(user)||(record.published&&record.archived!==true&&canReadStrategy(user,record.d.strategy));
  async function list(user,{includeLocalMarketHistory=false}={}){
    requireReader(user);await queue;const db=await load();
    const records=db.records.filter(record=>record.localMarketHistory!==true);
    if(includeLocalMarketHistory)records.push(...localRecords);
    return {revision:db.revision,access:{tiers:['pro','exclusive'].filter(tier=>canReadTier(user,tier))},locked:['pro','exclusive'].filter(tier=>!canReadTier(user,tier)),records:records.filter(record=>visible(record,user)).map(record=>projectRecord(record,user))};
  }
  async function get(id,user,{includeLocalMarketHistory=false}={}){
    requireReader(user);idValue(id);await queue;const db=await load();
    const record=db.records.find(record=>record.id===id&&record.localMarketHistory!==true)
      ??(includeLocalMarketHistory?localRecords.find(record=>record.id===id):undefined);
    if(!record||!visible(record,user))fail('Идея недоступна.',404);
    return projectRecord(record,user);
  }
  async function create(user,payload,options={}){
    requireAdmin(user);if(!isObject(payload))fail('Некорректный запрос.');const context=mutationContext(options,'create'),requestFingerprint=fingerprint('create',null,payload);
    return transaction(async db=>{
      const actor=await currentActor(user,context),previous=replay(db,actor,context,'create',null,requestFingerprint);if(previous)return previous;
      if(context.radarSource){
        const source=context.radarSource,existing=db.records.find(r=>r.radarSource?.draftId===source.draftId);
        if(existing){if(existing.radarSource.actorId!==actor.id||existing.radarSource.requestHash!==requestFingerprint||existing.radarSource.eventId!==source.eventId)fail('Черновик Radar уже опубликован с другими условиями.',409);return {unchanged:true,value:{record:clone(existing)}};}
        const actual=db.records.filter(r=>r.radarSource?.eventId===source.eventId).map(r=>r.id+':'+(r.recordVersion??0)).sort().join('|');
        if(actual!==context.expectedRadarFingerprint)fail('По событию Radar появилась или изменилась идея. Проверьте связанные сигналы.',409);
      }
      if(context.expectedDuplicateFingerprint!==undefined){
        const market=payload.d?.market??strategyMarkets[payload.d?.strategy]??'stocks';
        if(activeIdeaFingerprint(db.records,market,payload.d?.ticker)!==context.expectedDuplicateFingerprint)fail('Список активных идей по инструменту изменился. Проверьте его перед публикацией.',409);
      }
      checkRevision(db,payload);const record=makeRecord(actor,payload,undefined,context.createdVia);rememberOperation(record,actor,context,'create',requestFingerprint);if(context.radarSource)record.radarSource={...clone(context.radarSource),actorId:actor.id,requestHash:requestFingerprint};db.records.unshift(record);return {value:{record:clone(record)}};
    });
  }
  async function update(user,id,payload,options={}){
    requireAdmin(user);idValue(id);if(!isObject(payload))fail('Некорректный запрос.');const context=mutationContext(options,'update'),requestFingerprint=fingerprint('update',id,payload);
    return transaction(async db=>{
      const actor=await currentActor(user,context),previous=replay(db,actor,context,'update',id,requestFingerprint);if(previous)return previous;
      if(!isObject(payload))fail('Некорректный запрос.');checkRevision(db,payload);
      const index=db.records.findIndex(record=>record.id===id);if(index<0)fail('Идея не найдена.',404);
      let record=db.records[index];const version=record.recordVersion??0;
      if(context.expectedRecordVersion!==undefined&&context.expectedRecordVersion!==version)fail('Идея изменилась. Откройте её заново перед подтверждением.',409);
      if(version>=Number.MAX_SAFE_INTEGER)fail('Достигнут предел версий идеи. История сохранена.',409);
      if(context.expectedDuplicateFingerprint!==undefined){
        if(record.published||!['full','quick'].includes(payload.mode))fail('Подтверждение похожих идей допустимо при публикации черновика.');
        const market=payload.d?.market??strategyMarkets[payload.d?.strategy]??'stocks';
        if(activeIdeaFingerprint(db.records,market,payload.d?.ticker)!==context.expectedDuplicateFingerprint)fail('Список активных идей по инструменту изменился. Проверьте его перед публикацией.',409);
      }
      if(!record.published){const original=record;record=makeRecord(actor,payload,id,original.createdVia??'WEB');record.createdAt=original.createdAt;record.createdBy=original.createdBy;record.createdByUserId=original.createdByUserId??original.createdBy;if(original.telegram)record.telegram=original.telegram;if(original.radarSource)record.radarSource=original.radarSource;db.records[index]=record;}
      else applyUpdate(record,actor,payload,context.createdVia);
      record.recordVersion=version+1;rememberOperation(record,actor,context,'update',requestFingerprint);
      return {value:{record:clone(record)}};
    });
  }
  async function remove(user,id){requireAdmin(user);idValue(id);return transaction(db=>{const index=db.records.findIndex(record=>record.id===id);if(index<0)fail('Идея не найдена.',404);if(db.records[index].published)fail('Опубликованную идею нельзя удалить. Отметьте ошибочную публикацию с причиной.',409);db.records.splice(index,1);return {value:{ok:true}}})}
  async function importDemo(user){
    requireAdmin(user);const seeds=JSON.parse(await readFile(new URL('../fixtures/demo-ideas.json',import.meta.url),'utf8'));
    return transaction(db=>{const at=new Date().toISOString(),added=seeds.filter(source=>!db.records.some(record=>record.id===source.id)).map(source=>demoRecord(source,user,at));db.records.push(...added);return {unchanged:!added.length,value:{imported:added.length}}});
  }
  // Public landing example: only coarse, non-executable facts leave the server.
  async function showcase(){await queue;const db=await load();const record=db.records.find(r=>r.showcase===true&&r.published&&r.archived!==true&&!r.erroneous&&tierOf(r.d.strategy)==='pro'&&['announced','waiting','active'].includes(r.d.state));
    if(!record)return null;const d=record.d;return {id:record.id,ticker:d.ticker,name:d.name,market:d.market,dir:d.dir,strategy:'PRO',state:d.state,status:d.status,publishedAt:record.meta.publishedAt,enteredAt:record.meta.enteredAt??null,updatedAt:record.meta.updatedAt,horizon:d.horizon,_entry:d.state==='active'?d.entry:null};}
  // Public, aggregate-only track record: no ids, tickers or levels. Demo and
  // erroneous publications are excluded; only closed ideas with an exit count.
  async function stats(){await queue;const db=await load(),out={};
    for(const tier of ['pro','exclusive']){const rows=db.records.filter(r=>r.published&&!r.erroneous&&!r.demo&&!r.isDemo&&!String(r.id).startsWith('demo-')&&tierOf(r.d.strategy)===tier&&r.d.state==='closed'&&Number.isFinite(r.meta?.exit)&&Number.isFinite(r.d.entry)&&r.d.entry>0);
      const sign=r=>r.d.dir==='ШОРТ'?-1:1,pcts=rows.map(r=>r.meta.finalResultPct??closeReturn(r.d,r.meta.exit));
      const rs=rows.map(r=>{if(r.meta.closures)return ledgerResultR(r,r.meta.weightedExit);const stop=r.meta?.initial?.stop??r.meta?.initialLevels?.stop??r.d.stop,risk=Math.abs(r.d.entry-stop);return Number.isFinite(risk)&&risk>0?(r.meta.exit-r.d.entry)*sign(r)/risk:null;}).filter(Number.isFinite);
      out[tier]={closed:rows.length,winRate:rows.length?pcts.filter(v=>v>0).length/rows.length*100:0,avgPct:rows.length?pcts.reduce((a,b)=>a+b,0)/rows.length:0,avgR:rs.length?rs.reduce((a,b)=>a+b,0)/rs.length:null};}
    return out;}
  // Tickers of open published ideas by market — no levels, used to limit quote requests.
  async function activeTickers(market){await queue;const db=await load();return [...new Set(db.records.filter(r=>r.published&&!r.archived&&!r.erroneous&&r.d.market===market&&['announced','waiting','active'].includes(r.d.state)).map(r=>String(r.d.ticker||'').toUpperCase()).filter(Boolean))];}
  // Public, verifiable track record: EVERY finished real idea (closed, cancelled
  // and erroneous ones too) with the levels as first published and the final
  // ones. Open ideas are only counted — their levels stay paid.
  async function results({localMarketHistory=false}={}){await queue;const real=localMarketHistory?localRecords:(await load()).records.filter(publishedResultRecord);
    const finished=real.filter(r=>['closed','cancelled'].includes(r.d.state)||r.erroneous).map(record=>projectResult(record,{localMarketHistory}));
    finished.sort((a,b)=>String(b.closedAt||'').localeCompare(String(a.closedAt||'')));
    return {open:real.filter(r=>!r.erroneous&&['announced','waiting','active'].includes(r.d.state)).length,results:finished,generatedAt:new Date().toISOString(),
      ...(localMarketHistory&&localFixture?{requestedFrom:localFixture.requestedFrom,fromDate:localFixture.fromDate,throughDate:localFixture.throughDate,asOfDate:localFixture.asOfDate,latestQuotes:localFixture.latestQuotes||[]}:{})};}
  async function shareResult(user,id){
    requireAdmin(user);idValue(id);await queue;
    const record=(await load()).records.find(item=>item.id===id);
    if(!record||!publishedResultRecord(record)||record.localMarketHistory===true||record.erroneous||record.d.state!=='closed')
      fail('Карточка доступна для завершённой опубликованной идеи.',404);
    const result=projectResult(record);
    const exitAveraged=(result.closures?.length??0)>1;
    const entry=result.closures||!Number.isFinite(result.initial.entry)?result.final.entry:result.initial.entry;
    const exit=exitAveraged?result.weightedExit:result.exit;
    const closedAt=Date.parse(result.closedAt);
    if(!result.ticker||![entry,exit,result.pct,closedAt].every(Number.isFinite)||entry<=0||exit<=0)
      fail('Для карточки нужны цена входа, цена и дата закрытия и расчётный результат.',404);
    return {ticker:result.ticker,dir:result.dir,tier:result.tier,entry,exit,exitAveraged,
      unit:typeof result.unit==='string'?result.unit:'',pct:result.pct,closedAt:new Date(closedAt).toISOString()};
  }
  // Change listeners (e.g. instant notifications). Errors never affect the write.
  const listeners=new Set(),changed=()=>{for(const fn of listeners)setImmediate(()=>{try{fn();}catch{}});};
  const created=async(...args)=>{const result=await create(...args);changed();return result;},updated=async(...args)=>{const result=await update(...args);changed();return result;};
  return {list,get,create:created,update:updated,remove,importDemo,showcase,stats,activeTickers,results,shareResult,subscribe:fn=>{listeners.add(fn);return ()=>listeners.delete(fn);}};
}
