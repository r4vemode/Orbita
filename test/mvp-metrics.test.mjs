import test from 'node:test';
import assert from 'node:assert/strict';
import {buildMvpMetrics} from '../lib/mvp-metrics.mjs';

const DAY=86400000,origin=Date.parse('2026-01-01T00:00:00Z'),at=days=>new Date(origin+days*DAY).toISOString();
const member=(id,extra={})=>({id,role:'member',createdAt:at(0),emailVerified:false,...extra});
const order=(id,userId,plan,day,extra={})=>({id,userId,plan,createdAt:at(day),testMode:false,status:'paid',payment:{verified:true,at:at(day)},creditedAt:new Date(origin+day*DAY+1000).toISOString(),...extra});
const metrics=(users,orders,days=60)=>buildMvpMetrics({accounts:{users},billing:{orders},now:origin+days*DAY});

test('empty metrics preserve unknown denominators and never invent zero-percent success',()=>{
  const result=buildMvpMetrics({now:origin});assert.equal(result.registration.rate,null);assert.equal(result.registration.attempts,null);assert.equal(result.registration.reason,'not_collected');
  assert.equal(result.emailVerification.rate,null);assert.equal(result.paymentConversion.rate,null);assert.equal(result.activationLatency.medianMs,null);assert.equal(result.activationLatency.p95Ms,null);assert.equal(result.renewal30d.rate,null);
  assert.equal(result.renewal30d.reason,'no_mature_cohorts');
});

test('registration measurement uses only persisted aggregate counters from its actual start',()=>{
  const result=buildMvpMetrics({accounts:{users:[member('one'),member('two')],registrationStats:{startedAt:at(10),validAttempts:4,successful:3}},now:origin+60*DAY});
  assert.deepEqual(result.registration,{successful:2,measuredSuccessful:3,attempts:4,rate:.75,measurementStartedAt:at(10),reason:'valid_submissions'});
  for(const stats of [null,{}, {startedAt:at(10),validAttempts:'4',successful:3},{startedAt:at(10),validAttempts:2,successful:3},{startedAt:at(100),validAttempts:4,successful:3},{startedAt:at(10),validAttempts:-1,successful:0}]){
    const unmeasured=buildMvpMetrics({accounts:{users:[member('one')],registrationStats:stats},now:origin+60*DAY});assert.equal(unmeasured.registration.rate,null);assert.equal(unmeasured.registration.measuredSuccessful,null);assert.equal(unmeasured.registration.reason,'not_collected');
  }
});

test('conversion uses unique members and only live credited verified non-refunded orders',()=>{
  const users=[member('one',{emailVerified:true,email:'secret@example.test'}),member('two',{emailVerified:true}),member('three'),member('four',{subscriptions:[{plan:'pro',expiresAt:at(100)}]}),member('owner',{role:'admin'}),member('one')];
  const orders=[
    order('a','one','pro',1),order('b','one','exclusive',2),order('test','two','pro',3,{testMode:true}),order('string-test','two','pro',3,{testMode:'false'}),
    order('refunded','two','pro',4,{refund:{full:true}}),order('status-refunded','two','pro',4,{status:'refunded'}),order('refunded-at','two','pro',4,{refundedAt:at(5)}),
    order('unverified','two','pro',4,{payment:{verified:false,at:at(4)}}),order('manual','four','pro',4,{payment:undefined}),order('owner-pay','owner','pro',4),
    order('pending','two','pro',4,{status:'pending'}),order('partial','three','pro',4,{status:'refund_review',partialRefunds:[{amount:100}]})
  ];
  const result=metrics(users,orders);assert.deepEqual(result.emailVerification,{registeredMembers:4,verifiedMembers:2,rate:.5,reason:'stored_accounts'});
  assert.equal(result.paymentConversion.registeredMembers,4);assert.equal(result.paymentConversion.paidMembers,2);assert.equal(result.paymentConversion.liveOrders,3);assert.equal(result.paymentConversion.rate,.5);
  assert.ok(!JSON.stringify(result).includes('secret@example.test'));assert.ok(!JSON.stringify(result).includes('owner-pay'));
});

test('latency includes valid nonnegative samples and reports median and nearest-rank p95',()=>{
  const users=[member('one')],orders=Array.from({length:20},(_,index)=>order('latency-'+index,'one','pro',1,{creditedAt:new Date(origin+DAY+(index+1)*1000).toISOString()}));
  orders.push(order('negative','one','pro',2,{creditedAt:new Date(origin+2*DAY-1).toISOString()}));
  const result=metrics(users,orders);assert.deepEqual(result.activationLatency,{sampleCount:20,medianMs:10500,p95Ms:19000,reason:'payment_to_credit'});
});

test('renewal cohorts are per member and plan and include prepayment and seven-day grace',()=>{
  const users=[member('one'),member('two'),member('three')],orders=[
    order('one-pro-first','one','pro',0),order('one-pro-prepay','one','pro',15),
    order('one-exclusive-first','one','exclusive',0),order('one-exclusive-late','one','exclusive',38),
    order('two-pro-first','two','pro',5),order('two-pro-grace','two','pro',42),
    order('three-pro-new','three','pro',50)
  ];
  const result=metrics(users,orders,60);assert.equal(result.renewal30d.eligible,3);assert.equal(result.renewal30d.renewed,2);assert.equal(result.renewal30d.rate,2/3);assert.equal(result.renewal30d.graceDays,7);assert.equal(result.renewal30d.pendingGrace,0);
  const immature=metrics([member('one')],[order('first','one','pro',0)],29);assert.equal(immature.renewal30d.eligible,0);assert.equal(immature.renewal30d.rate,null);
  const open=buildMvpMetrics({accounts:{users:[member('one')]},billing:{orders:[order('first','one','pro',0)]},now:origin+30*DAY+1000});assert.equal(open.renewal30d.eligible,1);assert.equal(open.renewal30d.pendingGrace,1);assert.equal(open.renewal30d.reason,'grace_window_open');assert.equal(open.renewal30d.anchor,'first_credit');
});

test('renewal windows follow first access activation and require successful next credit within the window',()=>{
  const users=[member('one')];
  const delayed=order('created-long-before-payment','one','pro',0,{payment:{verified:true,at:at(20)},creditedAt:at(20)});
  const immature=metrics(users,[delayed],40);assert.equal(immature.renewal30d.eligible,0,'an old abandoned checkout does not age the paid cohort');
  const late=order('created-before-deadline','one','pro',25,{payment:{verified:true,at:at(60)},creditedAt:at(60)});
  const result=metrics(users,[delayed,late],61);assert.equal(result.renewal30d.eligible,1);assert.equal(result.renewal30d.renewed,0,'creation before deadline does not count without credit by day 37');
  const firstCreated=order('first-created','one','pro',0,{payment:{verified:true,at:at(10)},creditedAt:at(10)}),firstActivated=order('first-activated','one','pro',1,{payment:{verified:true,at:at(2)},creditedAt:at(2)});
  const orderedByActivation=metrics(users,[firstCreated,firstActivated],35);assert.equal(orderedByActivation.renewal30d.eligible,1);assert.equal(orderedByActivation.renewal30d.renewed,1);
});

test('malformed and future data is skipped without type coercion or input mutation',()=>{
  const users=[null,{},member('future',{createdAt:at(100)}),member('numeric-time',{createdAt:origin}),member('one')];
  const orders=[null,{},order('bad-plan','one','other',1),order('bad-time','one','pro',1,{creditedAt:1000}),order('bad-date','one','pro',1,{createdAt:'garbage'}),order('future','one','pro',100),order('missing-user','unknown','pro',1),order('valid','one','pro',1),order('valid','one','pro',2)];
  const before=JSON.stringify({users,orders}),result=metrics(users,orders);assert.equal(result.paymentConversion.registeredMembers,1);assert.equal(result.paymentConversion.liveOrders,1);assert.equal(result.activationLatency.sampleCount,1);assert.equal(JSON.stringify({users,orders}),before);
  assert.doesNotThrow(()=>buildMvpMetrics({accounts:5,billing:'bad',now:origin}));assert.equal(buildMvpMetrics({accounts:{users},billing:{orders},now:'2026-01-01'}).registration.reason,'invalid_reference_time');
});
