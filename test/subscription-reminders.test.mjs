import test from 'node:test';
import assert from 'node:assert/strict';
import {buildSubscriptionReminders,summarizeSubscriptions} from '../lib/subscription-reminders.mjs';

const HOUR=3600000,DAY=24*HOUR,now=Date.parse('2026-10-31T12:00:00.000Z');
const expiry=remaining=>new Date(now+remaining).toISOString();
const member=(...subscriptions)=>({id:'fixture-member',role:'member',subscriptions});
const subscription=(plan,remaining)=>({plan,expiresAt:expiry(remaining)});

test('renewal reminders use exact 72-hour, 24-hour and expiry boundaries',()=>{
 for(const [remaining,state,days] of [[72*HOUR+1,null,null],[72*HOUR,'expiring_soon',3],[24*HOUR+1,'expiring_soon',2],[24*HOUR,'expiring_today',1],[1,'expiring_today',1],[0,'expired',0],[-1,'expired',0],[-7*DAY,'expired',0],[-7*DAY-1,null,null]]){
  const result=buildSubscriptionReminders(member(subscription('pro',remaining)),{now});
  if(state===null)assert.deepEqual(result,[],String(remaining));
  else{assert.equal(result.length,1);assert.equal(result[0].state,state);assert.equal(result[0].daysRemaining,days);assert.equal(result[0].remainingMs,remaining);}
 }
});

test('Pro and Exclusive keep independent state and renewal destinations',()=>{
 const user=member(subscription('pro',12*HOUR),subscription('exclusive',2*DAY)),rows=summarizeSubscriptions(user,{now}),reminders=buildSubscriptionReminders(user,{now});
 assert.deepEqual(rows.map(row=>[row.plan,row.status,row.expiresAt]),[['pro','active',expiry(12*HOUR)],['exclusive','active',expiry(2*DAY)]]);
 assert.deepEqual(reminders.map(row=>[row.plan,row.state,row.renewUrl]),[['pro','expiring_today','/subscriptions.html?plan=pro'],['exclusive','expiring_soon','/subscriptions.html?plan=exclusive']]);
 assert.deepEqual(rows.map(row=>[row.name,row.price,row.days]),[['Orbita Pro',2999,30],['Orbita Exclusive',4999,30]]);
});

test('a renewal immediately replaces the former warning with the effective latest expiry',()=>{
 const user=member(subscription('pro',HOUR),subscription('pro',30*DAY),subscription('pro',2*HOUR));
 assert.deepEqual(buildSubscriptionReminders(user,{now}),[]);assert.equal(summarizeSubscriptions(user,{now})[0].expiresAt,expiry(30*DAY));
 const old=buildSubscriptionReminders(member(subscription('pro',HOUR)),{now})[0],changed=buildSubscriptionReminders(member(subscription('pro',2*HOUR)),{now})[0];assert.notEqual(old.id,changed.id);
});

test('removing the plan cancels its warning while legacy null entries cannot hide a valid grant',()=>{
 const removed=member();assert.deepEqual(buildSubscriptionReminders(removed,{now}),[]);assert.equal(summarizeSubscriptions(removed,{now})[0].status,'none');
 const nullOnly=member({plan:'pro',expiresAt:null});assert.deepEqual(buildSubscriptionReminders(nullOnly,{now}),[]);assert.equal(summarizeSubscriptions(nullOnly,{now})[0].status,'none');
 const legacy=member(subscription('pro',HOUR),{plan:'pro',expiresAt:null});assert.equal(buildSubscriptionReminders(legacy,{now})[0].expiresAt,expiry(HOUR));
 const renewed=member(subscription('pro',HOUR),{plan:'pro',expiresAt:null},subscription('pro',2*HOUR));assert.equal(buildSubscriptionReminders(renewed,{now})[0].expiresAt,expiry(2*HOUR));
});

test('administrator access does not generate purchase reminders or pretend to be a paid subscription',()=>{
 for(const user of [{role:'admin',subscriptions:[subscription('pro',HOUR)]},{role:'member',access:{isAdmin:true},subscriptions:[subscription('exclusive',-HOUR)]},{role:'member',security:{adminEnrollmentRequired:true},subscriptions:[subscription('pro',HOUR)]},{role:'member',security:{mfaRequiredForAdmin:true},subscriptions:[subscription('pro',HOUR)]}])assert.deepEqual(buildSubscriptionReminders(user,{now}),[]);
 assert.equal(buildSubscriptionReminders({role:'member',security:{adminEnrollmentRequired:false,mfaRequiredForAdmin:false},subscriptions:[subscription('pro',HOUR)]},{now}).length,1);
 assert.deepEqual(summarizeSubscriptions({role:'admin'},{now}).map(row=>[row.status,row.expiresAt]),[['none',null],['none',null]]);
});

test('ISO offsets normalize to the same instant and reminder identifier',()=>{
 const first=buildSubscriptionReminders(member({plan:'pro',expiresAt:'2026-11-01T03:00:00+03:00'}),{now})[0],second=buildSubscriptionReminders(member({plan:'pro',expiresAt:'2026-11-01T00:00:00.000Z'}),{now})[0];
 assert.deepEqual(first,second);assert.equal(first.remainingMs,12*HOUR);assert.equal(first.expiresAt,'2026-11-01T00:00:00.000Z');
});

test('invalid dates, coerced values and unknown plans cannot create a reminder or replace a valid grant',()=>{
 const invalid=['2026-02-30T12:00:00Z','2026-10-31T24:00:00Z','2026-10-31T12:60:00Z','2026-10-31T12:00:60Z','2026-10-31T12:00:00+24:00','2026-10-31T12:00:00+03:60','2026-10-31','0','',now+HOUR,new Date(now+HOUR),{},undefined];
 for(const expiresAt of invalid){assert.deepEqual(buildSubscriptionReminders(member({plan:'pro',expiresAt}),{now}),[]);assert.equal(summarizeSubscriptions(member(subscription('pro',HOUR),{plan:'pro',expiresAt}),{now})[0].expiresAt,expiry(HOUR));}
 const malformed=member(null,3,[],{plan:'__proto__',expiresAt:expiry(HOUR)},{plan:'unknown',expiresAt:expiry(HOUR)});assert.deepEqual(buildSubscriptionReminders(malformed,{now}),[]);
});

test('missing subscriptions have two honest empty cards and old expirations remain visible without recurring warnings',()=>{
 for(const user of [null,{},member(),{subscriptions:'invalid'}])assert.deepEqual(summarizeSubscriptions(user,{now}).map(row=>[row.plan,row.status,row.expiresAt,row.remainingMs,row.daysRemaining]),[['pro','none',null,null,0],['exclusive','none',null,null,0]]);
 const rows=summarizeSubscriptions(member(subscription('exclusive',-30*DAY)),{now});assert.equal(rows[1].status,'expired');assert.equal(rows[1].expiresAt,expiry(-30*DAY));assert.deepEqual(buildSubscriptionReminders(member(subscription('exclusive',-30*DAY)),{now}),[]);
});

test('reference time must be explicit valid epoch milliseconds, never silently repaired',()=>{
 for(const value of [NaN,Infinity,-Infinity,'2026-10-31',new Date(now),()=>now,Number.MAX_SAFE_INTEGER]){
  assert.throws(()=>buildSubscriptionReminders(member(subscription('pro',HOUR)),{now:value}),/now must/);assert.throws(()=>summarizeSubscriptions(null,{now:value}),/now must/);
 }
});

test('reminder DTOs contain no account secrets and the pure model leaves input unchanged',()=>{
 const user=member(subscription('pro',HOUR),subscription('exclusive',-HOUR));user.email='private-fixture@example.test';user.salt='private-salt';user.hash='private-hash';const before=structuredClone(user);Object.freeze(user.subscriptions);Object.freeze(user);
 const result=buildSubscriptionReminders(user,{now});assert.deepEqual(user,before);assert.equal(result.length,2);assert.ok(!JSON.stringify(result).includes('private-'));
 for(const row of result){assert.deepEqual(Object.keys(row),['id','plan','name','expiresAt','state','remainingMs','daysRemaining','renewUrl']);assert.ok(Number.isFinite(row.remainingMs));assert.ok(Number.isFinite(row.daysRemaining));}
 assert.match(result[0].id,/^subscription:pro:/);assert.match(result[0].id,/:expiring_today$/);
});
