import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createTelegramAdminEngine} from '../lib/telegram-admin/engine.mjs';
import {createIdeas} from '../lib/ideas.mjs';

async function fixture(t,{instantPublish=false,strategy='Momentum RU',quoteProvider=null}={}){
 const directory=await mkdtemp(path.join(tmpdir(),'orbita-telegram-engine-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 let clock=Date.parse('2026-11-02T12:00:00.000Z'),alive=true,session=null,nextUpdate=1,messageId=1,deliveryFailure=false;
 const identity={id:'fixture-admin',role:'admin',bindingId:'fixture-binding',telegramUserId:'123456',chatId:'123456',authStamp:'fixture-stamp'},prefs={instantPublish,strategy},receipts=new Map(),audit=[],sent=[];
 const clone=value=>structuredClone(value),unauthorized=()=>Object.assign(Error('Access revoked'),{status:403});
 const store={
  async getIdentity(tg,chat){return alive&&tg===identity.telegramUserId&&chat===identity.chatId?clone(identity):null;},
  async authorize(value){if(!alive||value.bindingId!==identity.bindingId||value.authStamp!==identity.authStamp)throw unauthorized();return clone(identity);},
  async settings(value){await this.authorize(value);return clone(prefs);},
  async session(value){await this.authorize(value);return clone(session);},
  async saveSession(value,data){await this.authorize(value);session=clone(data);return clone(data);},
  async getReceipt(value,key){await this.authorize(value);return clone(receipts.get(key)??null);},
  async saveReceipt(value,key,data){await this.authorize(value);if(!receipts.has(key))receipts.set(key,clone(data));return clone(receipts.get(key));},
  async audit(value,action,id,detail){await this.authorize(value);audit.push({action,id,detail});},
  async connect(tg,chat,code){if(code!=='fixture-one-time-code'&&code?.codeHash!=='fixture-code-hash')throw unauthorized();alive=true;return clone(identity);}
 };
 const ideas=await createIdeas(directory),send=async(method,payload)=>{if(deliveryFailure&&method!=='answerCallbackQuery'){deliveryFailure=false;throw Object.assign(Error('Synthetic transport unavailable'),{code:'SYNTHETIC_UNAVAILABLE'});}sent.push({method,payload:clone(payload)});return {message_id:++messageId};};
 const engine=createTelegramAdminEngine({store,ideas,send,publicOrigin:'https://orbita.example',now:()=>clock,quoteProvider});
 t.after(()=>engine.close());
 const message=(text,extra={})=>({update_id:nextUpdate++,message:{message_id:++messageId,chat:{id:123456,type:'private'},from:{id:123456,is_bot:false},text},...extra});
 const last=()=>sent.filter(item=>item.method!=='answerCallbackQuery').at(-1);
 const findButton=label=>last().payload.reply_markup?.inline_keyboard.flat().find(item=>item.text.includes(label));
 const callback=label=>{const item=findButton(label);assert.ok(item?.callback_data,'Missing callback '+label+' in '+last().payload.text);return {update_id:nextUpdate++,callback_query:{id:'query-'+nextUpdate,from:{id:123456,is_bot:false},message:{message_id:++messageId,chat:{id:123456,type:'private'}},data:item.callback_data}};};
 return {engine,ideas,identity,prefs,store,sent,audit,receipts,message,callback,last,findButton,get session(){return clone(session);},get now(){return clock;},advance(ms){clock+=ms;},revoke(){alive=false;},setDeliveryFailure(){deliveryFailure=true;},replaceBinding(){identity.bindingId='new-binding';identity.authStamp='new-stamp';}};
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

test('instant publishing is opt-in and an existing idea still requires a duplicate confirmation',async t=>{
 const f=await fixture(t,{instantPublish:true});await f.engine.process(f.message('SBER 312 307 325'));assert.equal((await all(f)).length,1);await f.engine.process(f.message('SBER 315 310 330'));assert.equal((await all(f)).length,1);assert.match(f.last().payload.text,/уже есть сигнал/);await f.engine.process(f.callback('Создать ещё один'));assert.equal((await all(f)).length,2);
 f.prefs.instantPublish=false;await f.engine.process(f.message('GAZP 150 140 180'));assert.equal((await all(f)).length,2);assert.match(f.last().payload.text,/Новый сигнал/);
});

test('changing stop and take requires confirmation and updates existing events through the shared service',async t=>{
 const f=await fixture(t);await f.engine.process(f.message('SBER 312 307 325'));await f.engine.process(f.callback('Опубликовать'));await f.engine.process(f.callback('Изменить стоп'));await f.engine.process(f.message('309'));assert.equal((await all(f))[0].d.stop,307);await f.engine.process(f.callback('Подтвердить'));assert.equal((await all(f))[0].d.stop,309);assert.equal((await all(f))[0].meta.events.at(-1)[3].type,'stop-change');
 await f.engine.process(f.callback('Изменить тейк'));await f.engine.process(f.message('330'));assert.equal((await all(f))[0].d.target,325);await f.engine.process(f.callback('Подтвердить'));assert.equal((await all(f))[0].d.target,330);assert.equal((await all(f))[0].meta.events.at(-1)[3].type,'target-change');
});

test('author activation and closing need independent confirmation and calculate direction-aware result',async t=>{
 const f=await fixture(t);await f.engine.process(f.message('SBER SHORT 312.5 318 300'));await f.engine.process(f.callback('Опубликовать'));assert.equal(f.findButton('Закрыть сигнал'),undefined);await f.engine.process(f.callback('Подтвердить вход'));assert.equal((await all(f))[0].d.state,'waiting');await f.engine.process(f.callback('Подтвердить'));assert.equal((await all(f))[0].d.state,'active');await f.engine.process(f.callback('Закрыть сигнал'));await f.engine.process(f.message('300'));assert.match(f.last().payload.text,/Результат автора: \+4\.00%/);assert.equal((await all(f))[0].d.state,'active');await f.engine.process(f.callback('Закрыть'));const record=(await all(f))[0];assert.equal(record.d.state,'closed');assert.equal(record.meta.exit,300);
});

test('concurrent website updates invalidate the pending Telegram action without overwriting current levels',async t=>{
 const f=await fixture(t);await f.engine.process(f.message('SBER 312 307 325'));await f.engine.process(f.callback('Опубликовать'));await f.engine.process(f.callback('Изменить стоп'));await f.engine.process(f.message('309'));const pending=f.callback('Подтвердить'),record=(await all(f))[0];await f.ideas.update(f.identity,record.id,{action:'stop-change',price:308,note:'Изменение через сайт.'});await f.engine.process(pending);assert.equal((await all(f))[0].d.stop,308);assert.match(f.last().payload.text,/Данные изменились/);
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
