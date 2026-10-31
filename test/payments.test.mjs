import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac,randomUUID} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createPayments} from '../lib/payments.mjs';
import {serviceFixture} from './service-fixture.mjs';

const secret='test-local-hmac-secret',config={publicId:'test-merchant',apiSecret:secret,publicOrigin:'https://orbita.example.test',testMode:true};
async function fixture(options={}){
 const calls=[];
 const fetchImpl=options.fetchImpl|| (async(url,init)=>{calls.push({url,init});return {ok:true,json:async()=>({Success:true,Model:{Id:'provider-order',Url:'https://orders.cloudpayments.ru/d/test'}})};});
 const f=await serviceFixture(({directory,accounts})=>createPayments(directory,{accounts:typeof options.accountsOverride==='function'?options.accountsOverride(accounts):accounts,config,...options,fetchImpl}));
 f.calls=calls;
 f.checkout=(account,plan='pro',requestId=randomUUID())=>f.request('/api/payments/checkout',{method:'POST',cookie:account.cookie,body:{plan,requestId}});
 f.callback=(kind,fields,{signed=true,raw=JSON.stringify(fields),headers={}}={})=>f.request('/api/payments/cloudpayments/'+kind,{method:'POST',body:raw,headers:{Origin:'',...(signed?{'Content-HMAC':createHmac('sha256',secret).update(raw).digest('base64')}:{}),...headers}});
 return f;
}
const fields=(order,user,extra={})=>({InvoiceId:order.id,AccountId:user.id,Amount:order.amount,Currency:'RUB',TestMode:1,TransactionId:'100001',Status:'Completed',DateTime:'2026-10-20 12:00:00',...extra});

test('checkout requires verified email, fixes price on server and keeps retries idempotent',async()=>{const f=await fixture();try{
 const member=await f.register('payment@example.test');
 assert.equal((await f.checkout(member)).data.code,'EMAIL_NOT_VERIFIED');await f.verify(member);
 assert.equal((await f.request('/api/payments/checkout',{method:'POST',cookie:member.cookie,body:{plan:'pro',requestId:randomUUID(),amount:1}})).status,400);
 const requestId=randomUUID(),first=await f.checkout(member,'exclusive',requestId),again=await f.checkout(member,'exclusive',requestId);
 assert.equal(first.status,200);assert.equal(first.data.order.amount,4999);assert.equal(first.data.order.status,'pending');assert.equal(again.data.order.id,first.data.order.id);assert.equal(f.calls.length,1);
 const call=f.calls[0],payload=JSON.parse(call.init.body);assert.equal(call.url,'https://api.cloudpayments.ru/orders/create');assert.equal(payload.RequireConfirmation,false);assert.equal(payload.Amount,4999);assert.equal(payload.AccountId,member.data.user.id);assert.equal(payload.InvoiceId,first.data.order.id);assert.match(call.init.headers.Authorization,/^Basic /);assert.equal(call.init.headers['X-Request-ID'],first.data.order.id);
 assert.equal((await f.checkout(member,'pro',requestId)).status,409);
 assert.deepEqual((await f.accounts.getUser(member.data.user.id)).subscriptions,[]);
 const other=await f.register('other-payment@example.test');assert.equal((await f.request('/api/payments/orders/'+first.data.order.id,{cookie:other.cookie})).status,404);
 assert.equal((await f.request('/api/payments/orders/'+first.data.order.id)).status,401);
 assert.ok(!JSON.stringify(first.data).includes(secret));
}finally{await f.close();}});

test('only signed exact completed payments activate access; duplicate callbacks and renewal are safe',async()=>{const f=await fixture();try{
 const member=await f.register('paid@example.test');await f.verify(member);const {order}= (await f.checkout(member)).data;
 const valid=fields(order,member.data.user);
 assert.equal((await f.callback('pay',valid,{signed:false})).status,403);
 for(const patch of [{Amount:1},{Currency:'USD'},{AccountId:'someone-else'},{TestMode:0},{Status:'Authorized'},{OperationType:'Refund'}])assert.notEqual((await f.callback('pay',{...valid,...patch})).status,200);
 assert.deepEqual((await f.accounts.getUser(member.data.user.id)).subscriptions,[]);
 const check=await f.callback('check',{...valid,Status:'Created'});assert.deepEqual(check.data,{code:0});
 const paid=await f.callback('pay',valid);assert.deepEqual(paid.data,{code:0});
 const expires=(await f.accounts.getUser(member.data.user.id)).subscriptions[0].expiresAt;
 assert.equal((await f.callback('pay',valid)).status,200);assert.equal((await f.accounts.getUser(member.data.user.id)).subscriptions[0].expiresAt,expires);
 assert.equal((await f.callback('fail',{...valid,Status:'Declined'})).status,200);assert.equal((await f.service.getOrder(member.data.user,order.id)).order.status,'paid');
 const next=(await f.checkout(member)).data.order;assert.equal((await f.callback('pay',fields(next,member.data.user,{TransactionId:'100002'}))).status,200);
 const after=Date.parse((await f.accounts.getUser(member.data.user.id)).subscriptions[0].expiresAt);assert.equal(after-Date.parse(expires),30*86400000);
 assert.equal((await f.callback('pay',fields(next,member.data.user))).status,409);
}finally{await f.close();}});

test('refunds preserve independent renewal and refund-before-pay never activates access',async()=>{const f=await fixture();try{
 const member=await f.register('refund@example.test');await f.verify(member);const a=(await f.checkout(member)).data.order,b=(await f.checkout(member)).data.order;
 await f.callback('pay',fields(a,member.data.user,{TransactionId:'21001'}));await f.callback('pay',fields(b,member.data.user,{TransactionId:'21002'}));
 const refund=fields(a,member.data.user,{TransactionId:'31001',PaymentTransactionId:'21001',OperationType:'Refund'});
 assert.equal((await f.callback('refund',refund)).status,200);assert.equal((await f.callback('refund',refund)).status,200);
 const current=(await f.accounts.getUser(member.data.user.id)).subscriptions[0];assert.ok(Date.parse(current.expiresAt)>Date.now()+29*86400000);assert.ok(Date.parse(current.expiresAt)<Date.now()+31*86400000);
 const c=(await f.checkout(member,'exclusive')).data.order;
 assert.equal((await f.callback('refund',fields(c,member.data.user,{TransactionId:'31003',PaymentTransactionId:'21003',OperationType:'Refund'}))).status,200);
 assert.equal((await f.callback('pay',fields(c,member.data.user,{TransactionId:'21003'}))).status,200);
 assert.ok(!(await f.accounts.getUser(member.data.user.id)).subscriptions.some(s=>s.plan==='exclusive'));
 assert.equal((await f.service.getOrder(member.data.user,c.id)).order.status,'refunded');
 const db=JSON.parse(await readFile(join(f.directory,'billing.json'),'utf8'));assert.equal(db.orders.length,3);
}finally{await f.close();}});

test('provider timeouts keep the same order and unsafe payment links never escape',async()=>{
 let calls=0;const f=await fixture({fetchImpl:async()=>{calls++;if(calls===1)throw Error('timeout with secret');return {ok:true,json:async()=>({Success:true,Model:{Url:'https://evil.example/pay'}})};}});
 try{const member=await f.register('timeout@example.test');await f.verify(member);const key=randomUUID();const first=await f.checkout(member,'pro',key),second=await f.checkout(member,'pro',key);assert.equal(first.status,503);assert.ok(!JSON.stringify(first).includes('timeout with secret'));assert.equal(second.status,502);assert.equal(JSON.parse(await readFile(join(f.directory,'billing.json'),'utf8')).orders.length,1);assert.deepEqual((await f.accounts.getUser(member.data.user.id)).subscriptions,[]);}finally{await f.close();}
});

test('unconfigured payments stay unavailable and signed form bodies use exact raw bytes',async()=>{
 const absent=await fixture({config:{publicId:'',apiSecret:'',publicOrigin:''}});try{assert.equal((await absent.request('/api/payments/config')).data.configured,false);const u=await absent.register('absent@example.test');await absent.verify(u);assert.equal((await absent.checkout(u)).status,503);}finally{await absent.close();}
 const f=await fixture();try{const u=await f.register('form@example.test');await f.verify(u);const order=(await f.checkout(u)).data.order,values=fields(order,u.data.user),raw=new URLSearchParams(values).toString();assert.equal((await f.callback('pay',values,{raw,headers:{'Content-Type':'application/x-www-form-urlencoded'}})).status,200);const altered=raw+'&Currency=RUB';assert.equal((await f.callback('pay',values,{raw:altered,headers:{'Content-Type':'application/x-www-form-urlencoded'}})).status,400);}finally{await f.close();}
});

test('unexpected signed callback keeps CloudPayments retry code and a safe support reference',async t=>{
 const logs=[];t.mock.method(console,'error',(...values)=>logs.push(values.join(' ')));
 const f=await fixture({accountsOverride:accounts=>({...accounts,creditPayment:async()=>{const failure=Error('private callback detail');failure.code='EFAULT';throw failure;}})});
 try{
  const member=await f.register('callback-fault@example.test');await f.verify(member);const order=(await f.checkout(member)).data.order;
  const response=await f.callback('pay',fields(order,member.data.user));
  assert.equal(response.status,500);assert.equal(response.data.code,13);assert.equal(response.data.reason,'PAYMENT_REQUEST_FAILED');assert.match(response.data.errorId,/^[a-f0-9-]{36}$/);
  assert.ok(logs.some(line=>line.includes(response.data.errorId)&&line.includes('code=EFAULT')));assert.doesNotMatch(JSON.stringify(response.data)+logs.join('\n'),/private callback detail/);
 }finally{await f.close();}
});

test('payment reconciliation continues after an earlier account cannot be credited or refunded',async t=>{
 const logs=[];t.mock.method(console,'error',(...values)=>logs.push(values.join(' ')));
 for(const operation of ['credit','refund']){
  let blocked=new Set(),permanent=null;
  const f=await fixture({accountsOverride:accounts=>({...accounts,
   creditPayment:async payload=>{if(operation==='credit'&&(blocked.has(payload.userId)||payload.userId===permanent))throw Error('private credit reconciliation failure');return accounts.creditPayment(payload);},
   reversePayment:async payload=>{if(operation==='refund'&&(blocked.has(payload.userId)||payload.userId===permanent))throw Error('private refund reconciliation failure');return accounts.reversePayment(payload);}
  })});
  try{
   const first=await f.register(operation+'-blocked@example.test'),second=await f.register(operation+'-recoverable@example.test');await f.verify(first);await f.verify(second);
   const a=(await f.checkout(first)).data.order,b=(await f.checkout(second)).data.order;
   if(operation==='refund'){
    assert.equal((await f.callback('pay',fields(a,first.data.user,{TransactionId:'90101'}))).status,200);
    assert.equal((await f.callback('pay',fields(b,second.data.user,{TransactionId:'90102'}))).status,200);
   }
   blocked=new Set([first.data.user.id,second.data.user.id]);permanent=first.data.user.id;
   for(const [order,member,transactionId,paymentId]of [[a,first,'90201','90101'],[b,second,'90202','90102']]){
    const response=await f.callback(operation==='credit'?'pay':'refund',fields(order,member.data.user,operation==='credit'?{TransactionId:paymentId}:{TransactionId:transactionId,PaymentTransactionId:paymentId,OperationType:'Refund'}));assert.equal(response.status,500);
   }
   blocked.clear();
   await assert.rejects(f.service.sync(),cause=>cause.status===503&&cause.code==='PAYMENT_SYNC_INCOMPLETE'&&!cause.message.includes('private'));
   const db=JSON.parse(await readFile(join(f.directory,'billing.json'),'utf8'));
   assert.equal(db.orders.find(order=>order.id===a.id).status,operation==='credit'?'crediting':'refund_pending');
   assert.equal(db.orders.find(order=>order.id===b.id).status,operation==='credit'?'paid':'refunded');
   const subscriptions=(await f.accounts.getUser(second.data.user.id)).subscriptions;assert.equal(subscriptions.some(plan=>Date.parse(plan.expiresAt)>Date.now()),operation==='credit');
  }finally{await f.close();}
 }
});

test('an extra payment retained for review cannot be reassigned to another order or account',async()=>{
 const f=await fixture();try{
  const first=await f.register('extra-payment-first@example.test'),second=await f.register('extra-payment-second@example.test');await f.verify(first);await f.verify(second);
  const a=(await f.checkout(first)).data.order,b=(await f.checkout(second)).data.order;
  assert.equal((await f.callback('pay',fields(a,first.data.user,{TransactionId:'71001'}))).status,200);
  const expiry=(await f.accounts.getUser(first.data.user.id)).subscriptions[0].expiresAt;
  assert.equal((await f.callback('pay',fields(a,first.data.user,{TransactionId:'71002'}))).status,200);
  assert.equal((await f.service.getOrder(first.data.user,a.id)).order.needsReview,true);assert.equal((await f.accounts.getUser(first.data.user.id)).subscriptions[0].expiresAt,expiry);
  assert.equal((await f.callback('pay',fields(b,second.data.user,{TransactionId:'71002'}))).status,409);assert.deepEqual((await f.accounts.getUser(second.data.user.id)).subscriptions,[]);
  const legacy=JSON.parse(await readFile(join(f.directory,'billing.json'),'utf8'));delete legacy.transactions['71002'];await writeFile(join(f.directory,'billing.json'),JSON.stringify(legacy));
  assert.equal((await f.callback('pay',fields(b,second.data.user,{TransactionId:'71002'}))).status,409,'review-only charges in pre-upgrade stores also remain bound to their original invoice');
  assert.equal((await f.callback('pay',fields(a,first.data.user,{TransactionId:'71002'}))).status,200);
  const db=JSON.parse(await readFile(join(f.directory,'billing.json'),'utf8'));assert.equal(db.transactions['71002'],a.id);assert.equal(db.orders.find(order=>order.id===a.id).extraPayments.length,1);
 }finally{await f.close();}
});
