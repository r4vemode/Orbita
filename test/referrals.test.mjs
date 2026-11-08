import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createReferrals,applyReferralPayment,applyReferralRefund,validateReferralsState} from '../lib/referrals.mjs';
import {createPayments} from '../lib/payments.mjs';
import {serviceFixture} from './service-fixture.mjs';
import {LEGAL_VERSION} from '../lib/access.mjs';

async function fixture(){
 const f=await serviceFixture(async({accounts,directory})=>{
  const refs=createReferrals({accounts,simulation:true}),payments=await createPayments(directory,{accounts,config:{mode:'simulation',publicOrigin:'',host:'127.0.0.1',nodeEnv:'test'}});
  return {webhookPaths:payments.webhookPaths,handle:async(req,res,url,user)=>await refs.visit(req,res,url)||await refs.handle(req,res,url,user)||await payments.handle(req,res,url,user)};
 });
 f.admin=await f.register('owner-ref@example.test');await f.accounts.promote(f.admin.data.user.email);
 f.partner=await f.register('partner@example.test');
 let made=await f.request('/api/admin/referrals/partners',{method:'POST',cookie:f.admin.cookie,body:{userId:f.partner.data.user.id,name:'Партнёр',terms:{holdDays:0}}});assert.equal(made.status,200);
 f.partnerData=()=>f.request('/api/referrals/me',{cookie:f.partner.cookie});
 f.link=(await f.partnerData()).data.partners[0].link;
 f.visit=async(link=f.link,cookie)=>{const response=await fetch(f.base+link,{redirect:'manual',headers:{...(cookie?{Cookie:cookie}:{})}});assert.equal(response.status,303);return response.headers.get('set-cookie').split(';')[0];};
 f.signup=(email,cookie)=>f.request('/api/register',{method:'POST',cookie,body:{email,password:'test-password-long-2026',acceptTerms:true,acceptPrivacy:true,legalVersion:LEGAL_VERSION}});
 f.pay=async(user)=>{
  const checkout=await f.request('/api/payments/checkout',{method:'POST',cookie:user.cookie,body:{plan:'pro',requestId:randomUUID()}});assert.equal(checkout.status,200);
  const body={action:'pay',orderId:checkout.data.order.id,requestId:randomUUID()};assert.equal((await f.request('/api/admin/payments/simulate',{method:'POST',cookie:f.admin.cookie,body})).status,200);return {order:checkout.data.order,body};
 };
 f.refund=(order,amountMinor,requestId=randomUUID())=>f.request('/api/admin/payments/simulate',{method:'POST',cookie:f.admin.cookie,body:{action:'refund',orderId:order.id,amountMinor,requestId}});
 return f;
}

test('first referral is retained, forged cookies do not attribute, and partner cannot see another account or administer',async()=>{
 const f=await fixture();try{
  const other=await f.register('partner-other@example.test');await f.request('/api/admin/referrals/partners',{method:'POST',cookie:f.admin.cookie,body:{userId:other.data.user.id,name:'Другой'}});
  const otherLink=(await f.request('/api/referrals/me',{cookie:other.cookie})).data.partners[0].link;
  const cookie=await f.visit(),again=await f.visit(otherLink,cookie);assert.equal(cookie,again);
  await f.signup('attributed@example.test',again);await f.signup('forged@example.test','orbita_ref='+('a'.repeat(48)));
  const own=(await f.partnerData()).data.partners[0];assert.equal(own.visits,1);assert.equal(own.registrations,1);
  assert.equal((await f.request('/api/referrals/me',{cookie:other.cookie})).data.partners[0].registrations,0);
  assert.equal((await f.request('/api/admin/referrals',{cookie:f.partner.cookie})).status,403);
  assert.equal((await f.request('/api/admin/referrals/partners',{method:'POST',cookie:f.partner.cookie,body:{}})).status,403);
  assert.doesNotMatch(JSON.stringify((await f.partnerData()).data),/attributed@example|forged@example/);
 }finally{await f.close();}
});

test('confirmed first/repeat payments accrue once and incremental refunds never exceed the original charge',async()=>{
 const f=await fixture();try{
  const user=await f.signup('customer@example.test',await f.visit());const first=await f.pay(user),second=await f.pay(user);
  let own=(await f.partnerData()).data.partners[0];assert.equal(own.balance.totalMinor,44985+29990);assert.equal(own.payments,2);assert.equal(own.mode,'simulation');
  await f.request('/api/admin/payments/simulate',{method:'POST',cookie:f.admin.cookie,body:first.body});assert.equal((await f.partnerData()).data.partners[0].balance.totalMinor,74975);
  const refundKey=randomUUID();assert.equal((await f.refund(first.order,149950,refundKey)).status,200);assert.equal((await f.refund(first.order,149950,refundKey)).status,200);
  own=(await f.partnerData()).data.partners[0];assert.equal(own.balance.totalMinor,22493+29990);
  assert.equal((await f.refund(first.order,149951)).status,409);assert.equal((await f.refund(first.order,149950)).status,200);
  own=(await f.partnerData()).data.partners[0];assert.equal(own.balance.totalMinor,29990);assert.equal(own.entries.filter(item=>item.kind==='refund').length,2);
  const record=(await f.accounts.getUser(user.data.user.id)).subscriptions[0];assert.ok(Date.parse(record.expiresAt)>Date.now()+29*86400000);assert.ok(Date.parse(record.expiresAt)<Date.now()+31*86400000);
 }finally{await f.close();}
});

test('payout reservation is atomic, settlement needs fresh password and reversal after payout is a negative balance',async()=>{
 const f=await fixture();try{
  const user=await f.signup('payout-customer@example.test',await f.visit());const {order}=await f.pay(user),partner=(await f.partnerData()).data.partners[0];
  const reserve=()=>f.request('/api/admin/referrals/payouts',{method:'POST',cookie:f.admin.cookie,body:{action:'reserve',requestId:randomUUID(),partnerId:partner.id,amountMinor:44985}});
  const concurrent=await Promise.all([reserve(),reserve()]);assert.deepEqual(concurrent.map(item=>item.status).sort(),[200,400]);const payout=concurrent.find(item=>item.status===200).data.payout;
  const body={action:'paid',payoutId:payout.id,requestId:randomUUID(),reference:'bank-operation-test-1'};
  assert.equal((await f.request('/api/admin/referrals/payouts',{method:'POST',cookie:f.admin.cookie,body})).status,401);
  body.password='test-password-long-2026';assert.equal((await f.request('/api/admin/referrals/payouts',{method:'POST',cookie:f.admin.cookie,body})).status,200);
  assert.equal((await f.request('/api/admin/referrals/payouts',{method:'POST',cookie:f.admin.cookie,body})).status,200);
  assert.equal((await f.refund(order,299900)).status,200);
  const balance=(await f.partnerData()).data.partners[0].balance;assert.equal(balance.paidMinor,44985);assert.equal(balance.availableMinor,-44985);assert.equal(balance.totalMinor,0);
 }finally{await f.close();}
});

test('refunds before commission projection are applied individually and self-attribution never earns',()=>{
 const at='2026-11-07T00:00:00.000Z',db={referrals:{version:1,partners:[{id:'p',userId:'owner',code:'a'.repeat(24),active:true,terms:[{version:1,effectiveAt:at,firstBps:1500,repeatBps:1000,holdDays:0,maxPayments:6}]}],visits:[],attributions:[{userId:'buyer',partnerId:'p',registeredAt:at},{userId:'owner',partnerId:'p',registeredAt:at}],payments:[],refunds:[],entries:[],payouts:[],audit:[]}};
 applyReferralRefund(db,{paymentId:'x',refundId:'r1',amountMinor:10000,refundedAt:at});applyReferralRefund(db,{paymentId:'x',refundId:'r2',amountMinor:10000,refundedAt:at});
 applyReferralPayment(db,{paymentId:'x',userId:'buyer',amountMinor:30000,plan:'pro',currency:'RUB',paidAt:at});
 assert.deepEqual(db.referrals.entries.map(item=>item.amountMinor),[4500,-1500,-1500]);
 applyReferralPayment(db,{paymentId:'self',userId:'owner',amountMinor:30000,plan:'pro',currency:'RUB',paidAt:at});assert.equal(db.referrals.entries.length,3);
});

test('a signed-in partner cannot refer a second email, including after logout on the marked visit',async()=>{
 const f=await fixture();try{
  const marked=await f.visit(f.link,f.partner.cookie);
  const afterLogout=await f.signup('self-after-logout@example.test',marked);assert.equal(afterLogout.status,200);
  const anonymousVisit=await f.visit();const withSession=await f.signup('self-with-session@example.test',anonymousVisit+'; '+f.partner.cookie);assert.equal(withSession.status,200);
  await f.pay(afterLogout);await f.pay(withSession);
  // Signing up in the same browser replaces its former session cookie.
  f.partner.cookie=(await f.request('/api/login',{method:'POST',body:{email:f.partner.data.user.email,password:'test-password-long-2026'}})).cookie;
  const own=(await f.partnerData()).data.partners[0];assert.equal(own.registrations,0);assert.equal(own.balance.totalMinor,0);assert.equal(own.fraudReview,undefined);
  const report=(await f.request('/api/admin/referrals',{cookie:f.admin.cookie})).data.partners[0];assert.equal(report.fraudReview.blockedRegistrations,2);
 }finally{await f.close();}
});

test('shared referral visits are flagged without rejecting registration, capped, and reviewed before a payout reserve',async()=>{
 const f=await fixture();try{
  const visit=await f.visit(),first=await f.signup('shared-0@example.test',visit);assert.equal(first.status,200);
  for(let index=1;index<=10;index++)assert.equal((await f.signup('shared-'+index+'@example.test',visit)).status,200);
  await f.pay(first);
  const report=(await f.request('/api/admin/referrals',{cookie:f.admin.cookie})).data.partners[0];
  assert.equal(report.registrations,10);assert.equal(report.fraudReview.reusedVisitRegistrations,9);assert.equal(report.fraudReview.unreviewedRegistrations,9);assert.equal(report.fraudReview.blockedRegistrations,1);assert.equal(report.fraudReview.registrations.length,9);
  assert.doesNotMatch(JSON.stringify((await f.partnerData()).data),/shared-\d+@|fraudReview/);
  const body={action:'reserve',requestId:randomUUID(),partnerId:report.id,amountMinor:44985};
  assert.equal((await f.request('/api/admin/referrals/payouts',{method:'POST',cookie:f.admin.cookie,body})).status,409);
  body.reviewAcknowledged=true;assert.equal((await f.request('/api/admin/referrals/payouts',{method:'POST',cookie:f.admin.cookie,body})).status,200);
  assert.equal((await f.request('/api/admin/referrals',{cookie:f.admin.cookie})).data.partners[0].fraudReview.unreviewedRegistrations,0);
  const db=await f.accounts.readDatabase();assert.equal(db.referrals.audit.filter(row=>row.action==='attribution-review-acknowledged').length,1);
 }finally{await f.close();}
});

test('refunds reduce held commission rather than creating a debt against other matured commissions',async()=>{
 const at='2026-11-01T00:00:00.000Z',now=Date.parse('2026-11-07T00:00:00.000Z'),db={users:[],referrals:{version:1,partners:[{id:'p',userId:'owner',code:'a'.repeat(24),active:true,terms:[{version:1,effectiveAt:at,firstBps:1500,repeatBps:1000,holdDays:30,maxPayments:6}]}],visits:[],attributions:[{userId:'buyer',partnerId:'p',registeredAt:at}],payments:[],refunds:[],entries:[],payouts:[],audit:[]}};
 applyReferralPayment(db,{paymentId:'matured',userId:'buyer',amountMinor:30000,plan:'pro',currency:'RUB',paidAt:at});db.referrals.entries[0].availableAt=at;
 applyReferralPayment(db,{paymentId:'held',userId:'buyer',amountMinor:30000,plan:'pro',currency:'RUB',paidAt:at});
 const user={id:'owner'},accounts={readDatabase:async()=>db,identify:async()=>user,authorizeInTransaction:()=>user},service=createReferrals({accounts,now:()=>now});
 async function balance(){let data;await service.handle({method:'GET',headers:{}},{writeHead(){},end(value){data=JSON.parse(value)}},new URL('http://localhost/api/referrals/me'),user);return data.partners[0].balance;}
 applyReferralRefund(db,{paymentId:'held',refundId:'half',amountMinor:15000,refundedAt:at});assert.deepEqual(await balance(),{totalMinor:6000,pendingMinor:1500,reservedMinor:0,paidMinor:0,availableMinor:4500});
 applyReferralRefund(db,{paymentId:'held',refundId:'rest',amountMinor:15000,refundedAt:at});assert.deepEqual(await balance(),{totalMinor:4500,pendingMinor:0,reservedMinor:0,paidMinor:0,availableMinor:4500});
});

test('commission rates use immutable server settlement order even when provider timestamps arrive late',()=>{
 const at='2026-11-01T00:00:00.000Z',db={referrals:{version:1,partners:[{id:'p',userId:'owner',code:'a'.repeat(24),active:true,terms:[{version:1,effectiveAt:at,firstBps:1500,repeatBps:1000,holdDays:30,maxPayments:6}]}],visits:[],attributions:[{userId:'buyer',partnerId:'p',registeredAt:at}],payments:[],refunds:[],entries:[],payouts:[],audit:[]}};
 applyReferralPayment(db,{paymentId:'late',userId:'buyer',amountMinor:499900,plan:'exclusive',currency:'RUB',paidAt:'2026-11-03T00:00:00.000Z'});
 const original=structuredClone(db.referrals.entries[0]);
 applyReferralPayment(db,{paymentId:'early',userId:'buyer',amountMinor:299900,plan:'pro',currency:'RUB',paidAt:'2026-11-02T00:00:00.000Z'});
 assert.deepEqual(db.referrals.entries[0],original);assert.deepEqual(db.referrals.entries.map(row=>row.rateBps),[1500,1000]);assert.deepEqual(db.referrals.payments.map(row=>row.settlementIndex),[1,2]);assert.ok(db.referrals.payments.every(row=>row.settlementPolicy==='first-server-confirmed-v1'&&Number.isFinite(Date.parse(row.settledAt))));
});

test('corrupt persisted partner terms fail validation before commission arithmetic or UI rendering',()=>{
 const terms={firstBps:1500,repeatBps:1000,maxPayments:6,holdDays:30,version:1,effectiveAt:'2026-11-07T00:00:00.000Z'};
 const source={version:1,partners:[{id:'p',userId:'owner',code:'a'.repeat(24),terms:[terms]}],visits:[],attributions:[],payments:[],refunds:[],entries:[],payouts:[],audit:[]};
 assert.equal(validateReferralsState(source),true);
 for(const broken of [[],[null],[{}],[{...terms,firstBps:3001}],[{...terms,repeatBps:-1}],[{...terms,maxPayments:0}],[{...terms,holdDays:181}],[{...terms,version:1.5}],[{...terms,effectiveAt:'not-a-date'}]]){const db=structuredClone(source);db.partners[0].terms=broken;assert.equal(validateReferralsState(db),false);}
});
