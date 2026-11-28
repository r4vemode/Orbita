import test from 'node:test';
import assert from 'node:assert/strict';
import {startLocalBeta} from '../scripts/beta-local.mjs';
import {createIdeas} from '../lib/ideas.mjs';

const admin={id:'fixture-editor',role:'admin'};
const full=(overrides={})=>({mode:'full',d:{
  ticker:'SBER',dir:'ЛОНГ',entry:100,stop:90,target:120,
  entryRule:'Условие входа.',cancelRule:'Условие отмены.',...overrides,
}});
const endpoint=id=>'/api/admin/ideas/'+id+'/share-card';

test('share-card API returns the canonical result only for real, fully closed published ideas',async t=>{
  const beta=await startLocalBeta({marketHistory:true});
  t.after(()=>beta.close());
  const ideas=await createIdeas(beta.directory,{localMarketHistory:true});
  const cookies={};
  for(const role of ['admin','pro']){
    const {email,password}=beta.accounts.find(account=>account.role===role);
    const response=await fetch(beta.base+'/api/login',{method:'POST',
      headers:{Origin:beta.base,'Content-Type':'application/json'},
      body:JSON.stringify({email,password})});
    assert.equal(response.status,200);
    cookies[role]=response.headers.get('set-cookie').split(';')[0];
  }
  const get=(route,user='admin',options={})=>fetch(beta.base+route,{
    headers:{...(user?{Cookie:cookies[user]}:{}),...options.headers},
    method:options.method||'GET',
  });

  let {record:weighted}=await ideas.create(admin,full());
  ({record:weighted}=await ideas.update(admin,weighted.id,{action:'terms-change',note:'Уточнён вход.',d:{
    entry:101,stop:90,target:120,entryRule:'Уточнено условие входа.',cancelRule:'Условие отмены.',
  }}));
  ({record:weighted}=await ideas.update(admin,weighted.id,{action:'activate',note:'Подтверждён вход.'}));
  const occurredAt=weighted.meta.enteredAt;
  ({record:weighted}=await ideas.update(admin,weighted.id,{action:'partial-close',percent:25,price:112,
    occurredAt,reason:'Зафиксирована часть.'}));
  assert.equal((await get(endpoint(weighted.id))).status,404);
  ({record:weighted}=await ideas.update(admin,weighted.id,{action:'early-close',price:98,
    occurredAt,reason:'Закрыта позиция.',note:'Внутреннее пояснение.'}));
  await ideas.update(admin,weighted.id,{action:'archive'});

  let {record:single}=await ideas.create(admin,full({ticker:'GAZP',dir:'ШОРТ',strategy:'Orbita Exclusive',stop:110,target:80}));
  ({record:single}=await ideas.update(admin,single.id,{action:'terms-change',note:'Уточнён вход.',d:{
    entry:102,stop:110,target:80,entryRule:'Уточнено условие входа.',cancelRule:'Условие отмены.',
  }}));
  ({record:single}=await ideas.update(admin,single.id,{action:'activate',note:'Подтверждён вход.'}));
  ({record:single}=await ideas.update(admin,single.id,{action:'manual',price:104,note:'Выход.'}));

  const {record:cancelled}=await ideas.create(admin,full({ticker:'ROSN'}));
  await ideas.update(admin,cancelled.id,{action:'cancel',note:'Условия потеряли силу.'});
  const {record:draft}=await ideas.create(admin,{mode:'draft',d:{}});
  const {record:bad}=await ideas.create(admin,full({ticker:'VTBR'}));
  await ideas.update(admin,bad.id,{action:'activate',note:'Вход.'});
  await ideas.update(admin,bad.id,{action:'manual',price:103,note:'Выход.'});
  await ideas.update(admin,bad.id,{action:'error',note:'Публикация ошибочна.'});
  await ideas.importDemo(admin);
  const demo=(await ideas.list(admin)).records.find(record=>record.demo&&record.d.state==='closed');
  const [simulation]=(await ideas.results({localMarketHistory:true})).results;
  assert.ok(demo&&simulation);
  for(const id of [cancelled.id,draft.id,bad.id,demo.id,simulation.id,'not-found']){
    assert.equal((await get(endpoint(id))).status,404,id);
  }

  const forged=endpoint(weighted.id)+'?publicOrigin=https%3A%2F%2Ffake.example';
  assert.equal((await get(forged,null)).status,401);
  assert.equal((await get(forged,'pro')).status,403);
  const response=await get(forged,'admin',{headers:{'X-Forwarded-Host':'fake.example'}});
  assert.equal(response.status,200);
  assert.equal(response.headers.get('cache-control'),'no-store');
  assert.equal(response.headers.get('vary'),'Cookie');
  const {results}=await (await get('/api/public/results',null)).json();
  const canonical=results.find(row=>row.id===weighted.id);
  const {card}=await response.json();
  assert.deepEqual(card,{ticker:'SBER',dir:'ЛОНГ',tier:'pro',entry:101,exit:101.5,exitAveraged:true,unit:'₽',
    pct:canonical.pct,closedAt:occurredAt,publicOrigin:'https://orbitaview.ru'});
  assert.equal(canonical.exit,98);
  assert.notEqual(canonical.initial.entry,card.entry);
  assert.equal(card.pct,weighted.meta.finalResultPct);

  const legacy=(await (await get(endpoint(single.id))).json()).card;
  assert.deepEqual(legacy,{ticker:'GAZP',dir:'ШОРТ',tier:'exclusive',entry:100,exit:104,exitAveraged:false,unit:'₽',
    pct:results.find(row=>row.id===single.id).pct,closedAt:single.meta.closedAt,publicOrigin:'https://orbitaview.ru'});
  assert.equal(single.d.entry,102);
  assert.ok(legacy.pct<0);
  const wrongMethod=await get(forged,'admin',{method:'POST',headers:{Origin:beta.base}});
  assert.equal(wrongMethod.status,405);
  assert.equal(wrongMethod.headers.get('allow'),'GET');
  for(const asset of ['/assets/result-share.js','/assets/result-share-card.js']){
    assert.equal((await get(asset,null)).status,401);
    assert.equal((await get(asset,'pro')).status,403);
  }
});
