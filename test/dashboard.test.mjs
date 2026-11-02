import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {createDashboard} from '../lib/dashboard.mjs';
import {serviceFixture} from './service-fixture.mjs';

const DAY=86400000;
const position=(ideaId,patch={})=>({ideaId,entry:100,quantity:2,pointValue:1,enteredAt:new Date(Date.now()-10000).toISOString(),exit:null,closedAt:null,...patch});
function full(ticker,strategy='Momentum RU'){return {mode:'full',d:{ticker,name:'Isolated '+ticker,dir:'ЛОНГ',market:'stocks',strategy,entry:100,stop:95,target:110,entryRule:'Confirmed by author',cancelRule:'Stop or cancellation',summary:'Isolated dashboard fixture'}};}
const record=(id,patch={})=>({id,published:true,d:{ticker:id.toUpperCase(),name:'Fixture',market:'stocks',unit:'₽',strategy:'Momentum RU',dir:'ЛОНГ',state:'active',status:'Активен',current:999999,...patch.d},meta:{events:[]},...patch});
async function fixture(options={}){
 const state={tickets:[],now:()=>Date.now()+1000,ideas:null,radar:null,...options};
 const f=await serviceFixture(({accounts,ideas})=>{state.realIdeas=ideas;state.radar??={canAccess:()=>false,overview:async()=>{throw Error('Locked source must never be called');}};state.ideas??=ideas;return createDashboard({accounts,ideas:state.ideas,radar:state.radar,support:{readDatabase:async()=>{if(state.supportError)throw Error('SENSITIVE SUPPORT FAILURE');return {tickets:state.tickets};}},now:()=>state.now()});});
 f.state=state;
 f.admin=await f.register('dashboard-admin@example.test');await f.accounts.promote(f.admin.data.user.email);
 f.pro=await f.register('dashboard-pro@example.test');f.exclusive=await f.register('dashboard-exclusive@example.test');f.free=await f.register('dashboard-free@example.test');
 f.grant=async(account,plan,expiresAt=new Date(Date.now()+2*DAY).toISOString())=>{const response=await f.request('/api/admin/subscriptions',{method:'POST',cookie:f.admin.cookie,body:{userId:account.data.user.id,plan,expiresAt,reason:'Isolated dashboard access'}});assert.equal(response.status,200);};
 await f.grant(f.pro,'pro');await f.grant(f.exclusive,'exclusive');
 f.setPrivate=(account,{positions=[],watchlist=[]})=>f.accounts.transact(db=>Object.assign(db.users.find(user=>user.id===account.data.user.id),{positions,watchlist}));
 return f;
}
const get=(f,account)=>f.request('/api/dashboard',{cookie:account?.cookie});

test('dashboard requires login but gives a free account only its subscription state and own support',async()=>{
 let ideaCalls=0;const f=await fixture({ideas:{list:async()=>{ideaCalls++;throw Error('Paid source must stay locked');}}});
 try{
  const own={id:'ticket-own',userId:f.free.data.user.id,number:'ORB-000001',subject:'Own ticket',status:'waiting_customer',updatedAt:new Date().toISOString(),messages:[{author:'admin',text:'Own reply',createdAt:new Date().toISOString(),actorId:'PRIVATE-ADMIN'}]},foreign={...own,id:'ticket-foreign',userId:f.pro.data.user.id,subject:'PRIVATE FOREIGN TICKET'};f.state.tickets=[own,foreign];
  assert.equal((await get(f)).status,401);const response=await get(f,f.free);assert.equal(response.status,200);const body=response.data;
  assert.equal(body.user.id,f.free.data.user.id);assert.equal(body.user.isAdmin,false);assert.deepEqual(body.subscriptions.map(row=>row.status),['none','none']);assert.deepEqual(body.reminders,[]);assert.equal(body.sections.positions,'locked');assert.deepEqual(body.positions,{items:[],total:0});assert.equal(body.sections.updates,'locked');assert.equal(ideaCalls,0);assert.equal(body.radar.available,false);assert.equal(body.support.total,1);assert.equal(body.support.waitingCount,1);assert.equal(body.support.items[0].lastReply.text,'Own reply');assert.ok(!JSON.stringify(body).includes('PRIVATE'));
  assert.equal((await f.request('/api/dashboard?userId=foreign',{cookie:f.free.cookie})).status,400);assert.equal((await f.request('/api/dashboard',{method:'POST',cookie:f.free.cookie,body:{}})).status,405);
 }finally{await f.close();}
});

test('dashboard uses current strategy permissions for personal positions and watched author events',async()=>{
 const f=await fixture();try{
  const actor={id:f.admin.data.user.id,role:'admin'},pro=(await f.ideas.create(actor,full('PROONLY'))).record,exclusive=(await f.ideas.create(actor,full('EXCLONLY','Orbita Exclusive'))).record;
  for(const account of [f.pro,f.exclusive])await f.setPrivate(account,{positions:[position(pro.id),position(exclusive.id)],watchlist:[pro.id,exclusive.id]});
  const p=(await get(f,f.pro)).data,e=(await get(f,f.exclusive)).data;
  assert.deepEqual(p.positions.items.map(row=>row.ticker),['PROONLY']);assert.ok(p.updates.items.every(row=>row.strategy==='Momentum RU'));assert.ok(!JSON.stringify(p).includes('EXCLONLY'));
  assert.deepEqual(e.positions.items.map(row=>row.ticker),['EXCLONLY']);assert.ok(e.updates.items.every(row=>row.strategy==='Orbita Exclusive'));assert.ok(!JSON.stringify(e).includes('PROONLY'));
  assert.equal(p.subscriptions[0].status,'active');assert.equal(p.reminders[0].plan,'pro');assert.equal(p.reminders[0].state,'expiring_soon');
 }finally{await f.close();}
});

test('manual positions remain pending exit review after author closure or an erroneous publication without fictitious live PnL',async()=>{
 const fixtures=[record('open'),record('author-closed',{d:{ticker:'CLOSED',name:'Closed author',market:'stocks',unit:'₽',strategy:'Momentum RU',dir:'ЛОНГ',state:'closed',status:'Закрыт',current:120},meta:{exit:120,events:[]}}),record('error',{erroneous:true}),record('manual-closed'),record('draft',{published:false})];
 const f=await fixture({ideas:{list:async()=>({records:fixtures})}});try{
  await f.setPrivate(f.pro,{positions:[position('open'),position('author-closed'),position('error'),position('manual-closed',{exit:102,closedAt:new Date().toISOString()}),position('draft'),position('missing'),position('bad',{quantity:-1})]});
  const body=(await get(f,f.pro)).data;assert.equal(body.positions.total,3);assert.equal(body.positions.items.find(item=>item.ideaId==='author-closed').needsExitReview,true);assert.equal(body.positions.items.find(item=>item.ideaId==='error').erroneous,true);assert.equal(body.positions.items.find(item=>item.ideaId==='open').needsExitReview,false);
  for(const item of body.positions.items)for(const field of ['current','pnl','percent','profit','exit','actorId'])assert.equal(Object.hasOwn(item,field),false,field);
 }finally{await f.close();}
});

test('overview bounds recent lists, sorts real event timestamps and ignores hidden, future, malformed or erroneous updates',async()=>{
 const at=Date.now()+1000,records=Array.from({length:10},(_,i)=>record('idea-'+i,{meta:{events:Array.from({length:2},(_,j)=>['label','Title '+i,'Body '+i,{id:'event-'+i+'-'+j,type:'note',at:new Date(at-1000-i*100-j).toISOString()}])}}));
 records.push(record('unwatched',{meta:{events:[['label','PRIVATE UNWATCHED','PRIVATE UNWATCHED',{id:'event-unwatched',at:new Date(at-2000).toISOString()}]]}}));
 records.push(record('erroneous',{erroneous:true,meta:{events:[['label','PRIVATE ERRONEOUS','PRIVATE ERRONEOUS',{id:'event-erroneous',at:new Date(at-100).toISOString()}]]}}));
 records[0].meta.events.push(['future','PRIVATE FUTURE','PRIVATE FUTURE',{id:'future',at:new Date(at+10000).toISOString()}],['bad','PRIVATE BAD','PRIVATE BAD',{id:'bad',at:'2026-02-30T00:00:00Z'}]);
 const f=await fixture({now:()=>at,ideas:{list:async()=>({records})}});try{
  await f.setPrivate(f.pro,{positions:records.slice(0,10).map((item,i)=>position(item.id,{enteredAt:new Date(at-10000-i).toISOString()})),watchlist:['erroneous']});
  const body=(await get(f,f.pro)).data;assert.equal(body.positions.total,10);assert.equal(body.positions.items.length,6);assert.equal(body.updates.total,20);assert.equal(body.updates.items.length,8);assert.ok(body.updates.items.every((item,i,all)=>i===0||item.at<=all[i-1].at));assert.ok(!JSON.stringify(body).includes('PRIVATE'));
 }finally{await f.close();}
});

test('Radar projection honors free preview and returns only compact existing authorized fields',async()=>{
 let feedCalls=0;const events=Array.from({length:7},(_,i)=>({id:'radar-'+i,ticker:'T'+i,companyName:'Fixture',eventType:'EARNINGS',headline:'Fixture headline',summary:'x'.repeat(500),impact:'positive',publishedAt:new Date(Date.now()-i*1000).toISOString(),isDemo:i===0,rawText:'PRIVATE RAW TEXT',whyImportant:'PRIVATE ANALYSIS',sources:['PRIVATE SOURCE'],importanceScore:10}));
 const f=await fixture({radar:{config:{enabled:true},canAccess:()=>true,canRealtime:()=>false,overview:async()=>{feedCalls++;return {events};}}});try{
  const body=(await get(f,f.free)).data;assert.equal(feedCalls,1);assert.equal(body.sections.radar,'ready');assert.equal(body.radar.limited,true);assert.equal(body.radar.returnedCount,5);assert.equal(body.radar.items[0].summary.length,240);assert.equal(body.radar.items[0].isDemo,true);assert.ok(!JSON.stringify(body).includes('PRIVATE'));for(const field of ['rawText','whyImportant','importanceScore','sources'])assert.equal(Object.hasOwn(body.radar.items[0],field),false);
  f.state.radar.config.enabled=false;const disabled=(await get(f,f.pro)).data;assert.equal(disabled.radar.available,false);assert.equal(disabled.radar.disabled,true);assert.equal(feedCalls,1);
 }finally{await f.close();}
});

test('source failures are independent and unavailable counts never masquerade as empty or expose exception details',async()=>{
 const f=await fixture({ideas:{list:async()=>{throw Error('PRIVATE IDEA SOURCE');}},radar:{canAccess:()=>true,overview:async()=>{throw Error('PRIVATE RADAR SOURCE');}}});try{
  f.state.supportError=true;const response=await get(f,f.pro);assert.equal(response.status,200);for(const section of ['positions','updates','radar','support'])assert.equal(response.data.sections[section],'unavailable');assert.equal(response.data.positions.total,null);assert.equal(response.data.support.total,null);assert.equal(response.data.radar.returnedCount,null);assert.ok(!JSON.stringify(response.data).includes('PRIVATE'));
  const original=f.accounts.readDatabase;f.accounts.readDatabase=async()=>{throw Object.assign(Error('PRIVATE ACCOUNT SOURCE'),{code:'DATA_INVALID'});};const core=await get(f,f.pro);f.accounts.readDatabase=original;assert.equal(core.status,503);assert.ok(!JSON.stringify(core.data).includes('PRIVATE'));assert.match(core.data.errorId,/^[a-f0-9-]{36}$/);
 }finally{await f.close();}
});

test('a subscription change, expiry extension or session revocation during aggregation discards the assembled paid snapshot',async()=>{
 for(const kind of ['revoke','extend','logout']){
  let entered,release;const gate=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});
  const f=await fixture({ideas:{list:async()=>{entered();await gate;return {records:[record('private-paid')]};}}});try{
   await f.setPrivate(f.pro,{positions:[position('private-paid')]});const pending=get(f,f.pro);await started;
   await f.accounts.transact(db=>{const owner=db.users.find(user=>user.id===f.pro.data.user.id);if(kind==='logout')db.sessions=db.sessions.filter(session=>session.userId!==owner.id);else owner.subscriptions=kind==='revoke'?[]:[{plan:'pro',expiresAt:new Date(Date.now()+30*DAY).toISOString()}];});release();
   const result=await pending;assert.equal(result.status,kind==='logout'?401:409,kind);assert.ok(!JSON.stringify(result.data).includes('PRIVATE-PAID'));assert.equal(Object.hasOwn(result.data,'positions'),false);
  }finally{release();await f.close();}
 }
});

test('an un-enrolled raw administrator never regains privileged dashboard data or purchase reminders',async()=>{
 let calls=0;const f=await serviceFixture(({accounts})=>createDashboard({accounts,ideas:{list:async()=>{calls++;return {records:[record('private-draft')]};}},support:{readDatabase:async()=>({tickets:[]})}}),{requireAdminMfa:true});try{
  const owner=await f.register('dashboard-enrollment@example.test');await f.accounts.promote(owner.data.user.email);const response=await get(f,owner);assert.equal(response.status,200);assert.equal(response.data.user.isAdmin,false);assert.equal(response.data.sections.positions,'locked');assert.deepEqual(response.data.reminders,[]);assert.equal(calls,0);
 }finally{await f.close();}
});

test('expired subscriptions keep support and renewal reminders available without reading paid history or writing files',async()=>{
 const f=await fixture();try{
  await f.accounts.transact(db=>{db.users.find(user=>user.id===f.free.data.user.id).subscriptions=[{plan:'exclusive',expiresAt:new Date(Date.now()-3600000).toISOString()}];});
  const names=await readdir(f.directory),before=new Map(await Promise.all(names.map(async name=>[name,await readFile(join(f.directory,name))]))),body=(await get(f,f.free)).data;
  assert.equal(body.sections.positions,'locked');assert.equal(body.sections.support,'ready');assert.equal(body.reminders[0].state,'expired');assert.equal(body.reminders[0].plan,'exclusive');assert.equal(body.subscriptions[1].status,'expired');
  assert.deepEqual(await readdir(f.directory),names);for(const name of names)assert.deepEqual(await readFile(join(f.directory,name)),before.get(name));
 }finally{await f.close();}
});

test('legacy expiration formats keep actual authenticated access while their uncertain card and reminder stay honest',async()=>{
 const f=await fixture({ideas:{list:async()=>({records:[record('legacy-paid')]})}});try{
  await f.setPrivate(f.pro,{positions:[position('legacy-paid')]});
  const unsupported=new Date(Date.now()+5*DAY).toISOString().slice(0,10);
  for(const subscriptions of [[{plan:'pro',expiresAt:unsupported}],[{plan:'pro',expiresAt:new Date(Date.now()+3600000).toISOString()},{plan:'pro',expiresAt:unsupported}]]){
   await f.accounts.transact(db=>{db.users.find(user=>user.id===f.pro.data.user.id).subscriptions=subscriptions;});
   const response=await get(f,f.pro);assert.equal(response.status,200);assert.equal(response.data.positions.total,1);assert.equal(response.data.sections.positions,'ready');const card=response.data.subscriptions[0];assert.equal(card.status,'unknown');assert.equal(card.expiresAt,null);assert.equal(card.remainingMs,null);assert.equal(card.daysRemaining,null);assert.equal(card.accessActive,true);assert.deepEqual(response.data.reminders,[]);
  }
 }finally{await f.close();}
});
