import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHmac} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {serviceFixture} from './service-fixture.mjs';
import {createPayments} from '../lib/payments.mjs';
import {RECURRING_TERMS_VERSION} from '../lib/payment-recurring.mjs';

async function fixture({simulation=false,lostCreation=false}={}){
 const calls=[],models=[];const config=simulation?{mode:'simulation',publicOrigin:'',host:'127.0.0.1',nodeEnv:'test'}:{mode:'cloudpayments',publicId:'fixture',apiSecret:'fixture-secret',publicOrigin:'https://orbita.example.test',testMode:true};
 const f=await serviceFixture(({accounts,directory})=>createPayments(directory,{accounts,config,fetchImpl:async(url,request)=>{
  const body=JSON.parse(request.body);calls.push({url,body});let model;
  if(url.endsWith('/orders/create'))model={Id:randomUUID(),Url:'https://orders.cloudpayments.ru/d/fixture'};
  else if(url.endsWith('/subscriptions/create')){model={...body,Token:undefined,Id:'sc_'+randomUUID(),Status:'Active',NextTransactionDateIso:body.StartDate};models.push(model);if(lostCreation)throw Error('response lost');}
  else if(url.endsWith('/subscriptions/find'))model=models.filter(item=>item.AccountId===body.AccountId);
  else if(url.endsWith('/subscriptions/get'))model=models.find(item=>item.Id===body.Id);
  else if(url.endsWith('/subscriptions/cancel')){models.find(item=>item.Id===body.Id).Status='Cancelled';model=null;}
  else throw Error('Unexpected provider call');
  return {ok:true,json:async()=>({Success:true,Model:model})};
 }}));
 f.calls=calls;f.models=models;
 f.checkout=(user,extra={})=>f.request('/api/payments/checkout',{method:'POST',cookie:user.cookie,body:{plan:'pro',requestId:randomUUID(),recurring:{accepted:true,termsVersion:RECURRING_TERMS_VERSION},...extra}});
 f.notify=(kind,fields)=>{const raw=JSON.stringify(fields);return f.request('/api/payments/cloudpayments/'+kind,{method:'POST',body:raw,headers:{'Content-HMAC':createHmac('sha256','fixture-secret').update(raw).digest('base64')}});};
 return f;
}
const payment=(order,user,extra={})=>({InvoiceId:order.id,AccountId:user.id,Amount:order.amount,Currency:'RUB',TestMode:true,TransactionId:'123001',Status:'Completed',Token:'sensitive-token-only-for-vault',...extra});

test('recurring requires explicit versioned consent and encrypts card tokens; duplicate Pay creates one agreement',async()=>{
 const f=await fixture();try{
  const user=await f.register('recurring@example.test');await f.verify(user);
  assert.equal((await f.checkout(user,{recurring:{accepted:false,termsVersion:RECURRING_TERMS_VERSION}})).status,400);
  const result=await f.checkout(user);assert.equal(result.status,200);const order=result.data.order;
  assert.equal((await f.notify('pay',payment(order,user.data.user))).status,200);
  assert.equal((await f.notify('pay',payment(order,user.data.user))).status,200);
  assert.equal(f.calls.filter(item=>item.url.endsWith('/subscriptions/create')).length,1);
  const list=await f.request('/api/payments/subscriptions',{cookie:user.cookie});assert.equal(list.data.subscriptions[0].status,'active');assert.equal(list.data.subscriptions[0].days,30);
  assert.ok(Date.parse(list.data.subscriptions[0].nextChargeAt)>Date.now());
  assert.doesNotMatch(await readFile(join(f.directory,'billing.json'),'utf8'),/sensitive-token-only-for-vault/);
  assert.doesNotMatch(JSON.stringify(list.data),/sensitive-token|providerId|email/);
 }finally{await f.close();}
});

test('renewal without InvoiceId extends once; failure and cancellation retain paid access and old status cannot reactivate',async()=>{
 const f=await fixture();try{
  const user=await f.register('cycles@example.test');await f.verify(user);const {order}=(await f.checkout(user)).data;
  await f.notify('pay',payment(order,user.data.user));const initial=Date.parse((await f.accounts.getUser(user.data.user.id)).subscriptions[0].expiresAt);
  const renewal=payment(order,user.data.user,{InvoiceId:undefined,SubscriptionId:f.models[0].Id,TransactionId:'123002'});
  assert.equal((await f.notify('pay',renewal)).status,200);assert.equal((await f.notify('pay',renewal)).status,200);
  assert.equal(Date.parse((await f.accounts.getUser(user.data.user.id)).subscriptions[0].expiresAt)-initial,30*86400000);
  assert.equal((await f.notify('fail',{...renewal,TransactionId:'123003',Status:'Declined'})).status,200);
  const agreement=(await f.request('/api/payments/subscriptions',{cookie:user.cookie})).data.subscriptions[0];
  const other=await f.register('not-owner@example.test');assert.equal((await f.request('/api/payments/subscriptions/'+agreement.id+'/cancel',{method:'POST',cookie:other.cookie,body:{}})).status,404);
  assert.equal((await f.request('/api/payments/subscriptions/'+agreement.id+'/cancel',{method:'POST',cookie:user.cookie,body:{}})).status,200);
  const stale={...f.models[0],Status:'Active'};assert.equal((await f.notify('recurrent',stale)).status,200);
  assert.equal((await f.request('/api/payments/subscriptions',{cookie:user.cookie})).data.subscriptions[0].status,'cancelled');
  assert.equal(Date.parse((await f.accounts.getUser(user.data.user.id)).subscriptions[0].expiresAt)-initial,30*86400000);
  assert.equal((await f.request('/api/payments/history',{cookie:other.cookie})).data.orders.length,0);
 }finally{await f.close();}
});

test('lost subscription-create response reconciles the same provider agreement instead of creating another',async()=>{
 const f=await fixture({lostCreation:true});try{
  const user=await f.register('lost-recurring@example.test');await f.verify(user);const {order}=(await f.checkout(user)).data;
  assert.equal((await f.notify('pay',payment(order,user.data.user))).status,200);
  await f.service.sync();assert.equal(f.calls.filter(item=>item.url.endsWith('/subscriptions/create')).length,1);
  assert.equal((await f.service.recurring.list(user.data.user)).subscriptions[0].status,'active');
 }finally{await f.close();}
});

test('local payment simulator exercises the same credit/refund path and requires an administrator for outcomes',async()=>{
 const f=await fixture({simulation:true});try{
  const admin=await f.register('sim-admin@example.test');await f.accounts.promote(admin.data.user.email);
  const user=await f.register('sim-client@example.test');const {order}=(await f.checkout(user)).data;
  assert.equal(order.simulation,true);const body={action:'pay',orderId:order.id,requestId:randomUUID()};
  assert.equal((await f.request('/api/admin/payments/simulate',{method:'POST',cookie:user.cookie,body})).status,403);
  assert.equal((await f.request('/api/admin/payments/simulate',{method:'POST',cookie:admin.cookie,body})).status,200);
  const expires=(await f.accounts.getUser(user.data.user.id)).subscriptions[0].expiresAt;
  assert.equal((await f.request('/api/admin/payments/simulate',{method:'POST',cookie:admin.cookie,body})).status,200);
  assert.equal((await f.accounts.getUser(user.data.user.id)).subscriptions[0].expiresAt,expires);
  const refund={action:'refund',orderId:order.id,requestId:randomUUID()};assert.equal((await f.request('/api/admin/payments/simulate',{method:'POST',cookie:admin.cookie,body:refund})).status,200);
  assert.equal((await f.accounts.getUser(user.data.user.id)).subscriptions.length,0);assert.equal(f.calls.length,0);
  assert.equal((await f.notify('pay',payment(order,user.data.user))).status,404);
 }finally{await f.close();}
});

test('simulation is rejected with production, public origin or external binding',async()=>{
 for(const patch of [{nodeEnv:'production'},{publicOrigin:'https://orbita.example.test'},{host:'0.0.0.0'}])await assert.rejects(createPayments('/tmp/orbita-must-not-create',{config:{mode:'simulation',publicOrigin:'',nodeEnv:'test',host:'127.0.0.1',...patch}}),/только локально/);
});
