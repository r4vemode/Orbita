import {randomBytes} from 'node:crypto';
import {parseSignal,parsePrice,validateSignal,signalMetrics} from './parser.mjs';
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

// The transport and account store are supplied by the existing backend. This
// module has no database, credentials, polling loop or direct Telegram client.
export function createTelegramAdminEngine({store,ideas,send,publicOrigin,now=Date.now,draftTtlMs=1800000,quoteProvider=null}={}){
 if(!store||!ideas||typeof send!=='function'||typeof now!=='function'||!Number.isSafeInteger(draftTtlMs)||draftTtlMs<60000||draftTtlMs>86400000)throw Error('Invalid Telegram admin engine dependencies');
 const origin=new URL(publicOrigin);if(origin.protocol!=='https:'||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash)throw Error('Telegram admin links require a HTTPS origin');
 let queue=Promise.resolve(),pending=0;
 const adminUrl=id=>origin.origin+'/admin.html'+(id?'?idea='+encodeURIComponent(id):'');
 const fresh=(type,extra={})=>({type,nonce:nonce(),createdAt:now(),expiresAt:now()+draftTtlMs,...extra});
 async function authorize(identity){const user=await store.authorize(identity);if(!user||user.id!==identity.id||user.role!=='admin')fail('Доступ администратора отозван. Подключите Telegram заново в настройках сайта.',403);return user;}
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
 function menu(f,identity,text='Signals Admin\n\nЧто делаем?',messageId=null){const session=fresh('menu');f.nextSession=session;output(f,identity,session,text,[[button(session,'➕ Новый сигнал','new')],[button(session,'📊 Активные сигналы','active'),button(session,'🕘 Последние','recent')],[button(session,'⚙️ Настройки','settings')]],messageId);}
 const help='Отправьте: ТИКЕР ВХОД СТОП ТЕЙК\nНапример: SBER 312.5 307 325\n\nНаправление определяется автоматически. Можно указать LONG или SHORT после тикера. Поддерживаются точка и запятая. Команды /s и /signal работают так же.\n\n/cancel — отменить текущий ввод. Публикация после предпросмотра; вход подтверждается отдельно.';
 async function listRecords(identity){await authorize(identity);const result=await ideas.list(identity);if(!Array.isArray(result?.records))throw Error('Invalid shared ideas service response');return result.records;}
 async function list(f,identity,active,messageId){const records=(await listRecords(identity)).filter(r=>!active||(r.published&&!r.erroneous&&['announced','waiting','active'].includes(r.d.state))).slice(0,10),session=fresh('list',{records:records.map(r=>({id:r.id,recordVersion:version(r)}))});f.nextSession=session;
  const text=records.length?(active?'Активные и ожидающие сигналы':'Последние сигналы')+'\n\n'+records.map((r,i)=>`${i+1}. ${r.d.ticker} • ${direction(r)}\n${number(r.d.entry)} → ${number(r.d.target)} · Stop ${number(r.d.stop)}\n${status(r)}`).join('\n\n'):'Пока нет '+(active?'активных сигналов.':'сигналов.');
  output(f,identity,session,text,[...records.map((r,i)=>[button(session,r.d.ticker+' • '+direction(r),'open'+i)]),[button(session,'➕ Новый сигнал','new')]],messageId);
 }
 function status(record){return ({draft:'DRAFT',announced:'ANNOUNCED · уровни ещё не добавлены',waiting:'WAITING · ожидает подтверждения входа',active:'ACTIVE',closed:'CLOSED',cancelled:'CANCELLED'})[record.d.state]||'Статус требует проверки';}
 function recordText(record){const d=record.d,unit=d.unit||'',lines=[`${d.ticker} • ${direction(record)}`,`Вход: ${number(d.entry)} ${unit}`,`Стоп: ${number(d.stop)} ${unit}`,`Тейк: ${number(d.target)} ${unit}`,status(record),d.strategy];if(record.erroneous)lines.push('ОШИБОЧНАЯ ПУБЛИКАЦИЯ');if(d.state==='closed'&&Number.isFinite(record.meta?.exit)&&Number.isFinite(d.entry)){const pnl=(record.meta.exit-d.entry)/d.entry*100*(d.dir==='ШОРТ'?-1:1);lines.push(`Выход: ${number(record.meta.exit)} ${unit}`,`Результат автора: ${pnl>=0?'+':'−'}${percent(pnl)}%`);}return lines.join('\n');}
 function recordCard(f,identity,record,{prefix='',messageId=null}={}){const session=fresh('record',{recordId:record.id,recordVersion:version(record)}),rows=[];f.nextSession=session;
  if(!record.erroneous){if(record.d.state==='waiting')rows.push([button(session,'Подтвердить вход','activate')]);if(['waiting','active'].includes(record.d.state))rows.push([button(session,'Изменить стоп','stop'),button(session,'Изменить тейк','take')]);if(record.d.state==='active')rows.push([button(session,'Закрыть сигнал','close')]);if(['announced','waiting'].includes(record.d.state))rows.push([button(session,'Отменить до входа','cancelidea')]);}
  rows.push([{text:'Открыть в админке',url:adminUrl(record.id)}],[button(session,'📊 Активные сигналы','active')]);output(f,identity,session,(prefix?prefix+'\n\n':'')+recordText(record),rows,messageId);
 }
 async function settings(f,identity,messageId){const prefs=await store.settings(identity),session=fresh('menu');f.nextSession=session;output(f,identity,session,`Настройки\n\nСтратегия по умолчанию: ${prefs.strategy}\nМгновенная публикация: ${prefs.instantPublish?'включена':'выключена'}\n\nДля другого рынка используется соответствующая стратегия инструмента. Настройки публикации изменяются в защищённой веб-админке.`,[[{text:'Настройки Telegram',url:origin.origin+'/telegram-admin.html'}],[button(session,'➕ Новый сигнал','new')]],messageId);}
 async function duplicates(identity,instrument){return (await listRecords(identity)).filter(r=>r.published&&!r.erroneous&&!isDemo(r)&&['announced','waiting','active'].includes(r.d.state)&&r.d.market===instrument.market&&r.d.ticker.toUpperCase()===instrument.ticker.toUpperCase());}
 const fingerprint=records=>records.map(r=>r.id+':'+version(r)).sort().join('|');
 async function quoteWarning(instrument,signal){if(typeof quoteProvider!=='function')return '';let timer;try{const result=await Promise.race([Promise.resolve().then(()=>quoteProvider(instrument)),new Promise(resolve=>{timer=setTimeout(()=>resolve(null),1000);})]);const age=now()-Date.parse(result?.asOf);if(!Number.isFinite(result?.price)||result.price<=0||result.isDemo===true||!Number.isFinite(age)||age<0||age>900000)return '';const delta=Math.abs(signal.entry-result.price)/result.price*100;return delta>=20?`\n⚠️ Вход отличается от котировки ${number(result.price)} ${instrument.unit} примерно на ${delta.toFixed(1)}%. Проверьте цену.`:'';}catch{return '';}finally{clearTimeout(timer);}}
 function editRows(session){return [[button(session,'Инструмент','fieldticker'),button(session,'Направление','fielddirection')],[button(session,'Вход','fieldentry'),button(session,'Стоп','fieldstop'),button(session,'Тейк','fieldtake')],[button(session,'❌ Отмена','cancel')]];}
 async function renderDraft(f,identity,draft,{messageId=null,allowInstant=false}={}){
  let signal,problem='';try{signal=validateSignal(draft.signal);}catch(cause){if(cause.status!==400)throw cause;signal={...draft.signal,missing:prices.filter(field=>draft.signal[field]===null||draft.signal[field]===undefined)};problem=cause.message;}
  const session=fresh('draft',{...draft,signal,messageId:messageId??draft.messageId??null,nonce:nonce()});f.nextSession=session;
  if(problem){session.step=null;output(f,identity,session,problem+'\n\nИзмените необходимые поля. Публикация пока недоступна.',editRows(session),session.messageId);return;}
  if(!session.instrument){const records=await listRecords(identity),candidates=findInstruments(signal.ticker,{records});const exact=candidates.filter(item=>item.ticker===signal.ticker||item.market==='crypto'&&item.ticker.replace('/','')===signal.ticker.replace('/',''));
   if(exact.length===1){session.instrument=exact[0];session.signal.ticker=exact[0].ticker;}else{session.candidates=candidates.slice(0,8);session.step='ticker';const rows=session.candidates.map((item,index)=>[button(session,item.ticker+' — '+item.name+' · '+item.market,'instrument'+index)]);rows.push([button(session,'❌ Отмена','cancel')]);output(f,identity,session,candidates.length?'Выберите инструмент:':`Не нашёл инструмент ${signal.ticker}.\nПроверьте тикер и отправьте его заново.`,rows,session.messageId);return;}
  }
  if(signal.missing.length){session.step=signal.missing[0];output(f,identity,session,`Не хватает ${labels[session.step]}${session.step==='take'?' (Take Profit)':''}.\n\nМожно отправить только значение.\n${session.instrument.ticker} · ${session.instrument.name}`,[[button(session,'✏️ Изменить','edit')],[button(session,'❌ Отмена','cancel')]],session.messageId);return;}
  session.step=null;const prefs=await store.settings(identity);session.strategy=markets[prefs.strategy]===session.instrument.market?prefs.strategy:session.instrument.strategy;
  const active=await duplicates(identity,session.instrument);session.duplicateFingerprint=fingerprint(active);
  if(allowInstant&&prefs.instantPublish===true&&!active.length){await publish(f,identity,session,false,{instant:true});return;}
  const metrics=signalMetrics(signal);let text=`Новый сигнал\n\n${signal.ticker} • ${signal.direction}\n${session.strategy}\n\nВход: ${number(signal.entry)} ${session.instrument.unit}\nСтоп: ${number(signal.stop)} ${session.instrument.unit}\nRisk: −${percent(metrics.riskPercent)}%\nТейк: ${number(signal.take)} ${session.instrument.unit}\nPotential: +${percent(metrics.potentialPercent)}%\nRisk / Reward: 1 : ${metrics.riskReward.toFixed(2)}\n\nПосле публикации: WAITING. Вход подтверждается отдельно.`;
  text+=await quoteWarning(session.instrument,signal);
  const rows=[];if(active.length){text+='\n\n⚠️ По этому инструменту уже есть сигнал:\n'+recordText(active[0])+'\n\nВсё равно создать ещё один?';rows.push([button(session,'Создать ещё один','publishduplicate')],[{text:'Открыть текущий',url:adminUrl(active[0].id)}]);}else rows.push([button(session,'✅ Опубликовать','publish')]);rows.push([button(session,'✏️ Изменить','edit'),button(session,'❌ Отмена','cancel')]);output(f,identity,session,text,rows,session.messageId);
 }
 function mutationContext(identity,operationId,messageId,expectedRecordVersion){return {createdVia:'TELEGRAM',operationId,telegramChatId:identity.chatId,telegramMessageId:messageId,authorize:()=>authorize(identity),...(expectedRecordVersion===undefined?{}:{expectedRecordVersion})};}
 async function publish(f,identity,session,confirmedDuplicate,{instant=false}={}){const signal=validateSignal(session.signal);if(signal.missing.length||!session.instrument)fail('Сначала заполните инструмент и все уровни.');
  const known=findInstruments(session.instrument.ticker,{records:await listRecords(identity)}).find(item=>item.id===session.instrument.id);if(!known||known.ticker!==signal.ticker)fail('Инструмент изменился. Отправьте сигнал заново.');
  const active=await duplicates(identity,known);if(active.length&&(!confirmedDuplicate||session.duplicateFingerprint!==fingerprint(active))){await renderDraft(f,identity,session,{messageId:session.messageId});return;}
  const prefs=await store.settings(identity);if(instant&&prefs.instantPublish!==true){await renderDraft(f,identity,session,{messageId:session.messageId});return;}const strategy=markets[session.strategy]===known.market?session.strategy:markets[prefs.strategy]===known.market?prefs.strategy:known.strategy;
  const d={ticker:known.ticker,name:known.name,market:known.market,strategy,dir:signal.direction==='SHORT'?'ШОРТ':'ЛОНГ',entry:signal.entry,stop:signal.stop,target:signal.take,summary:'',thesis:'',entryRule:`Плановый вход: ${number(signal.entry)} ${known.unit}. Подтверждение входа автором — отдельным событием.`,cancelRule:`Выход по стопу ${number(signal.stop)} ${known.unit} или цели ${number(signal.take)} ${known.unit}; изменения публикуются отдельными событиями.`};
  const result=await ideas.create(await authorize(identity),{mode:'full',d},{...mutationContext(identity,f.operationId+':publish',f.incomingMessageId),expectedDuplicateFingerprint:fingerprint(active),authorize:async()=>{const actor=await authorize(identity);if(instant&&(await store.settings(identity)).instantPublish!==true)fail('Мгновенная публикация отключена. Отправьте сигнал заново для предпросмотра.',409);return actor;}});await store.audit(identity,'signal-created',result.record.id,{ticker:d.ticker});recordCard(f,identity,result.record,{prefix:'✅ Сигнал опубликован. Вход ещё не подтверждён.',messageId:session.messageId});
 }
 async function latestRecord(f,identity,session,messageId){const record=await ideas.get(session.recordId,await authorize(identity));if(version(record)!==session.recordVersion){recordCard(f,identity,record,{prefix:'Данные изменились в другой сессии. Проверьте актуальные условия и повторите действие.',messageId});return null;}return record;}
 function confirmation(f,identity,record,action,{price=null,messageId=null}={}){const session=fresh('confirmation',{recordId:record.id,recordVersion:version(record),action,price,messageId}),d=record.d;f.nextSession=session;let text;
  if(action==='manual'){const pnl=(price-d.entry)/d.entry*100*(d.dir==='ШОРТ'?-1:1);text=`${d.ticker}\nВход: ${number(d.entry)} ${d.unit}\nВыход: ${number(price)} ${d.unit}\nРезультат автора: ${pnl>=0?'+':'−'}${percent(pnl)}%\n\nЗакрыть сигнал?`;}
  else if(action==='activate')text=recordText(record)+'\n\nПодтвердить вход автора? Это запись автора, а не исполнение сделки брокером.';
  else if(action==='cancel')text=recordText(record)+'\n\nОтменить сигнал до входа?';
  else text=`${d.ticker}\n${action==='stop-change'?'Стоп':'Тейк'}: ${number(action==='stop-change'?d.stop:d.target)} → ${number(price)} ${d.unit}\n\nПодтвердить изменение?`;
  output(f,identity,session,text,[[button(session,action==='manual'?'✅ Закрыть':'✅ Подтвердить','confirm')],[button(session,'❌ Отмена','back')]],messageId);
 }
 function validChange(record,field,price){const d=record.d;if(!['waiting','active'].includes(d.state))fail('Изменение уровней доступно только ожидающему или активному сигналу.');if(field==='stop'){if(price===d.stop)fail('Новый стоп совпадает с текущим.');if(d.dir==='ЛОНГ'?price>=d.target:price<=d.target)fail('Стоп должен оставаться до цели по направлению сделки.');if(d.state==='waiting'&&(d.dir==='ЛОНГ'?price>=d.entry:price<=d.entry))fail('До входа стоп должен оставаться за ценой входа.');}else{if(price===d.target)fail('Новый тейк совпадает с текущим.');if(d.dir==='ЛОНГ'?price<=d.entry||price<=d.stop:price>=d.entry||price>=d.stop)fail('Тейк должен оставаться за входом и стопом по направлению сделки.');}}
 async function callback(f,identity,session,action,messageId){
  if(action==='new'){const next=fresh('menu');f.nextSession=next;output(f,identity,next,help,[[button(next,'❌ Отмена','cancel')]],messageId);return;}
  if(action==='active'||action==='recent'){await list(f,identity,action==='active',messageId);return;}
  if(action==='settings'){await settings(f,identity,messageId);return;}
  if(action==='cancel'){menu(f,identity,'Ввод отменён. Сигналы не изменены.',messageId);return;}
  if(session.type==='list'&&/^open\d+$/.test(action)){const item=session.records[Number(action.slice(4))];if(!item||!validId(item.id))fail('Выберите сигнал из актуального списка.');recordCard(f,identity,await ideas.get(item.id,await authorize(identity)),{messageId});return;}
  if(session.type==='draft'){
   const draft={...session,messageId};if(action==='edit'){f.nextSession=fresh('draft',{...draft,nonce:nonce(),step:null});output(f,identity,f.nextSession,'Что изменить?',editRows(f.nextSession),messageId);return;}
   if(/^field(?:ticker|entry|stop|take|direction)$/.test(action)){const field=action.slice(5);f.nextSession=fresh('draft',{...draft,nonce:nonce(),step:field});output(f,identity,f.nextSession,`Текущий ${labels[field]}: ${draft.signal[field]??'не указан'}\n\nОтправьте ${field==='direction'?'LONG или SHORT':field==='ticker'?'тикер инструмента':'новое значение'}.`,[[button(f.nextSession,'❌ Отмена','cancel')]],messageId);return;}
   if(/^instrument\d+$/.test(action)){const instrument=session.candidates?.[Number(action.slice(10))];if(!instrument)fail('Выберите инструмент из актуального списка.');await renderDraft(f,identity,{...draft,instrument,signal:{...draft.signal,ticker:instrument.ticker},candidates:[]},{messageId});return;}
   if(action==='publish'||action==='publishduplicate'){await publish(f,identity,draft,action==='publishduplicate');return;}
  }
  if(session.type==='record'){
   const record=await latestRecord(f,identity,session,messageId);if(!record)return;
   if(action==='stop'||action==='take'||action==='close'){if(record.erroneous)fail('Для ошибочной публикации доступны комментарии через сайт.');if(action==='close'&&record.d.state!=='active')fail('Закрыть можно только активный сигнал.');if(action!=='close'&&!['waiting','active'].includes(record.d.state))fail('Уровни этого сигнала уже нельзя изменить.');f.nextSession=fresh('value',{recordId:record.id,recordVersion:version(record),field:action,messageId});output(f,identity,f.nextSession,record.d.ticker+'\n'+(action==='close'?'Цена закрытия?':`Текущий ${action==='stop'?'стоп':'тейк'}: ${number(action==='stop'?record.d.stop:record.d.target)} ${record.d.unit}\n\nОтправьте новое значение.`),[[button(f.nextSession,'❌ Отмена','back')]],messageId);return;}
   if(action==='activate'){if(record.d.state!=='waiting')fail('Вход доступен только ожидающему сигналу.');confirmation(f,identity,record,'activate',{messageId});return;}
   if(action==='cancelidea'){if(!['announced','waiting'].includes(record.d.state))fail('Отменить можно только до входа.');confirmation(f,identity,record,'cancel',{messageId});return;}
  }
  if(['value','confirmation'].includes(session.type)&&action==='back'){recordCard(f,identity,await ideas.get(session.recordId,await authorize(identity)),{messageId});return;}
  if(session.type==='confirmation'&&action==='confirm'){
   const record=await latestRecord(f,identity,session,messageId);if(!record)return;const payload={action:session.action,note:'Действие подтверждено автором через Telegram.',...(['manual','stop-change','target-change'].includes(session.action)?{price:session.price}:{})};
   const result=await ideas.update(await authorize(identity),record.id,payload,mutationContext(identity,f.operationId+':'+session.action,f.incomingMessageId,session.recordVersion));await store.audit(identity,'signal-'+session.action,record.id,{before:session.action==='stop-change'?record.d.stop:session.action==='target-change'?record.d.target:record.d.state,after:session.price??result.record.d.state});recordCard(f,identity,result.record,{prefix:'✅ Изменение сохранено.',messageId});return;
  }
  fail('Эта кнопка больше не подходит к текущему действию. Откройте /start или /active.');
 }
 async function message(f,identity,session,text){const match=text.match(/^\/(\w+)(?:@[A-Za-z0-9_]+)?(?:\s|$)/),command=match?.[1]?.toLowerCase();
  if(command==='start'){menu(f,identity);return;}if(command==='help'){menu(f,identity,help);return;}if(command==='cancel'){menu(f,identity,'Текущий ввод отменён. Сигналы не изменены.');return;}if(command==='active'||text==='📊 Активные сигналы'){await list(f,identity,true);return;}if(command==='recent'||text==='🕘 Последние'){await list(f,identity,false);return;}if(command==='settings'||text==='⚙️ Настройки'){await settings(f,identity);return;}if(text==='➕ Новый сигнал'){menu(f,identity,help);return;}
  if(session?.type==='value'&&!command){const price=parsePrice(text),record=await latestRecord(f,identity,session,session.messageId);if(!record)return;if(session.field!=='close')validChange(record,session.field,price);confirmation(f,identity,record,session.field==='stop'?'stop-change':session.field==='take'?'target-change':'manual',{price,messageId:session.messageId});return;}
  if(session?.type==='draft'&&session.step&&!command&&!/\s/.test(text)){const signal={...session.signal};if(session.step==='ticker'){const parsed=parseSignal(text);if(parsed.missing.length!==3)fail('Для смены инструмента отправьте только тикер.');signal.ticker=parsed.ticker;}else if(session.step==='direction'){if(!/^(?:LONG|SHORT)$/i.test(text))fail('Направление: LONG или SHORT.');signal.direction=text.toUpperCase();}else signal[session.step]=parsePrice(text);await renderDraft(f,identity,{...session,signal,...(session.step==='ticker'?{instrument:null,candidates:[]}:{})},{messageId:session.messageId});return;}
  const signal=parseSignal(text);await renderDraft(f,identity,fresh('draft',{signal,instrument:null}),{allowInstant:true});
 }
 function incoming(update){
  if(!update||!Number.isSafeInteger(update.update_id)||update.update_id<0)return null;const query=update.callback_query,message=query?.message??update.message,from=query?.from??message?.from;
  if(!message||message.chat?.type!=='private'||!Number.isSafeInteger(message.chat.id)||message.chat.id<=0||!Number.isSafeInteger(from?.id)||from.id!==message.chat.id||from.is_bot===true||!Number.isSafeInteger(message.message_id)||message.message_id<=0)return null;
  if(query&&(typeof query.id!=='string'||query.id.length>200||typeof query.data!=='string'||Buffer.byteLength(query.data)>64))return null;if(!query&&(typeof message.text!=='string'||message.text.length>512))return null;
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
   else if(query){const parsed=query.data.match(/^ta:([A-Za-z0-9_-]{12}):([A-Za-z0-9]+)$/);if(!session||!parsed||parsed[1]!==session.nonce)fail('Кнопка устарела или время ввода истекло. Откройте /start или отправьте сигнал заново.');await callback(f,identity,session,parsed[2],msg.message_id);}
   else await message(f,identity,session,text);
  }catch(cause){if(cause.status===401||cause.status===403)throw cause;if(!cause.status)throw cause;output(f,identity,null,cause.status===409?'Сигнал изменился в другой сессии. Откройте /active и проверьте актуальную карточку.':cause.message);}
  const action=query?query.data.match(/^ta:[A-Za-z0-9_-]{12}:([A-Za-z0-9]+)$/)?.[1]||'invalid':text.match(/^\/([A-Za-z]+)(?:@\w+)?(?:\s|$)/)?.[1]?.toLowerCase()||'signal-input';
  await store.audit(identity,query?'bot-callback':'bot-message',f.nextSession?.recordId??session?.recordId??null,{action,updateId:update.update_id});
  const receipt=await store.saveReceipt(identity,operationId,{outputs:f.outputs,sessionBeforeNonce:f.sessionBeforeNonce,...(Object.hasOwn(f,'nextSession')?{nextSession:f.nextSession}:{})});await applySession(identity,receipt);await deliver(identity,receipt);return {ok:true};
 }
 function process(update){if(pending>=64)return Promise.reject(Object.assign(Error('Telegram admin queue is busy'),{status:429}));pending++;const job=queue.then(()=>processOne(update));queue=job.catch(()=>{});return job.finally(()=>pending--);}
 return {process,close:()=>queue};
}
