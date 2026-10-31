import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {createPayments} from '../lib/payments.mjs';
import {createNotifications} from '../lib/notifications.mjs';
import {serviceFixture} from './service-fixture.mjs';

async function pausedRequest(f,account,route,method='POST'){
 const req=new PassThrough();req.method=method;req.headers={host:new URL(f.base).host,origin:f.base,cookie:account.cookie,'content-type':'application/json'};req.socket={remoteAddress:'127.0.0.1'};
 const user=await f.accounts.identify(req);assert.ok(user);
 let reading;const ready=new Promise(resolve=>{reading=resolve;});req.on('newListener',name=>{if(name==='data')reading();});
 const response={status:0,data:null,writeHead(status){this.status=status;return this;},end(body){this.data=JSON.parse(body);}};
 const work=f.service.handle(req,response,new URL(route,f.base),user);
 await Promise.race([ready,work.then(()=>{throw Error('Request completed before reading its body');})]);
 return async body=>{req.end(JSON.stringify(body));await work;return response;};
}
const revoke=(f,userId)=>f.accounts.transact(db=>{db.sessions=db.sessions.filter(session=>session.userId!==userId);});

test('checkout rejects a session revoked while its body is still arriving before creating an invoice',async()=>{
 let providerCalls=0;
 const f=await serviceFixture(({directory,accounts})=>createPayments(directory,{accounts,config:{publicId:'isolated-merchant',apiSecret:'isolated-key',publicOrigin:'https://orbita.example.test',testMode:true},fetchImpl:async()=>{providerCalls++;return {ok:true,json:async()=>({Success:true,Model:{Url:'https://orders.cloudpayments.ru/d/isolated'}})};}}));
 try{
  const member=await f.register('slow-checkout@example.test');await f.verify(member);
  const finish=await pausedRequest(f,member,'/api/payments/checkout');await revoke(f,member.data.user.id);
  const response=await finish({plan:'pro',requestId:'slow-checkout-request-2026'});assert.equal(response.status,401);assert.equal(providerCalls,0);
  await assert.rejects(readFile(path.join(f.directory,'billing.json')),cause=>cause.code==='ENOENT');
 }finally{await f.close();}
});

test('notification preferences and Telegram links reject sessions revoked during request upload',async()=>{
 for(const [route,method,body]of [['/api/notifications/preferences','PUT',{newSignals:true}],['/api/notifications/telegram/link','POST',{}]]){
  const f=await serviceFixture(({directory,accounts,ideas})=>createNotifications(directory,{accounts,ideas,config:{botToken:'123456:abcdefghijklmnopqrstuvwxyzABCDEF',botUsername:'orbita_test_bot',webhookSecret:'isolated-webhook-secret-123',publicOrigin:'https://orbita.example.test'}}));
  try{
   const member=await f.register('slow-delivery@example.test'),finish=await pausedRequest(f,member,route,method);await revoke(f,member.data.user.id);
   const response=await finish(body);assert.equal(response.status,401,route);assert.equal(response.data.deepLink,undefined);
   await assert.rejects(readFile(path.join(f.directory,'notifications.json')),cause=>cause.code==='ENOENT');
  }finally{await f.close();}
 }
});
