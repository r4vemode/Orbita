import test from 'node:test';
import assert from 'node:assert/strict';
import {createAccounts} from '../lib/accounts.mjs';
import {LEGAL_VERSION} from '../lib/access.mjs';
import {buildMvpMetrics} from '../lib/mvp-metrics.mjs';
import {serviceFixture} from './service-fixture.mjs';

const emptyService=async()=>({handle:async()=>false,webhookPaths:[]});
const payload=email=>({email,password:'test-registration-password',acceptTerms:true,acceptPrivacy:true,legalVersion:LEGAL_VERSION});

test('valid registrations and duplicate retries persist aggregate counters without exposing them to clients',async()=>{
 const f=await serviceFixture(emptyService);try{
  const initial=await f.accounts.readDatabase();assert.equal(initial.registrationStats,undefined);
  const first=await f.register('measured@example.test');assert.equal(first.status,200);
  const duplicate=await f.register('measured@example.test');assert.equal(duplicate.status,409);assert.equal(duplicate.cookie,undefined);
  const second=await f.register('second-measured@example.test');assert.equal(second.status,200);
  const db=await f.accounts.readDatabase();assert.equal(db.users.length,2);assert.deepEqual(Object.keys(db.registrationStats).sort(),['startedAt','successful','validAttempts']);assert.equal(db.registrationStats.validAttempts,3);assert.equal(db.registrationStats.successful,2);assert.ok(Number.isFinite(Date.parse(db.registrationStats.startedAt)));
  const serialized=JSON.stringify(db.registrationStats);for(const privateValue of ['measured@example.test','second-measured@example.test','test-password-long-2026','127.0.0.1'])assert.ok(!serialized.includes(privateValue));
  for(const response of [first,second,await f.request('/api/me',{cookie:first.cookie})])assert.ok(!JSON.stringify(response.data).includes('registrationStats'));
  const reopened=await createAccounts(f.directory,{publicOrigin:f.base});assert.deepEqual((await reopened.readDatabase()).registrationStats,db.registrationStats);
  const report=buildMvpMetrics({accounts:db,now:Date.now()});assert.equal(report.registration.attempts,3);assert.equal(report.registration.measuredSuccessful,2);assert.equal(report.registration.rate,2/3);assert.equal(report.registration.reason,'valid_submissions');
 }finally{await f.close();}
});

test('malformed forms, missing consent and rejected origins are outside registration measurement',async()=>{
 const f=await serviceFixture(emptyService);try{
  const request=(body,headers={})=>f.request('/api/register',{method:'POST',body,headers});
  assert.equal((await request({...payload('missing-consent@example.test'),acceptPrivacy:false})).status,400);
  assert.equal((await request({...payload('short-password@example.test'),password:'short'})).status,400);
  assert.equal((await request(payload('foreign-origin@example.test'),{Origin:'https://outside.example'})).status,403);
  assert.equal((await f.accounts.readDatabase()).registrationStats,undefined);
  assert.equal((await f.register('valid-after-invalid@example.test')).status,200);const stats=(await f.accounts.readDatabase()).registrationStats;assert.equal(stats.validAttempts,1);assert.equal(stats.successful,1);
 }finally{await f.close();}
});

test('existing account history is not invented when measurement starts with a duplicate',async()=>{
 const f=await serviceFixture(emptyService);try{
  await f.register('legacy@example.test');await f.accounts.transact(db=>{delete db.registrationStats;});
  assert.equal((await f.register('legacy@example.test')).status,409);const db=await f.accounts.readDatabase();assert.equal(db.users.length,1);assert.equal(db.registrationStats.validAttempts,1);assert.equal(db.registrationStats.successful,0);
  const report=buildMvpMetrics({accounts:db,now:Date.now()});assert.equal(report.registration.successful,1);assert.equal(report.registration.measuredSuccessful,0);assert.equal(report.registration.rate,0);
 }finally{await f.close();}
});

test('concurrent duplicate attempts count once per valid request while creating one account',async()=>{
 const f=await serviceFixture(emptyService);try{
  const responses=await Promise.all([f.register('simultaneous@example.test'),f.register('simultaneous@example.test')]);assert.deepEqual(responses.map(response=>response.status).sort(),[200,409]);
  const db=await f.accounts.readDatabase();assert.equal(db.users.length,1);assert.equal(db.registrationStats.validAttempts,2);assert.equal(db.registrationStats.successful,1);
 }finally{await f.close();}
});

test('rate-limited registration requests do not enter the denominator',async()=>{
 const f=await serviceFixture(emptyService);try{
  for(let attempt=0;attempt<12;attempt++)assert.equal((await f.register('limited@example.test')).status,attempt===0?200:409);
  assert.equal((await f.register('limited@example.test')).status,429);const stats=(await f.accounts.readDatabase()).registrationStats;assert.equal(stats.validAttempts,12);assert.equal(stats.successful,1);
 }finally{await f.close();}
});
