import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,symlink,writeFile,readFile,chmod} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {serviceFixture} from './service-fixture.mjs';
import {createRadar,validateRadarDatabase} from '../lib/radar/service.mjs';
import {radarConfiguration} from '../lib/radar/config.mjs';

async function roles(f){const owner=await f.register('owner@radar-security.example.test');await f.accounts.promote(owner.data.user.email);const member=await f.register('member@radar-security.example.test'),free=await f.register('free@radar-security.example.test');assert.equal((await f.request('/api/admin/subscriptions',{method:'POST',cookie:owner.cookie,body:{userId:member.data.user.id,plan:'pro',expiresAt:new Date(Date.now()+86400000).toISOString(),reason:'Isolated Radar security'}})).status,200);return {owner,member,free};}
const manual={companyId:'sber',eventType:'DIVIDEND',headline:'Проверка защитного допуска',summary:'Вымышленное событие из локальной проверки.',whyImportant:'Проверка правил публикации.',impact:'POSITIVE',importanceScore:9.2,source:'https://www.e-disclosure.ru/',publishedAt:'2020-01-01T00:00:00.000Z',status:'published'};

test('Radar flags fail closed for malformed values and keep unpaid access disabled by default',()=>{
  const config=radarConfiguration({});assert.equal(config.enabled,true);assert.equal(config.freeEnabled,false);assert.equal(config.notificationsEnabled,false);assert.equal(config.aiEnabled,false);assert.deepEqual(config.allowedPlans,['pro']);assert.equal(config.mode,'off');
  for(const env of [{RADAR_ENABLED:'yes'},{RADAR_FREE_DELAY_SECONDS:'0'},{RADAR_FREE_LIMIT:'1000'},{RADAR_ALLOWED_PLANS:'pro,admin'},{RADAR_PROVIDER_MODE:'https://secret-url'}])assert.throws(()=>radarConfiguration(env));
});

test('Free Radar delay uses server availability, limits a global window and denies premium endpoints',async()=>{
  let clock=Date.now();const f=await serviceFixture(({directory,accounts})=>createRadar(directory,{accounts,env:{RADAR_FREE_ENABLED:'true',RADAR_FREE_DELAY_SECONDS:'60',RADAR_FREE_LIMIT:'2'},now:()=>clock}));
  try{
    const {owner,member,free}=await roles(f);const create=body=>f.request('/api/admin/radar',{method:'POST',cookie:owner.cookie,body:{...manual,...body}});
    const first=await create({headline:'Новое событие со старым временем источника'});assert.equal(first.status,201);
    assert.equal((await f.request('/api/radar',{cookie:free.cookie})).data.events.length,0,'Backdated provider timestamp must not bypass delay');
    clock+=60001;const ready=await f.request('/api/radar',{cookie:free.cookie});assert.equal(ready.data.events.length,1);for(const key of ['importanceScore','confidence','rawText','whyImportant','marketReaction','sources','extractedData'])assert.ok(!Object.hasOwn(ready.data.events[0],key));
    assert.equal((await f.request('/api/radar/'+first.data.event.id,{cookie:free.cookie})).status,403);assert.equal((await f.request('/api/radar/stream',{cookie:free.cookie})).status,403);assert.equal((await f.request('/api/radar/subscriptions',{cookie:free.cookie})).status,403);assert.equal((await f.request('/api/radar/important',{cookie:free.cookie})).status,403);assert.equal((await f.request('/api/radar?category=credit',{cookie:free.cookie})).status,403);
    for(const query of ['importance=0','cursor=fake','from=2000-01-01','type=DIVIDEND','impact=POSITIVE'])assert.equal((await f.request('/api/radar?'+query,{cookie:free.cookie})).status,403);
    const updated=await f.request('/api/admin/radar/'+first.data.event.id,{method:'PATCH',cookie:owner.cookie,body:{revision:1,summary:'Свежее исправление опубликованного материала'}});assert.equal(updated.status,200);assert.equal((await f.request('/api/radar',{cookie:free.cookie})).data.events.length,0,'An edit to a published card must not bypass the free delay');clock+=60001;
    const hide=await f.request('/api/admin/radar/'+first.data.event.id,{method:'PATCH',cookie:owner.cookie,body:{revision:updated.data.event.revision,status:'hidden'}});clock+=1000;
    const publish=await f.request('/api/admin/radar/'+first.data.event.id,{method:'PATCH',cookie:owner.cookie,body:{revision:hide.data.event.revision,status:'published'}});assert.equal(publish.status,200);assert.equal((await f.request('/api/radar',{cookie:free.cookie})).data.events.length,0,'Republish must apply a fresh free-tier fence');
    assert.equal((await f.request('/api/radar/'+first.data.event.id,{cookie:member.cookie})).status,200);
    clock+=60001;for(let n=0;n<4;n++)await create({headline:'Ограниченное окно '+n,publishedAt:new Date(Date.parse(manual.publishedAt)+n*1000).toISOString()});clock+=60001;
    const limited=await f.request('/api/radar',{cookie:free.cookie});assert.equal(limited.data.events.length,2);assert.equal(limited.data.nextCursor,null);const hiddenHistory=await f.request('/api/radar?q='+encodeURIComponent('Новое событие со старым'),{cookie:free.cookie});assert.equal(hiddenHistory.data.events.length,0,'Search must not reveal events outside the free global window');
  }finally{await f.close();}
});

test('Radar protects admin writes and owned rules against ordinary users and cross-origin requests',async()=>{
  const f=await serviceFixture(({directory,accounts})=>createRadar(directory,{accounts,env:{}}));
  try{
    const {owner,member}=await roles(f);
    for(const route of ['/api/admin/radar','/api/admin/radar/sync'])assert.equal((await f.request(route,{method:'POST',cookie:member.cookie,body:manual})).status,403);
    assert.equal((await f.request('/api/admin/radar',{method:'POST',cookie:owner.cookie,body:manual,headers:{Origin:'https://outside.example'}})).status,403);
    assert.equal((await f.request('/api/radar/subscriptions',{method:'POST',cookie:member.cookie,body:{minimumImportance:9,userId:owner.data.user.id}})).status,400);
    const created=await f.request('/api/admin/radar',{method:'POST',cookie:owner.cookie,body:{...manual,headline:'<script>throw 1</script>Безопасный заголовок',summary:'<img src=x onerror=alert(1)>Обычный текст'}});assert.equal(created.status,201);assert.equal(created.data.event.headline,'Безопасный заголовок');assert.equal(created.data.event.summary,'Обычный текст');
    const event=created.data.event;assert.equal((await f.request('/api/admin/radar/'+event.id,{method:'PATCH',cookie:owner.cookie,body:{revision:event.revision,companyId:'lkoh'}})).status,400);
  }finally{await f.close();}
});

test('Radar rejects symlink/corrupt storage and uses private atomic files',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'orbita-radar-storage-')),target=path.join(directory,'external.json'),store=path.join(directory,'radar.json'),accounts={identify:async()=>null,checkRequest:()=>{}};
  try{
    await writeFile(target,'{"outside":true}',{mode:0o600});await symlink(target,store);await assert.rejects(createRadar(directory,{accounts,env:{}}),cause=>cause.code==='DATA_UNSAFE');assert.equal(await readFile(target,'utf8'),'{"outside":true}');
    await rm(store);await writeFile(store,'{"broken":true}',{mode:0o600});await assert.rejects(createRadar(directory,{accounts,env:{}}),cause=>cause.code==='DATA_INVALID');await rm(store);
    const radar=await createRadar(directory,{accounts,env:{}});await radar.seedDemo();assert.equal(validateRadarDatabase(JSON.parse(await readFile(store))),true);await radar.close();
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('Radar SSE has bounded user connections, sends revision-only updates and closes on revoked access',async()=>{
  const f=await serviceFixture(({directory,accounts})=>createRadar(directory,{accounts,env:{},streamHeartbeatMs:20,streamLifetimeMs:5000})),controllers=[];
  try{
    const {owner,member}=await roles(f);const connect=async()=>{const controller=new AbortController();controllers.push(controller);const response=await fetch(f.base+'/api/radar/stream',{headers:{Cookie:member.cookie},signal:controller.signal});return {response,reader:response.body.getReader()};};
    const first=await connect();assert.equal(first.response.status,200);const frame=new TextDecoder().decode((await first.reader.read()).value);assert.match(frame,/event: ready/);assert.ok(!frame.includes('headline')&&!frame.includes('rawText'));
    const second=await connect();assert.equal(second.response.status,200);await second.reader.read();const third=await fetch(f.base+'/api/radar/stream',{headers:{Cookie:member.cookie}});assert.equal(third.status,429);
    await f.request('/api/admin/radar',{method:'POST',cookie:owner.cookie,body:manual});let update='';for(let tries=0;tries<20&&!update.includes('radar-update');tries++)update+=new TextDecoder().decode((await first.reader.read()).value);assert.match(update,/radar-update/);assert.ok(!update.includes(manual.headline));
    assert.equal((await f.request('/api/admin/subscriptions',{method:'POST',cookie:owner.cookie,body:{userId:member.data.user.id,plan:'pro',expiresAt:null,reason:'Revocation during Radar stream'}})).status,200);
    let ended=false;for(let tries=0;tries<10&&!ended;tries++)ended=(await first.reader.read()).done;assert.equal(ended,true);assert.equal((await f.request('/api/radar',{cookie:member.cookie})).status,403);
  }finally{for(const controller of controllers)controller.abort();await f.close();}
});
