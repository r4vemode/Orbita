import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {activeIdeaFingerprint,createIdeas,validateIdeasDatabase} from '../lib/ideas.mjs';

const admin={id:'fixture-editor',role:'admin',subscriptions:[]};
const pro={id:'fixture-pro',role:'member',subscriptions:[{plan:'pro',expiresAt:'2099-01-01T00:00:00.000Z'}]};
const exclusive={id:'fixture-exclusive',role:'member',subscriptions:[{plan:'exclusive',expiresAt:'2099-01-01T00:00:00.000Z'}]};
const full=(d={})=>({mode:'full',d:{ticker:'SBER',dir:'ЛОНГ',entry:312.5,stop:307,target:325,entryRule:'Ожидается подтверждение автора.',cancelRule:'Выход по стопу или отмена автора.',...d}});
const context=(operationId='fixture:create',overrides={})=>({createdVia:'TELEGRAM',operationId,telegramChatId:'123456789',telegramMessageId:123,authorize:async()=>admin,...overrides});
const rejects=(promise,status)=>assert.rejects(promise,cause=>cause.status===status);
async function fixture(t){const directory=await mkdtemp(join(tmpdir(),'orbita-tg-ideas-'));t.after(()=>rm(directory,{recursive:true,force:true}));return {directory,ideas:await createIdeas(directory)};}

test('Telegram publication uses the common idea store and subscriber gates without inventing an execution',async t=>{
 const {ideas,directory}=await fixture(t),created=await ideas.create(admin,full(),context()),record=created.record;
 assert.equal(created.revision,1);assert.equal(record.recordVersion,1);assert.equal(record.createdVia,'TELEGRAM');assert.equal(record.createdByUserId,admin.id);
 assert.equal(record.d.state,'waiting');assert.equal(record.meta.enteredAt,undefined);assert.equal(record.meta.events.length,1);assert.equal(record.meta.events[0][3].via,'TELEGRAM');
 assert.equal(record.telegram.chatId,'123456789');assert.equal(record.telegram.messageId,123);assert.equal(record.telegram.operations.length,1);
 const visible=await ideas.get(record.id,pro);assert.equal(visible.id,record.id);assert.equal(visible.d.entry,312.5);assert.equal(visible.telegram,undefined);assert.equal(visible.createdByUserId,undefined);
 assert.equal(JSON.stringify(visible).includes('123456789'),false);assert.equal((await ideas.list(pro)).records[0].telegram,undefined);
 await rejects(ideas.get(record.id,exclusive),404);await rejects(ideas.list(null),401);
 const restarted=await createIdeas(directory);assert.deepEqual(await restarted.get(record.id,admin),record);
});

test('duplicate Telegram deliveries across independent service instances publish exactly one idea',async t=>{
 const {ideas,directory}=await fixture(t),second=await createIdeas(directory);let authorizations=0;
 const options=context('tg:stable-binding:123:create',{authorize:async()=>{authorizations++;return admin;}});
 const results=await Promise.all([ideas.create(admin,full(),options),second.create(admin,full(),options)]);
 assert.equal(results[0].record.id,results[1].record.id);assert.equal(authorizations,2);assert.equal(results[0].revision,1);assert.equal(results[1].revision,1);
 const db=await ideas.list(admin);assert.equal(db.records.length,1);assert.equal(db.records[0].meta.events.length,1);assert.equal(db.records[0].telegram.operations.length,1);
});

test('create replay ignores a stale global revision but rejects a changed request and still checks current authorization',async t=>{
 const {ideas}=await fixture(t),payload={...full(),revision:0},options=context();
 const created=await ideas.create(admin,payload,options),note=await ideas.update(admin,created.record.id,{action:'note',note:'Дополнение через сайт.'});
 const replay=await ideas.create(admin,{d:payload.d,revision:0,mode:'full'},options);assert.equal(replay.record.id,created.record.id);assert.equal(replay.revision,note.revision);assert.equal(replay.record.meta.events.length,2);
 await rejects(ideas.create(admin,full({entry:313}),options),409);
 await rejects(ideas.create(admin,payload,{...options,authorize:async()=>({...admin,role:'member'})}),403);
 await rejects(ideas.create(admin,payload,{...options,authorize:async()=>null}),401);
 assert.equal((await ideas.list(admin)).revision,note.revision);
});

test('Telegram update versions concern the chosen record, preserve history and remain idempotent after a web change',async t=>{
 const {ideas}=await fixture(t),created=await ideas.create(admin,full(),context()),initial=structuredClone(created.record.meta.initial);
 await ideas.create(admin,full({ticker:'GAZP'}));
 const options=context('tg:binding:124:stop',{expectedRecordVersion:1}),payload={action:'stop-change',price:309,note:'Новый стоп из Telegram.'};
 const changed=await ideas.update(admin,created.record.id,payload,options);assert.equal(changed.record.recordVersion,2);assert.equal(changed.record.d.stop,309);assert.equal(changed.record.meta.events.at(-1)[3].via,'TELEGRAM');
 const web=await ideas.update(admin,created.record.id,{action:'note',note:'Комментарий из веб-редакции.'});assert.equal(web.record.recordVersion,3);assert.equal(web.record.meta.events.at(-1)[3].via,'WEB');
 const replay=await ideas.update(admin,created.record.id,payload,options);assert.equal(replay.revision,web.revision);assert.equal(replay.record.meta.events.length,3);assert.deepEqual(replay.record.meta.initial,initial);
 await rejects(ideas.update(admin,created.record.id,{action:'target-change',price:330,note:'Устаревшая карточка.'},context('tg:binding:125:take',{expectedRecordVersion:2})),409);
 await rejects(ideas.update(admin,created.record.id,{...payload,price:310},options),409);
});

test('role revocation, account replacement and missing trusted authorization prevent both first writes and replays',async t=>{
 const {ideas}=await fixture(t);let live=admin;
 const options=context('tg:binding:guard:create',{authorize:async()=>live});
 live={...admin,role:'member'};await rejects(ideas.create(admin,full(),options),403);assert.equal((await ideas.list(admin)).revision,0);
 live={...admin,id:'another-editor'};await rejects(ideas.create(admin,full(),options),403);
 live=admin;const record=(await ideas.create(admin,full(),options)).record;
 live={...admin,role:'member'};await rejects(ideas.create(admin,full(),options),403);
 await rejects(ideas.update(admin,record.id,{action:'note',note:'Нет доступа.'},context('tg:binding:guard:note',{authorize:async()=>live})),403);
 await rejects(ideas.create(admin,full(),context('tg:missing-auth',{authorize:undefined})),400);
 assert.equal((await ideas.list(admin)).revision,1);
});

test('new target events respect long and short geometry, keep initial conditions and use the existing close lifecycle',async t=>{
 const {ideas}=await fixture(t),long=(await ideas.create(admin,full(),context())).record,original=structuredClone(long.meta.initial);
 const next=await ideas.update(admin,long.id,{action:'target-change',price:330,note:'Новая цель.'},context('tg:target:long',{expectedRecordVersion:1}));
 assert.equal(next.record.d.target,330);assert.deepEqual(next.record.meta.initial,original);assert.equal(next.record.meta.events.at(-1)[3].before.target,325);assert.equal(next.record.meta.events.at(-1)[3].after.target,330);
 for(const price of [312.5,300,0,Infinity])await rejects(ideas.update(admin,long.id,{action:'target-change',price,note:'Неверно.'}),400);
 await ideas.update(admin,long.id,{action:'activate',note:'Вход подтверждён.'},context('tg:activate'));
 await ideas.update(admin,long.id,{action:'stop-change',price:320,note:'Зафиксировать часть движения.'});
 await rejects(ideas.update(admin,long.id,{action:'target-change',price:318,note:'Цель за стопом.'}),400);
 const closed=await ideas.update(admin,long.id,{action:'manual',price:324.7,note:'Закрытие подтверждено.'},context('tg:close'));
 assert.equal(closed.record.d.state,'closed');assert.equal(closed.record.meta.exit,324.7);assert.deepEqual(closed.record.meta.initial,original);
 await rejects(ideas.update(admin,long.id,{action:'target-change',price:350,note:'Слишком поздно.'}),400);
 const short=(await ideas.create(admin,full({dir:'ШОРТ',stop:318,target:300}),context('tg:create:short'))).record;
 await rejects(ideas.update(admin,short.id,{action:'target-change',price:315,note:'Неверная цель.'}),400);
 const shortTake=await ideas.update(admin,short.id,{action:'target-change',price:290,note:'Перенести цель.'},context('tg:target:short'));
 assert.equal(shortTake.record.d.target,290);assert.equal(shortTake.record.meta.events.at(-1)[3].via,'TELEGRAM');
});

test('untrusted payloads cannot forge provenance, operations or record versions',async t=>{
 const {ideas}=await fixture(t);
 for(const injected of [{createdVia:'TELEGRAM'},{telegram:{chatId:'123456789'}},{recordVersion:100},{createdByUserId:admin.id},{operationId:'tg:fake'}])await rejects(ideas.create(admin,{...full(),...injected}),400);
 for(const options of [context('bad space'),context('tg:bad',{telegramChatId:'-123'}),context('tg:bad',{telegramMessageId:0}),context('tg:bad',{expectedRecordVersion:-1}),{createdVia:'TELEGRAM'}, {operationId:'tg:fake'},{createdVia:'OTHER'}])await rejects(ideas.create(admin,full(),options),400);
 assert.deepEqual(await ideas.list(admin),{revision:0,records:[]});
});

test('legacy record token zero becomes a persisted per-record version without reconstructing history',async t=>{
 const {ideas,directory}=await fixture(t),record=(await ideas.create(admin,full())).record,file=join(directory,'ideas.json');
 const db=JSON.parse(await readFile(file,'utf8'));delete db.records[0].recordVersion;delete db.records[0].createdVia;delete db.records[0].createdByUserId;await writeFile(file,JSON.stringify(db));
 const service=await createIdeas(directory),changed=await service.update(admin,record.id,{action:'note',note:'Первое изменение старой записи.'},context('tg:legacy:note',{expectedRecordVersion:0}));
 assert.equal(changed.record.recordVersion,1);assert.deepEqual(changed.record.meta.initial,record.meta.initial);assert.deepEqual(changed.record.meta.events[0],record.meta.events[0]);
 await rejects(service.update(admin,record.id,{action:'note',note:'Старая карточка.'},context('tg:legacy:stale',{expectedRecordVersion:0})),409);
});

test('operation history has a finite fail-closed limit without deleting published records or blocking web management',async t=>{
 const {ideas,directory}=await fixture(t),record=(await ideas.create(admin,full(),context())).record,file=join(directory,'ideas.json');
 const db=JSON.parse(await readFile(file,'utf8')),hash=text=>createHash('sha256').update(text).digest('hex');
 for(let i=1;i<1024;i++)db.records[0].telegram.operations.push({id:hash('synthetic-op-'+i),actorId:admin.id,kind:'update',fingerprint:hash('synthetic-body-'+i)});
 assert.equal(validateIdeasDatabase(db),true);await writeFile(file,JSON.stringify(db));const service=await createIdeas(directory);
 await rejects(service.update(admin,record.id,{action:'target-change',price:330,note:'За пределом журнала.'},context('tg:limit')),409);
 assert.equal((await service.get(record.id,admin)).d.target,325);assert.equal((await service.get(record.id,admin)).recordVersion,1);
 const web=await service.update(admin,record.id,{action:'target-change',price:330,note:'Продолжение через веб.'});assert.equal(web.record.d.target,330);
 const oldReplay=await service.create(admin,full(),context());assert.equal(oldReplay.record.id,record.id);assert.equal(oldReplay.revision,web.revision);
 await rejects(service.remove(admin,record.id),409);
});

test('malformed Telegram metadata fails storage validation and never becomes public data',async t=>{
 const {ideas,directory}=await fixture(t);await ideas.create(admin,full(),context());const file=join(directory,'ideas.json'),original=JSON.parse(await readFile(file,'utf8'));
 for(const corrupt of [db=>{db.records[0].telegram.chatId='prefix123';},db=>{db.records[0].telegram.operations.push(db.records[0].telegram.operations[0]);},db=>{db.records[0].recordVersion=-1;}]){
  const db=structuredClone(original);corrupt(db);assert.equal(validateIdeasDatabase(db),false);const bytes=JSON.stringify(db);await writeFile(file,bytes);await assert.rejects(createIdeas(directory),cause=>cause.code==='DATA_INVALID');assert.equal(await readFile(file,'utf8'),bytes);
 }
});

test('web terms corrections before entry retain the initial publication and journal complete before/after rules',async t=>{
 const {ideas}=await fixture(t),published=(await ideas.create(admin,full(),context())).record,initial=structuredClone(published.meta.initial),first=structuredClone(published.meta.events[0]);
 const changed=await ideas.update(admin,published.id,{action:'terms-change',note:'Исправлена цена до подтверждения входа.',d:{entry:313,stop:308,target:330,entryRule:'Подтверждение уровня 313.',cancelRule:'Отмена при потере 308.'}});
 const record=changed.record,event=record.meta.events.at(-1);
 assert.equal(record.createdVia,'TELEGRAM');assert.equal(record.d.state,'waiting');assert.equal(record.recordVersion,2);assert.equal(record.d.current,313);assert.equal(record.d.chartPlaceholder,true);
 assert.deepEqual(record.meta.initial,initial);assert.deepEqual(record.meta.events[0],first);assert.equal(event[3].type,'terms-change');assert.equal(event[3].via,'WEB');
 assert.equal(event[3].before.entry,312.5);assert.equal(event[3].after.entry,313);assert.equal(event[3].before.entryRule,full().d.entryRule);assert.equal(event[3].after.entryRule,'Подтверждение уровня 313.');assert.equal(event[3].after.cancelRule,'Отмена при потере 308.');
 assert.equal(record.meta.entryRule,event[3].after.entryRule);assert.equal(record.meta.cancelRule,event[3].after.cancelRule);
 const rulesOnly=await ideas.update(admin,published.id,{action:'terms-change',note:'Уточнено подтверждение.',d:{entryRule:'Ждём отдельный комментарий автора.'}});
 assert.equal(rulesOnly.record.d.entry,313);assert.equal(rulesOnly.record.d.stop,308);assert.equal(rulesOnly.record.d.target,330);assert.deepEqual(rulesOnly.record.meta.initial,initial);
 await ideas.update(admin,published.id,{action:'activate',note:'Подтверждение по новым условиям.'});
 await rejects(ideas.update(admin,published.id,{action:'terms-change',note:'Не переписывать исполненный вход.',d:{entry:315}}),400);
 const closed=await ideas.update(admin,published.id,{action:'manual',note:'Закрытие.',price:329});
 await rejects(ideas.update(admin,published.id,{action:'terms-change',note:'Не переписывать закрытую историю.',d:{entry:315}}),400);
 assert.equal((await ideas.get(published.id,admin)).meta.exit,closed.record.meta.exit);
});

test('web description edits on closed Telegram ideas preserve trade outcome and append auditable original text',async t=>{
 const {ideas}=await fixture(t),created=(await ideas.create(admin,full({summary:'Первоначальный краткий разбор.'}),context())).record;
 await ideas.update(admin,created.id,{action:'activate',note:'Подтверждён вход.'});const closed=(await ideas.update(admin,created.id,{action:'manual',price:306,note:'Убыточное закрытие.'})).record;
 const updated=(await ideas.update(admin,created.id,{action:'description',note:'Добавлен разбор итогов.',d:{title:'SBER: итог сделки',summary:'Разбор после закрытия.',thesis:'Причина закрытия и выводы.',name:'Сбербанк',horizon:'Несколько дней'}})).record;
 for(const field of ['entry','stop','target','state','outcome','current'])assert.equal(updated.d[field],closed.d[field]);
 assert.equal(updated.meta.exit,306);assert.equal(updated.meta.closedAt,closed.meta.closedAt);assert.deepEqual(updated.meta.initial,closed.meta.initial);assert.deepEqual(updated.meta.events.slice(0,-1),closed.meta.events);
 const event=updated.meta.events.at(-1);assert.equal(event[3].type,'description');assert.equal(event[3].before.summary,'Первоначальный краткий разбор.');assert.equal(event[3].after.summary,'Разбор после закрытия.');assert.equal(event[3].after.thesis,'Причина закрытия и выводы.');
 await ideas.update(admin,created.id,{action:'error',note:'Публикация отмечена отдельно.'});
 await rejects(ideas.update(admin,created.id,{action:'description',note:'Не переписываем ошибочную публикацию.',d:{summary:'Иной текст.'}}),400);
});

test('terms and description actions reject no-ops, missing reasons, incompatible levels and fields outside their explicit scope',async t=>{
 const {ideas}=await fixture(t),record=(await ideas.create(admin,full(),context())).record,before=await ideas.get(record.id,admin);
 for(const payload of [
  {action:'terms-change',d:{entry:313}},
  {action:'terms-change',note:'Без изменений.',d:{}},
  {action:'terms-change',note:'Без изменений.',d:{entry:312.5}},
  {action:'terms-change',note:'Нет подтверждения.',d:{entryRule:''}},
  {action:'terms-change',note:'Неверная геометрия.',d:{entry:306}},
  {action:'terms-change',note:'Неверная цена.',d:{target:Infinity}},
  {action:'terms-change',note:'Нельзя менять инструмент.',d:{ticker:'GAZP'}},
  {action:'terms-change',note:'Нельзя менять направление.',d:{dir:'ШОРТ'}},
  {action:'terms-change',note:'Нельзя менять стратегию.',d:{strategy:'Orbita Exclusive'}},
  {action:'terms-change',note:'Цена должна быть внутри d.',entry:313},
  {action:'description',note:'Без изменений.',d:{}},
  {action:'description',d:{summary:'Нет причины.'}},
  {action:'description',note:'Без изменений.',d:{title:record.d.title}},
  {action:'description',note:'Не изменяет цену.',d:{entry:1}},
  {action:'description',note:'Не изменяет историю.',d:{initial:{entry:1}}},
  {action:'description',note:'Поля только внутри d.',summary:'Текст.'},
  {action:'note',note:'Не обходит условия.',d:{entry:313}}
 ])await rejects(ideas.update(admin,record.id,payload),400);
 assert.deepEqual(await ideas.get(record.id,admin),before);
 const announced=(await ideas.create(admin,{mode:'quick',d:{ticker:'GAZP',dir:'ЛОНГ'}})).record;
 await rejects(ideas.update(admin,announced.id,{action:'terms-change',note:'Сначала полные уровни.',d:{entry:100,stop:90,target:110}}),400);
});

test('publication atomically rechecks active duplicates while unrelated instruments and idempotent replays remain valid',async t=>{
 const {ideas,directory}=await fixture(t),web=await createIdeas(directory);
 const initial=activeIdeaFingerprint((await ideas.list(admin)).records,'stocks','sber');assert.equal(initial,'');
 // A website publication wins the lock after Telegram checked for duplicates.
 const concurrent=(await web.create(admin,full())).record;
 await rejects(ideas.create(admin,full(),context('tg:duplicate-race',{expectedDuplicateFingerprint:initial})),409);
 assert.equal((await ideas.list(admin)).records.length,1);
 const confirmed=activeIdeaFingerprint((await ideas.list(admin)).records,'stocks','SBER');assert.equal(confirmed,concurrent.id+':1');
 await web.create(admin,full({ticker:'GAZP'}));
 const published=await ideas.create(admin,full(),context('tg:duplicate-confirmed',{expectedDuplicateFingerprint:confirmed}));assert.equal(published.record.d.ticker,'SBER');
 const revision=published.revision;
 const replay=await ideas.create(admin,full(),context('tg:duplicate-confirmed',{expectedDuplicateFingerprint:initial}));assert.equal(replay.record.id,published.record.id);assert.equal(replay.revision,revision);
 const beforeChange=activeIdeaFingerprint((await ideas.list(admin)).records,'stocks','SBER');
 await web.update(admin,concurrent.id,{action:'note',note:'Карточка изменилась после предупреждения.'});
 await rejects(ideas.create(admin,full(),context('tg:duplicate-edited',{expectedDuplicateFingerprint:beforeChange})),409);
});

test('duplicate fingerprint excludes archived, erroneous, demo and other-market records and cannot be supplied by a web payload',async t=>{
 const base={id:'real',published:true,recordVersion:3,d:{state:'waiting',market:'stocks',ticker:'SBER'}};
 const records=[base,{...base,id:'older',recordVersion:undefined},{...base,id:'demo-copy',demo:false},{...base,id:'exclusive-copy'},{...base,id:'explicit-demo',isDemo:true},{...base,id:'marked-demo',demo:true},{...base,id:'closed',d:{...base.d,state:'closed'}},{...base,id:'cancelled',d:{...base.d,state:'cancelled'}},{...base,id:'error',erroneous:true},{...base,id:'draft',published:false},{...base,id:'crypto',d:{...base.d,market:'crypto'}},{...base,id:'other',d:{...base.d,ticker:'SBERP'}}];
 assert.equal(activeIdeaFingerprint(records,'stocks','sber'),'older:0|real:3');
 assert.equal(activeIdeaFingerprint(null,'stocks','SBER'),'');
 const {ideas}=await fixture(t);
 for(const expectedDuplicateFingerprint of [null,1,'x'.repeat(64001)])await rejects(ideas.create(admin,full(),context('tg:bad-duplicate',{expectedDuplicateFingerprint})),400);
 await rejects(ideas.create(admin,full(),{expectedDuplicateFingerprint:''}),400);
 await rejects(ideas.create(admin,{...full(),expectedDuplicateFingerprint:''}),400);
 const record=(await ideas.create(admin,full())).record;
 await rejects(ideas.update(admin,record.id,{action:'note',note:'Не относится к публикации.'},context('tg:bad-update',{expectedDuplicateFingerprint:''})),400);
});

test('optional chart links normalize HTTPS and keep the original chart and each replacement in published history',async t=>{
 const {ideas,directory}=await fixture(t),url='https://charts.example.test/view?symbol=SBER#daily';
 const created=(await ideas.create(admin,full({chartUrl:' HTTPS://CHARTS.EXAMPLE.TEST:443/view?symbol=SBER#daily '}),context())).record;
 assert.equal(created.d.chartUrl,url);assert.equal(created.meta.initial.chartUrl,url);assert.equal(created.meta.events[0][3].after.chartUrl,url);
 assert.equal((await ideas.get(created.id,pro)).d.chartUrl,url);
 const changed=(await ideas.update(admin,created.id,{action:'description',note:'Обновлён график.',d:{chartUrl:'https://charts.example.test/new'}})).record,event=changed.meta.events.at(-1);
 assert.equal(changed.d.chartUrl,'https://charts.example.test/new');assert.equal(event[3].before.chartUrl,url);assert.equal(event[3].after.chartUrl,changed.d.chartUrl);assert.equal(changed.meta.initial.chartUrl,url);
 const removed=(await ideas.update(admin,created.id,{action:'description',note:'Ссылка больше не актуальна.',d:{chartUrl:''}})).record;
 assert.equal(removed.d.chartUrl,'');assert.equal(removed.meta.events.at(-1)[3].before.chartUrl,'https://charts.example.test/new');assert.equal(removed.meta.events.at(-1)[3].after.chartUrl,'');assert.equal(removed.meta.initial.chartUrl,url);assert.deepEqual(removed.meta.events[0],created.meta.events[0]);
 const restarted=await createIdeas(directory);assert.deepEqual(await restarted.get(created.id,admin),removed);
 const draft=(await ideas.create(admin,{mode:'draft',d:{chartUrl:'https://charts.example.test'}})).record;assert.equal(draft.d.chartUrl,'https://charts.example.test/');
});

test('chart links reject executable, insecure, credentialed, oversized and malformed addresses without changing an idea',async t=>{
 const {ideas}=await fixture(t),bad=['javascript:alert(1)','data:text/html,test','file:///tmp/chart','http://charts.example.test','//charts.example.test','https://user:password@charts.example.test','https://user@charts.example.test','https://charts.example.test/a\nb','https://charts.example.test/'+'x'.repeat(2048),null,1];
 for(const chartUrl of bad){await rejects(ideas.create(admin,full({chartUrl})),400);await rejects(ideas.create(admin,{mode:'draft',d:{chartUrl}}),400);}
 assert.equal((await ideas.list(admin)).revision,0);
 const record=(await ideas.create(admin,full())).record;
 for(const chartUrl of bad)await rejects(ideas.update(admin,record.id,{action:'description',note:'Недопустимая ссылка.',d:{chartUrl}}),400);
 assert.deepEqual(await ideas.get(record.id,admin),record);
});

test('legacy records without chart metadata stay unchanged on load and do not gain fabricated chart history',async t=>{
 const {ideas,directory}=await fixture(t),created=(await ideas.create(admin,full())).record,file=join(directory,'ideas.json'),bytes=await readFile(file,'utf8');
 assert.equal(Object.hasOwn(created.d,'chartUrl'),false);assert.equal(Object.hasOwn(created.meta.initial,'chartUrl'),false);assert.equal(validateIdeasDatabase(JSON.parse(bytes)),true);
 const restarted=await createIdeas(directory);assert.deepEqual(await restarted.get(created.id,admin),created);assert.equal(await readFile(file,'utf8'),bytes);
 await rejects(restarted.update(admin,created.id,{action:'description',note:'Ссылка уже пустая.',d:{chartUrl:''}}),400);
 const changed=(await restarted.update(admin,created.id,{action:'description',note:'Добавлен текст без графика.',d:{summary:'Новый текст.'}})).record;
 assert.equal(Object.hasOwn(changed.d,'chartUrl'),false);assert.equal(Object.hasOwn(changed.meta.initial,'chartUrl'),false);assert.equal(Object.hasOwn(changed.meta.events.at(-1)[3].before,'chartUrl'),false);assert.equal(Object.hasOwn(changed.meta.events.at(-1)[3].after,'chartUrl'),false);
 const db=JSON.parse(await readFile(file,'utf8'));db.records[0].d.chartUrl='javascript:alert(1)';assert.equal(validateIdeasDatabase(db),false);
});
