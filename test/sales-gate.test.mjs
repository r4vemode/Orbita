import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac,randomUUID} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createSalesGate} from '../lib/sales-gate.mjs';
import {createPayments} from '../lib/payments.mjs';
import {serviceFixture} from './service-fixture.mjs';

const version='ORBITA-2026-10-27-1',secret='isolated-sales-test-secret';
async function fixture({gate,testMode=false}={}){
  const calls=[];
  const f=await serviceFixture(({directory,accounts})=>createPayments(directory,{accounts,checkoutGate:gate,config:{publicId:'isolated-shop',apiSecret:secret,publicOrigin:'https://orbita.example.test',testMode},fetchImpl:async(_url,options)=>{calls.push(JSON.parse(options.body));return {ok:true,json:async()=>({Success:true,Model:{Id:'isolated-invoice',Url:'https://orders.cloudpayments.ru/d/isolated'}})};}}));
  const member=await f.register('sales-gate@example.test');await f.verify(member);
  const checkout=(legalVersion=version,requestId=randomUUID(),extra={})=>f.request('/api/payments/checkout',{method:'POST',cookie:member.cookie,body:{plan:'pro',requestId,...(legalVersion===null?{}:{legalVersion}),...extra}});
  const callback=(kind,order,fields={})=>{
    const values={InvoiceId:order.id,AccountId:member.data.user.id,Amount:order.amount,Currency:'RUB',TestMode:testMode?1:0,TransactionId:'80101',Status:kind==='check'?'Created':'Completed',...fields},raw=JSON.stringify(values);
    return f.request('/api/payments/cloudpayments/'+kind,{method:'POST',body:raw,headers:{Origin:'','Content-HMAC':createHmac('sha256',secret).update(raw).digest('base64')}});
  };
  return {...f,calls,member,checkout,callback};
}

test('sales require all explicit operator settings and published documents, never draft data or a malformed version',async()=>{
  for(const [enabled,receipts,published,expected]of [[false,false,false,false],[true,false,true,false],[false,true,true,false],[true,true,false,false],[true,true,true,true]]){
    const gate=createSalesGate({env:{ORBITA_LIVE_PAYMENTS_ENABLED:String(enabled),ORBITA_RECEIPTS_CONFIRMED:String(receipts)},legal:{readPublic:async()=>({published,version,profile:{ownerName:'PRIVATE DRAFT MUST NOT LEAK'}})}});
    const state=await gate();assert.equal(state.ready,expected);assert.ok(!JSON.stringify(state).includes('PRIVATE DRAFT'));
  }
  const absent=createSalesGate({env:{},legal:{readPublic:async()=>({published:true,version})}});assert.equal((await absent()).ready,false);
  const invalid=createSalesGate({env:{ORBITA_LIVE_PAYMENTS_ENABLED:'true',ORBITA_RECEIPTS_CONFIRMED:'true'},legal:{readPublic:async()=>({published:true,version:'https://outside.example'})}});assert.equal((await invalid()).ready,false);
  assert.throws(()=>createSalesGate({env:{ORBITA_LIVE_PAYMENTS_ENABLED:'secret-value-not-to-echo'}}),error=>!error.message.includes('secret-value-not-to-echo'));
});

test('configured live keys alone cannot create an invoice or invoke the provider',async()=>{
  const f=await fixture();try{
    const config=(await f.request('/api/payments/config')).data;assert.equal(config.configured,true);assert.equal(config.checkoutEnabled,false);
    const refused=await f.checkout();assert.equal(refused.status,503);assert.equal(refused.data.code,'SALES_NOT_OPEN');assert.equal(f.calls.length,0);
    await assert.rejects(readFile(join(f.directory,'billing.json')),{code:'ENOENT'});
    const forged=await f.checkout(version,randomUUID(),{livePaymentsEnabled:true});assert.equal(forged.status,400);assert.equal(f.calls.length,0);
  }finally{await f.close();}
});

test('new live invoices bind the accepted legal edition while an exact retry retains its original contract',async()=>{
  let activeVersion=version;const f=await fixture({gate:async()=>({ready:true,legalVersion:activeVersion})});
  try{
    assert.equal((await f.checkout(null)).data.code,'LEGAL_VERSION_CHANGED');assert.equal((await f.checkout('ORBITA-2026-10-20')).data.code,'LEGAL_VERSION_CHANGED');assert.equal(f.calls.length,0);
    const requestId=randomUUID(),first=await f.checkout(version,requestId);assert.equal(first.status,200);assert.equal(first.data.order.legalVersion,version);
    const db=JSON.parse(await readFile(join(f.directory,'billing.json'),'utf8'));assert.equal(db.orders[0].legalVersion,version);assert.ok(Number.isFinite(Date.parse(db.orders[0].acceptedAt)));
    activeVersion='ORBITA-2026-10-27-2';
    const retry=await f.checkout(activeVersion,requestId);assert.equal(retry.status,200);assert.equal(retry.data.order.id,first.data.order.id);assert.equal(retry.data.order.legalVersion,version);assert.equal(f.calls.length,1);
    const stale=await f.checkout(version);assert.equal(stale.status,409);assert.equal(stale.data.code,'LEGAL_VERSION_CHANGED');assert.equal(f.calls.length,1);
  }finally{await f.close();}
});

test('closing sales denies further Check and checkout while valid Pay and Refund still settle money already in flight',async()=>{
  let ready=true;const f=await fixture({gate:async()=>({ready,legalVersion:version})});
  try{
    const order=(await f.checkout()).data.order;ready=false;
    assert.equal((await f.callback('check',order)).data.code,13);assert.equal((await f.checkout()).status,503);
    assert.equal((await f.callback('pay',order)).data.code,0);assert.equal((await f.accounts.getUser(f.member.data.user.id)).access.hasSubscription,true);
    assert.equal((await f.callback('refund',order,{TransactionId:'90101',PaymentTransactionId:'80101',OperationType:'Refund'})).data.code,0);
    assert.equal((await f.accounts.getUser(f.member.data.user.id)).access.hasSubscription,false);
    assert.equal((await f.callback('pay',order)).data.code,0);assert.equal((await f.accounts.getUser(f.member.data.user.id)).access.hasSubscription,false);
  }finally{await f.close();}
});

test('an unpublished price change blocks new orders and preserves signed Checks for existing invoices and renewals',async()=>{
  let draft=false,enabled=true;
  const legal={readPublic:async({version:requested}={})=>requested===version||!draft?{published:true,version}:{published:false,version:'ORBITA-2026-11-27'}};
  const active=createSalesGate({legal,env:{ORBITA_LIVE_PAYMENTS_ENABLED:'true',ORBITA_RECEIPTS_CONFIRMED:'true'}});
  const stopped=createSalesGate({legal,env:{ORBITA_LIVE_PAYMENTS_ENABLED:'false',ORBITA_RECEIPTS_CONFIRMED:'true'}});
  const f=await fixture({gate:input=>enabled?active(input):stopped(input)});
  try{
    const order=(await f.checkout()).data.order;draft=true;
    const file=join(f.directory,'billing.json'),db=JSON.parse(await readFile(file,'utf8'));
    db.orders[0].amount=1999;order.amount=1999;
    await writeFile(file,JSON.stringify(db));
    assert.equal((await f.checkout()).status,503);
    assert.deepEqual((await f.callback('check',order)).data,{code:0});
    assert.equal((await f.callback('check',order,{Amount:1990})).data.code,13);
    assert.deepEqual((await f.callback('check',{...order,id:'order-unknown'})).data,{code:13});
    const current=JSON.parse(await readFile(file,'utf8')),original=current.orders[0];
    const agreement={id:'agreement-1',status:'active',providerId:'cloudpayments-subscription-1',orderId:original.id,userId:original.userId,email:original.email,plan:original.plan,amount:original.amount,currency:original.currency,days:original.days,testMode:original.testMode};
    current.subscriptions=[agreement];
    await writeFile(file,JSON.stringify(current));
    const renewal={InvoiceId:undefined,SubscriptionId:agreement.providerId,TransactionId:'80102'};
    assert.deepEqual((await f.callback('check',order,renewal)).data,{code:0});
    assert.equal((await f.callback('check',order,{...renewal,Amount:1990})).data.code,13);
    const checked=JSON.parse(await readFile(file,'utf8'));
    assert.equal(checked.orders.find(item=>item.id==='order-renew-80102').amount,1999);
    checked.subscriptions[0].cancelRequestedAt=new Date().toISOString();
    await writeFile(file,JSON.stringify(checked));
    assert.deepEqual((await f.callback('check',order,renewal)).data,{code:13});
    enabled=false;
    assert.deepEqual((await f.callback('check',order)).data,{code:13});
    assert.deepEqual((await f.callback('pay',order)).data,{code:0});
    assert.equal((await f.service.getOrder(f.member.data.user,order.id)).order.amount,1999);
  }finally{await f.close();}
});

test('test merchant remains available without opening live sales and gate failures cannot expose their cause',async t=>{
  const testing=await fixture({testMode:true});try{assert.equal((await testing.request('/api/payments/config')).data.checkoutEnabled,true);assert.equal((await testing.checkout(null)).status,200);}finally{await testing.close();}
  const logs=[];t.mock.method(console,'error',value=>logs.push(String(value)));
  const broken=await fixture({gate:async()=>{throw Error('private-launch-state');}});try{
    const refused=await broken.checkout();assert.equal(refused.status,500);assert.equal(broken.calls.length,0);assert.ok(!JSON.stringify(refused.data).includes('private-launch-state'));assert.ok(!logs.join('\n').includes('private-launch-state'));
  }finally{await broken.close();}
});
