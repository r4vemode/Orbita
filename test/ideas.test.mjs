import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createIdeas} from '../lib/ideas.mjs';

const admin={id:'editor',role:'admin',subscriptions:[]};
const subscriber=plan=>({id:plan,role:'user',subscriptions:[{plan,expiresAt:'2099-01-01T00:00:00.000Z'}]});
const pro=subscriber('pro'),exclusive=subscriber('exclusive');
const noPlan={id:'unpaid',role:'user',subscriptions:[]};
const expired={id:'expired',role:'user',subscriptions:[{plan:'pro',expiresAt:'2000-01-01T00:00:00.000Z'}]};
const rejected=(promise,status)=>assert.rejects(promise,error=>error.status===status);
const full=(overrides={})=>({mode:'full',d:{ticker:'SBER',dir:'ЛОНГ',entry:310,stop:300,target:340,entryRule:'Закрепление выше входа.',cancelRule:'Выход при достижении стопа.',...overrides}});
async function fixture(t){const directory=await mkdtemp(join(tmpdir(),'orbita-ideas-'));t.after(()=>rm(directory,{recursive:true,force:true}));return {directory,ideas:await createIdeas(directory)}}

test('normal startup is empty and guests, unpaid and expired users receive no ideas',async t=>{
  const {ideas}=await fixture(t);assert.deepEqual(await ideas.list(admin),{revision:0,records:[]});
  for(const [user,status] of [[null,401],[noPlan,403],[expired,403]]){
    await rejected(ideas.list(user),status);await rejected(ideas.get('anything',user),status);
  }
  assert.deepEqual((await ideas.list(pro)).records,[]);
  for(const action of [()=>ideas.create(null,full()),()=>ideas.update(null,'id',{action:'note',note:'x'}),()=>ideas.remove(null,'id'),()=>ideas.importDemo(null)])await rejected(action(),401);
  for(const action of [()=>ideas.create(pro,full()),()=>ideas.update(pro,'id',{action:'note',note:'x'}),()=>ideas.remove(pro,'id'),()=>ideas.importDemo(pro)])await rejected(action(),403);
});

test('strategy entitlements are separate and drafts are visible only to administrators',async t=>{
  const {ideas}=await fixture(t);
  const regular=(await ideas.create(admin,full())).record;
  const special=(await ideas.create(admin,full({strategy:'Orbita Exclusive'}))).record;
  const draft=(await ideas.create(admin,{mode:'draft',d:{}})).record;
  assert.deepEqual((await ideas.list(pro)).records.map(r=>r.id),[regular.id]);
  assert.deepEqual((await ideas.list(exclusive)).records.map(r=>r.id),[special.id]);
  assert.equal((await ideas.list(admin)).records.length,3);
  assert.equal((await ideas.list({...pro,subscriptions:[...pro.subscriptions,...exclusive.subscriptions]})).records.length,2);
  await rejected(ideas.get(special.id,pro),404);await rejected(ideas.get(regular.id,exclusive),404);await rejected(ideas.get(draft.id,pro),404);
  assert.equal((await ideas.get(special.id,admin)).id,special.id);
});

test('quick publication needs only ticker and direction and never fabricates executable levels',async t=>{
  const {ideas}=await fixture(t),created=await ideas.create(admin,{mode:'quick',d:{ticker:'SBER',dir:'ЛОНГ'}}),r=created.record;
  assert.equal(created.revision,1);assert.equal(r.published,true);assert.equal(r.d.state,'announced');
  assert.equal(r.d.market,'stocks');assert.equal(r.d.strategy,'Momentum RU');assert.match(r.d.title,/SBER/);
  for(const field of ['entry','stop','target','current','min','max'])assert.equal(r.d[field],null);
  assert.deepEqual(r.d.points,[]);assert.equal(r.meta.initial.entry,null);assert.equal(r.meta.events[0][3].type,'published');
  for(const action of ['activate','manual','target','stop','stop-change'])await rejected(ideas.update(admin,r.id,{action,note:'Рано.',price:320}),400);
  assert.equal((await ideas.list(admin)).revision,1);
  const staleValues=(await ideas.create(admin,{mode:'quick',d:{ticker:'BTC/USDT',dir:'ШОРТ',market:'crypto',entry:100,stop:110,target:90}})).record;
  assert.equal(staleValues.d.entry,null);assert.equal(staleValues.d.stop,null);assert.equal(staleValues.d.target,null);
  assert.equal(staleValues.d.strategy,'Crypto Momentum');
});

test('strategy and market must match and omitted counterparts are inferred before publication',async t=>{
  const {ideas}=await fixture(t);
  const markets={'Momentum RU':'stocks','Trend RU':'stocks','Импульс':'futures','Crypto Momentum':'crypto','Crypto Trend':'crypto','Orbita Exclusive':'stocks'};
  for(const [strategy,market]of Object.entries(markets)){
    const mismatched=market==='stocks'?'crypto':'stocks';
    for(const mode of ['quick','full','draft']){
      const payload={...full({strategy,market:mismatched}),mode};
      await rejected(ideas.create(admin,payload),400);
    }
  }
  assert.equal((await ideas.list(admin)).revision,0,'invalid pairs do not write records or revisions');
  for(const [strategy,market]of Object.entries(markets)){
    for(const mode of ['quick','full']){
      const created=(await ideas.create(admin,{...full({strategy}),mode})).record;
      assert.equal(created.d.strategy,strategy);assert.equal(created.d.market,market);
    }
  }
  for(const [market,strategy]of Object.entries({stocks:'Momentum RU',futures:'Импульс',crypto:'Crypto Momentum'})){
    for(const mode of ['quick','full']){
      const created=(await ideas.create(admin,{...full({market}),mode})).record;
      assert.equal(created.d.market,market);assert.equal(created.d.strategy,strategy);
    }
  }
  const draft=(await ideas.create(admin,{mode:'draft',d:{ticker:'DRAFT'}})).record,before=await ideas.list(admin);
  await rejected(ideas.update(admin,draft.id,{mode:'full',d:full({market:'crypto',strategy:'Orbita Exclusive'}).d}),400);
  assert.deepEqual(await ideas.list(admin),before,'invalid draft publication preserves the stored draft');
});

test('quick signal gains levels in a dated event while its publication snapshot remains unchanged',async t=>{
  const {ideas}=await fixture(t);let r=(await ideas.create(admin,{mode:'quick',d:{ticker:'SBER',dir:'ЛОНГ'}})).record;
  const original=structuredClone(r.meta.initial),first=structuredClone(r.meta.events[0]);
  r=(await ideas.update(admin,r.id,{action:'note',note:'Разбор тренда.'})).record;
  assert.equal(r.d.state,'announced');assert.equal(r.meta.events.at(-1)[3].type,'note');
  await rejected(ideas.update(admin,r.id,{action:'levels',entry:310,stop:300,target:340}),400);
  r=(await ideas.update(admin,r.id,{action:'levels',d:{entry:310,stop:300,target:340,entryRule:'Подтверждение входа.',cancelRule:'Выход по стопу.'}})).record;
  assert.equal(r.d.state,'waiting');assert.deepEqual(r.meta.initial,original);assert.deepEqual(r.meta.events[0],first);
  assert.equal(r.meta.initialLevels.entry,310);assert.equal(r.meta.events.at(-1)[3].before.entry,null);assert.equal(r.meta.events.at(-1)[3].after.entry,310);
  assert.equal(r.meta.events.at(-1)[3].after.entryRule,'Подтверждение входа.');
  assert.equal(r.meta.events.at(-1)[3].type,'levels');
  await rejected(ideas.update(admin,r.id,{action:'levels',...full().d}),400);
  r=(await ideas.update(admin,r.id,{action:'activate',note:'Условие входа выполнено.'})).record;
  assert.equal(r.d.state,'active');assert.ok(r.meta.enteredAt);
});

test('published lifecycle is append-only and erroneous closed trades retain original outcome and exit',async t=>{
  const {ideas,directory}=await fixture(t);let r=(await ideas.create(admin,full())).record;
  const original=structuredClone(r.meta.initial),journal=structuredClone(r.meta.events);
  r=(await ideas.update(admin,r.id,{action:'activate',note:'Вход подтверждён.'})).record;
  r=(await ideas.update(admin,r.id,{action:'stop-change',note:'Защищаем позицию.',price:312})).record;
  const stop=r.meta.events.at(-1);assert.equal(stop[3].before.stop,300);assert.equal(stop[3].after.stop,312);assert.match(stop[2],/SBER: стоп изменён с 300 до 312 ₽/);
  r=(await ideas.update(admin,r.id,{action:'manual',note:'Закрытие позиции.',price:325})).record;
  const closed=structuredClone(r);
  r=(await ideas.update(admin,r.id,{action:'error',note:'Ошибочно опубликован инструмент.'})).record;
  assert.equal(r.erroneous,true);assert.equal(r.meta.errorReason,'Ошибочно опубликован инструмент.');assert.equal(r.meta.exit,325);assert.equal(r.d.state,'closed');assert.equal(r.d.outcome,'Закрыто вручную');
  assert.deepEqual(r.meta.initial,original);assert.deepEqual(r.meta.events.slice(0,journal.length),journal);assert.deepEqual(r.meta.events.slice(0,closed.meta.events.length),closed.meta.events);
  await rejected(ideas.remove(admin,r.id),409);await rejected(ideas.update(admin,r.id,{action:'stop-change',note:'Исправить.',price:305}),400);
  r=(await ideas.update(admin,r.id,{action:'note',note:'Пояснение к ошибке.'})).record;
  assert.equal(r.meta.exit,325);assert.equal(new Set(r.meta.events.map(e=>e[3].id)).size,r.meta.events.length);
  for(const [i,e] of r.meta.events.entries()){assert.match(e[0],/^\d{2}\.\d{2}\.\d{4} · \d{2}:\d{2}$/);assert.equal(new Date(e[3].at).toISOString(),e[3].at);if(i)assert.ok(e[3].at>=r.meta.events[i-1][3].at)}
  const restarted=await createIdeas(directory);assert.deepEqual(await restarted.get(r.id,admin),r);
});

test('short lifecycle closes at the revised stop and validates stop direction',async t=>{
  const {ideas}=await fixture(t);let r=(await ideas.create(admin,full({dir:'ШОРТ',stop:320,target:280}))).record;
  await rejected(ideas.update(admin,r.id,{action:'stop-change',note:'Неверный стоп до входа.',price:305}),400);
  r=(await ideas.update(admin,r.id,{action:'activate',note:'Вход в шорт.'})).record;
  r=(await ideas.update(admin,r.id,{action:'stop-change',note:'Защищаем прибыль.',price:305})).record;
  r=(await ideas.update(admin,r.id,{action:'stop',note:'Сработал стоп.'})).record;
  assert.equal(r.d.state,'closed');assert.equal(r.meta.exit,305);assert.equal(r.d.current,305);assert.equal(r.meta.initial.stop,320);
  await rejected(ideas.update(admin,r.id,{action:'activate',note:'Повтор.'}),400);
});

test('drafts can be saved, deleted or published while published cancellations remain in history',async t=>{
  const {ideas}=await fixture(t);let draft=(await ideas.create(admin,{mode:'draft',d:{}})).record;
  assert.equal(draft.published,false);assert.equal(draft.d.state,'draft');assert.equal(draft.meta.events.length,0);
  draft=(await ideas.update(admin,draft.id,{mode:'draft',d:{ticker:'SBER',entry:310}})).record;
  const createdAt=draft.createdAt;
  const published=(await ideas.update(admin,draft.id,{mode:'full',d:full().d})).record;
  assert.equal(published.id,draft.id);assert.equal(published.createdAt,createdAt);assert.equal(published.published,true);
  const cancelled=(await ideas.update(admin,published.id,{action:'cancel',note:'Условие отмены выполнено.'})).record;
  assert.equal(cancelled.d.state,'cancelled');assert.equal(cancelled.meta.exit,undefined);assert.equal(cancelled.meta.initial.entry,310);
  await rejected(ideas.remove(admin,cancelled.id),409);
  const other=(await ideas.create(admin,{mode:'draft',d:{ticker:'LKOH'}})).record;
  assert.equal((await ideas.remove(admin,other.id)).ok,true);await rejected(ideas.get(other.id,admin),404);
});

test('stale revisions conflict and no mutable API data can rewrite protected history',async t=>{
  const {ideas}=await fixture(t),created=await ideas.create(admin,full()),id=created.record.id;
  await rejected(ideas.create(admin,{...full(),revision:0}),409);
  await rejected(ideas.update(admin,id,{action:'note',note:'Старые данные.',revision:0}),409);
  const saved=await ideas.update(admin,id,{action:'note',note:'Свежий комментарий.',revision:created.revision});assert.equal(saved.revision,2);
  for(const payload of [{action:'note',note:'x',events:[]},{action:'note',note:'x',meta:{initial:{entry:1}}},{action:'note',note:'x',id:'replacement'},{action:'note',note:'x',entry:1},{mode:'full',d:full().d}])await rejected(ideas.update(admin,id,payload),400);
  const response=await ideas.get(id,admin);response.meta.initial.entry=1;response.meta.events.length=0;response.d.target=999;
  const persisted=await ideas.get(id,admin);assert.equal(persisted.meta.initial.entry,310);assert.equal(persisted.d.target,340);assert.equal(persisted.meta.events.length,2);assert.equal((await ideas.list(admin)).revision,2);
});

test('invalid numeric fields and malformed input never mutate the database',async t=>{
  const {ideas}=await fixture(t);
  for(const payload of [null,{},full({entry:Infinity}),full({stop:NaN}),full({target:0}),full({entry:'310'}),full({stop:315}),full({strategy:'Invented'}),full({ticker:'<script>'}),full({summary:'a'.repeat(351)}),full({id:'injected'}),{...full(),events:[]}])await rejected(ideas.create(admin,payload),400);
  assert.equal((await ideas.list(admin)).revision,0);
  const r=(await ideas.create(admin,full())).record;
  for(const p of [0,-1,NaN,Infinity,'305',340])await rejected(ideas.update(admin,r.id,{action:'stop-change',note:'Неверный стоп.',price:p}),400);
  await rejected(ideas.update(admin,r.id,{action:'note',note:'   '}),400);
  await rejected(ideas.update(admin,r.id,{action:'cancel',note:'x',revision:'1'}),409);
  assert.equal((await ideas.list(admin)).revision,1);
});

test('separate instances reload persisted state and serialize concurrent writers',async t=>{
  const {ideas,directory}=await fixture(t),second=await createIdeas(directory);
  await Promise.all(Array.from({length:12},(_,i)=>(i%2?ideas:second).create(admin,{mode:'quick',d:{ticker:'TEST'+i,dir:'ЛОНГ'}})));
  for(const instance of [ideas,second]){const result=await instance.list(admin);assert.equal(result.revision,12);assert.equal(result.records.length,12);assert.equal(new Set(result.records.map(r=>r.id)).size,12)}
  const file=JSON.parse(await readFile(join(directory,'ideas.json'),'utf8'));assert.equal(file.records.length,12);
});

test('demo import is explicit, idempotent, server-only and visible to an already running store',async t=>{
  const {ideas,directory}=await fixture(t);assert.equal((await ideas.list(admin)).records.length,0);
  const run=promisify(execFile);
  const command=await run(process.execPath,['scripts/seed-demo.mjs'],{cwd:new URL('../',import.meta.url),env:{...process.env,ORBITA_DATA_DIR:directory}});
  assert.match(command.stdout,/импортированы: 9/);
  const result=await ideas.list(admin);assert.equal(result.revision,1);assert.equal(result.records.length,9);assert.ok(result.records.every(r=>r.demo&&r.importedAt));
  assert.equal((await ideas.list(pro)).records.length,6);assert.equal((await ideas.list(exclusive)).records.length,3);
  assert.deepEqual(await ideas.importDemo(admin),{revision:1,imported:0});
  assert.ok(result.records.some(r=>r.d.state==='closed'&&r.meta.exit<r.d.entry));assert.ok(result.records.some(r=>r.d.state==='closed'&&r.meta.exit>r.d.entry));
  for(const r of result.records){assert.ok(r.meta.initial);assert.ok(r.meta.events.every(e=>e[3]?.id&&e[3]?.at))}
});
