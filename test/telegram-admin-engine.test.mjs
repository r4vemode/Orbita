import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createTelegramAdminEngine} from '../lib/telegram-admin/engine.mjs';
import {createIdeas} from '../lib/ideas.mjs';
import {createContent} from '../lib/content.mjs';
import {createArticleDraftClient,createTelegramContentWorkflow} from '../lib/telegram-admin/content-workflow.mjs';
import {createTelegramDeliveryWorkflow} from '../lib/telegram-admin/delivery-workflow.mjs';

async function fixture(t,{instantPublish=false,strategy='Momentum RU',quoteProvider=null,workflows=false,ai=null,clockStart=Date.parse('2026-11-02T12:00:00.000Z')}={}){
 const directory=await mkdtemp(path.join(tmpdir(),'orbita-telegram-engine-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 let clock=clockStart,alive=true,session=null,nextUpdate=1,messageId=1,deliveryFailure=false;
 const identity={id:'fixture-admin',role:'admin',bindingId:'fixture-binding',telegramUserId:'123456',chatId:'123456',authStamp:'fixture-stamp'},prefs={instantPublish,strategy},receipts=new Map(),audit=[],sent=[];
 const clone=value=>structuredClone(value),unauthorized=()=>Object.assign(Error('Access revoked'),{status:403});
 let broadcastGrant=false;
 const store={
  async getIdentity(tg,chat){return alive&&tg===identity.telegramUserId&&chat===identity.chatId?clone(identity):null;},
  async authorize(value){if(!alive||value.bindingId!==identity.bindingId||value.authStamp!==identity.authStamp)throw unauthorized();return clone(identity);},
  async useBroadcastGrant(value){await this.authorize(value);if(!broadcastGrant)throw Object.assign(Error('Подтвердите рассылку.'),{status:428,code:'TELEGRAM_BROADCAST_REAUTH'});broadcastGrant=false;},
  async settings(value){await this.authorize(value);return clone(prefs);},
  async session(value){await this.authorize(value);return clone(session);},
  async saveSession(value,data){await this.authorize(value);session=clone(data);return clone(data);},
  async getReceipt(value,key){await this.authorize(value);return clone(receipts.get(key)??null);},
  async saveReceipt(value,key,data){await this.authorize(value);if(!receipts.has(key))receipts.set(key,clone(data));return clone(receipts.get(key));},
  async audit(value,action,id,detail){await this.authorize(value);audit.push({action,id,detail});},
  async connect(tg,chat,code){if(code!=='fixture-one-time-code'&&code?.codeHash!=='fixture-code-hash')throw unauthorized();alive=true;return clone(identity);}
 };
 const ideas=await createIdeas(directory),send=async(method,payload)=>{if(deliveryFailure&&method!=='answerCallbackQuery'){deliveryFailure=false;throw Object.assign(Error('Synthetic transport unavailable'),{code:'SYNTHETIC_UNAVAILABLE'});}sent.push({method,payload:clone(payload)});return {message_id:++messageId};};
 const publicOrigin='https://orbita.example',now=()=>clock,broadcasts=[];
 const content=workflows?await createContent(directory,{now}):null;
 const editor=content&&createTelegramContentWorkflow({content,publicOrigin,now,ai});
 const delivery=content&&createTelegramDeliveryWorkflow({store,publicOrigin,notifications:{
  async statistics(){return {pending:3,oldestPendingSeconds:60,telegramSent:7,failed:2,blocked:1,broadcasts:[]};},
  async enqueueBroadcast({audience,text,authorize}){await authorize();broadcasts.push({audience,text});return {id:'fixture-broadcast',planned:3};}
 }});
 const contentWorkflow=content&&{async handle(input){return await delivery.handle(input)||await editor.handle(input);}};
 const engine=createTelegramAdminEngine({store,ideas,send,publicOrigin,now,quoteProvider,contentWorkflow});
 t.after(()=>engine.close());
 const message=(text,extra={})=>({update_id:nextUpdate++,message:{message_id:++messageId,chat:{id:123456,type:'private'},from:{id:123456,is_bot:false},text},...extra});
 const last=()=>sent.filter(item=>item.method!=='answerCallbackQuery').at(-1);
 const findButton=label=>last().payload.reply_markup?.inline_keyboard.flat().find(item=>item.text.includes(label));
 const callback=label=>{const item=findButton(label);assert.ok(item?.callback_data,'Missing callback '+label+' in '+last().payload.text);return {update_id:nextUpdate++,callback_query:{id:'query-'+nextUpdate,from:{id:123456,is_bot:false},message:{message_id:++messageId,chat:{id:123456,type:'private'}},data:item.callback_data}};};
 return {engine,ideas,identity,prefs,store,sent,audit,receipts,message,callback,last,findButton,content,broadcasts,grantBroadcast(){broadcastGrant=true;},get session(){return clone(session);},get now(){return clock;},advance(ms){clock+=ms;},revoke(){alive=false;},setDeliveryFailure(){deliveryFailure=true;},replaceBinding(){identity.bindingId='new-binding';identity.authStamp='new-stamp';}};
}
const all=async f=>(await f.ideas.list(f.identity)).records;

test('Telegram engine is private and ignores forged callback chat identity and groups',async t=>{
 const f=await fixture(t);const group=f.message('SBER 312 307 325');group.message.chat.type='group';await f.engine.process(group);assert.equal(f.sent.length,0);
 const stranger=f.message('/start');stranger.message.chat.id=999;stranger.message.from.id=999;await f.engine.process(stranger);assert.match(f.last().payload.text,/только подключённым администраторам/);assert.equal((await all(f)).length,0);
 await f.engine.process(f.message('/start'));const forged=f.callback('Новый сигнал');forged.callback_query.from.id=999;const count=f.sent.length;await f.engine.process(forged);assert.equal(f.sent.length,count);assert.equal((await all(f)).length,0);
});

test('one-line signal previews metrics then creates exactly one common waiting idea with Telegram provenance',async t=>{
 const f=await fixture(t);await f.engine.process(f.message('sber 312,5 307 325'));assert.equal((await all(f)).length,0);assert.match(f.last().payload.text,/SBER • LONG/);assert.match(f.last().payload.text,/Risk: −1\.76%/);assert.match(f.last().payload.text,/Potential: \+4\.00%/);assert.match(f.last().payload.text,/1 : 2\.27/);
 const published=f.callback('Опубликовать');await f.engine.process(published);const [record]=await all(f);assert.equal(record.d.state,'waiting');assert.equal(record.d.entry,312.5);assert.equal(record.createdVia,'TELEGRAM');assert.equal(record.telegram.chatId,'123456');assert.equal(record.createdByUserId,f.identity.id);assert.equal(record.meta.events[0][3].via,'TELEGRAM');assert.match(f.last().payload.text,/Вход ещё не подтверждён/);assert.ok(f.last().payload.reply_markup.inline_keyboard.flat().some(b=>b.url==='https://orbita.example/admin.html?idea='+record.id));
 await f.engine.process(published);assert.equal((await all(f)).length,1);const replayedButton={...published,update_id:900};await f.engine.process(replayedButton);assert.equal((await all(f)).length,1);assert.match(f.last().payload.text,/Кнопка устарела/);
 await f.ideas.update(f.identity,record.id,{action:'note',note:'Комментарий через существующую веб-редакцию.'});assert.equal((await all(f))[0].meta.events.length,2);
});

test('partial input continues with only the missing take and draft edits recalculate before publication',async t=>{
 const f=await fixture(t);await f.engine.process(f.message('/s SBER 312.5 307'));assert.match(f.last().payload.text,/Не хватает Тейк/);await f.engine.process(f.message('325'));assert.match(f.last().payload.text,/Risk: −1\.76%/);await f.engine.process(f.callback('Изменить'));await f.engine.process(f.callback('Стоп'));await f.engine.process(f.message('309'));assert.match(f.last().payload.text,/Risk: −1\.12%/);assert.equal((await all(f)).length,0);await f.engine.process(f.callback('Опубликовать'));assert.equal((await all(f))[0].d.stop,309);
});

test('unknown tickers require a catalogue choice, markets use matching strategies and Exclusive remains explicit',async t=>{
 const f=await fixture(t,{strategy:'Orbita Exclusive'});await f.engine.process(f.message('TEST 100 90 120'));assert.match(f.last().payload.text,/Не нашёл инструмент TEST/);assert.equal((await all(f)).length,0);
 await f.engine.process(f.message('/cancel'));await f.engine.process(f.message('SBE 312 307 325'));assert.match(f.last().payload.text,/Выберите инструмент/);const sber=f.findButton('SBER —');assert.ok(sber);await f.engine.process(f.callback('SBER —'));assert.match(f.last().payload.text,/Orbita Exclusive/);await f.engine.process(f.callback('Опубликовать'));assert.equal((await all(f))[0].d.strategy,'Orbita Exclusive');
 await f.engine.process(f.message('BTCUSDT SHORT 80000 81000 75000'));assert.match(f.last().payload.text,/Crypto Momentum/);await f.engine.process(f.callback('Опубликовать'));assert.equal((await all(f))[0].d.market,'crypto');assert.equal((await all(f))[0].d.strategy,'Crypto Momentum');
 await f.engine.process(f.message('Si 100 90 110'));assert.match(f.last().payload.text,/Импульс/);await f.engine.process(f.callback('Опубликовать'));assert.equal((await all(f))[0].d.market,'futures');
});

test('the access tier can be set per signal (EX/PRO word or preview button) for any market',async t=>{
 const f=await fixture(t);
 await f.engine.process(f.message('Si EX 100 90 110'));assert.match(f.last().payload.text,/Orbita Exclusive/);assert.match(f.last().payload.text,/Доступ: EXCLUSIVE/);
 await f.engine.process(f.callback('Опубликовать'));assert.equal((await all(f))[0].d.strategy,'Orbita Exclusive');assert.equal((await all(f))[0].d.market,'futures');
 await f.engine.process(f.message('GAZP 150 140 180'));assert.match(f.last().payload.text,/Доступ: PRO/);
 await f.engine.process(f.callback('Сделать EXCLUSIVE'));assert.match(f.last().payload.text,/Доступ: EXCLUSIVE/);
 await f.engine.process(f.callback('Сделать PRO'));assert.match(f.last().payload.text,/Доступ: PRO/);
 await f.engine.process(f.callback('Опубликовать'));assert.notEqual((await all(f))[0].d.strategy,'Orbita Exclusive');
});

test('publication requires explicit preview even for accounts with a legacy instant preference',async t=>{
 const f=await fixture(t,{instantPublish:true});await f.engine.process(f.message('SBER 312 307 325'));assert.equal((await all(f)).length,0);
 await f.engine.process(f.callback('Опубликовать'));assert.equal((await all(f)).length,1);
 await f.engine.process(f.message('SBER 315 310 330'));assert.equal((await all(f)).length,1);
 assert.match(f.last().payload.text,/уже есть сигнал/);await f.engine.process(f.callback('Создать ещё один'));assert.equal((await all(f)).length,2);
});

test('changing stop and take requires confirmation and updates existing events through the shared service',async t=>{
 const f=await fixture(t);await f.engine.process(f.message('SBER 312 307 325'));await f.engine.process(f.callback('Опубликовать'));await f.engine.process(f.callback('Изменить стоп'));await f.engine.process(f.message('309'));await f.engine.process(f.message('Уточнение риска'));assert.equal((await all(f))[0].d.stop,307);await f.engine.process(f.callback('Подтвердить'));assert.equal((await all(f))[0].d.stop,309);assert.equal((await all(f))[0].meta.events.at(-1)[3].type,'stop-change');assert.equal((await all(f))[0].meta.events.at(-1)[3].note,'Уточнение риска');
 await f.engine.process(f.callback('Изменить тейк'));await f.engine.process(f.message('330'));await f.engine.process(f.message('Обновлённая цель'));assert.equal((await all(f))[0].d.target,325);await f.engine.process(f.callback('Подтвердить'));assert.equal((await all(f))[0].d.target,330);assert.equal((await all(f))[0].meta.events.at(-1)[3].type,'target-change');
});

test('author activation and closing need independent confirmation and calculate direction-aware result',async t=>{
 const f=await fixture(t);await f.engine.process(f.message('SBER SHORT 312.5 318 300'));await f.engine.process(f.callback('Опубликовать'));assert.equal(f.findButton('Закрыть сигнал'),undefined);await f.engine.process(f.callback('Подтвердить вход'));assert.equal((await all(f))[0].d.state,'waiting');await f.engine.process(f.callback('Подтвердить'));assert.equal((await all(f))[0].d.state,'active');await f.engine.process(f.callback('Закрыть сигнал'));await f.engine.process(f.message('300'));assert.match(f.last().payload.text,/Результат автора: \+4\.00%/);assert.equal((await all(f))[0].d.state,'active');await f.engine.process(f.callback('Закрыть'));const record=(await all(f))[0];assert.equal(record.d.state,'closed');assert.equal(record.meta.exit,300);
});

test('concurrent website updates invalidate the pending Telegram action without overwriting current levels',async t=>{
 const f=await fixture(t);await f.engine.process(f.message('SBER 312 307 325'));await f.engine.process(f.callback('Опубликовать'));await f.engine.process(f.callback('Изменить стоп'));await f.engine.process(f.message('309'));await f.engine.process(f.message('Уточнение риска'));const pending=f.callback('Подтвердить'),record=(await all(f))[0];await f.ideas.update(f.identity,record.id,{action:'stop-change',price:308,note:'Изменение через сайт.'});await f.engine.process(pending);assert.equal((await all(f))[0].d.stop,308);assert.match(f.last().payload.text,/Данные изменились/);
});

test('expired drafts, cancelled drafts and stale accepted binding epochs cannot publish',async t=>{
 const f=await fixture(t);await f.engine.process(f.message('SBER 312 307 325'));const expired=f.callback('Опубликовать');f.advance(1800001);await f.engine.process(expired);assert.equal((await all(f)).length,0);assert.match(f.last().payload.text,/время ввода истекло/);
 await f.engine.process(f.message('GAZP 150 140 180'));const old=f.callback('Опубликовать');await f.engine.process(f.message('/cancel'));await f.engine.process(old);assert.equal((await all(f)).length,0);
 const stale=f.message('SBER 312 307 325',{acceptedBindingId:f.identity.bindingId,acceptedAuthStamp:f.identity.authStamp});f.prefs.instantPublish=true;f.replaceBinding();const count=f.sent.length;const result=await f.engine.process(stale);assert.equal(result.staleBinding,true);assert.equal(f.sent.length,count);assert.equal((await all(f)).length,0);
});

test('acknowledgement retry after transport failure reuses the mutation receipt and cannot roll back a newer draft',async t=>{
 const f=await fixture(t);await f.engine.process(f.message('SBER 312 307 325'));const publish=f.callback('Опубликовать');f.setDeliveryFailure();await assert.rejects(f.engine.process(publish),/Synthetic transport/);assert.equal((await all(f)).length,1);const saved=f.session;assert.equal(saved.type,'record');await f.engine.process(f.message('GAZP 150 140 180'));const next=f.session.nonce;await f.engine.process(publish);assert.equal((await all(f)).length,1);assert.equal(f.session.nonce,next);assert.equal(f.session.signal.ticker,'GAZP');assert.match(f.last().payload.text,/Сигнал опубликован/);
});

test('revoked administrator cannot use an existing preview or receive private card replay',async t=>{
 const f=await fixture(t);await f.engine.process(f.message('SBER 312 307 325'));const publish=f.callback('Опубликовать');f.revoke();const count=f.sent.length;await f.engine.process(publish);assert.equal(f.sent.length,count);assert.equal((await f.ideas.list({id:f.identity.id,role:'admin'})).records.length,0);
});

test('quote warning is optional and appears only for a recent explicit non-demo quote',async t=>{
 const f=await fixture(t,{quoteProvider:async()=>({price:200,asOf:'2026-11-02T11:59:00.000Z',isDemo:false})});await f.engine.process(f.message('SBER 312 307 325'));assert.match(f.last().payload.text,/Вход отличается от котировки 200/);
 const demo=await fixture(t,{quoteProvider:async()=>({price:200,asOf:'2026-11-02T11:59:00.000Z',isDemo:true})});await demo.engine.process(demo.message('SBER 312 307 325'));assert.ok(!demo.last().payload.text.includes('Вход отличается'));
});

test('canonical hashed connect and its retry remain usable without persisting the raw code in receipts',async t=>{
 const f=await fixture(t);const update=f.message('/connect',{connectCodeHash:'fixture-code-hash'});await f.engine.process(update);assert.match(f.last().payload.text,/Telegram подключён/);await f.engine.process(update);assert.match(f.last().payload.text,/Telegram подключён/);assert.ok(!JSON.stringify([...f.receipts.values()]).includes('fixture-code-hash'));
 await f.engine.process(f.message('/settings'));assert.ok(f.last().payload.reply_markup.inline_keyboard.flat().some(b=>b.url==='https://orbita.example/telegram-admin.html'));
});

test('guided creation saves a resumable signal draft and publishes the same ID with range, targets and details',async t=>{
 const f=await fixture(t),send=text=>f.engine.process(f.message(text)),click=label=>f.engine.process(f.callback(label));
 await send('/new');await click('EXCLUSIVE');await click('Акции');await send('SBER');await click('LONG');await click('Диапазон');
 await send('300 320');await send('290');await send('330');await send('340 360');await send('1–5 дней');
 const comment='Проверенный комментарий автора. '.repeat(25).trim();
 await send(comment);await send('https://example.org/sber');
 assert.match(f.last().payload.text,/Диапазон 300–320/);
 assert.match(f.last().payload.text,/Дополнительные цели: 340 · 360/);
 await click('Сохранить черновик');
 const [draft]=await all(f);
 assert.equal(draft.published,false);assert.equal(draft.d.entry,310);assert.deepEqual(draft.d.targets,[340,360]);assert.equal(draft.d.thesis,comment);
 await send('/drafts');await click('SBER');await click('Продолжить черновик');
 assert.match(f.last().payload.text,/Диапазон 300–320/);
 await click('Опубликовать');
 const [published]=await all(f);
 assert.equal(published.id,draft.id);assert.equal(published.published,true);assert.equal(published.d.strategy,'Orbita Exclusive');
 assert.equal(published.d.chartUrl,'https://example.org/sber');assert.match(published.d.entryRule,/300–320/);
});

test('partial exit keeps the remainder active and early exit records weighted results and history',async t=>{
 const f=await fixture(t,{clockStart:Date.now()}),send=text=>f.engine.process(f.message(text)),click=label=>f.engine.process(f.callback(label));
 await send('SBER 100 90 120');await click('Опубликовать');await click('Подтвердить вход');await click('Подтвердить');
 const [entered]=await all(f);
 f.advance(Date.parse(entered.meta.enteredAt)-f.now);
 await click('Частично закрыть');await send('110');await send('25');await click('Сейчас');await send('Зафиксировать часть результата');await click('Без комментария');
 assert.match(f.last().payload.text,/Остаток: 75%/);assert.equal((await all(f))[0].meta.closures,undefined);
 await click('Подтвердить');
 assert.equal((await all(f))[0].d.state,'active');assert.equal((await all(f))[0].meta.remainingPct,75);
 await click('Частично закрыть');await send('105');await send('75');
 assert.match(f.last().payload.text,/должен быть меньше остатка/);
 await send('/active');await click('SBER');await click('Закрыть досрочно');await send('96');await click('Сейчас');await send('Сменился сценарий');await click('Без комментария');await click('Подтвердить');
 const [closed]=await all(f);
 assert.equal(closed.d.state,'closed');assert.ok(Math.abs(closed.meta.finalResultPct+0.5)<1e-12);assert.equal(closed.meta.weightedExit,99.5);assert.equal(closed.meta.closures[1].priceOrigin,'admin');
 assert.match(f.last().payload.text,/Итог идеи: −0\.50%/);
 await click('История');assert.match(f.last().payload.text,/Сменился сценарий/);assert.match(f.last().payload.text,/25% по 110/);
});

test('administrative article, news, delivery and broadcast actions accept full editorial text through the engine',async t=>{
 const f=await fixture(t,{workflows:true}),send=text=>f.engine.process(f.message(text)),click=label=>f.engine.process(f.callback(label));
 await send('/start');assert.ok(f.findButton('Новости'));assert.ok(f.findButton('Статьи'));assert.ok(f.findButton('Рассылки'));assert.ok(f.findButton('Статистика'));
 await click('Статистика');assert.match(f.last().payload.text,/В очереди: 3/);
 await click('Рассылки');await click('Только EXCLUSIVE');const long='Редакционный обзор. '.repeat(65).trim();await send(long);
 assert.match(f.last().payload.text,/Предпросмотр · Только EXCLUSIVE/);const original=f.callback('Поставить в очередь');await f.engine.process(original);
 assert.equal(f.broadcasts.length,0);assert.match(f.last().payload.text,/Подтвердите рассылку/);
 f.grantBroadcast();await f.engine.process({...original,update_id:900});await f.engine.process({...original,update_id:900});
 assert.deepEqual(f.broadcasts,[{audience:'exclusive',text:long}]);
 await click('Новости');await click('Создать');await send('Новый материал редакции');await click('Акции');await send('Краткое описание материала.');await send(long);await send('https://example.org/news');
 await click('Предпросмотр');assert.match(f.last().payload.text,/https:\/\/example.org\/news/);
 await click('Сохранить черновик');assert.equal((await f.content.readNews(null)).items.length,0);
 await click('Аудитория');await click('Все');await click('Предпросмотр');await click('Опубликовать');await click('Подтвердить');
 assert.equal((await f.content.readNews(null)).items[0].title,'Новый материал редакции');
});

test('AI article is an editable draft with explicit sources and reaches entitled readers only after scheduled publication',async t=>{
 const replies=['Подробности уточняются, решение требует проверки.','Цена 111 ₽'];
 const calls=[];
 const ai=createArticleDraftClient({env:{TELEGRAM_EDITOR_AI_ENDPOINT:'https://example.org/ai'},request:async(url,input)=>{
  calls.push({url,input});return {contentType:'application/json',body:JSON.stringify({interpretation:replies.shift()})};
 }});
 const f=await fixture(t,{workflows:true,ai}),send=text=>f.engine.process(f.message(text)),click=label=>f.engine.process(f.callback(label));
 await send('/articles');await click('ИИ-черновик');await send('Факторы риска');await send('Компания опубликовала отчёт.');await send('https://example.org/report');
 assert.equal(calls[0].input.body.input.sources[0],'https://example.org/report');
 assert.match(f.last().payload.text,/ИИ-черновик/);assert.equal((await f.content.readArticles(f.identity)).lessons.length,0);
 await click('Название');await send('Новая редакция разбора');await click('Интерпретация');await send('Редактор сверил интерпретацию с материалами отчёта.');await click('Предпросмотр');
 assert.match(f.last().payload.text,/Факты, указанные редактором/);assert.match(f.last().payload.text,/Интерпретация · ИИ-черновик/);
 await click('Сохранить черновик');
 const [draft]=(await f.content.readAdmin(f.identity)).lessons.filter(row=>row.kind==='article');
 assert.equal(draft.title,'Новая редакция разбора');assert.equal(draft.published,false);assert.equal(draft.draftOrigin,'ai');
 assert.equal(draft.sections[0].text,'Компания опубликовала отчёт.');assert.match(draft.sections[1].text,/Редактор сверил/);
 await click('Аудитория');await click('Только EXCLUSIVE');await click('Предпросмотр');await click('Запланировать');
 const at=new Date(f.now+10000).toISOString();await send(at);await click('Подтвердить');
 assert.equal((await f.content.readArticles(f.identity)).lessons.length,0);
 f.advance(11000);assert.equal((await f.content.publishDue()).published,1);assert.equal((await f.content.publishDue()).published,0);
 const pro={id:'pro-fixture',role:'member',subscriptions:[{plan:'pro',expiresAt:new Date(f.now+86400000).toISOString()}]};
 assert.equal((await f.content.readArticles(pro)).lessons.length,0);
 assert.equal((await f.content.readArticle(f.identity,draft.id)).lesson.title,'Новая редакция разбора');
 await send('/articles');await click('ИИ-черновик');await send('Непроверенная цена');await send('Проверенный факт.');await send('https://example.org/report');
 assert.match(f.last().payload.text,/не вернул безопасный черновик/);assert.equal((await f.content.readAdmin(f.identity)).lessons.filter(row=>row.kind==='article').length,1);
});
