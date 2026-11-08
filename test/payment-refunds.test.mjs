import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHmac} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {serviceFixture} from './service-fixture.mjs';
import {createPayments} from '../lib/payments.mjs';
import {RECURRING_TERMS_VERSION} from '../lib/payment-recurring.mjs';
import {LEGAL_VERSION} from '../lib/access.mjs';
const password='test-password-long-2026',secret='only-a-test-secret';
async function fixture(options={}){
 const calls=[],models=new Map();let next=5000;
 const f=await serviceFixture(({directory,accounts})=>createPayments(directory,{accounts,config:{mode:'cloudpayments',publicId:'test-refund-terminal',apiSecret:secret,publicOrigin:'https://orbita.example.test',testMode:true,...options.config},checkoutGate:options.checkoutGate,recurringGate:options.recurringGate,fetchImpl:async(url,init)=>{
  const body=JSON.parse(init.body),method=url.split('/').slice(-2).join('/');calls.push({method,body,requestId:init.headers['X-Request-ID']});let model;
  if(method==='orders/create')model={Url:'https://orders.cloudpayments.ru/d/test-refund'};
  else if(method==='payments/get'){if(options.getFailure?.())throw Error('temporary provider problem');model=models.get(String(body.TransactionId));if(options.onGet)await options.onGet({body,model});}
  else if(method==='payments/refund'){
   const original=models.get(String(body.TransactionId)),id=String(++next);model={TransactionId:id};models.set(id,{...original,TransactionId:id,OriginalTransactionId:String(body.TransactionId),Amount:body.Amount,CreatedDateIso:'2026-11-07T00:00:00',ConfirmDateIso:'2026-11-07T00:00:00'});
   if(options.lostRefundReply)throw Error('lost refund response');
  }else throw Error('Unexpected provider method '+method);
  return {ok:true,json:async()=>({Success:true,Model:model})};
 }}));
 f.calls=calls;f.models=models;
 f.notify=(kind,fields)=>{const raw=JSON.stringify(fields);return f.request('/api/payments/cloudpayments/'+kind,{method:'POST',body:raw,headers:{'Content-HMAC':createHmac('sha256',secret).update(raw).digest('base64')}});};
 f.admin=await f.register('refund-admin@example.test');await f.accounts.promote(f.admin.data.user.email);
 f.member=await f.register('refund-customer@example.test');await f.verify(f.member);
 f.newOrder=async({paid=true,plan='pro'}={})=>{
  const response=await f.request('/api/payments/checkout',{method:'POST',cookie:f.member.cookie,body:{plan,requestId:randomUUID(),...(options.checkoutGate?{legalVersion:LEGAL_VERSION}:{})}});assert.equal(response.status,200);const {order}=response.data,transactionId=String(++next);
  const model={PublicId:'test-refund-terminal',TransactionId:transactionId,InvoiceId:order.id,AccountId:f.member.data.user.id,Amount:order.amount,Currency:'RUB',TestMode:options.config?.testMode??true,Status:'Completed',OriginalTransactionId:null,Refunded:false,CreatedDateIso:'2026-11-07T00:00:00'};models.set(transactionId,model);if(paid)assert.equal((await f.notify('pay',model)).status,200);return {order,transactionId,model};
 };
 f.refund=(order,extra={})=>f.request('/api/admin/payments/refunds',{method:'POST',cookie:f.admin.cookie,body:{orderId:order.id,amountMinor:order.amount*100,reason:'Возврат по обращению клиента',requestId:randomUUID(),password,...extra}});
 return f;
}

test('admin refund authenticates freshly, reserves the remainder, confirms provider state and is idempotent',async()=>{
 const f=await fixture();try{
  const {order}=await f.newOrder(),requestId=randomUUID(),input={orderId:order.id,amountMinor:100000,reason:'Частичный возврат по заявлению',requestId,password};
  assert.equal((await f.request('/api/admin/payments/refunds',{method:'POST',cookie:f.member.cookie,body:input})).status,403);
  assert.equal((await f.refund(order,{password:'incorrect'})).status,401);
  const first=await f.request('/api/admin/payments/refunds',{method:'POST',cookie:f.admin.cookie,body:input});assert.equal(first.status,200);assert.equal(first.data.refund.status,'completed');
  const again=await f.request('/api/admin/payments/refunds',{method:'POST',cookie:f.admin.cookie,body:input});assert.equal(again.status,200);assert.equal(again.data.refund.id,first.data.refund.id);
  assert.equal(f.calls.filter(item=>item.method==='payments/refund').length,1);
  await assert.rejects(f.service.refunds.request(f.admin.data.user,{...input,amountMinor:99999}),cause=>cause.status===409);
  await assert.rejects(f.service.refunds.request(f.admin.data.user,{...input,requestId:randomUUID(),amountMinor:200000}),cause=>cause.status===409);
  const snapshot=(await f.request('/api/admin/payments/orders',{cookie:f.admin.cookie})).data;assert.equal(snapshot.orders[0].remainingRefundMinor,199900);
  assert.equal((await f.accounts.getUser(f.member.data.user.id)).subscriptions.length,1);
  assert.equal((await f.refund(order,{amountMinor:199900})).status,200);assert.equal((await f.accounts.getUser(f.member.data.user.id)).subscriptions.length,0);
  const disk=await readFile(join(f.directory,'billing.json'),'utf8');assert.doesNotMatch(disk,/test-password-long|only-a-test-secret/);
  assert.equal((await f.request('/api/payments/history',{cookie:f.member.cookie})).data.orders[0].status,'refunded');
 }finally{await f.close();}
});

test('unknown refund outcome never resends money; an exact provider transaction reconciles it',async()=>{
 const f=await fixture({lostRefundReply:true});try{
  const {order}=await f.newOrder(),requestId=randomUUID(),first=await f.refund(order,{requestId});assert.equal(first.status,202);assert.equal(first.data.refund.status,'unknown');
  assert.equal((await f.refund(order,{requestId})).status,202);assert.equal(f.calls.filter(item=>item.method==='payments/refund').length,1);
  assert.equal((await f.refund(order,{amountMinor:1})).status,409);
  const id=first.data.refund.id,refundTx=[...f.models.values()].find(model=>model.OriginalTransactionId).TransactionId;
  const response=await f.request('/api/admin/payments/refunds/'+id+'/reconcile',{method:'POST',cookie:f.admin.cookie,body:{transactionId:refundTx,password}});assert.equal(response.status,200);assert.equal(response.data.refund.status,'completed');
  assert.equal((await f.accounts.getUser(f.member.data.user.id)).subscriptions.length,0);assert.equal(f.calls.filter(item=>item.method==='payments/refund').length,1);
 }finally{await f.close();}
});

test('prepared refund survives failed preflight and retries the original intent without another reservation',async()=>{
 let unavailable=true;const f=await fixture({getFailure:()=>unavailable});try{
  const {order}=await f.newOrder();assert.equal((await f.refund(order)).status,503);
  const state=(await f.request('/api/admin/payments/orders',{cookie:f.admin.cookie})).data;assert.equal(state.refundRequests[0].status,'prepared');assert.equal(state.orders[0].remainingRefundMinor,0);assert.equal(f.calls.filter(item=>item.method==='payments/refund').length,0);
  unavailable=false;const response=await f.request('/api/admin/payments/refunds/'+state.refundRequests[0].id+'/retry',{method:'POST',cookie:f.admin.cookie,body:{password}});assert.equal(response.status,200);assert.equal(response.data.refund.status,'completed');assert.equal(f.calls.filter(item=>item.method==='payments/refund').length,1);
 }finally{await f.close();}
});

test('reconciliation validates account, amount, mode and original transaction before applying a missing payment/refund',async()=>{
 const f=await fixture({lostRefundReply:true});try{
  const {order,model,transactionId}=await f.newOrder({paid:false}),route='/api/admin/payments/orders/'+order.id+'/reconcile';
  model.AccountId='another-account';assert.equal((await f.request(route,{method:'POST',cookie:f.admin.cookie,body:{transactionId}})).status,502);assert.equal((await f.accounts.getUser(f.member.data.user.id)).subscriptions.length,0);
  model.AccountId=f.member.data.user.id;model.Refunded=true;assert.equal((await f.request(route,{method:'POST',cookie:f.admin.cookie,body:{transactionId}})).data.code,'PAYMENT_REFUND_REVIEW_REQUIRED');model.Refunded=false;
  assert.equal((await f.request(route,{method:'POST',cookie:f.admin.cookie,body:{transactionId}})).status,200);
  const refund=(await f.refund(order)).data.refund,refundModel=[...f.models.values()].find(item=>item.OriginalTransactionId),refundRoute='/api/admin/payments/refunds/'+refund.id+'/reconcile';
  for(const patch of [{OriginalTransactionId:'123'},{Amount:1},{TestMode:false},{InvoiceId:'another-order'},{AccountId:'another-account'},{PublicId:'another-terminal'}]){
   const original={...refundModel};Object.assign(refundModel,patch);await assert.rejects(f.service.refunds.reconcile(refund.id,{transactionId:refundModel.TransactionId}),cause=>cause.status===502);Object.assign(refundModel,original);
  }
  assert.equal((await f.accounts.getUser(f.member.data.user.id)).subscriptions.length,1);
 }finally{await f.close();}
});

test('a role revoked during provider preflight prevents the refund monetary call',async()=>{
 let revoke=null;const f=await fixture({onGet:async()=>{if(revoke)await revoke();}});try{
  const {order}=await f.newOrder();revoke=()=>f.accounts.transact(db=>{db.users.find(user=>user.id===f.admin.data.user.id).role='free';});
  assert.equal((await f.refund(order)).status,403);assert.equal(f.calls.filter(item=>item.method==='payments/refund').length,0);
 }finally{await f.close();}
});

test('live recurring requires explicit operator enablement and the matching published recurring terms',async()=>{
 for(const [enabled,termsReady,expected]of [[false,true,false],[true,false,false],[true,true,true]]){
  const f=await fixture({config:{testMode:false,recurringEnabled:enabled},checkoutGate:async()=>({ready:true,legalVersion:LEGAL_VERSION}),recurringGate:async()=>({ready:termsReady,legalVersion:LEGAL_VERSION})});try{
   const config=(await f.request('/api/payments/config')).data;assert.equal(config.recurringAvailable,expected);assert.equal(config.recurringTermsVersion,expected?RECURRING_TERMS_VERSION:null);
   const response=await f.request('/api/payments/checkout',{method:'POST',cookie:f.member.cookie,body:{plan:'pro',requestId:randomUUID(),legalVersion:LEGAL_VERSION,recurring:{accepted:true,termsVersion:RECURRING_TERMS_VERSION}}});assert.equal(response.status,expected?200:503);
  }finally{await f.close();}
 }
});
