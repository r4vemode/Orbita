import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {createHook} from 'node:async_hooks';
import {serviceFixture} from './service-fixture.mjs';
import {totp} from '../lib/account-security.mjs';

const fixture=options=>serviceFixture(async()=>({handle:async()=>false,webhookPaths:[]}),options);
const password='test-password-long-2026';
async function pausedRequest(f,account,route,method='POST'){
 const req=new PassThrough();req.method=method;req.headers={host:new URL(f.base).host,origin:f.base,cookie:account.cookie,'content-type':'application/json'};req.socket={remoteAddress:'127.0.0.1'};
 let listening;const ready=new Promise(resolve=>{listening=resolve;});req.on('newListener',name=>{if(name==='data')listening();});
 const response={status:0,data:null,writeHead(status){this.status=status;return this;},end(body){this.data=JSON.parse(body);}};
 const work=f.accounts.handle(req,response,new URL(route,f.base));
 await Promise.race([ready,work.then(()=>{throw Error('Request completed before body reading');})]);
 return async body=>{req.end(JSON.stringify(body));await work;return response;};
}

test('subscription administration rechecks the current role and session after a slow request body',async()=>{
 for(const mutation of ['role','session']){
  const f=await fixture();try{
   const admin=await f.register('slow-admin@example.test'),member=await f.register('slow-member@example.test');await f.accounts.promote(admin.data.user.email);
   const finish=await pausedRequest(f,admin,'/api/admin/subscriptions');
   await f.accounts.transact(db=>{if(mutation==='role')db.users.find(user=>user.id===admin.data.user.id).role='member';else db.sessions=db.sessions.filter(session=>session.userId!==admin.data.user.id);});
   const result=await finish({userId:member.data.user.id,plan:'pro',expiresAt:new Date(Date.now()+86400000).toISOString(),reason:'Isolated race fixture'});
   assert.equal(result.status,mutation==='role'?403:401,mutation);
   assert.deepEqual((await f.accounts.readDatabase()).users.find(user=>user.id===member.data.user.id).subscriptions,[]);
  }finally{await f.close();}
 }
});

test('member mutations reject access revoked while their request body is still arriving',async()=>{
 const position={ideaId:'race-idea',entry:100,quantity:2,pointValue:1,enteredAt:'2026-10-01T10:00:00.000Z',exit:null,closedAt:null};
 for(const [route,method,body]of [['/api/watchlist','PUT',{ids:['race-idea']}],['/api/positions','PUT',position],['/api/positions','DELETE',{ideaId:'race-idea'}]]){
  const f=await fixture();try{
   const member=await f.register('slow-member@example.test');await f.accounts.transact(db=>{const user=db.users[0];user.subscriptions=[{plan:'pro',expiresAt:new Date(Date.now()+86400000).toISOString()}];user.positions=[position];});
   const finish=await pausedRequest(f,member,route,method);
   await f.accounts.transact(db=>{db.users[0].subscriptions=[];});
   const result=await finish(body);assert.equal(result.status,403,route+' '+method);
   const current=(await f.accounts.readDatabase()).users[0];assert.deepEqual(current.watchlist,[]);assert.deepEqual(current.positions,[position]);
  }finally{await f.close();}
 }
});

test('MFA setup cannot create a pending secret after its session is revoked during password work',async()=>{
 const f=await fixture();let hook,scheduled;
 try{
  const account=await f.register('mfa-revoked@example.test');
  hook=createHook({init(_id,type){if(type==='SCRYPTREQUEST'&&!scheduled)scheduled=f.accounts.transact(db=>{db.sessions=db.sessions.filter(session=>session.userId!==account.data.user.id);});}});
  hook.enable();const result=await f.request('/api/security/mfa/setup',{method:'POST',cookie:account.cookie,body:{password}});hook.disable();await scheduled;
  assert.ok(scheduled);assert.equal(result.status,401);assert.equal((await f.accounts.readDatabase()).users[0].mfaPending,undefined);
 }finally{hook?.disable();await f.close();}
});

test('newly promoted administrators cannot disable mandatory MFA through an already running request',async()=>{
 const f=await fixture({requireAdminMfa:true});let hook,scheduled;
 try{
  const account=await f.register('mfa-promoted@example.test'),setup=await f.request('/api/security/mfa/setup',{method:'POST',cookie:account.cookie,body:{password}});
  const confirm=await f.request('/api/security/mfa/confirm',{method:'POST',cookie:account.cookie,body:{code:totp(setup.data.secret)}});assert.equal(confirm.status,200);
  hook=createHook({init(_id,type){if(type==='SCRYPTREQUEST'&&!scheduled)scheduled=f.accounts.promote(account.data.user.email);}});
  hook.enable();const result=await f.request('/api/security/mfa/disable',{method:'POST',cookie:account.cookie,body:{password,code:confirm.data.recoveryCodes[0]}});hook.disable();await scheduled;
  assert.ok(scheduled);assert.equal(result.status,403);const current=(await f.accounts.readDatabase()).users[0];assert.equal(current.mfa.enabled,true);assert.equal(current.mfa.recoveryHashes.length,10);
 }finally{hook?.disable();await f.close();}
});
