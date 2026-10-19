import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';

const seedSource=readFileSync(new URL('../public/assets/editor-seed.js',import.meta.url),'utf8');
const storeSource=readFileSync(new URL('../public/assets/editor-store.js',import.meta.url),'utf8');
function setup(){
  const storage=new Map(),events=[];
  const context=vm.createContext({Intl,Date,crypto:{randomUUID},localStorage:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value)},CustomEvent:class{constructor(type,options){this.type=type;this.detail=options?.detail}}});
  context.window=context;context.dispatchEvent=event=>events.push(event);
  vm.runInContext(seedSource,context);vm.runInContext(storeSource,context);
  return {S:context.OrbitaStore,context,events,storage};
}
function draft(id='test-idea'){
  return {id,published:false,d:{ticker:'SBER',name:'Сбербанк',market:'stocks',dir:'ЛОНГ',title:'Тестовая идея',summary:'Проверка сценария.',entry:310,stop:300,target:340,horizon:'5–15 дней',strategy:'Orbita Exclusive',thesis:'Возврат к поддержке.',entryRule:'Закрепление выше входа.',cancelRule:'Выход при достижении стопа.'}};
}
function addPublished(S){const db=S.read(),r=draft();S.publish(r);db.records.push(r);S.write(db);return S.read()}

test('legacy migration completes dates and stable event IDs without replacing results',()=>{
  const {S}=setup(),db=S.read(),r=db.records.find(r=>r.id==='demo-4');
  assert.equal(r.meta.events[0][0],'06.10.2026 · 09:30');
  assert.equal(r.meta.events[2][3].at,'2026-10-09T07:20:00.000Z');
  assert.equal(r.meta.events[0][3].type,'published');
  assert.equal(r.meta.initial.reconstructed,true);
  assert.match(r.meta.initial.reconstructedReason,/не подтверждены/);
  assert.equal(r.meta.exit,504);assert.equal(r.d.state,'closed');
  assert.equal(JSON.stringify(S.read()),JSON.stringify(db));
  S.write(db);assert.equal(JSON.stringify(S.read()),JSON.stringify(db));
});

test('published lifecycle appends events, preserves initial stop and retains closed erroneous results',()=>{
  const {S,events}=setup();let db=addPublished(S),r=db.records.find(r=>r.id==='test-idea');
  assert.equal(r.meta.initial.reconstructed,false);
  const initial=JSON.stringify(r.meta.initial);
  for(const [action,note,price] of [['activate','Вход подтверждён.'],['stop-change','Защищаем позицию.',312],['manual','Закрываем позицию.',325]]){
    S.update(r,action,note,price);S.write(db);db=S.read();r=db.records.find(r=>r.id==='test-idea');
  }
  assert.equal(r.d.state,'closed');assert.equal(r.meta.exit,325);assert.equal(JSON.stringify(r.meta.initial),initial);
  const stop=r.meta.events.find(e=>e[3].type==='stop-change');
  assert.equal(stop[3].before.stop,300);assert.equal(stop[3].after.stop,312);assert.match(stop[2],/SBER: стоп изменён с 300 до 312 ₽/);
  S.update(r,'error','Опубликован неверный инструмент.');S.write(db);db=S.read();r=db.records.find(r=>r.id==='test-idea');
  assert.equal(r.erroneous,true);assert.equal(r.meta.errorReason,'Опубликован неверный инструмент.');
  assert.equal(r.d.state,'closed');assert.equal(r.meta.exit,325);assert.equal(r.d.outcome,'Закрыто вручную');
  assert.throws(()=>S.update(r,'stop-change','Сменить стоп.',305),/Ошибочная/);
  S.update(r,'note','Уточнение автора.');S.write(db);
  assert.equal(new Set(r.meta.events.map(e=>e[3].id)).size,r.meta.events.length);
  assert.ok(r.meta.events.every(e=>!Number.isNaN(Date.parse(e[3].at))));
  assert.equal(events.length,6);assert.equal(events.at(-1).type,'orbita:store-change');assert.equal(events.at(-1).detail.revision,6);
});

test('published history, snapshots and results cannot be removed or rewritten',()=>{
  const {S}=setup();let db=addPublished(S);
  for(const tamper of [
    state=>{state.records=state.records.filter(r=>r.id!=='test-idea')},
    state=>{state.records.find(r=>r.id==='test-idea').meta.events[0][2]='Исправленный текст'},
    state=>{state.records.find(r=>r.id==='test-idea').meta.initial.entry=309},
    state=>{state.records.find(r=>r.id==='test-idea').d.target=345},
    state=>{state.records.find(r=>r.id==='test-idea').d.state='closed'},
    state=>{state.records.find(r=>r.id==='demo-4').meta.exit=510},
  ]){const copy=S.clone(db);tamper(copy);assert.throws(()=>S.write(copy))}
  const r=db.records.find(r=>r.id==='test-idea');S.update(r,'activate','Вход.');r.meta.events.at(-1)[3].after.state='closed';
  assert.throws(()=>S.write(db),/соответствовать событию/);
  db=S.read();assert.equal(db.records.find(r=>r.id==='test-idea').d.state,'waiting');
});

test('invalid prices and lifecycle transitions are rejected before mutation',()=>{
  const {S}=setup(),db=addPublished(S),r=db.records.find(r=>r.id==='test-idea');
  for(const price of [0,-1,NaN,Infinity,'no price',310,341]){
    const before=JSON.stringify(r);assert.throws(()=>S.update(r,'stop-change','Новый стоп.',price));assert.equal(JSON.stringify(r),before);
  }
  assert.throws(()=>S.update(r,'manual','Закрываем.',320),/активную/);
  S.update(r,'activate','Вход.');assert.throws(()=>S.update(r,'cancel','Отмена.'),/до входа/);
  assert.throws(()=>S.update(r,'activate','Повторный вход.'),/ожидающей/);
  assert.throws(()=>S.update(r,'note','   '),/пояснение/);
  S.update(r,'target','Цель достигнута.');assert.equal(r.meta.exit,340);
  assert.throws(()=>S.update(r,'stop-change','Поздняя правка.',305),/ожидающей или активной/);
  S.write(db);
});

test('new publication and multiple events can be saved together; short positions use correct levels',()=>{
  const {S}=setup(),db=S.read(),r=draft('short-idea');Object.assign(r.d,{dir:'ШОРТ',stop:320,target:280});
  S.publish(r);S.update(r,'activate','Вход в шорт.');S.update(r,'stop-change','Защищаем прибыль.',305);S.update(r,'stop','Сработал стоп.');db.records.push(r);S.write(db);
  assert.equal(S.read().records.find(r=>r.id==='short-idea').meta.exit,305);
});

test('revision conflicts protect other tabs while drafts remain deletable',()=>{
  const {S}=setup(),first=S.read(),stale=S.read();first.records.push(draft());S.write(first);
  assert.throws(()=>S.write(stale),/другой вкладке/);
  const next=S.read();next.records=next.records.filter(r=>r.id!=='test-idea');S.write(next);
  assert.ok(!S.read().records.some(r=>r.id==='test-idea'));
});

test('new Exclusive seeds merge into saved databases without reviving removed original demos',()=>{
  const {S,storage,context}=setup(),db=S.read();db.records=db.records.filter(r=>r.id!=='demo-5');
  // An older database could already have missing examples before deletion was restricted.
  storage.set(S.key,JSON.stringify(db));
  const exclusive=S.clone(context.ORBITA_SEED[0]);exclusive.id='exclusive-new';context.ORBITA_SEED.push(exclusive);
  let migrated=S.read();assert.ok(migrated.records.some(r=>r.id==='exclusive-new'));assert.ok(!migrated.records.some(r=>r.id==='demo-5'));
  S.write(migrated);migrated=S.read();assert.equal(migrated.records.filter(r=>r.id==='exclusive-new').length,1);
});

test('legacy date reconstruction handles Moscow New Year and year rollover',()=>{
  const {S,storage}=setup(),db=S.read(),r=db.records[0];
  delete r.meta.initial;delete r.meta.publishedAt;
  r.meta.published='01.01.2026 · 01:00';r.meta.events=[['01.01 · 01:00','Идея опубликована','Условия.']];
  storage.set(S.key,JSON.stringify(db));assert.equal(S.read().records[0].meta.events[0][0],'01.01.2026 · 01:00');
  r.meta.published='31.12.2026 · 22:00';r.meta.events=[['31.12 · 22:00','Идея опубликована','Условия.'],['01.01 · 01:00','Комментарий','Новое событие.']];
  storage.set(S.key,JSON.stringify(db));assert.equal(S.read().records[0].meta.events[1][0],'01.01.2027 · 01:00');
});
