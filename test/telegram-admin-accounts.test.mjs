import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {serviceFixture} from './service-fixture.mjs';
import {createTelegramAdminStore,validateTelegramAdminState} from '../lib/telegram-admin/accounts.mjs';

async function fixture(options={}){
 let clock=Date.parse('2026-11-02T10:00:00Z');
 const f=await serviceFixture(async({accounts})=>({store:createTelegramAdminStore({accounts,now:()=>clock,...options}),webhookPaths:[],handle:async()=>false}));
 const admin=await f.register('telegram-editor@example.test'),free=await f.register('telegram-free@example.test');await f.accounts.promote(admin.data.user.email);
 const req=(account=admin,method='POST')=>({method,headers:{host:new URL(f.base).host,origin:f.base,cookie:account.cookie}}),store=f.service.store;
 return {...f,admin,free,req,store,advance(ms){clock+=ms;},async link(tg=123456){const token=await store.issueLink(req());return store.connect(tg,tg,token.code);}};
}
const update=(id,text,tg=123456)=>({update_id:id,message:{message_id:id+1,chat:{id:tg,type:'private'},from:{id:tg,is_bot:false},text}});

test('Telegram binding is issued only to an effective web admin and stores a one-use hash with TTL',async()=>{
 const f=await fixture();try{
  await assert.rejects(f.store.issueLink(f.req(f.free)),cause=>cause.status===403);
  await assert.rejects(f.store.issueLink(f.req(f.admin,'GET')),cause=>cause.status===405);
  const first=await f.store.issueLink(f.req()),second=await f.store.issueLink(f.req());assert.notEqual(first.code,second.code);assert.equal(first.code.length,41);
  const db=await f.accounts.readDatabase();assert.ok(!JSON.stringify(db).includes(second.code));assert.equal(db.telegramAdmin.links.length,1);assert.equal(db.telegramAdmin.links[0].hash,createHash('sha256').update(second.code).digest('hex'));
  await assert.rejects(f.store.connect(123456,123456,first.code),cause=>cause.status===400);
  const identity=await f.store.connect(123456,123456,second.code);assert.equal(identity.id,f.admin.data.user.id);assert.equal(identity.role,'admin');assert.equal((await f.store.status(f.req())).linked,true);
  await assert.rejects(f.store.connect(123456,123456,second.code),cause=>cause.status===400);
  const expiring=await f.store.issueLink(f.req());f.advance(600001);await assert.rejects(f.store.connect(123456,123456,expiring.code),cause=>cause.status===400);
 }finally{await f.close();}
});

test('Telegram binding requires private matching numeric IDs and cannot steal an existing admin binding',async()=>{
 const f=await fixture();try{
  const token=await f.store.issueLink(f.req());for(const ids of [['nickname','nickname'],[123,456],[-1,-1],['0123','0123']])await assert.rejects(f.store.connect(...ids,token.code),cause=>cause.status===403);
  await f.store.connect(123456,123456,token.code);await f.accounts.promote(f.free.data.user.email);const other=await f.store.issueLink(f.req(f.free));await assert.rejects(f.store.connect(123456,123456,other.code),cause=>cause.status===400);assert.equal((await f.store.getIdentity(123456,123456)).id,f.admin.data.user.id);
 }finally{await f.close();}
});

test('every Telegram action rechecks role, password and MFA stamp without restoring a raw administrator',async()=>{
 const f=await fixture();try{
  const identity=await f.link();await f.store.saveSession(identity,{step:'preview'});
  await f.accounts.transact(db=>{db.users.find(user=>user.id===identity.id).role='member';});assert.equal(await f.store.getIdentity(123456,123456),null);await assert.rejects(f.store.session(identity),cause=>cause.status===403);await assert.rejects(f.store.audit(identity,'publish'),cause=>cause.status===403);
  await f.accounts.transact(db=>{const user=db.users.find(user=>user.id===identity.id);user.role='admin';user.hash='b'.repeat(128);});await assert.rejects(f.store.authorize(identity),cause=>cause.status===403);
  const reset=await f.link();await f.accounts.transact(db=>{db.users.find(user=>user.id===reset.id).mfa={enabled:true,secret:'fixture-new-wrapped-secret'};});assert.equal(await f.store.getIdentity(123456,123456),null);await assert.rejects(f.store.saveReceipt(reset,'old-op',{ok:true}),cause=>cause.status===403);
 }finally{await f.close();}
});

test('MFA-required site cannot issue a link from an administrator enrollment or unverified MFA session',async()=>{
 const f=await fixture({requireMfa:true});try{
  await assert.rejects(f.store.issueLink(f.req()),cause=>cause.status===403);
  await f.accounts.transact(db=>{db.users.find(user=>user.id===f.admin.data.user.id).mfa={enabled:true,secret:'fixture-secret'};});await assert.rejects(f.store.issueLink(f.req()),cause=>cause.status===403);
  const cookie=f.admin.cookie.slice('orbita_session='.length),hash=createHash('sha256').update(cookie).digest('hex');await f.accounts.transact(db=>{db.sessions.find(session=>session.hash===hash).mfa=true;});const token=await f.store.issueLink(f.req());assert.equal((await f.store.connect(123456,123456,token.code)).role,'admin');
 }finally{await f.close();}
});

test('unlink invalidates drafts, callbacks, receipts and outstanding link codes',async()=>{
 const f=await fixture();try{
  const identity=await f.link(),token=await f.store.issueLink(f.req());await f.store.saveSession(identity,{step:'preview'});await f.store.saveReceipt(identity,'publish',{recordId:'idea-fixture'});await f.store.unlink(f.req());assert.equal(await f.store.getIdentity(123456,123456),null);await assert.rejects(f.store.session(identity),cause=>cause.status===403);await assert.rejects(f.store.getReceipt(identity,'publish'),cause=>cause.status===403);await assert.rejects(f.store.connect(123456,123456,token.code),cause=>cause.status===400);const state=(await f.accounts.readDatabase()).telegramAdmin;assert.deepEqual(state.sessions,[]);assert.deepEqual(state.receipts,[]);
 }finally{await f.close();}
});

test('drafts expire and settings are per-admin, default to preview and clear stale drafts when changed',async()=>{
 const f=await fixture();try{
  const identity=await f.link();assert.deepEqual(await f.store.settings(identity),{instantPublish:false,strategy:'Momentum RU'});await f.store.saveSession(identity,{step:'preview',entry:312.5});f.advance(30*60000);assert.equal(await f.store.session(identity),null);
  await f.store.saveSession(identity,{step:'preview'});assert.deepEqual(await f.store.setPreferences(f.req(),{instantPublish:true,strategy:'Orbita Exclusive'}),{preferences:{instantPublish:true,strategy:'Orbita Exclusive'}});assert.equal(await f.store.session(identity),null);await assert.rejects(f.store.setPreferences(f.req(),{strategy:'invented'}),cause=>cause.status===400);await assert.rejects(f.store.setPreferences(f.req(f.free),{instantPublish:true}),cause=>cause.status===403);
  await f.accounts.promote(f.free.data.user.email);const code=await f.store.issueLink(f.req(f.free)),other=await f.store.connect(789012,789012,code.code);assert.deepEqual(await f.store.settings(other),{instantPublish:false,strategy:'Momentum RU'});assert.equal(await f.store.getReceipt(other,'unknown'),null);
 }finally{await f.close();}
});

test('idempotent receipts preserve first result and reject oversized payloads',async()=>{
 const f=await fixture();try{
  const identity=await f.link();await f.store.saveReceipt(identity,'publication:1',{recordId:'idea-first'});assert.deepEqual(await f.store.saveReceipt(identity,'publication:1',{recordId:'idea-second'}),{recordId:'idea-first'});assert.deepEqual(await f.store.getReceipt(identity,'publication:1'),{recordId:'idea-first'});await assert.rejects(f.store.saveReceipt(identity,'large',{text:'a'.repeat(40000)}),cause=>cause.status===400);await assert.rejects(f.store.saveSession(identity,{text:'a'.repeat(40000)}),cause=>cause.status===400);
 }finally{await f.close();}
});

test('durable inbox canonicalizes fields, hashes connect codes, deduplicates and resumes after store recreation',async()=>{
 const f=await fixture();try{
  const token=await f.store.issueLink(f.req()),input={...update(1,'/connect '+token.code),connectCodeHash:'attacker',extra:'discard'};assert.deepEqual(await f.store.acceptUpdate(input),{accepted:true});assert.deepEqual(await f.store.acceptUpdate(input),{accepted:false,duplicate:true});const queued=(await f.store.pendingUpdates())[0];assert.equal(queued.message.text,'/connect');assert.equal(queued.connectCodeHash,createHash('sha256').update(token.code).digest('hex'));assert.ok(!JSON.stringify((await f.accounts.readDatabase()).telegramAdmin).includes(token.code));assert.ok(!Object.hasOwn(queued,'extra'));
  const identity=await f.store.connect(123456,123456,{codeHash:queued.connectCodeHash});assert.equal(identity.id,f.admin.data.user.id);await f.store.completeUpdate(1);assert.deepEqual(await f.store.pendingUpdates(),[]);assert.deepEqual(await f.store.acceptUpdate(update(2,'SBER 312 307 325')),{accepted:true});const restored=createTelegramAdminStore({accounts:f.accounts,now:()=>Date.parse('2026-11-02T10:00:00Z')});assert.equal((await restored.pendingUpdates())[0].update_id,2);
 }finally{await f.close();}
});

test('durable inbox drops unauthenticated and non-private updates and never honors external connect hashes',async()=>{
 const f=await fixture();try{
  for(const candidate of [update(1,'SBER 312 307 325'),{...update(2,'/connect'),connectCodeHash:'a'.repeat(64)},update(3,'/start'),{...update(4,'/connect orbadmin_'+'a'.repeat(32)),message:{...update(4,'x').message,chat:{id:123456,type:'group'}}}])assert.deepEqual(await f.store.acceptUpdate(candidate),{accepted:false});
  await f.link();const callback={update_id:5,callback_query:{id:'callback-fixture',data:'publish:draft',from:{id:123456,is_bot:false},message:{message_id:99,chat:{id:123456,type:'private'},from:{id:999999,is_bot:true},text:'discard original card'}}};assert.deepEqual(await f.store.acceptUpdate(callback),{accepted:true});assert.ok(!JSON.stringify(await f.store.pendingUpdates()).includes('discard original card'));
 }finally{await f.close();}
});

test('failed updates use bounded retries and become terminal without retaining command payloads',async()=>{
 const f=await fixture();try{
  await f.link();await f.store.acceptUpdate(update(1,'SBER 312 307 325'));for(let attempt=0;attempt<4;attempt++){assert.equal((await f.store.failUpdate(1)).retry,true);assert.deepEqual(await f.store.pendingUpdates(),[]);f.advance(60001);assert.equal((await f.store.pendingUpdates()).length,1);}assert.equal((await f.store.failUpdate(1)).retry,false);assert.deepEqual(await f.store.pendingUpdates(),[]);const item=(await f.accounts.readDatabase()).telegramAdmin.updates.find(item=>item.id===1);assert.equal(item.status,'failed');assert.equal(item.update,null);assert.deepEqual(await f.store.acceptUpdate(update(1,'SBER 312 307 325')),{accepted:false,duplicate:true});
 }finally{await f.close();}
});

test('connect attempts are limited per Telegram ID and corrupt metadata fails closed',async()=>{
 const f=await fixture();try{
  for(let i=0;i<5;i++)await assert.rejects(f.store.connect(123456,123456,'orbadmin_'+'a'.repeat(32)),cause=>cause.status===400);await assert.rejects(f.store.connect(123456,123456,'orbadmin_'+'a'.repeat(32)),cause=>cause.status===429);f.advance(15*60000);await assert.rejects(f.store.connect(123456,123456,'orbadmin_'+'a'.repeat(32)),cause=>cause.status===400);assert.equal(validateTelegramAdminState(undefined),true);assert.equal(validateTelegramAdminState({version:1}),false);assert.equal(validateTelegramAdminState((await f.accounts.readDatabase()).telegramAdmin),true);
 }finally{await f.close();}
});

test('unbound random connect codes cannot fill the durable inbox and live codes reserve only one slot',async()=>{
 const f=await fixture();try{
  for(let i=0;i<70;i++)assert.deepEqual(await f.store.acceptUpdate(update(i,'/connect orbadmin_'+'a'.repeat(32),123456+i)),{accepted:false});assert.deepEqual(await f.store.pendingUpdates(),[]);
  const code=await f.store.issueLink(f.req());assert.deepEqual(await f.store.acceptUpdate(update(101,'/connect '+code.code,222222)),{accepted:true});assert.deepEqual(await f.store.acceptUpdate(update(102,'/connect '+code.code,333333)),{accepted:false,duplicate:true});assert.equal((await f.store.pendingUpdates()).length,1);
  await f.store.completeUpdate(101);f.advance(600001);assert.deepEqual(await f.store.acceptUpdate(update(103,'/connect '+code.code,444444)),{accepted:false});assert.deepEqual(await f.store.pendingUpdates(),[]);
 }finally{await f.close();}
});

test('queued bound updates carry an internal binding epoch and are discarded after unlink or account rebind',async()=>{
 const f=await fixture();try{
  const identity=await f.link();const input={...update(1,'SBER 312 307 325'),acceptedBindingId:'external-forgery',acceptedAuthStamp:'external-forgery'};assert.deepEqual(await f.store.acceptUpdate(input),{accepted:true});const accepted=(await f.store.pendingUpdates())[0];assert.equal(accepted.acceptedBindingId,identity.bindingId);assert.equal(accepted.acceptedAuthStamp,identity.authStamp);
  await f.store.unlink(f.req());await f.accounts.promote(f.free.data.user.email);const code=await f.store.issueLink(f.req(f.free));const rebound=await f.store.connect(123456,123456,code.code);assert.notEqual(rebound.bindingId,identity.bindingId);assert.deepEqual(await f.store.pendingUpdates(),[]);const old=(await f.accounts.readDatabase()).telegramAdmin.updates.find(item=>item.id===1);assert.equal(old.status,'complete');assert.equal(old.update,null);
 }finally{await f.close();}
});
