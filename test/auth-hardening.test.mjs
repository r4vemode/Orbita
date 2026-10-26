import test from 'node:test';
import assert from 'node:assert/strict';
import {createHook} from 'node:async_hooks';
import {scrypt} from 'node:crypto';
import {promisify} from 'node:util';
import {createPasswordWork,derivePassword} from '../lib/password-work.mjs';
import {tokenHash} from '../lib/account-security.mjs';
import {createAttemptLimiter} from '../lib/auth-limits.mjs';
import {serviceFixture} from './service-fixture.mjs';

const tick=()=>new Promise(resolve=>setImmediate(resolve));
const busy=promise=>assert.rejects(promise,error=>error.status===429&&error.code==='PASSWORD_WORK_BUSY');
const service=()=>serviceFixture(async()=>({webhookPaths:[],handle:async()=>false}));

test('account attempt capacity rejects new keys without evicting or resetting live limits',()=>{
 let at=0;const limiter=createAttemptLimiter({maxKeys:3,windowMs:100,now:()=>at});
 assert.equal(limiter.take([['ip:one',10],['account:one',2]]),true);
 assert.equal(limiter.take([['account:two',2]]),true);
 assert.equal(limiter.take([['account:three',2]]),false,'a fourth live key cannot be retained');
 assert.equal(limiter.take([['account:one',2]]),true);
 assert.equal(limiter.take([['account:one',2]]),false,'overflow did not evict and reset the first account');
 at=101;assert.equal(limiter.take([['account:three',2]]),true,'expired entries release capacity');
 assert.equal(limiter.take([['account:one',2]]),true,'an expired account gets a new window');
});

test('a rejected source bucket cannot create later account keys or extend its own time window',()=>{
 let at=0;const limiter=createAttemptLimiter({maxKeys:2,windowMs:100,now:()=>at});
 assert.equal(limiter.take([['ip:one',1]]),true);at=50;
 assert.equal(limiter.take([['ip:one',1],['account:not-created',100]]),false);
 assert.equal(limiter.take([['account:other',1]]),true,'later bucket was never allocated');
 at=101;assert.equal(limiter.take([['ip:one',1]]),true,'rejected attempts did not extend the original window');
});

test('password work has a process-wide bounded active count and queue without changing hash format',async()=>{
 let active=0,peak=0,started=0;const releases=[];
 const work=createPasswordWork({timeoutMs:1000,worker:value=>new Promise(resolve=>{active++;started++;peak=Math.max(peak,active);releases.push(()=>{active--;resolve(value);});})});
 const jobs=Array.from({length:10},(_,index)=>work(index));
 await busy(work('overflow'));await tick();assert.equal(started,2);
 for(let completed=0;completed<10;completed++){assert.ok(active<=2);assert.ok(releases.length);releases.shift()();await tick();}
 assert.deepEqual(await Promise.all(jobs),Array.from({length:10},(_,i)=>i));assert.equal(peak,2);
 const expected=await promisify(scrypt)('compatibility-password','persisted-salt',64);
 assert.deepEqual(await derivePassword('compatibility-password','persisted-salt',64),expected);
});

test('expired password work never releases native capacity before the underlying operation ends',async()=>{
 const releases=[];let started=0;
 const work=createPasswordWork({concurrency:1,maxQueue:1,timeoutMs:100,worker:()=>new Promise(resolve=>{started++;releases.push(resolve);})});
 const first=busy(work('active')),queued=busy(work('queued'));
 await Promise.all([first,queued]);assert.equal(started,1,'queued work expired without invoking crypto');
 const next=work('after-expiry');await tick();assert.equal(started,1,'timed-out active crypto still owns its slot');
 releases.shift()('ignored late result');await tick();assert.equal(started,2);releases.shift()('new result');assert.equal(await next,'new result');
});

test('password worker rejection frees capacity and queued requests still complete',async()=>{
 let calls=0;const work=createPasswordWork({concurrency:1,maxQueue:1,worker:async()=>{if(++calls===1)throw Error('derive failed');return Buffer.from('second');}});
 const first=assert.rejects(work('one'),/derive failed/),second=work('two');await first;assert.deepEqual(await second,Buffer.from('second'));
 const immediate=createPasswordWork({concurrency:1,maxQueue:0,worker:async value=>value});assert.equal(await immediate('first'),'first');assert.equal(await immediate('next'),'next');
});

test('nonexistent and expired password-reset tokens do not start expensive crypto work',async()=>{
 const f=await service();let count=0;const hook=createHook({init(_id,type){if(type==='SCRYPTREQUEST')count++;}});
 try{
  const registration=await f.register('reset-budget@example.test');assert.equal(registration.status,200);
  const token='b'.repeat(64),expiredToken='c'.repeat(64);
  await f.accounts.transact(db=>{db.securityTokens.push({hash:tokenHash(expiredToken),userId:registration.data.user.id,purpose:'reset',expires:Date.now()-1000});});
  hook.enable();
  const absent=await f.request('/api/security/reset-password',{method:'POST',body:{token,password:'new-password-never-derived'}});assert.equal(absent.status,400);
  const expired=await f.request('/api/security/reset-password',{method:'POST',body:{token:expiredToken,password:'new-password-never-derived'}});assert.equal(expired.status,400);
  const invalid=await f.request('/api/security/reset-password',{method:'POST',body:{token:'not-a-token',password:'new-password-never-derived'}});assert.equal(invalid.status,400);
  hook.disable();assert.equal(count,0);
 }finally{hook.disable();await f.close();}
});

test('concurrent resets consume one token, retain only the winning password and revoke old sessions',async()=>{
 const f=await service();
 try{
  const account=await f.register('reset-race@example.test');assert.equal(account.status,200);
  assert.equal((await f.request('/api/security/request-password-reset',{method:'POST',body:{email:account.data.user.email}})).status,200);await f.accounts.flushMail();
  const token=new URL(f.emails.at(-1).text.match(/https?:\/\/\S+/)[0]).hash.slice(7),passwords=['concurrent-reset-first','concurrent-reset-second'];
  const results=await Promise.all(passwords.map(password=>f.request('/api/security/reset-password',{method:'POST',body:{token,password}})));
  assert.deepEqual(results.map(result=>result.status).sort(),[200,400]);const winner=results.findIndex(result=>result.status===200);
  assert.equal((await f.request('/api/me',{cookie:account.cookie})).data.user,null);
  const login=password=>f.request('/api/login',{method:'POST',body:{email:account.data.user.email,password}});
  assert.equal((await login(passwords[winner])).status,200);assert.equal((await login(passwords[1-winner])).status,401);assert.equal((await login('test-password-long-2026')).status,401);
  const replay=await f.request('/api/security/reset-password',{method:'POST',body:{token,password:'reset-replay-password'}});assert.equal(replay.status,400);
 }finally{await f.close();}
});
