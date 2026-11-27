import {randomBytes} from 'node:crypto';
import {parseSignal,parsePrice,parseExitPercent,parseExitTime,parseEntryRange,parseExtraTargets,validateSignal,signalMetrics} from './parser.mjs';
import {findInstruments} from '../instruments.mjs';

const markets={'Momentum RU':'stocks','Trend RU':'stocks','Orbita Exclusive':'stocks','Импульс':'futures','Crypto Momentum':'crypto','Crypto Trend':'crypto'};
const prices=['entry','stop','take'],labels={entry:'Вход',stop:'Стоп',take:'Тейк',ticker:'Инструмент',direction:'Направление'};
const nonce=()=>randomBytes(9).toString('base64url');
const validId=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(value);
const number=value=>Number.isFinite(value)?value.toLocaleString('ru-RU',{maximumFractionDigits:8}):'—';
const percent=value=>Math.abs(value).toFixed(2);
const fail=(message,status=400)=>{throw Object.assign(Error(message),{status});};
const key=(session,action)=>'ta:'+session.nonce+':'+action;
const button=(session,text,action)=>({text,callback_data:key(session,action)});
const keyboard=rows=>({inline_keyboard:rows});
const direction=record=>record.d.dir==='ШОРТ'?'SHORT':'LONG';
const version=record=>record.recordVersion??0;
const isDemo=record=>record.demo===true||record.isDemo===true||/^(?:demo-|exclusive-)/.test(record.id);
const remaining=record=>record.meta?.remainingPct??(record.d.state==='closed'?0:100);
const detailedExit=action=>action==='early-close'||action==='partial-close';
const signedPercent=value=>`${value<0?'−':'+'}${percent(value)}%`;
const moscowTime=new Intl.DateTimeFormat('ru-RU',{timeZone:'Europe/Moscow',dateStyle:'short',timeStyle:'short'});
const marketLabels={stocks:'Акции',futures:'Фьючерсы',crypto:'Крипто'};
const detailFields=['targets','horizon','thesis','chartUrl'];
const detailPrompts={targets:'Дополнительные цели. Отправьте до четырёх цен через пробел.',horizon:'Горизонт идеи. Например: 1–5 дней.',thesis:'Комментарий к идее, до 1 500 символов.',chartUrl:'Ссылка на график или первоисточник. Укажите полный HTTPS-адрес.'};
const publishedFields={title:'Заголовок',summary:'Краткое описание',thesis:'Комментарий',horizon:'Горизонт'};
const publishedFieldLimits={title:100,summary:350,thesis:1500,horizon:50};

// The transport and account store are supplied by the existing backend. This
// module has no database, credentials, polling loop or direct Telegram client.
export function createTelegramAdminEngine({store,ideas,send,publicOrigin,now=Date.now,draftTtlMs=1800000,quoteProvider=null,radarWorkflow=null,contentWorkflow=null}={}){
 if(!store||!ideas||typeof send!=='function'||typeof now!=='function'||!Number.isSafeInteger(draftTtlMs)||draftTtlMs<60000||draftTtlMs>86400000)throw Error('Invalid Telegram admin engine dependencies');
 const origin=new URL(publicOrigin);if(origin.protocol!=='https:'||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash)throw Error('Telegram admin links require a HTTPS origin');
 let queue=Promise.resolve(),pending=0;
 const adminUrl=id=>origin.origin+'/admin.html'+(id?'?idea='+encodeURIComponent(id):'');
 const fresh=(type,extra={})=>({type,nonce:nonce(),createdAt:now(),expiresAt:now()+draftTtlMs,...extra});
 async function authorize(identity){const user=await store.authorize(identity);if(!user||user.id!==identity.id||user.role!=='admin')fail('Доступ администратора отозван. Подключите Telegram заново в настройках сайта.',403);return user;}
 async function authorizePublication(identity){
  const actor=await authorize(identity);
  await store.authorizePublication?.(identity);
  return actor;
 }
 function frame(session){return {outputs:[],sessionBeforeNonce:session?.nonce??null};}
 function output(f,identity,session,text,rows=[],messageId=null){
  const payload={chat_id:identity.chatId,text:String(text).slice(0,3950),reply_markup:keyboard(rows),link_preview_options:{is_disabled:true}};
  if(Number.isSafeInteger(messageId)&&messageId>0)payload.message_id=messageId;
  f.outputs.push({method:payload.message_id?'editMessageText':'sendMessage',payload,sessionNonce:session?.nonce??null});
 }
 async function deliver(identity,receipt){
  for(const item of receipt.outputs){await authorize(identity);const result=await send(item.method,item.payload);const messageId=result?.message_id??result?.result?.message_id;
   if(item.sessionNonce&&Number.isSafeInteger(messageId)&&messageId>0){const session=await store.session(identity);if(session?.nonce===item.sessionNonce&&!session.messageId)await store.saveSession(identity,{...session,messageId});}
  }
 }
 async function applySession(identity,receipt){
  if(!Object.hasOwn(receipt,'nextSession')||receipt.nextSession&&receipt.nextSession.expiresAt<=now())return;const current=await store.session(identity);
  // A retry of an old acknowledgement must not overwrite a later draft.
  if((current?.nonce??null)===receipt.sessionBeforeNonce)await store.saveSession(identity,receipt.nextSession);
 }
 function menu(f,identity,text='ORBITA · Редакция\n\nЧто делаем?',messageId=null){
  const session=fresh('menu');f.nextSession=session;
  const rows=[[button(session,'➕ Новый сигнал','new')],[button(session,'📊 Активные сигналы','active'),button(session,'🕘 Последние','recent')],[button(session,'Черновики','drafts')]];
  if(radarWorkflow)rows.push([{text:'Radar',url:origin.origin+'/radar-admin.html'}]);
  if(contentWorkflow)rows.push([button(session,'Новости','news'),button(session,'Статьи','articles')],[button(session,'Рассылки','broadcast'),button(session,'Статистика','stats')]);
  rows.push([button(session,'⚙️ Настройки','settings')]);
  output(f,identity,session,text,rows,messageId);
 }
 const help='Отправьте: ТИКЕР ВХОД СТОП ТЕЙК\nНапример: SBER 312.5 307 325\n\nНаправление определяется автоматически. Можно указать LONG или SHORT после тикера. Тариф: добавьте EX (EXCLUSIVE) или PRO, например SBER EX 312.5 307 325; без пометки — стратегия по умолчанию из настроек. Тариф можно переключить кнопкой в предпросмотре. Поддерживаются точка и запятая. Команды /s и /signal работают так же.\n\n/cancel — отменить текущий ввод. Публикация после предпросмотра; вход подтверждается отдельно.';
 const contentSections=['news','articles','broadcast','stats'];
 async function contentStep(f,identity,session,input,messageId){
  if(!contentWorkflow||!contentSections.includes(input.action)&&!contentSections.includes(input.command)&&session?.type!=='editor-content')return false;
  if(session?.radarDraftToken)fail('Сначала завершите текущий сценарий Radar или отправьте /cancel.');
  const operationId=session?.type==='editor-content'?'editor:'+identity.bindingId+':'+session.nonce:f.operationId;
  const result=await contentWorkflow.handle({user:await authorize(identity),session,operationId,authorize:()=>authorize(identity),authorizePublication:()=>authorizePublication(identity),...input});
  if(!result)fail('Выберите действие в текущем меню или введите /cancel.');
  if(result.backToMenu){menu(f,identity,result.text,messageId);return true;}
  const next={...result.session,...fresh('editor-content',{messageId})};f.nextSession=next;
  const rows=(result.rows||[]).map(row=>row.map(item=>{
   if(typeof item.action==='string'&&/^[A-Za-z0-9]{1,32}$/.test(item.action))return button(next,item.text,item.action);
   const url=new URL(item.url);
   if(url.protocol!=='https:'||url.username||url.password)fail('Ссылка должна использовать HTTPS.');
   return {text:item.text,url:url.href};
  }));
  output(f,identity,next,result.text,rows,messageId);return true;
 }
 function setupPrompt(f,identity,step,state={},messageId=null){
  const next=fresh('setup',{...state,step,messageId,nonce:nonce()});f.nextSession=next;
  const cancel=[button(next,'Отмена','cancel')];
  if(step==='tier')output(f,identity,next,'Новый сигнал · выберите тариф.\n\nДля быстрого ввода можно сразу отправить ТИКЕР ВХОД СТОП ТЕЙК.',[[button(next,'PRO','setuppro'),button(next,'EXCLUSIVE','setupexclusive')],cancel],messageId);
  else if(step==='market')output(f,identity,next,'Выберите рынок.',[[button(next,'Акции','setupstocks'),button(next,'Фьючерсы','setupfutures'),button(next,'Крипто','setupcrypto')],[button(next,'Назад','setuptier'),...cancel]],messageId);
  else output(f,identity,next,`${marketLabels[next.market]} · отправьте тикер инструмента.`,[[button(next,'Назад','setupmarket'),...cancel]],messageId);
 }
 async function listRecords(identity){await authorize(identity);const result=await ideas.list(identity);if(!Array.isArray(result?.records))throw Error('Invalid shared ideas service response');return result.records;}
 async function list(f,identity,mode,messageId){
  const items=await listRecords(identity);
  const records=items.filter(r=>mode==='drafts'?!r.published:r.published&&(mode!=='active'||!r.erroneous&&['announced','waiting','active'].includes(r.d.state))).slice(0,10);
  const session=fresh('list',{records:records.map(r=>({id:r.id,recordVersion:version(r)}))});f.nextSession=session;
  const title={active:'Активные и ожидающие сигналы',recent:'Последние сигналы',drafts:'Черновики'}[mode];
  const text=title+'\n\n'+(records.map((r,i)=>`${i+1}. ${r.d.ticker} • ${direction(r)}\n${number(r.d.entry)} → ${number(r.d.target)} · Stop ${number(r.d.stop)}\n${status(r)}`).join('\n\n')||'Пока пусто.');
  output(f,identity,session,text,[...records.map((r,i)=>[button(session,r.d.ticker+' • '+direction(r),'open'+i)]),[button(session,'➕ Новый сигнал','new'),button(session,'Назад','menu')]],messageId);
 }
 function status(record){return ({draft:'DRAFT',announced:'ANNOUNCED · уровни ещё не добавлены',waiting:'WAITING · ожидает подтверждения входа',active:'ACTIVE',closed:'CLOSED',cancelled:'CANCELLED'})[record.d.state]||'Статус требует проверки';}
 function recordText(record){
  const d=record.d,m=record.meta||{},unit=d.unit||'',targets=[d.target,...(d.targets||[])].map(number).join(' · ');
  const lines=[`${d.ticker} • ${direction(record)}`,`Вход: ${number(d.entry)} ${unit}`,`Стоп: ${number(d.stop)} ${unit}`,`Цели: ${targets} ${unit}`,status(record),d.strategy+' · '+(d.strategy==='Orbita Exclusive'?'EXCLUSIVE':'PRO')];
  if(record.erroneous)lines.push('ОШИБОЧНАЯ ПУБЛИКАЦИЯ');
  if(m.closures?.length){
   lines.push(`Закрыто: ${number(100-remaining(record))}% · Осталось: ${number(remaining(record))}%`);
   if(Number.isFinite(m.realizedPct))lines.push(`Расчётный результат закрытой части в доле исходного объёма: ${signedPercent(m.realizedPct)}`);
   if(d.state==='closed'&&Number.isFinite(m.finalResultPct))lines.push(`Итог идеи: ${signedPercent(m.finalResultPct)} · Средневзвешенный выход: ${number(m.weightedExit)} ${unit}`);
  }else if(d.state==='closed'&&Number.isFinite(m.exit)&&Number.isFinite(d.entry)){
   const pnl=(m.exit-d.entry)/d.entry*100*(d.dir==='ШОРТ'?-1:1);
   lines.push(`Выход: ${number(m.exit)} ${unit}`,`Расчётный результат идеи: ${signedPercent(pnl)}`);
  }
  return lines.join('\n');
 }
 function recordCard(f,identity,record,{prefix='',messageId=null}={}){const session=fresh('record',{recordId:record.id,recordVersion:version(record)}),rows=[];f.nextSession=session;
  if(!record.erroneous){
   if(!record.published)rows.push([button(session,'Продолжить черновик','resumedraft')]);
   if(record.d.state==='waiting')rows.push([button(session,'Подтвердить вход','activate')]);
   if(record.published)rows.push([button(session,'Редактировать','description')]);
   if(['waiting','active'].includes(record.d.state))rows.push([button(session,'Изменить стоп','stop'),button(session,'Изменить тейк','take')]);
   if(record.d.state==='active'){
    rows.push([button(session,'Закрыть досрочно','early'),button(session,'Частично закрыть','partial')]);
    rows.push([button(session,'Закрыть по TP','closetarget'),button(session,'Закрыть по SL','closestop')]);
    rows.push([button(session,'Закрыть сигнал по цене','close')]);
   }
   if(['announced','waiting'].includes(record.d.state))rows.push([button(session,'Отменить до входа','cancelidea')]);
  }
  rows.push([button(session,'История','history'),{text:'Открыть в админке',url:adminUrl(record.id)}],[button(session,'📊 Активные сигналы','active'),button(session,'Назад','menu')]);output(f,identity,session,(prefix?prefix+'\n\n':'')+recordText(record),rows,messageId);
 }
 function recordHistory(f,identity,record,page,messageId){
  const events=record.meta?.events||[],pageSize=6,last=Math.max(0,Math.ceil(events.length/pageSize)-1),index=Math.min(Math.max(0,page),last);
  const session=fresh('history',{recordId:record.id,recordVersion:version(record),page:index});f.nextSession=session;
  const changes=events.slice().reverse().slice(index*pageSize,(index+1)*pageSize).map(([date,title,body,details])=>{
   const exit=details?.closure;
   if(!exit)return `${date} · ${title}\n${body.slice(0,320)}`;
   const when=moscowTime.format(new Date(exit.occurredAt));
   const priceOrigin={admin:'Цена введена автором', 'configured-level':'Уровень из условий идеи', 'market-reference':'Цена по рыночным данным'}[exit.priceOrigin];
   return `${date} · ${title}\n${number(exit.percent)}% по ${number(exit.price)} ${record.d.unit} · ${when} МСК\n${priceOrigin||''}\n${exit.reason||''}\nВклад в итог идеи: ${signedPercent(exit.contributionPct)}`;
  });
  const pager=[];if(index>0)pager.push(button(session,'Новее','historynewer'));if(index<last)pager.push(button(session,'Старее','historyolder'));
  const rows=pager.length?[pager]:[];rows.push([button(session,'Назад','back')]);
  output(f,identity,session,`${record.d.ticker} · История ${index+1}/${last+1}\n\n${changes.join('\n\n')||'Изменений пока нет.'}`,rows,messageId);
 }
 async function settings(f,identity,messageId){const prefs=await store.settings(identity),session=fresh('menu');f.nextSession=session;output(f,identity,session,`Настройки\n\nСтратегия по умолчанию: ${prefs.strategy}. Для другого рынка используется стратегия инструмента. Каждый сигнал публикуется после подтверждения.`,[[{text:'Настройки Telegram',url:origin.origin+'/telegram-admin.html'}],[button(session,'➕ Новый сигнал','new'),button(session,'Назад','menu')]],messageId);}
 async function duplicates(identity,instrument){return (await listRecords(identity)).filter(r=>r.published&&!r.erroneous&&!isDemo(r)&&['announced','waiting','active'].includes(r.d.state)&&r.d.market===instrument.market&&r.d.ticker.toUpperCase()===instrument.ticker.toUpperCase());}
 const fingerprint=records=>records.map(r=>r.id+':'+version(r)).sort().join('|');
 async function quoteWarning(instrument,signal){if(typeof quoteProvider!=='function')return '';let timer;try{const result=await Promise.race([Promise.resolve().then(()=>quoteProvider(instrument)),new Promise(resolve=>{timer=setTimeout(()=>resolve(null),1000);})]);const age=now()-Date.parse(result?.asOf);if(!Number.isFinite(result?.price)||result.price<=0||result.isDemo===true||!Number.isFinite(age)||age<0||age>900000)return '';const delta=Math.abs(signal.entry-result.price)/result.price*100;return delta>=20?`\n⚠️ Вход отличается от котировки ${number(result.price)} ${instrument.unit} примерно на ${delta.toFixed(1)}%. Проверьте цену.`:'';}catch{return '';}finally{clearTimeout(timer);}}
 function editRows(session){return [
  [button(session,'Инструмент','fieldticker'),button(session,'Направление','fielddirection')],
  [button(session,'Вход','fieldentry'),button(session,'Стоп','fieldstop'),button(session,'Тейк','fieldtake')],
  [button(session,'Другие цели','detailtargets'),button(session,'Горизонт','detailhorizon')],
  [button(session,'Комментарий','detailthesis'),button(session,'Источник','detailchartUrl')],
  [button(session,'❌ Отмена','cancel')]
 ];}
 // EXCLUSIVE is a cross-market premium feed; PRO strategies keep their market.
 const allowedFor=(strategy,market)=>strategy==='Orbita Exclusive'||markets[strategy]===market;
 function strategyFor(tier,prefs,instrument){
  if(tier==='exclusive')return 'Orbita Exclusive';
  const pro=allowedFor(prefs.strategy,instrument.market)&&prefs.strategy!=='Orbita Exclusive'?prefs.strategy:instrument.strategy;
  if(tier==='pro')return pro==='Orbita Exclusive'?instrument.strategy:pro;
  // Without an explicit tier the saved default keeps its original market.
  return markets[prefs.strategy]===instrument.market?prefs.strategy:instrument.strategy;
 }
 const accessLine=strategy=>strategy==='Orbita Exclusive'?'Доступ: EXCLUSIVE — видят только подписчики EXCLUSIVE':'Доступ: PRO — видят подписчики PRO и EXCLUSIVE';
 function verifyExtraLevels(draft,signal){
  if(signal.missing.length)return;
  const range=draft.entryRange;
  if(range&&(signal.direction==='LONG'?!(signal.stop<range.min&&range.max<signal.take):!(signal.take<range.min&&range.max<signal.stop)))fail('Стоп и первая цель должны находиться за границами диапазона входа.');
  if(draft.fields?.targets?.length)parseExtraTargets(draft.fields.targets.join(' '),signal.direction,signal.take);
 }
 function detailsPrompt(f,identity,session,field){
  session.step=field;f.nextSession=session;
  const rows=session.detailsDone?[]:[[button(session,'Пропустить','skipdetail'),button(session,'К предпросмотру','finishdetails')]];
  rows.push([button(session,'❌ Отмена','cancel')]);
  output(f,identity,session,detailPrompts[field],rows,session.messageId);
 }
 function entryModePrompt(f,identity,session){
  session.step='entryKind';f.nextSession=session;
  output(f,identity,session,'Как задать вход? Расчёт по диапазону будет использовать его середину.',[[button(session,'Одна цена','entryprice'),button(session,'Диапазон','entryrange')],[button(session,'❌ Отмена','cancel')]],session.messageId);
 }
 async function nextDetail(f,identity,session,fields,messageId){
  if(!session.wizard||session.detailsDone){await renderDraft(f,identity,{...session,fields},{messageId});return;}
  const detailIndex=detailFields.indexOf(session.step)+1;
  await renderDraft(f,identity,{...session,fields,detailIndex},{messageId});
 }
 function sourceUrl(value){
  const input=shortText(value,'Источник',900);
  let url;
  try{url=new URL(input);}catch{fail('Укажите полный HTTPS-адрес.');}
  if(url.protocol!=='https:'||url.username||url.password)fail('Укажите полный HTTPS-адрес без учётных данных.');
  return url.href;
 }
 async function renderDraft(f,identity,draft,{messageId=null}={}){
  let signal,problem='';try{signal=validateSignal(draft.signal);verifyExtraLevels(draft,signal);}catch(cause){if(cause.status!==400)throw cause;signal={...draft.signal,missing:prices.filter(field=>draft.signal[field]===null||draft.signal[field]===undefined)};problem=cause.message;}
  const session=fresh('draft',{...draft,type:'draft',signal,messageId:messageId??draft.messageId??null,nonce:nonce()});f.nextSession=session;
  if(problem){session.step=null;output(f,identity,session,problem+'\n\nИзмените необходимые поля. Публикация пока недоступна.',editRows(session),session.messageId);return;}
  if(!session.instrument){const records=await listRecords(identity),candidates=findInstruments(signal.ticker,{records}).filter(item=>!session.market||item.market===session.market);const exact=candidates.filter(item=>item.ticker===signal.ticker||item.market==='crypto'&&item.ticker.replace('/','')===signal.ticker.replace('/',''));
   if(exact.length===1){session.instrument=exact[0];session.signal.ticker=exact[0].ticker;}else{session.candidates=candidates.slice(0,8);session.step='ticker';const rows=session.candidates.map((item,index)=>[button(session,item.ticker+' — '+item.name+' · '+item.market,'instrument'+index)]);rows.push([button(session,'❌ Отмена','cancel')]);output(f,identity,session,candidates.length?'Выберите инструмент:':`Не нашёл инструмент ${signal.ticker}.\nПроверьте тикер и отправьте его заново.`,rows,session.messageId);return;}
  }
  if(session.wizard&&!signal.direction){session.step='direction';output(f,identity,session,`${session.instrument.ticker} · выберите направление.`,[[button(session,'LONG','directionlong'),button(session,'SHORT','directionshort')],[button(session,'❌ Отмена','cancel')]],session.messageId);return;}
  if(session.wizard&&!session.entryKind&&signal.missing.includes('entry')){entryModePrompt(f,identity,session);return;}
  if(signal.missing.length){session.step=signal.missing[0];const range=session.step==='entry'&&session.entryKind==='range';output(f,identity,session,`Не хватает ${labels[session.step]}${session.step==='take'?' (Take Profit)':''}.\n\n${range?'Отправьте нижнюю и верхнюю цену через пробел. Например: 312,5 314.':'Можно отправить только значение.'}\n${session.instrument.ticker} · ${session.instrument.name}`,[[button(session,'✏️ Изменить','edit')],[button(session,'❌ Отмена','cancel')]],session.messageId);return;}
  if(session.wizard&&!session.detailsDone){const field=detailFields[session.detailIndex??0];if(field){detailsPrompt(f,identity,session,field);return;}session.detailsDone=true;}
  session.step=null;const prefs=await store.settings(identity);session.tier=draft.tier??signal.tier??null;session.strategy=allowedFor(session.savedStrategy,session.instrument.market)?session.savedStrategy:strategyFor(session.tier,prefs,session.instrument);
  const active=await duplicates(identity,session.instrument);session.duplicateFingerprint=fingerprint(active);
  const metrics=signalMetrics(signal);let text=`Новый сигнал\n\n${signal.ticker} • ${signal.direction}\n${session.strategy}\n${accessLine(session.strategy)}\n\nВход: ${number(signal.entry)} ${session.instrument.unit}\nСтоп: ${number(signal.stop)} ${session.instrument.unit}\nRisk: −${percent(metrics.riskPercent)}%\nТейк: ${number(signal.take)} ${session.instrument.unit}\nPotential: +${percent(metrics.potentialPercent)}%\nRisk / Reward: 1 : ${metrics.riskReward.toFixed(2)}\n\nПосле публикации: WAITING. Вход подтверждается отдельно.`;
  const fields=session.fields||{},range=session.entryRange;
  if(range)text+=`\nДиапазон ${number(range.min)}–${number(range.max)} ${session.instrument.unit}. В расчёте используется середина диапазона.`;
  if(fields.targets?.length)text+='\nДополнительные цели: '+fields.targets.map(number).join(' · ');
  if(fields.horizon)text+='\nГоризонт: '+fields.horizon;
  if(fields.thesis)text+='\nКомментарий: '+fields.thesis;
  if(fields.chartUrl)text+='\nИсточник: '+fields.chartUrl;
  if(session.radarDraftToken)text+='\n\nИсточник: Radar · '+session.radarHeadline+'\nСобытие не определяет направление. Проверьте уровни и подтвердите публикацию.';
  text+=await quoteWarning(session.instrument,signal);
  const rows=[];if(active.length){text+='\n\n⚠️ По этому инструменту уже есть сигнал:\n'+recordText(active[0])+'\n\nВсё равно создать ещё один?';rows.push([button(session,'Создать ещё один','publishduplicate')],[{text:'Открыть текущий',url:adminUrl(active[0].id)}]);}else rows.push([button(session,'✅ Опубликовать','publish')]);rows.push([session.strategy==='Orbita Exclusive'?button(session,'Сделать PRO','tierpro'):button(session,'Сделать EXCLUSIVE','tierexclusive')]);
  if(!session.radarDraftToken)rows.push([button(session,'Сохранить черновик','savedraft')]);
  rows.push([button(session,'✏️ Изменить','edit'),button(session,'❌ Отмена','cancel')]);output(f,identity,session,text,rows,session.messageId);
 }
 function mutationContext(identity,operationId,messageId,expectedRecordVersion){return {createdVia:'TELEGRAM',operationId,telegramChatId:identity.chatId,telegramMessageId:messageId,authorize:()=>authorizePublication(identity),...(expectedRecordVersion===undefined?{}:{expectedRecordVersion})};}
 function draftData(known,signal,strategy,session){
  const entryRange=session.entryRange;
  const entryRule=entryRange?`Плановый диапазон входа ${number(entryRange.min)}–${number(entryRange.max)} ${known.unit}. Расчётная цена — середина диапазона. Подтверждение входа автором — отдельным событием.`:`Плановый вход: ${number(signal.entry)} ${known.unit}. Подтверждение входа автором — отдельным событием.`;
  const prior=session.originalData;
  const sameTicker=prior?.ticker===signal.ticker;
  const data={ticker:known.ticker,market:known.market,strategy,dir:signal.direction==='SHORT'?'ШОРТ':'ЛОНГ',entry:signal.entry,stop:signal.stop,target:signal.take,
   entryRule:sameTicker&&prior.entry===signal.entry&&prior.entryRule?prior.entryRule:entryRule,
   cancelRule:sameTicker&&prior.stop===signal.stop&&prior.target===signal.take&&prior.cancelRule?prior.cancelRule:`Выход по стопу ${number(signal.stop)} ${known.unit} или цели ${number(signal.take)} ${known.unit}; изменения публикуются отдельными событиями.`,
   name:sameTicker&&prior.name?prior.name:known.name,...session.fields};
  if(sameTicker&&prior.title)data.title=prior.title;
  return data;
 }
 async function saveDraft(f,identity,session){
  const signal=validateSignal(session.signal);
  if(!session.instrument||!session.strategy||signal.missing.length||session.radarDraftToken)fail('Сначала откройте предпросмотр сигнала.');
  verifyExtraLevels(session,signal);
  const data={mode:'draft',d:draftData(session.instrument,signal,session.strategy,session)};
  const context={...mutationContext(identity,f.operationId+':draft',f.incomingMessageId,session.recordVersion),authorize:()=>authorize(identity)};
  const actor=await authorize(identity);
  const result=session.recordId?await ideas.update(actor,session.recordId,data,context):await ideas.create(actor,data,context);
  await store.audit(identity,'signal-draft-saved',result.record.id);
  recordCard(f,identity,result.record,{prefix:'Черновик сохранён.',messageId:session.messageId});
 }
 async function resumeDraft(f,identity,record,messageId){
  const {d}=record;
  const fields=Object.fromEntries(['summary',...detailFields].filter(field=>d[field]!=null).map(field=>[field,d[field]]));
  const signal={ticker:d.ticker,direction:direction(record),entry:d.entry,stop:d.stop,take:d.target};
  const range=d.entryRule.match(/^Плановый диапазон входа ([\d\s.,]+)–([\d\s.,]+) /);
  let entryRange=null;
  if(range){try{entryRange=parseEntryRange(range.slice(1).map(value=>value.replace(/\s/g,'')).join(' '));}catch(cause){if(!cause.status)throw cause;}}
  if(!signal.ticker){setupPrompt(f,identity,'ticker',{recordId:record.id,recordVersion:version(record),savedStrategy:d.strategy,tier:d.strategy==='Orbita Exclusive'?'exclusive':'pro',market:d.market,fields},messageId);return;}
  const originalData=Object.fromEntries(['ticker','name','title','entry','stop','target','entryRule','cancelRule'].map(field=>[field,d[field]]));
  await renderDraft(f,identity,fresh('draft',{recordId:record.id,recordVersion:version(record),signal,fields,entryRange,originalData,entryKind:entryRange?'range':'price',market:d.market,savedStrategy:d.strategy}),{messageId});
 }
 async function publish(f,identity,session,confirmedDuplicate){const signal=validateSignal(session.signal);if(signal.missing.length||!session.instrument)fail('Сначала заполните инструмент и все уровни.');
  verifyExtraLevels(session,signal);
  const known=findInstruments(session.instrument.ticker,{records:await listRecords(identity)}).find(item=>item.id===session.instrument.id);if(!known||known.ticker!==signal.ticker)fail('Инструмент изменился. Отправьте сигнал заново.');
  const active=await duplicates(identity,known);if(active.length&&(!confirmedDuplicate||session.duplicateFingerprint!==fingerprint(active))){await renderDraft(f,identity,session,{messageId:session.messageId});return;}
  const prefs=await store.settings(identity),strategy=allowedFor(session.strategy,known.market)?session.strategy:strategyFor(session.tier,prefs,known);
  const d=draftData(known,signal,strategy,session),data={mode:'full',d};
  const context={...mutationContext(identity,f.operationId+':publish',f.incomingMessageId,session.recordVersion),expectedDuplicateFingerprint:fingerprint(active)};
  const actor=await authorize(identity);
  let result;
  if(session.radarDraftToken)result=await radarWorkflow.publish(actor,data,{draftToken:session.radarDraftToken,context});
  else if(session.recordId)result=await ideas.update(actor,session.recordId,data,context);
  else result=await ideas.create(actor,data,context);
  await store.audit(identity,'signal-created',result.record.id,{ticker:d.ticker});
  recordCard(f,identity,result.record,{prefix:'✅ Сигнал опубликован. Вход ещё не подтверждён.',messageId:session.messageId});
 }
 async function latestRecord(f,identity,session,messageId){const record=await ideas.get(session.recordId,await authorize(identity));if(version(record)!==session.recordVersion){recordCard(f,identity,record,{prefix:'Данные изменились в другой сессии. Проверьте актуальные условия и повторите действие.',messageId});return null;}return record;}
 function confirmation(f,identity,record,action,{price=null,messageId=null,closure=null,note=null}={}){const session=fresh('confirmation',{recordId:record.id,recordVersion:version(record),action,price,closure,note,messageId}),d=record.d;f.nextSession=session;let text;
  if(detailedExit(action)){
   const share=closure.percent??remaining(record),move=returnAt(record,closure.price),left=remaining(record)-share;
   text=`${d.ticker} · ${action==='partial-close'?'Частичный выход':'Досрочный выход'}\n\nЗакрыть: ${number(share)}% исходного объёма. Остаток: ${number(left)}%.\nЦена: ${number(closure.price)} ${d.unit} (введена автором)\nДата выхода: ${moscowTime.format(new Date(closure.occurredAt))} МСК\nПричина: ${closure.reason}\n${closure.note?`Комментарий: ${closure.note}\n`:''}\nРасчётное изменение цены: ${signedPercent(move)}\nВклад этого выхода в итог идеи: ${signedPercent(move*share/100)}`;
  }else if(action==='manual')text=`${d.ticker}\nВход: ${number(d.entry)} ${d.unit}\nВыход: ${number(price)} ${d.unit}\nРезультат автора: ${signedPercent(returnAt(record,price))}\n\nЗакрыть сигнал?`;
  else if(action==='target'||action==='stop')text=`${d.ticker}\n${action==='target'?'Тейк':'Стоп'}: ${number(price)} ${d.unit}\nЗакрывается оставшийся объём: ${number(remaining(record))}%.\n\nПодтвердить закрытие?`;
  else if(action==='activate')text=recordText(record)+'\n\nПодтвердить вход автора? Это запись автора, а не исполнение сделки брокером.';
  else if(action==='cancel')text=recordText(record)+'\n\nОтменить сигнал до входа?';
  else text=`${d.ticker}\n${action==='stop-change'?'Стоп':'Тейк'}: ${number(action==='stop-change'?d.stop:d.target)} → ${number(price)} ${d.unit}\nПричина: ${note}\n\nПодтвердить изменение?`;
  output(f,identity,session,text,[[button(session,action==='manual'?'✅ Закрыть':'✅ Подтвердить','confirm')],[button(session,'❌ Отмена','back')]],messageId);
 }
 function returnAt(record,price){return (price-record.d.entry)/record.d.entry*100*(record.d.dir==='ШОРТ'?-1:1);}
 const exitPrompts={price:'Укажите цену выхода числом.',percent:'Укажите долю исходной позиции в процентах. Например: 25%',occurredAt:'Отправьте дату и время выхода в формате ДД.ММ.ГГГГ ЧЧ:ММ (МСК) или выберите «Сейчас».',reason:'Укажите причину выхода, до 300 символов.',note:'Добавьте комментарий, до 300 символов, или пропустите этот шаг.'};
 function exitPrompt(f,identity,record,action,messageId,step='price',closure={}){
  const next=fresh('exit',{recordId:record.id,recordVersion:version(record),action,step,closure,messageId});f.nextSession=next;
  const rows=[];
  if(step==='occurredAt')rows.push([button(next,'Сейчас','exitnow')]);
  if(step==='note')rows.push([button(next,'Без комментария','exitskip')]);
  rows.push([button(next,'Отмена','back')]);
  output(f,identity,next,`${record.d.ticker} · ${action==='partial-close'?'Частичный выход':'Досрочный выход'}\nОсталось: ${number(remaining(record))}% исходного объёма.\n\n${exitPrompts[step]}`,rows,messageId);
 }
 function shortText(text,label,limit){
  const value=text.trim();
  if(!value||value.length>limit||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value))fail(`${label}: укажите текст до ${limit} символов.`);
  return value;
 }
 async function exitValue(f,identity,session,text,messageId){
  const record=await latestRecord(f,identity,session,messageId);if(!record)return;
  const {step,action}=session,closure={...session.closure};
  if(step==='price'){
   closure.price=parsePrice(text);
   exitPrompt(f,identity,record,action,messageId,action==='partial-close'?'percent':'occurredAt',closure);
  }else if(step==='percent'){
   closure.percent=parseExitPercent(text);
   if(closure.percent>=remaining(record))fail('Частичный выход должен быть меньше остатка. Чтобы закрыть весь остаток, выберите «Закрыть досрочно».');
   exitPrompt(f,identity,record,action,messageId,'occurredAt',closure);
  }else if(step==='occurredAt'){
   closure.occurredAt=parseExitTime(text,now());
   exitPrompt(f,identity,record,action,messageId,'reason',closure);
  }else if(step==='reason'){
   closure.reason=shortText(text,'Причина',300);
   exitPrompt(f,identity,record,action,messageId,'note',closure);
  }else if(step==='note'){
   if(text!==null)closure.note=shortText(text,'Комментарий',300);
   confirmation(f,identity,record,action,{closure,messageId});
  }
 }
 function validChange(record,field,price){const d=record.d;if(!['waiting','active'].includes(d.state))fail('Изменение уровней доступно только ожидающему или активному сигналу.');if(field==='stop'){if(price===d.stop)fail('Новый стоп совпадает с текущим.');if(d.dir==='ЛОНГ'?price>=d.target:price<=d.target)fail('Стоп должен оставаться до цели по направлению сделки.');if(d.state==='waiting'&&(d.dir==='ЛОНГ'?price>=d.entry:price<=d.entry))fail('До входа стоп должен оставаться за ценой входа.');}else{if(price===d.target)fail('Новый тейк совпадает с текущим.');if(d.dir==='ЛОНГ'?price<=d.entry||price<=d.stop:price>=d.entry||price>=d.stop)fail('Тейк должен оставаться за входом и стопом по направлению сделки.');}}
 function descriptionPrompt(f,identity,record,messageId){
  const next=fresh('description',{recordId:record.id,recordVersion:version(record),messageId});f.nextSession=next;
  const fields=Object.entries(publishedFields).map(([name,label])=>button(next,label,name));
  output(f,identity,next,`${record.d.ticker} · выберите поле для редактирования.`,[fields.slice(0,2),fields.slice(2),[button(next,'Назад','back')]],messageId);
 }
 async function descriptionText(f,identity,session,text){
  const record=await latestRecord(f,identity,session,session.messageId);if(!record)return;
  if(session.field&&!session.value){
   const value=shortText(text,publishedFields[session.field],publishedFieldLimits[session.field]);
   if(value===record.d[session.field])fail('Значение совпадает с текущим.');
   const next=fresh('description',{recordId:record.id,recordVersion:version(record),messageId:session.messageId,field:session.field,value});f.nextSession=next;
   output(f,identity,next,'Укажите причину изменения, до 300 символов.',[[button(next,'Отмена','back')]],session.messageId);return;
  }
  if(!session.value||session.note)fail('Выберите поле или используйте кнопки для подтверждения.');
  const note=shortText(text,'Причина',300),next=fresh('description',{recordId:record.id,recordVersion:version(record),messageId:session.messageId,field:session.field,value:session.value,note});f.nextSession=next;
  const before=String(record.d[session.field]||'—').slice(0,1000);
  output(f,identity,next,`${record.d.ticker} · ${publishedFields[session.field]}\n\nБыло\n${before}\n\nСтало\n${session.value}\n\nПричина\n${note}`,[[button(next,'Подтвердить изменение','confirm'),button(next,'Отмена','back')]],session.messageId);
 }
 async function callback(f,identity,session,action,messageId){
  if(session.radarDraftToken&&action==='fieldticker')fail('Инструмент связан с событием Radar. Для другого инструмента создайте отдельный ручной сигнал.');
  if(action==='new'){setupPrompt(f,identity,'tier',{},messageId);return;}
  if(['active','recent','drafts'].includes(action)){await list(f,identity,action,messageId);return;}
  if(action==='menu'){menu(f,identity,undefined,messageId);return;}
  if(action==='settings'){await settings(f,identity,messageId);return;}
  if(action==='cancel'){if(session.radarDraftToken)await radarWorkflow.release(identity,session.radarDraftToken);menu(f,identity,'Ввод отменён.',messageId);return;}
  if(await contentStep(f,identity,session,{action},messageId))return;
  if(session.type==='setup'){
   const state={...session};delete state.step;delete state.nonce;
   if(action==='setuptier'){setupPrompt(f,identity,'tier',state,messageId);return;}
   if(session.step==='tier'&&['setuppro','setupexclusive'].includes(action)){setupPrompt(f,identity,'market',{...state,tier:action.slice(5)},messageId);return;}
   if(action==='setupmarket'){setupPrompt(f,identity,'market',state,messageId);return;}
   if(session.step==='market'&&action.startsWith('setup')&&Object.hasOwn(marketLabels,action.slice(5))){setupPrompt(f,identity,'ticker',{...state,market:action.slice(5)},messageId);return;}
  }
  if(session.type==='list'&&/^open\d+$/.test(action)){const item=session.records[Number(action.slice(4))];if(!item||!validId(item.id))fail('Выберите сигнал из актуального списка.');recordCard(f,identity,await ideas.get(item.id,await authorize(identity)),{messageId});return;}
  if(session.type==='draft'){
   const draft={...session,messageId};if(action==='edit'){f.nextSession=fresh('draft',{...draft,nonce:nonce(),step:null});output(f,identity,f.nextSession,'Что изменить?',editRows(f.nextSession),messageId);return;}
   if(/^field(?:ticker|entry|stop|take|direction)$/.test(action)){const field=action.slice(5);f.nextSession=fresh('draft',{...draft,nonce:nonce(),step:field});if(field==='entry'&&(session.wizard||session.entryRange)){entryModePrompt(f,identity,f.nextSession);return;}output(f,identity,f.nextSession,`Текущий ${labels[field]}: ${draft.signal[field]??'не указан'}\n\nОтправьте ${field==='direction'?'LONG или SHORT':field==='ticker'?'тикер инструмента':'новое значение'}.`,[[button(f.nextSession,'❌ Отмена','cancel')]],messageId);return;}
   if(/^instrument\d+$/.test(action)){const instrument=session.candidates?.[Number(action.slice(10))];if(!instrument)fail('Выберите инструмент из актуального списка.');await renderDraft(f,identity,{...draft,instrument,signal:{...draft.signal,ticker:instrument.ticker},candidates:[]},{messageId});return;}
   if(action==='tierpro'||action==='tierexclusive'){await renderDraft(f,identity,{...draft,tier:action.slice(4),savedStrategy:null},{messageId});return;}
   if(session.step==='direction'&&['directionlong','directionshort'].includes(action)){
    await renderDraft(f,identity,{...draft,signal:{...draft.signal,direction:action.slice(9).toUpperCase()}},{messageId});return;
   }
   if(session.step==='entryKind'&&['entryprice','entryrange'].includes(action)){
    const originalData=draft.originalData?{...draft.originalData,entryRule:''}:null;
    await renderDraft(f,identity,{...draft,signal:{...draft.signal,entry:null},entryKind:action.slice(5),entryRange:null,originalData},{messageId});return;
   }
   if(action.startsWith('detail')&&detailFields.includes(action.slice(6))){
    detailsPrompt(f,identity,fresh('draft',{...draft,nonce:nonce()}),action.slice(6));return;
   }
   if(detailFields.includes(session.step)&&action==='skipdetail'){await nextDetail(f,identity,session,session.fields,messageId);return;}
   if(detailFields.includes(session.step)&&action==='finishdetails'){await renderDraft(f,identity,{...draft,detailsDone:true},{messageId});return;}
   if(action==='savedraft'&&!session.step){await saveDraft(f,identity,draft);return;}
   if(!session.step&&session.strategy&&(action==='publish'||action==='publishduplicate')){await publish(f,identity,draft,action==='publishduplicate');return;}
  }
  if(session.type==='record'){
   const record=await latestRecord(f,identity,session,messageId);if(!record)return;
   if(action==='history'){recordHistory(f,identity,record,0,messageId);return;}
   if(action==='description'&&record.published&&!record.erroneous){descriptionPrompt(f,identity,record,messageId);return;}
   if(action==='resumedraft'&&!record.published){await resumeDraft(f,identity,record,messageId);return;}
   if(['early','partial','closetarget','closestop'].includes(action)){
    if(record.erroneous||record.d.state!=='active')fail('Закрыть можно только активный сигнал.');
    if(action==='early'||action==='partial')exitPrompt(f,identity,record,action==='early'?'early-close':'partial-close',messageId);
    else confirmation(f,identity,record,action==='closetarget'?'target':'stop',{price:action==='closetarget'?record.d.target:record.d.stop,messageId});
    return;
   }
   if(action==='stop'||action==='take'||action==='close'){if(record.erroneous)fail('Для ошибочной публикации доступны комментарии через сайт.');if(action==='close'&&record.d.state!=='active')fail('Закрыть можно только активный сигнал.');if(action!=='close'&&!['waiting','active'].includes(record.d.state))fail('Уровни этого сигнала уже нельзя изменить.');f.nextSession=fresh('value',{recordId:record.id,recordVersion:version(record),field:action,messageId});output(f,identity,f.nextSession,record.d.ticker+'\n'+(action==='close'?'Цена закрытия?':`Текущий ${action==='stop'?'стоп':'тейк'}: ${number(action==='stop'?record.d.stop:record.d.target)} ${record.d.unit}\n\nОтправьте новое значение.`),[[button(f.nextSession,'❌ Отмена','back')]],messageId);return;}
   if(action==='activate'){if(record.d.state!=='waiting')fail('Вход доступен только ожидающему сигналу.');confirmation(f,identity,record,'activate',{messageId});return;}
   if(action==='cancelidea'){if(!['announced','waiting'].includes(record.d.state))fail('Отменить можно только до входа.');confirmation(f,identity,record,'cancel',{messageId});return;}
  }
  if(['value','level-reason','confirmation','exit','history','description'].includes(session.type)&&action==='back'){recordCard(f,identity,await ideas.get(session.recordId,await authorize(identity)),{messageId});return;}
  if(session.type==='description'){
   const record=await latestRecord(f,identity,session,messageId);if(!record)return;
   if(!session.field&&Object.hasOwn(publishedFields,action)){
    const next=fresh('description',{recordId:record.id,recordVersion:version(record),messageId,field:action});f.nextSession=next;
    output(f,identity,next,`${publishedFields[action]} · отправьте новый текст, до ${publishedFieldLimits[action]} символов.`,[[button(next,'Назад','back')]],messageId);return;
   }
   if(action==='confirm'&&session.note){
    const payload={action:'description',note:session.note,d:{[session.field]:session.value}};
    const result=await ideas.update(await authorize(identity),record.id,payload,mutationContext(identity,f.operationId+':description',f.incomingMessageId,session.recordVersion));
    await store.audit(identity,'signal-description',record.id,{field:session.field});
    recordCard(f,identity,result.record,{prefix:'Изменение сохранено.',messageId});return;
   }
  }
  if(session.type==='history'&&['historynewer','historyolder'].includes(action)){
   const record=await latestRecord(f,identity,session,messageId);if(!record)return;
   recordHistory(f,identity,record,session.page+(action==='historyolder'?1:-1),messageId);return;
  }
  if(session.type==='exit'&&(action==='exitnow'&&session.step==='occurredAt'||action==='exitskip'&&session.step==='note')){
   await exitValue(f,identity,session,action==='exitnow'?'сейчас':null,messageId);return;
  }
  if(session.type==='confirmation'&&action==='confirm'){
   const record=await latestRecord(f,identity,session,messageId);if(!record)return;
   const payload=detailedExit(session.action)?{action:session.action,...session.closure}:{action:session.action,note:session.note||'Действие подтверждено автором через Telegram.',...(['manual','stop-change','target-change'].includes(session.action)?{price:session.price}:{})};
   const result=await ideas.update(await authorize(identity),record.id,payload,mutationContext(identity,f.operationId+':'+session.action,f.incomingMessageId,session.recordVersion));
   await store.audit(identity,'signal-'+session.action,record.id,{before:session.action==='stop-change'?record.d.stop:session.action==='target-change'?record.d.target:record.d.state,after:session.closure?.price??session.price??result.record.d.state});
   recordCard(f,identity,result.record,{prefix:'✅ Изменение сохранено.',messageId});return;
  }
  fail('Эта кнопка больше не подходит к текущему действию. Откройте /start или /active.');
 }
 async function message(f,identity,session,text){const match=text.match(/^\/(\w+)(?:@[A-Za-z0-9_]+)?(?:\s|$)/),command=match?.[1]?.toLowerCase();
  if(session?.radarDraftToken&&['cancel','start','help','new','active','recent','drafts','settings'].includes(command))await radarWorkflow.release(identity,session.radarDraftToken);
  if(session?.radarDraftToken&&['s','signal'].includes(command))fail('Сначала завершите текущий сценарий Radar или отправьте /cancel.');
  if(command==='start'){menu(f,identity);return;}if(command==='help'){menu(f,identity,help);return;}if(command==='cancel'){menu(f,identity,'Текущий ввод отменён.');return;}if(command==='active'||text==='📊 Активные сигналы'){await list(f,identity,'active');return;}if(command==='recent'||text==='🕘 Последние'){await list(f,identity,'recent');return;}if(command==='drafts'){await list(f,identity,'drafts');return;}if(command==='settings'||text==='⚙️ Настройки'){await settings(f,identity);return;}if(command==='new'||text==='➕ Новый сигнал'){setupPrompt(f,identity,'tier');return;}
  if(await contentStep(f,identity,session,{command,text},command?null:session?.messageId))return;
  if(session?.radarDraftToken&&session.step==='radarprices'&&!command){const signal=parseSignal(session.instrument.ticker+' '+text);if(signal.missing.length)fail('Отправьте три цены: ВХОД СТОП ТЕЙК. Например: 312.5 307 325.');await renderDraft(f,identity,{...session,signal},{messageId:session.messageId});return;}
  if(session?.type==='setup'&&session.step==='ticker'&&!command){
   const signal=parseSignal(text);
   const {tier,market,recordId,recordVersion,savedStrategy,fields}=session;
   await renderDraft(f,identity,fresh('draft',{signal,tier,market,recordId,recordVersion,savedStrategy,fields,wizard:true}),{messageId:session.messageId});return;
  }
  if(session?.type==='value'&&!command){
   const price=parsePrice(text),messageId=session.messageId,record=await latestRecord(f,identity,session,messageId);
   if(!record)return;
   if(session.field==='close'){confirmation(f,identity,record,'manual',{price,messageId});return;}
   validChange(record,session.field,price);
   const action=session.field==='stop'?'stop-change':'target-change';
   const next=fresh('level-reason',{recordId:record.id,recordVersion:version(record),price,action,messageId});f.nextSession=next;
   output(f,identity,next,'Укажите причину изменения уровня, до 300 символов.',[[button(next,'Отмена','back')]],messageId);return;
  }
  if(session?.type==='level-reason'&&!command){
   const record=await latestRecord(f,identity,session,session.messageId);
   if(record)confirmation(f,identity,record,session.action,{price:session.price,messageId:session.messageId,note:shortText(text,'Причина',300)});
   return;
  }
  if(session?.type==='exit'&&!command){await exitValue(f,identity,session,text,session.messageId);return;}
  if(session?.type==='description'&&!command){await descriptionText(f,identity,session,text);return;}
  if(session?.type==='draft'&&detailFields.includes(session.step)&&!command){
   const {step,signal}=session,fields={...session.fields};
   if(step==='targets')fields.targets=parseExtraTargets(text,signal.direction,signal.take);
   if(step==='horizon')fields.horizon=shortText(text,'Горизонт',50);
   if(step==='thesis')fields.thesis=shortText(text,'Комментарий',1500);
   if(step==='chartUrl')fields.chartUrl=sourceUrl(text);
   await nextDetail(f,identity,session,fields,session.messageId);return;
  }
  if(session?.type==='draft'&&session.step==='entry'&&session.entryKind==='range'&&!command){
   const entryRange=parseEntryRange(text),signal={...session.signal,entry:entryRange.entry};
   await renderDraft(f,identity,{...session,signal,entryRange},{messageId:session.messageId});return;
  }
  if(session?.type==='draft'&&session.step&&!command&&!/\s/.test(text)){const signal={...session.signal};if(session.step==='ticker'){const parsed=parseSignal(text);if(parsed.missing.length!==3)fail('Для смены инструмента отправьте только тикер.');signal.ticker=parsed.ticker;}else if(session.step==='direction'){if(!/^(?:LONG|SHORT)$/i.test(text))fail('Направление: LONG или SHORT.');signal.direction=text.toUpperCase();}else signal[session.step]=parsePrice(text);await renderDraft(f,identity,{...session,signal,...(session.step==='ticker'?{instrument:null,candidates:[]}:{})},{messageId:session.messageId});return;}
  if(session?.radarDraftToken)fail('Используйте кнопки изменения уровней или /cancel для нового сигнала.');
  const signal=parseSignal(text);await renderDraft(f,identity,fresh('draft',{signal,instrument:null}));
 }
 async function radarCallback(f,identity,session,data,messageId){
  if(!radarWorkflow)fail('Radar не подключён.');const match=data.match(/^tr:([A-Za-z0-9_-]{24}):(create|another|ignore|[ph]\d{1,16})$/);if(!match)fail('Неизвестная кнопка Radar.');
  const action=match[2];
  if(/^[ph]\d+$/.test(action)){
   if(typeof radarWorkflow.review!=='function')fail('Модерация Radar недоступна.');
   const published=action[0]==='p',revision=Number(action.slice(1));
   if(!Number.isSafeInteger(revision))fail('Некорректная версия события.');
   await authorizePublication(identity);
   const {event}=await radarWorkflow.review(identity,match[1],{status:published?'published':'hidden',revision});
   output(f,identity,null,`${published?'Событие опубликовано':'Событие отклонено'} · ${event.headline}`,[],messageId);return;
  }
  const {event}=await radarWorkflow.alert(identity,match[1]);
  if(match[2]==='ignore'){await radarWorkflow.ignore(identity,event.id);output(f,identity,null,'Событие пропущено для вашего аккаунта. Публикация в Radar и черновик сигнала не изменены.');return;}
  if(['setup','draft','value','level-reason','confirmation','exit','description','editor-content'].includes(session?.type))fail('У вас есть незавершённый ввод. Завершите его или отправьте /cancel, затем нажмите кнопку Radar снова.');
  const info=await radarWorkflow.inspect(identity,event.id);
  if(info.relatedSignals.length&&match[2]!=='another'){output(f,identity,null,'По событию уже есть '+info.relatedSignals.length+' сигнал(а). Создать ещё один после проверки?',[[{text:'Создать ещё один',callback_data:'tr:'+match[1]+':another'}],[{text:'Открыть текущий',url:adminUrl(info.relatedSignals[0].id)}]]);return;}
  const result=await radarWorkflow.begin(identity,event.id,{requestId:f.operationId.replace(/:/g,'_'),allowAnother:match[2]==='another'}),next=fresh('draft',{signal:parseSignal(result.instrument.ticker),instrument:result.instrument,radarDraftToken:result.draftToken,radarHeadline:result.event.headline,radarEventId:result.event.id,step:'radarprices',messageId:null});f.nextSession=next;
  output(f,identity,next,`Radar · ${result.instrument.ticker}\n${result.event.headline}\n\nОтправьте три цены: ВХОД СТОП ТЕЙК.\nНапример: 312.5 307 325\n\nНаправление определится по уровням. Перед публикацией будет обязательный предпросмотр.`,[[button(next,'❌ Отмена','cancel')]]);
 }
 function incoming(update){
  if(!update||!Number.isSafeInteger(update.update_id)||update.update_id<0)return null;const query=update.callback_query,message=query?.message??update.message,from=query?.from??message?.from;
  if(!message||message.chat?.type!=='private'||!Number.isSafeInteger(message.chat.id)||message.chat.id<=0||!Number.isSafeInteger(from?.id)||from.id!==message.chat.id||from.is_bot===true||!Number.isSafeInteger(message.message_id)||message.message_id<=0)return null;
  if(query&&(typeof query.id!=='string'||query.id.length>200||typeof query.data!=='string'||Buffer.byteLength(query.data)>64))return null;if(!query&&(typeof message.text!=='string'||message.text.length>4096))return null;
  return {query,message,telegramUserId:String(from.id),chatId:String(message.chat.id)};
 }
 async function processOne(update){const source=incoming(update);if(!source)return {ignored:true};const {query,message:msg,telegramUserId,chatId}=source;let identity=await store.getIdentity(telegramUserId,chatId);
  if(Object.hasOwn(update,'acceptedBindingId')&&update.acceptedBindingId!==identity?.bindingId||Object.hasOwn(update,'acceptedAuthStamp')&&update.acceptedAuthStamp!==identity?.authStamp)return {ignored:true,staleBinding:true};
  if(identity){const previous=await store.getReceipt(identity,'tg:'+identity.bindingId+':'+update.update_id);if(previous){await authorize(identity);await applySession(identity,previous);await deliver(identity,previous);return {replayed:true};}}
  const text=typeof msg.text==='string'?msg.text.trim():'';const connect=!query&&text.match(/^\/connect(?:@[A-Za-z0-9_]+)?(?:\s+([^\s]+))?$/i);
  if(connect){try{identity=await store.connect(telegramUserId,chatId,update.connectCodeHash?{codeHash:update.connectCodeHash}:connect[1]||'');}catch(cause){if(!cause.status)throw cause;await send('sendMessage',{chat_id:chatId,text:'Не удалось подключить Telegram. Создайте новый одноразовый код в настройках администратора.'});return {connected:false};}}
  if(!identity){if(!query)await send('sendMessage',{chat_id:chatId,text:'Бот доступен только подключённым администраторам. Получите одноразовый код в настройках сайта и отправьте /connect КОД.'});return {ignored:true};}
  await authorize(identity);const operationId='tg:'+identity.bindingId+':'+update.update_id,existing=await store.getReceipt(identity,operationId);
  if(existing){await applySession(identity,existing);await deliver(identity,existing);return {replayed:true};}
  let session=await store.session(identity);if(session&&(!Number.isFinite(session.expiresAt)||session.expiresAt<=now())){await store.saveSession(identity,null);session=null;}
  const f=frame(session);f.operationId=operationId;f.incomingMessageId=msg.message_id;
  if(query){try{await authorize(identity);await send('answerCallbackQuery',{callback_query_id:query.id});}catch{}}
  try{
   if(connect)menu(f,identity,'✅ Telegram подключён к аккаунту администратора.\n\n'+help);
   else if(query&&query.data.startsWith('tr:'))await radarCallback(f,identity,session,query.data,msg.message_id);
   else if(query){const parsed=query.data.match(/^ta:([A-Za-z0-9_-]{12}):([A-Za-z0-9]+)$/);if(!session||!parsed||parsed[1]!==session.nonce)fail('Кнопка устарела или время ввода истекло. Откройте /start или отправьте сигнал заново.');await callback(f,identity,session,parsed[2],msg.message_id);}
   else await message(f,identity,session,text);
  }catch(cause){
   if(!cause.status||cause.status===401||cause.status===403)throw cause;
   const needsReauth=['TELEGRAM_PUBLICATION_REAUTH','TELEGRAM_BROADCAST_REAUTH'].includes(cause.code);
   if(needsReauth){
    output(f,identity,null,`${cause.message}\nЗатем нажмите кнопку подтверждения под предпросмотром ещё раз.`,[[{text:'Подтвердить на сайте ↗',url:origin.origin+'/telegram-admin.html#broadcast'}]]);
   }else{
    const signalConflict=cause.status===409&&!['editor-content','setup'].includes(session?.type)&&!(session?.radarDraftToken||query?.data?.startsWith('tr:'));
    output(f,identity,null,signalConflict?'Сигнал изменился в другой сессии. Откройте /active и проверьте актуальную карточку.':cause.message);
   }
  }
  const action=query?query.data.match(/^ta:[A-Za-z0-9_-]{12}:([A-Za-z0-9]+)$/)?.[1]||'invalid':text.match(/^\/([A-Za-z]+)(?:@\w+)?(?:\s|$)/)?.[1]?.toLowerCase()||'signal-input';
  await store.audit(identity,query?'bot-callback':'bot-message',f.nextSession?.recordId??session?.recordId??null,{action,updateId:update.update_id});
  const receipt=await store.saveReceipt(identity,operationId,{outputs:f.outputs,sessionBeforeNonce:f.sessionBeforeNonce,...(Object.hasOwn(f,'nextSession')?{nextSession:f.nextSession}:{})});await applySession(identity,receipt);await deliver(identity,receipt);return {ok:true};
 }
 function process(update){if(pending>=64)return Promise.reject(Object.assign(Error('Telegram admin queue is busy'),{status:429}));pending++;const job=queue.then(()=>processOne(update));queue=job.catch(()=>{});return job.finally(()=>pending--);}
 return {process,close:()=>queue};
}
