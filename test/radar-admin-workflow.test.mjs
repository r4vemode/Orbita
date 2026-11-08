import test from 'node:test';
import assert from 'node:assert/strict';
import {serviceFixture} from './service-fixture.mjs';
import {createTelegramAdminStore,validateTelegramAdminState} from '../lib/telegram-admin/accounts.mjs';
import {createRadarAdminWorkflow} from '../lib/telegram-admin/radar-workflow.mjs';
import {createTelegramAdminEngine} from '../lib/telegram-admin/engine.mjs';
import {radarDefaults} from '../lib/telegram-admin/radar-state.mjs';

async function fixture(t){
 let clock=Date.parse('2026-11-07T10:00:00Z'),nextUpdate=1,messageId=100,failDelivery=false;
 const sent=[],db={companies:[{id:'sber',active:true}],providerStates:{feed:{status:'online'}},events:[]};
 const radar={config:{enabled:true},readDatabase:async()=>structuredClone(db)};
 const f=await serviceFixture(async({accounts,ideas})=>{const store=createTelegramAdminStore({accounts,now:()=>clock}),send=async(method,payload)=>{if(failDelivery&&method==='sendMessage'){failDelivery=false;throw Error('Synthetic transport failure');}sent.push({method,payload:structuredClone(payload)});return {message_id:++messageId};},workflow=createRadarAdminWorkflow({radar,ideas,store,send,publicOrigin:'https://orbita.example',now:()=>clock});const engine=createTelegramAdminEngine({ideas,store,send,publicOrigin:'https://orbita.example',now:()=>clock,radarWorkflow:workflow});return {store,workflow,engine,webhookPaths:[],handle:workflow.handle,close:engine.close};});t.after(()=>f.close());
 const admin=await f.register('radar-editor@example.test'),other=await f.register('radar-other@example.test'),free=await f.register('radar-member@example.test');await f.accounts.promote(admin.data.user.email);await f.accounts.promote(other.data.user.email);
 const req=(account=admin,method='POST')=>({method,headers:{host:new URL(f.base).host,origin:f.base,cookie:account.cookie}});
 const {store,workflow,engine}=f.service;
 async function link(account=admin,tg=123456){const token=await store.issueLink(req(account));return store.connect(tg,tg,token.code);}
 const identity=await link();
 function add(extra={}){clock+=1;const at=new Date(clock).toISOString(),e={id:'event-'+(db.events.length+1),companyId:'sber',ticker:'SBER',companyName:'Сбербанк',assetType:'stock',eventType:'EARNINGS',headline:'Synthetic test earnings',summary:'Synthetic fixture, not a real market event.',whyImportant:'Synthetic analysis',importanceScore:8,impact:'POSITIVE',status:'published',revision:1,isDemo:false,sources:[{provider:'feed',url:'https://example.org/test-source'}],publishedAt:at,firstPublishedAt:at,lastPublishedAt:at,analysisMethod:'rules',...extra};db.events.push(e);return e;}
 const message=(text,tg=123456)=>({update_id:nextUpdate++,message:{message_id:++messageId,chat:{id:tg,type:'private'},from:{id:tg,is_bot:false},text}});
 const callback=(data,tg=123456)=>({update_id:nextUpdate++,callback_query:{id:'query-'+nextUpdate,from:{id:tg,is_bot:false},message:{message_id:++messageId,chat:{id:tg,type:'private'}},data}});
 const last=()=>sent.filter(s=>s.method!=='answerCallbackQuery').at(-1);
 const button=label=>{const b=last().payload.reply_markup.inline_keyboard.flat().find(b=>b.text.includes(label));assert.ok(b?.callback_data,'Missing '+label+' in '+last().payload.text);return callback(b.callback_data);};
 const enable=async(account=admin,patch={})=>workflow.preferences(req(account),{...radarDefaults(),enabled:true,quietStart:0,quietEnd:0,...patch});
 return {...f,admin,other,free,req,identity,store,workflow,engine,radar,db,sent,link,add,message,callback,last,button,enable,advance(ms){clock+=ms;},fail(){failDelivery=true;},get now(){return clock;}};
}
const plan=()=>({mode:'full',d:{ticker:'SBER',name:'Сбербанк',market:'stocks',strategy:'Momentum RU',dir:'ЛОНГ',entry:312,stop:307,target:325,entryRule:'Подтверждение автора отдельно.',cancelRule:'Стоп и цель — по плану.'}});

test('Radar preferences are private, opt-in and bound to the live Telegram connection',async t=>{
 const f=await fixture(t);assert.equal((await f.workflow.preferences(f.req())).preferences.enabled,false);
 assert.equal((await f.request('/api/admin/telegram/radar',{cookie:f.free.cookie})).status,403);
 assert.equal((await f.request('/api/admin/telegram/radar',{method:'PUT',cookie:f.other.cookie,body:radarDefaults()})).status,409);
 await f.enable();assert.equal((await f.workflow.preferences(f.req())).preferences.enabled,true);
 await assert.rejects(f.enable(f.admin,{minimumImportance:8,criticalImportance:7}),e=>e.status===400);
 await f.store.unlink(f.req());assert.equal((await f.workflow.preferences(f.req())).preferences.enabled,false);
 assert.equal(validateTelegramAdminState((await f.accounts.readDatabase()).telegramAdmin),true);
});

test('Radar delivery has per-admin dedupe, no historical/demo replay, quiet hours and critical bypass',async t=>{
 const f=await fixture(t);f.add();await f.enable();await f.link(f.other,222222);await f.enable(f.other);
 const e=f.add();f.add({isDemo:true});f.add({importanceScore:5});await f.workflow.pump();assert.equal(f.sent.length,2);assert.deepEqual(new Set(f.sent.map(x=>x.payload.chat_id)),new Set(['123456','222222']));await f.workflow.pump();assert.equal(f.sent.length,2);
 f.advance(12*3600000);await f.enable(f.admin,{quietStart:23,quietEnd:8});await f.workflow.preferences(f.req(f.other),{...radarDefaults(),enabled:false});f.add({importanceScore:8});f.add({importanceScore:9});await f.workflow.pump();assert.equal(f.sent.length,3);assert.match(f.last().payload.text,/9\/10/);
 f.advance(8*3600000);await f.workflow.pump();assert.equal(f.sent.length,4);
 assert.equal(f.db.events.find(v=>v.id===e.id).notificationSentAt,undefined,'Does not reuse client-global notification marker');
});

test('Radar delivery retries persistently and invalidated bindings cannot receive queued events',async t=>{
 const f=await fixture(t);await f.enable();f.add();f.fail();await f.workflow.pump();assert.equal(f.sent.length,0);assert.equal((await f.store.radarRead()).alerts[0].attempts,1);f.advance(3000);await f.workflow.pump();assert.equal(f.sent.length,1);
 f.add();await f.store.unlink(f.req());await f.workflow.pump();assert.equal(f.sent.length,1);await assert.rejects(f.workflow.alert(f.identity,'anything'),e=>e.status===403);
});

test('Radar alert preserves manual draft and ignores an event without changing that draft',async t=>{
 const f=await fixture(t);await f.enable();f.add();await f.workflow.pump();const create=f.button('Создать сигнал'),ignore=f.button('Пропустить');await f.engine.process(f.message('GAZP 150 140 170'));const draft=await f.store.session(f.identity);await f.engine.process(create);assert.match(f.last().payload.text,/незавершённый ввод/);assert.equal((await f.store.session(f.identity)).nonce,draft.nonce);await f.engine.process(ignore);assert.equal((await f.store.session(f.identity)).nonce,draft.nonce);assert.equal((await f.store.radarRead()).ignored.length,1);
});

test('Radar three-price input always previews despite instant mode, publishes once and keeps provenance private',async t=>{
 const f=await fixture(t);await f.enable();await f.store.setPreferences(f.req(),{instantPublish:true});const e=f.add();await f.workflow.pump();await f.engine.process(f.button('Создать сигнал'));assert.match(f.last().payload.text,/три цены/);await f.engine.process(f.message('312 307 325'));assert.match(f.last().payload.text,/Источник: Radar/);assert.equal((await f.ideas.list(f.identity)).records.length,0);
 const confirm=f.button('Опубликовать');await f.engine.process(confirm);const [record]=(await f.ideas.list(f.identity)).records;assert.equal(record.radarSource.eventId,e.id);assert.equal(record.createdVia,'TELEGRAM');assert.equal(record.d.state,'waiting');assert.equal(record.d.summary,'');await f.engine.process(confirm);assert.equal((await f.ideas.list(f.identity)).records.length,1);
 const projected=await f.ideas.get(record.id,{id:'member',role:'member',subscriptions:[{plan:'pro',expiresAt:'2099-01-01T00:00:00Z'}]});assert.equal(projected.radarSource,undefined);assert.equal(projected.telegram,undefined);
});

test('Radar web draft is actor-bound, idempotent and requires confirmation for a second signal',async t=>{
 const f=await fixture(t),e=f.add(),actor=await f.accounts.identify(f.req());const first=await f.workflow.begin(actor,e.id,{requestId:'web-request-first'},f.req());
 const result=await f.workflow.publish(actor,plan(),{draftToken:first.draftToken,req:f.req()});const replay=await f.workflow.publish(actor,plan(),{draftToken:first.draftToken,req:f.req()});assert.equal(result.record.id,replay.record.id);
 await assert.rejects(f.workflow.publish(await f.accounts.identify(f.req(f.other)),plan(),{draftToken:first.draftToken,req:f.req(f.other)}),e=>e.status===409);
 await assert.rejects(f.workflow.begin(actor,e.id,{requestId:'web-request-second'},f.req()),e=>e.status===409);
 const second=await f.workflow.begin(actor,e.id,{requestId:'web-request-second',allowAnother:true},f.req());await f.workflow.publish(actor,plan(),{draftToken:second.draftToken,req:f.req()});assert.equal((await f.ideas.list(actor)).records.length,2);
 await assert.rejects(f.workflow.publish(actor,{...plan(),d:{...plan().d,entry:313}},{draftToken:first.draftToken,req:f.req()}),e=>e.status===409);
});

test('Radar rejects hidden/demo/bond events, changed sources and races between preview and publication',async t=>{
 const f=await fixture(t),actor=await f.accounts.identify(f.req());for(const extra of [{isDemo:true},{status:'hidden'},{assetType:'bond'}]){const e=f.add(extra);await assert.rejects(f.workflow.begin(actor,e.id,{requestId:'invalid-event-'+e.id},f.req()),e=>[400,409].includes(e.status));}
 const e=f.add(),a=await f.workflow.begin(actor,e.id,{requestId:'race-request-first'},f.req()),b=await f.workflow.begin(actor,e.id,{requestId:'race-request-second'},f.req());const settled=await Promise.allSettled([a,b].map(d=>f.workflow.publish(actor,plan(),{draftToken:d.draftToken,req:f.req()})));assert.equal(settled.filter(r=>r.status==='fulfilled').length,1);assert.equal(settled.find(r=>r.status==='rejected').reason.status,409);
 const next=f.add(),draft=await f.workflow.begin(actor,next.id,{requestId:'changed-source-request'},f.req());next.revision++;await assert.rejects(f.workflow.publish(actor,plan(),{draftToken:draft.draftToken,req:f.req()}),e=>e.status===409);assert.equal((await f.ideas.list(actor)).records.length,1);
});

test('Radar claim protects another editor, can be released, and role revocation stops publication',async t=>{
 const f=await fixture(t),e=f.add(),actor=await f.accounts.identify(f.req()),other=await f.accounts.identify(f.req(f.other));const first=await f.workflow.begin(actor,e.id,{requestId:'claim-first-request'},f.req());await assert.rejects(f.workflow.begin(other,e.id,{requestId:'claim-other-request'},f.req(f.other)),e=>e.status===409);await f.workflow.release(actor,first.draftToken,f.req());const second=await f.workflow.begin(other,e.id,{requestId:'claim-other-request'},f.req(f.other));await f.accounts.transact(db=>{db.users.find(u=>u.id===other.id).role='member';});await assert.rejects(f.workflow.publish(other,plan(),{draftToken:second.draftToken,req:f.req(f.other)}),e=>e.status===403);assert.equal((await f.ideas.list(actor)).records.length,0);
});

test('concurrent Radar pumps claim each delivery once before calling transport',async t=>{
 const f=await fixture(t);await f.enable();f.add();await Promise.all([f.workflow.pump(),f.workflow.pump()]);assert.equal(f.sent.length,1);assert.equal((await f.store.radarRead()).alerts[0].status,'sent');
});
