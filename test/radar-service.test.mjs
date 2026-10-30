import test from 'node:test';
import assert from 'node:assert/strict';
import {serviceFixture} from './service-fixture.mjs';
import {createRadar,validateRadarDatabase} from '../lib/radar/service.mjs';
import {createRadarJobs} from '../lib/radar/jobs.mjs';

const password='test-password-long-2026';
async function users(f,{exclusive=false}={}){
  const admin=await f.register('radar-admin@example.test');await f.accounts.promote(admin.data.user.email);
  const pro=await f.register('radar-pro@example.test'),free=await f.register('radar-free@example.test');
  const grant=async(account,plan)=>f.request('/api/admin/subscriptions',{method:'POST',cookie:admin.cookie,body:{userId:account.data.user.id,plan,expiresAt:new Date(Date.now()+86400000).toISOString(),reason:'Isolated Radar test'}});
  assert.equal((await grant(pro,'pro')).status,200);let separate;
  if(exclusive){separate=await f.register('radar-exclusive@example.test');assert.equal((await grant(separate,'exclusive')).status,200);}
  return {admin,pro,free,separate};
}
const manual=(extra={})=>({companyId:'sber',eventType:'DIVIDEND',headline:'Учебное решение о дивидендах',summary:'Совет рекомендовал учебную выплату. Не реальные рыночные сведения.',whyImportant:'Показатель влияет на будущий денежный поток владельца акции.',impact:'POSITIVE',importanceScore:9.1,source:'https://www.e-disclosure.ru/',publishedAt:new Date(Date.now()-3600000).toISOString(),status:'published',...extra});

test('Radar stores an explicit demo once, projects compact cards and enforces separate tariff access',async()=>{
  const f=await serviceFixture(({directory,accounts})=>createRadar(directory,{accounts,env:{}}));
  try{
    const {admin,pro,free,separate}=await users(f,{exclusive:true});
    assert.equal((await f.request('/api/radar')).status,401);assert.equal((await f.request('/api/radar',{cookie:free.cookie})).status,403);assert.equal((await f.request('/api/radar',{cookie:separate.cookie})).status,403);
    const seeded=await f.service.seedDemo();assert.ok(seeded.inserted>=15);const again=await f.service.seedDemo();assert.equal(again.inserted,0);assert.equal(again.duplicates,seeded.inserted);
    const result=await f.request('/api/radar?importance=0',{cookie:pro.cookie});assert.equal(result.status,200);assert.equal(result.data.events.length,seeded.inserted);
    for(const event of result.data.events){assert.equal(event.isDemo,true);for(const key of ['rawText','trace','audit','sources','originalAnalysis'])assert.ok(!Object.hasOwn(event,key));}
    const detail=await f.request('/api/radar/'+result.data.events[0].id,{cookie:pro.cookie});assert.equal(detail.status,200);assert.equal(typeof detail.data.event.rawText,'string');assert.ok(detail.data.event.sources.length>0);
    const all=await f.request('/api/admin/radar',{cookie:admin.cookie});assert.equal(all.status,200);assert.equal(all.data.events.length,seeded.inserted);assert.ok(all.data.providers.every(provider=>provider.status==='disabled'));
    assert.equal(validateRadarDatabase(await f.service.readDatabase()),true);
  }finally{await f.close();}
});

test('Radar admin correction keeps original analysis, optimistic edits and merged duplicate records',async()=>{
  const f=await serviceFixture(({directory,accounts})=>createRadar(directory,{accounts,env:{}}));
  try{
    const {admin,pro}=await users(f);const write=(route,body,method='POST')=>f.request(route,{method,cookie:admin.cookie,body});
    const first=await write('/api/admin/radar',manual());assert.equal(first.status,201);const event=first.data.event;
    assert.equal((await write('/api/admin/radar/'+event.id,{revision:event.revision,summary:'Исправленное объяснение',impact:'MIXED',aiIncorrect:true},'PATCH')).status,200);
    assert.equal((await write('/api/admin/radar/'+event.id,{revision:event.revision,summary:'Старая вкладка'},'PATCH')).status,409);
    const current=(await f.request('/api/admin/radar',{cookie:admin.cookie})).data.events.find(row=>row.id===event.id);assert.equal(current.summary,'Исправленное объяснение');assert.equal(current.audit.length,2);
    const hidden=await write('/api/admin/radar/'+event.id,{revision:current.revision,status:'hidden'},'PATCH');assert.equal(hidden.status,200);assert.equal((await f.request('/api/radar/'+event.id,{cookie:pro.cookie})).status,404);
    const second=await write('/api/admin/radar',manual({headline:'Повтор из другого источника',source:'https://www.moex.com/'}));assert.equal(second.status,201);
    const combined=await write('/api/admin/radar/'+hidden.data.event.id+'/merge',{revision:hidden.data.event.revision,targetId:second.data.event.id,targetRevision:second.data.event.revision});assert.equal(combined.status,200);assert.equal(combined.data.event.sources.length,2);
    const db=await f.service.readDatabase();assert.equal(db.events.length,2);assert.equal(db.events.find(row=>row.id===event.id).status,'duplicate');assert.equal(db.events.find(row=>row.id===event.id).mergedInto,second.data.event.id);
    const third=await write('/api/admin/radar',manual({companyId:'lkoh'}));assert.equal((await write('/api/admin/radar/'+third.data.event.id+'/merge',{revision:1,targetId:combined.data.event.id,targetRevision:combined.data.event.revision})).status,400);
    assert.equal((await write('/api/admin/radar',manual({source:'javascript:alert(1)'}))).status,400);
    assert.equal((await write('/api/admin/radar',manual({role:'admin'}))).status,400);
    await assert.rejects(f.service.seedDemo(),cause=>cause.status===409);
  }finally{await f.close();}
});

test('Radar cursor is bound to filters and user; source duplicates preserve one event and two sources',async()=>{
  const f=await serviceFixture(({directory,accounts})=>createRadar(directory,{accounts,env:{}}));
  try{
    const {pro,admin}=await users(f);await f.service.seedDemo();
    const first=await f.request('/api/radar?importance=0&limit=2',{cookie:pro.cookie});assert.equal(first.data.events.length,2);assert.ok(first.data.nextCursor);
    const next=await f.request('/api/radar?importance=0&limit=2&cursor='+encodeURIComponent(first.data.nextCursor),{cookie:pro.cookie});assert.equal(next.status,200);assert.equal(next.data.events.length,2);assert.ok(!next.data.events.some(event=>first.data.events.some(row=>row.id===event.id)));
    assert.equal((await f.request('/api/radar?importance=9&limit=2&cursor='+encodeURIComponent(first.data.nextCursor),{cookie:pro.cookie})).status,400);
    assert.equal((await f.request('/api/radar?importance=0&limit=2&cursor='+encodeURIComponent(first.data.nextCursor),{cookie:admin.cookie})).status,400);
    assert.equal((await f.request('/api/radar?limit=1&limit=2',{cookie:pro.cookie})).status,400);assert.equal((await f.request('/api/radar?constructor=admin',{cookie:pro.cookie})).status,400);
    const raw={provider:'edisclosure',externalId:'unique-dedup-test',ticker:'SBER',sourceType:'DISCLOSURE',sourceUrl:'https://www.e-disclosure.ru/',title:'Сбербанк рекомендовал дивиденды 123 рубля',rawText:'Совет директоров Сбербанка рекомендовал выплатить дивиденды 123 рубля на акцию за учебный период.',publishedAt:new Date().toISOString()};
    const inserted=await f.service.ingestBatch([raw]);assert.equal(inserted.inserted,1);
    const duplicate=await f.service.ingestBatch([{...raw,provider:'company-ir',externalId:'ir-dedup-test',sourceType:'IR',sourceUrl:'https://www.sberbank.com/'}]);assert.equal(duplicate.inserted,0);assert.equal(duplicate.duplicates,1);
    const stored=(await f.service.readDatabase()).events.find(event=>event.sources.some(source=>source.externalId==='unique-dedup-test'));assert.equal(stored.sources.length,2);assert.ok(stored.originalAnalysis);assert.ok(stored.audit.some(entry=>entry.action==='source-added'));
    assert.equal(stored.marketReaction,null,'Live events must never acquire fake market reaction');
  }finally{await f.close();}
});

test('Radar notifications require explicit current own rules, freshness and significant events',async()=>{
  let clock=Date.now();const f=await serviceFixture(({directory,accounts})=>createRadar(directory,{accounts,env:{RADAR_NOTIFICATIONS_ENABLED:'true'},now:()=>clock}));
  try{
    const {admin,pro,free}=await users(f);const actor=()=>f.accounts.getUser(pro.data.user.id),create=body=>f.request('/api/admin/radar',{method:'POST',cookie:admin.cookie,body:manual(body)}),subscribe=body=>f.request('/api/radar/subscriptions',{method:'POST',cookie:pro.cookie,body});
    const historical=await create({headline:'Событие до подписки'});clock+=1000;assert.equal((await subscribe({companyId:null,eventType:null,minimumImportance:9,enabled:false})).status,201);
    clock+=1000;const whileDisabled=await create({headline:'Событие во время отключения'});clock+=1000;const enabled=await subscribe({companyId:null,eventType:null,minimumImportance:9,enabled:true});assert.equal(enabled.status,201);
    assert.deepEqual(await f.service.notificationsFor(await actor()),[]);
    clock+=1000;const fresh=await create({headline:'Новое значимое событие'});await create({headline:'Низкая важность',importanceScore:5});
    const events=await f.service.notificationsFor(await actor());assert.deepEqual(events.map(event=>event.id),[fresh.data.event.id]);assert.ok(!Object.hasOwn(events[0],'rawText'));assert.ok(!events.some(event=>event.id===historical.data.event.id||event.id===whileDisabled.data.event.id));
    assert.deepEqual(await f.service.notificationsFor(await actor(),{since:clock+1}),[]);assert.deepEqual(await f.service.notificationsFor(await f.accounts.getUser(free.data.user.id)),[]);
    const own=enabled.data.subscriptions[0];assert.ok(!Object.hasOwn(own,'userId'));assert.equal((await f.request('/api/radar/subscriptions/'+own.id,{method:'DELETE',cookie:admin.cookie})).status,404);
    assert.equal((await f.request('/api/radar/subscriptions',{method:'POST',cookie:free.cookie,body:{minimumImportance:6}})).status,403);
    const before=await f.service.getForNotification(await actor(),fresh.data.event.id);assert.ok(before);await f.request('/api/admin/radar/'+fresh.data.event.id,{method:'PATCH',cookie:admin.cookie,body:{revision:fresh.data.event.revision,status:'hidden'}});assert.equal(await f.service.getForNotification(await actor(),fresh.data.event.id),null);
    assert.equal((await f.request('/api/radar/subscriptions/'+own.id,{method:'DELETE',cookie:pro.cookie})).status,200);assert.deepEqual(await f.service.notificationsFor(await actor()),[]);
  }finally{await f.close();}
});

test('Radar remembers a suppressed provider identity and follows merged tombstones when sources replay',async()=>{
  const f=await serviceFixture(({directory,accounts})=>createRadar(directory,{accounts,env:{}}));
  try{
    const {admin,pro}=await users(f),raw={provider:'edisclosure',externalId:'suppressed-source',ticker:'SBER',sourceType:'DISCLOSURE',sourceUrl:'https://www.e-disclosure.ru/',title:'Решение о дивидендах',rawText:'Сбербанк: рекомендованы дивиденды 123 рубля на акцию.',publishedAt:new Date().toISOString()};
    await f.service.ingestBatch([raw]);const suppressed=(await f.service.readDatabase()).events[0];
    assert.equal((await f.request('/api/admin/radar/'+suppressed.id,{method:'DELETE',cookie:admin.cookie,body:{revision:suppressed.revision}})).status,200);
    assert.equal((await f.service.ingestBatch([raw])).inserted,0);assert.equal((await f.service.ingestBatch([{...raw,provider:'company-ir',externalId:'suppressed-ir-copy'}])).inserted,0);assert.equal((await f.service.readDatabase()).events.length,1);assert.equal((await f.request('/api/radar?importance=0',{cookie:pro.cookie})).data.events.length,0);
    const main=await f.request('/api/admin/radar',{method:'POST',cookie:admin.cookie,body:manual({headline:'Основное событие'})});assert.equal(main.status,201);
    const current=(await f.service.readDatabase()).events.find(event=>event.id===suppressed.id);
    assert.equal((await f.request('/api/admin/radar/'+suppressed.id+'/merge',{method:'POST',cookie:admin.cookie,body:{revision:current.revision,targetId:main.data.event.id,targetRevision:main.data.event.revision}})).status,200);
    assert.equal((await f.service.ingestBatch([raw])).inserted,0);const db=await f.service.readDatabase();assert.equal(db.events.length,2);assert.equal(db.events.filter(event=>event.status==='published').length,1);assert.equal(db.events.find(event=>event.id===main.data.event.id).sources.length,2);
  }finally{await f.close();}
});

test('Radar provider jobs isolate failures, suppress secret errors and retry independently',async()=>{
  const states=[],seen=[];
  const jobs=createRadarJobs({providers:[{id:'bad',name:'Failure',enabled:true,interval:1000,async fetchEvents(){throw Error('secret API credential response');}},{id:'good',name:'Success',enabled:true,interval:1000,async fetchEvents(){return {events:[],cursor:'safe-cursor'};}}],onEvents:async(events,{provider})=>{seen.push(provider);return {inserted:0,delays:[]};},onState:async state=>{states.push(state);}});
  try{await jobs.start();await jobs.sync();assert.ok(seen.includes('good'));assert.ok(states.some(state=>state.id==='good'&&state.status==='online'));const failure=states.find(state=>state.id==='bad'&&state.status==='error');assert.ok(Date.parse(failure.nextAttemptAt)>Date.parse(failure.lastFetch)+1000);assert.equal(failure.error,'PROVIDER_FAILED');assert.ok(!JSON.stringify(states).includes('secret API'));}finally{await jobs.close();}
});

test('Radar maps the existing trusted idea watchlist through current idea permissions without enabling alerts',async()=>{
  const f=await serviceFixture(({directory,accounts,ideas})=>createRadar(directory,{accounts,ideas,env:{RADAR_ALLOWED_PLANS:'pro,exclusive',RADAR_NOTIFICATIONS_ENABLED:'true'}}));
  try{
    const {admin,pro}=await users(f);await f.service.seedDemo();
    const idea=await f.ideas.create({id:admin.data.user.id,role:'admin'},{mode:'quick',d:{ticker:'SBER',dir:'ЛОНГ',strategy:'Momentum RU'}});
    assert.equal((await f.request('/api/watchlist',{method:'PUT',cookie:pro.cookie,body:{ids:[idea.record.id]}})).status,200);
    const followed=await f.request('/api/radar?watchlist=1',{cookie:pro.cookie});assert.equal(followed.status,200);assert.equal(followed.data.events[0].ticker,'SBER');assert.equal(followed.data.events[0].following,true);assert.deepEqual(await f.service.notificationsFor(await f.accounts.getUser(pro.data.user.id)),[]);
    assert.equal((await f.request('/api/admin/subscriptions',{method:'POST',cookie:admin.cookie,body:{userId:pro.data.user.id,plan:'exclusive',expiresAt:new Date(Date.now()+86400000).toISOString(),reason:'Alternate Radar tariff'}})).status,200);
    assert.equal((await f.request('/api/admin/subscriptions',{method:'POST',cookie:admin.cookie,body:{userId:pro.data.user.id,plan:'pro',expiresAt:null,reason:'Remove access to the watched Pro idea'}})).status,200);
    const after=await f.request('/api/radar?watchlist=1',{cookie:pro.cookie});assert.equal(after.status,200);assert.ok(after.data.events.filter(event=>event.ticker==='SBER').every(event=>event.following===false));
  }finally{await f.close();}
});

test('Radar provider cursor and backoff survive a service restart',async()=>{
  let clock=Date.now(),calls=0;const seen=[];const provider={id:'resumable',name:'Resume',enabled:true,interval:1000,async fetchEvents({cursor}){calls++;seen.push(cursor);return {events:[],cursor:'page-'+calls};}};
  const f=await serviceFixture(({directory,accounts})=>createRadar(directory,{accounts,env:{RADAR_PROVIDER_MODE:'live'},providers:[provider],now:()=>clock}));
  let restarted;
  try{
    const {admin}=await users(f);assert.equal((await f.request('/api/admin/radar/sync',{method:'POST',cookie:admin.cookie,body:{}})).status,200);assert.equal(calls,1);assert.deepEqual(seen,[null]);await f.service.close();
    restarted=await createRadar(f.directory,{accounts:f.accounts,env:{RADAR_PROVIDER_MODE:'live'},providers:[provider],now:()=>clock});await restarted.start();clock+=1001;
    await new Promise(resolve=>setTimeout(resolve,1100));assert.equal(calls,2);assert.deepEqual(seen,[null,'page-1']);
  }finally{await restarted?.close();await f.close();}
});

test('Radar job shutdown cancels in-progress analysis through the same provider signal',async()=>{
  let entered;const ready=new Promise(resolve=>{entered=resolve;}),states=[];
  const jobs=createRadarJobs({providers:[{id:'cancel',name:'Cancellation',enabled:true,interval:1000,async fetchEvents(){return {events:[{externalId:'temporary'}],cursor:'next'};}}],onEvents:async(events,{signal})=>{assert.ok(signal instanceof AbortSignal);entered();await new Promise((resolve,reject)=>{signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});},onState:async state=>{states.push(state);}});
  const running=jobs.sync();await ready;const started=Date.now();await jobs.close();await running;assert.ok(Date.now()-started<1000);assert.equal(states.at(-1).status,'error');assert.equal(states.at(-1).cursor,null,'An interrupted batch must not advance its cursor');
});
