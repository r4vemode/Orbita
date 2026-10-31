import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {setImmediate as nextTurn} from 'node:timers/promises';
import {serviceFixture} from './service-fixture.mjs';
import {createRadar} from '../lib/radar/service.mjs';
import {createParticipants} from '../lib/participants.mjs';

const scenarios=[
 {name:'Radar publication rechecks administrator role after a slow upload',build:createRadar,route:'/api/admin/radar',method:'POST',actor:'admin',status:403,body:{companyId:'sber',eventType:'DIVIDEND',headline:'Регрессионная публикация',summary:'Публикация не должна произойти.',impact:'NEUTRAL',importanceScore:7,source:'https://www.moex.com/',publishedAt:new Date().toISOString(),status:'published'},revoke:async(f,actor)=>f.accounts.transact(db=>{db.users.find(user=>user.id===actor.data.user.id).role='member';}),empty:db=>assert.deepEqual(db.events,[])},
 {name:'Radar rules recheck a revoked subscription after a slow upload',build:createRadar,route:'/api/radar/subscriptions',method:'POST',actor:'pro',status:403,body:{companyId:'sber',minimumImportance:9},revoke:async(f,actor)=>f.accounts.transact(db=>{db.users.find(user=>user.id===actor.data.user.id).subscriptions=[];}),empty:db=>assert.deepEqual(db.subscriptions,[])},
 {name:'Participant watchlists recheck a logged-out session after a slow upload',build:createParticipants,route:'/api/participants/watchlist',method:'PUT',actor:'pro',status:401,body:{symbols:['SBER']},revoke:async(f,actor)=>{assert.equal((await f.request('/api/logout',{method:'POST',cookie:actor.cookie,body:{}})).status,200);},empty:db=>assert.deepEqual(db.watchlists,[])}
];

for(const scenario of scenarios)test(scenario.name,async()=>{
 let entered,identifications=0;const identified=new Promise(resolve=>{entered=resolve;});
 const f=await serviceFixture(({directory,accounts})=>{const original=accounts.identify;accounts.identify=async req=>{const user=await original(req);if(req.url===scenario.route){identifications++;entered();}return user;};return scenario.build(directory,{accounts,env:{}});});
 let upload;
 try{
  const admin=await f.register('upload-admin@example.test');await f.accounts.promote(admin.data.user.email);const pro=await f.register('upload-pro@example.test');
  await f.accounts.transact(db=>{db.users.find(user=>user.id===pro.data.user.id).subscriptions=[{plan:'pro',expiresAt:new Date(Date.now()+86400000).toISOString()}];});
  const actor=scenario.actor==='admin'?admin:pro,body=JSON.stringify(scenario.body);
  const response=new Promise((resolve,reject)=>{upload=http.request(f.base+scenario.route,{method:scenario.method,headers:{Origin:f.base,Cookie:actor.cookie,'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}},res=>{const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve({status:res.statusCode,data:JSON.parse(Buffer.concat(chunks))}));});upload.on('error',reject);upload.setTimeout(5000,()=>upload.destroy(Error('Isolated upload fixture timed out')));upload.write(body.slice(0,1));});
  await identified;await nextTurn();await scenario.revoke(f,actor);upload.end(body.slice(1));const result=await response;
  assert.equal(result.status,scenario.status);assert.equal(identifications,2,'The original cookie must be looked up again after the body arrives');scenario.empty(await f.service.readDatabase());
 }finally{upload?.destroy();await f.close();}
});
