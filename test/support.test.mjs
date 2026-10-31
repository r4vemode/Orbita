import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,readFile,writeFile,rm,stat,symlink,readdir,truncate,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {createSupport,validateSupportDatabase} from '../lib/support.mjs';
import {serviceFixture} from './service-fixture.mjs';

const DAY=86400000;
const createBody=(patch={})=>({requestId:randomUUID(),subject:'Проверка поддержки',category:'other',message:'Учебное описание проблемы.',page:'/app.html',reference:'',...patch});
async function fixture({now}={}){
 const f=await serviceFixture(({directory,accounts})=>createSupport(directory,{accounts,...(now?{now}:{})}));
 const owner=await f.register('support-owner@example.test'),other=await f.register('support-other@example.test'),admin=await f.register('support-editor@example.test');await f.accounts.promote(admin.data.user.email);
 const create=(payload=createBody(),account=owner)=>f.request('/api/support',{method:'POST',body:payload,cookie:account.cookie});
 const reply=(ticket,message='Учебный ответ',account=owner,requestId=randomUUID(),revision=ticket.revision)=>f.request((account===admin?'/api/admin/support/':'/api/support/')+ticket.id+'/messages',{method:'POST',body:{requestId,revision,message},cookie:account.cookie});
 const status=(ticket,status,requestId=randomUUID())=>f.request('/api/admin/support/'+ticket.id,{method:'PATCH',cookie:admin.cookie,body:{requestId,revision:ticket.revision,status}});
 return {...f,owner,other,admin,create,reply,status};
}
function publicOnly(value){const raw=JSON.stringify(value);for(const field of ['userId','actorId','requests','requestId','historyId','hash','salt','cookie','userEmail'])assert.ok(!raw.includes('"'+field+'"'),field+' must stay private');}

test('support accepts free accounts, isolates tickets and guards all administrative routes',async()=>{
 const f=await fixture();try{
  for(const route of ['/api/support','/api/admin/support'])assert.equal((await f.request(route)).status,401);
  assert.equal((await f.request('/api/admin/support',{cookie:f.owner.cookie})).status,403);
  const result=await f.create();assert.equal(result.status,201);const ticket=result.data.ticket;assert.equal(ticket.number,'ORB-000001');assert.equal(ticket.status,'open');assert.equal(ticket.revision,1);assert.equal(ticket.messageCount,1);publicOnly(result.data);
  assert.deepEqual((await f.request('/api/support',{cookie:f.other.cookie})).data.tickets,[]);
  assert.equal((await f.request('/api/support/'+ticket.id,{cookie:f.other.cookie})).status,404);
  assert.equal((await f.reply(ticket,'Не мой ответ',f.other)).status,404);
  assert.equal((await f.request('/api/admin/support/'+ticket.id,{cookie:f.owner.cookie})).status,403);
  assert.equal((await f.request('/api/support/'+ticket.id,{cookie:f.admin.cookie})).status,404,'Administrative access uses its own namespace');
  const list=(await f.request('/api/admin/support',{cookie:f.admin.cookie})).data.tickets;assert.equal(list.length,1);assert.equal(list[0].userEmail,f.owner.data.user.email);assert.ok(!Object.hasOwn(list[0],'userId'));
  const adminDetail=(await f.request('/api/admin/support/'+ticket.id,{cookie:f.admin.cookie})).data.ticket;assert.equal(adminDetail.userEmail,f.owner.data.user.email);assert.equal(adminDetail.messages.length,1);assert.ok(!Object.hasOwn(adminDetail.messages[0],'actorId'));
 }finally{await f.close();}
});

test('support validates explicit context without collecting credentials, query strings or arbitrary metadata',async()=>{
 const f=await fixture();try{
  const invalid=[{subject:'a\nb'},{subject:''},{category:'unknown'},{message:'x'.repeat(3001)},{message:'Control\u0001text'},{page:'https://example.test/app.html'},{page:'/app.html?token=secret'},{page:'/app.html#secret'},{page:'/api/private'},{page:'//internal.example'},{page:'/%61pp.html'},{reference:'not-an-error-id'},{requestId:'invalid'},{userId:f.other.data.user.id},{headers:{Cookie:'secret'}}];
  for(const patch of invalid)assert.equal((await f.create(createBody(patch))).status,400,JSON.stringify(Object.keys(patch)));
  await assert.rejects(readFile(path.join(f.directory,'support.json')),cause=>cause.code==='ENOENT');
  const reference=randomUUID().toUpperCase(),result=await f.create(createBody({subject:'<b>Текст</b>',message:'<script>window.xss=true</script>',page:'/',reference}));assert.equal(result.status,201);assert.equal(result.data.ticket.page,'/index.html');assert.equal(result.data.ticket.reference,reference.toLowerCase());assert.equal(result.data.ticket.messages[0].text,'<script>window.xss=true</script>');publicOnly(result.data);
  for(const route of ['/api/support?userId=foreign','/api/support/'+result.data.ticket.id+'?token=secret'])assert.equal((await f.request(route,{cookie:f.owner.cookie})).status,400);
  assert.equal((await f.request('/api/support',{method:'DELETE',cookie:f.owner.cookie,body:{}})).status,405);
  assert.equal((await f.request('/api/support/'+result.data.ticket.id,{method:'PATCH',cookie:f.owner.cookie,body:{}})).status,405);
 }finally{await f.close();}
});

test('support preserves the original thread and coherent status history through the complete conversation',async()=>{
 let clock=Date.now();const f=await fixture({now:()=>clock});try{
  let ticket=(await f.create()).data.ticket;const original=structuredClone(ticket.messages[0]);
  clock+=1000;ticket=(await f.status(ticket,'in_progress')).data.ticket;
  clock+=1000;ticket=(await f.reply(ticket,'Уточните браузер',f.admin)).data.ticket;assert.equal(ticket.status,'waiting_customer');
  clock+=1000;ticket=(await f.reply(ticket,'Использую учебный Chromium')).data.ticket;assert.equal(ticket.status,'open');
  clock+=1000;ticket=(await f.status(ticket,'resolved')).data.ticket;
  clock+=1000;ticket=(await f.reply(ticket,'Нужно ещё уточнение')).data.ticket;assert.equal(ticket.status,'open');assert.equal(ticket.revision,6);assert.deepEqual(ticket.messages[0],original);assert.equal(ticket.messages.length,4);assert.equal(ticket.history.length,6);
  assert.deepEqual(ticket.history.map(event=>[event.action,event.from,event.to]),[['created',null,'open'],['status','open','in_progress'],['reply','in_progress','waiting_customer'],['reply','waiting_customer','open'],['status','open','resolved'],['reply','resolved','open']]);
  assert.equal(validateSupportDatabase(await f.service.readDatabase()),true);publicOnly(ticket);
 }finally{await f.close();}
});

test('support idempotency is actor-bound, survives stale versions and never rewrites the same operation',async()=>{
 const f=await fixture();try{
  const body=createBody(),created=await f.create(body),ticket=created.data.ticket,file=path.join(f.directory,'support.json'),before=await readFile(file);
  const duplicate=await f.create(body);assert.equal(duplicate.status,200);assert.equal(duplicate.data.ticket.id,ticket.id);assert.deepEqual(await readFile(file),before);
  assert.equal((await f.create({...body,message:'Другая отправка'})).status,409);
  const other=await f.create(body,f.other);assert.equal(other.status,201);assert.notEqual(other.data.ticket.id,ticket.id);
  const operation={requestId:randomUUID(),revision:ticket.revision,message:'Один ответ'},posted=await f.request('/api/support/'+ticket.id+'/messages',{method:'POST',body:operation,cookie:f.owner.cookie});assert.equal(posted.status,200);
  const resolved=(await f.status(posted.data.ticket,'resolved')).data.ticket,stable=await readFile(file),replayed=await f.request('/api/support/'+ticket.id+'/messages',{method:'POST',body:operation,cookie:f.owner.cookie});assert.equal(replayed.status,200);assert.equal(replayed.data.ticket.status,'resolved');assert.equal(replayed.data.ticket.revision,resolved.revision);assert.deepEqual(await readFile(file),stable);
  assert.equal((await f.request('/api/support/'+ticket.id+'/messages',{method:'POST',body:{...operation,message:'Подмена'},cookie:f.owner.cookie})).status,409);
  assert.equal((await f.reply(ticket,'Новый запрос со старой версией')).status,409);
 }finally{await f.close();}
});

test('an administrator cannot replay a customer response as an editorial response with the same identifier',async()=>{
 const f=await fixture();try{
  const ticket=(await f.create(createBody(),f.admin)).data.ticket,payload={requestId:randomUUID(),revision:ticket.revision,message:'Ответ из своего кабинета'};
  const customer=await f.request('/api/support/'+ticket.id+'/messages',{method:'POST',body:payload,cookie:f.admin.cookie});assert.equal(customer.status,200);assert.equal(customer.data.ticket.messages.at(-1).author,'customer');
  const before=await readFile(path.join(f.directory,'support.json'));
  const editorial=await f.request('/api/admin/support/'+ticket.id+'/messages',{method:'POST',body:payload,cookie:f.admin.cookie});assert.equal(editorial.status,409);assert.equal(editorial.data.code,'SUPPORT_REQUEST_CONFLICT');assert.deepEqual(await readFile(path.join(f.directory,'support.json')),before);
 }finally{await f.close();}
});

test('support daily creation quota persists, returns the real retry window and permits an exact replay',async()=>{
 let clock=Date.now();const f=await fixture({now:()=>clock});try{
  const first=createBody();for(let i=0;i<5;i++){const result=await f.create(i===0?first:createBody());assert.equal(result.status,201);assert.equal((await f.status(result.data.ticket,'resolved')).status,200);}
  const response=await fetch(f.base+'/api/support',{method:'POST',headers:{Origin:f.base,Cookie:f.owner.cookie,'Content-Type':'application/json'},body:JSON.stringify(createBody())});assert.equal(response.status,429);assert.equal(response.headers.get('retry-after'),'86400');assert.equal((await response.json()).code,'SUPPORT_DAILY_LIMIT');
  assert.equal((await f.create(first)).status,200);clock+=DAY+1;assert.equal((await f.create()).status,201);
 }finally{await f.close();}
});

test('support active quota also blocks reopening old resolved tickets, without inventing a retry time',async()=>{
 let clock=Date.now();const f=await fixture({now:()=>clock});try{
  let closed=(await f.create()).data.ticket;const accepted={requestId:randomUUID(),revision:closed.revision,message:'Сохранённый ответ'};closed=(await f.request('/api/support/'+closed.id+'/messages',{method:'POST',body:accepted,cookie:f.owner.cookie})).data.ticket;closed=(await f.status(closed,'resolved')).data.ticket;
  clock+=DAY+1;for(let i=0;i<5;i++)assert.equal((await f.create()).status,201);
  const response=await fetch(f.base+'/api/support/'+closed.id+'/messages',{method:'POST',headers:{Origin:f.base,Cookie:f.owner.cookie,'Content-Type':'application/json'},body:JSON.stringify({requestId:randomUUID(),revision:closed.revision,message:'Не открывать шестое'})});assert.equal(response.status,429);assert.equal(response.headers.get('retry-after'),null);assert.equal((await response.json()).code,'SUPPORT_ACTIVE_LIMIT');
  const replay=await f.request('/api/support/'+closed.id+'/messages',{method:'POST',body:accepted,cookie:f.owner.cookie});assert.equal(replay.status,200);assert.equal(replay.data.ticket.status,'resolved');
  const create=await f.create();assert.equal(create.status,429);assert.equal(create.data.code,'SUPPORT_ACTIVE_LIMIT');
 }finally{await f.close();}
});

test('customer reply quota counts across tickets and idempotent replay is safe at the limit',async()=>{
 let clock=Date.now();const f=await fixture({now:()=>clock});try{
  let ticket=(await f.create()).data.ticket,last;
  for(let i=0;i<20;i++){last={requestId:randomUUID(),revision:ticket.revision,message:'Ответ '+i};const result=await f.request('/api/support/'+ticket.id+'/messages',{method:'POST',cookie:f.owner.cookie,body:last});assert.equal(result.status,200);ticket=result.data.ticket;}
  assert.equal((await f.request('/api/support/'+ticket.id+'/messages',{method:'POST',cookie:f.owner.cookie,body:last})).status,200);
  const blocked=await f.reply(ticket);assert.equal(blocked.status,429);assert.equal(blocked.data.code,'SUPPORT_DAILY_LIMIT');clock+=DAY+1;assert.equal((await f.reply(ticket)).status,200);
 }finally{await f.close();}
});

test('message and history capacity errors preserve all earlier messages and permit exact replays',async()=>{
 const f=await fixture();try{
  let ticket=(await f.create()).data.ticket;
  for(let i=1;i<50;i++){const result=await f.reply(ticket,'Ответ редакции '+i,f.admin);assert.equal(result.status,200);ticket=result.data.ticket;}
  const file=path.join(f.directory,'support.json'),messagesFull=await readFile(file);assert.equal((await f.reply(ticket,'Лишнее сообщение',f.admin)).status,409);assert.deepEqual(await readFile(file),messagesFull);
  while(ticket.revision<200){const result=await f.status(ticket,ticket.status==='resolved'?'in_progress':'resolved');assert.equal(result.status,200);ticket=result.data.ticket;}
  const stable=await readFile(file),last=(await f.service.readDatabase()).tickets[0].requests.at(-1);assert.equal((await f.status(ticket,'open')).status,409);assert.deepEqual(await readFile(file),stable);
  const replay=await f.request('/api/admin/support/'+ticket.id,{method:'PATCH',cookie:f.admin.cookie,body:{requestId:last.id,revision:ticket.revision-1,status:ticket.status}});assert.equal(replay.status,200);assert.equal(replay.data.ticket.revision,200);assert.equal(replay.data.ticket.messages.length,50);assert.deepEqual(await readFile(file),stable);
 }finally{await f.close();}
});

test('support uses private persistent files and multiple instances cannot lose concurrent accepted replies',async()=>{
 const f=await fixture();let second;try{
  const ticket=(await f.create()).data.ticket,file=path.join(f.directory,'support.json');assert.equal((await stat(file)).mode&0o777,0o600);assert.equal(validateSupportDatabase(await f.service.readDatabase()),true);
  second=await createSupport(f.directory,{accounts:f.accounts});assert.equal((await second.readDatabase()).tickets[0].id,ticket.id);
  const calls=await Promise.all([f.reply(ticket,'Первый параллельный'),f.reply(ticket,'Второй параллельный')]);assert.deepEqual(calls.map(result=>result.status).sort(),[200,409]);assert.equal((await second.readDatabase()).tickets[0].messages.length,2);assert.equal((await second.readDatabase()).tickets[0].revision,2);
  assert.deepEqual((await readdir(f.directory)).filter(name=>name.startsWith('support.')),['support.json']);
 }finally{await second?.close();await f.close();}
});

test('support structural validation detects tampered history, hashes, identities and unsafe revision fields',async()=>{
 const f=await fixture();try{
  const ticket=(await f.create()).data.ticket;await f.reply(ticket,'Редакторский ответ',f.admin);const original=await f.service.readDatabase();assert.equal(validateSupportDatabase(original),true);
  const mutations=[db=>{db.version=2;},db=>{db.nextNumber=1;},db=>{db.revision++;},db=>{db.tickets[0].userId='foreign';},db=>{db.tickets[0].history[0].to='resolved';},db=>{db.tickets[0].messages[0].text='Подмена';},db=>{db.tickets[0].requests[0].hash='0'.repeat(64);},db=>{db.tickets[0].history[0].at='2026-02-30T00:00:00.000Z';},db=>{db.tickets[0].reference='secret-token';},db=>{db.tickets[0].page='/app.html?secret=token';},db=>{db.tickets[0].extra='unknown';}];
  for(const mutate of mutations){const db=structuredClone(original);mutate(db);assert.equal(validateSupportDatabase(db),false);}
  const inconsistent=structuredClone(original);inconsistent.tickets[0].history[1].to='resolved';inconsistent.tickets[0].status='resolved';assert.equal(validateSupportDatabase(inconsistent),false,'Reply status follows the actor-specific transition');
 }finally{await f.close();}
});

test('support rejects corrupt, oversized and symbolic stores on startup without resetting their bytes',async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),'orbita-support-files-')),accounts={identify:async()=>null,checkRequest(){}};try{
  const file=path.join(directory,'support.json');await writeFile(file,'{"version":1}');await assert.rejects(createSupport(directory,{accounts}),cause=>cause.code==='DATA_INVALID');assert.equal(await readFile(file,'utf8'),'{"version":1}');
  await writeFile(file,'');await truncate(file,16*1024*1024+1);await assert.rejects(createSupport(directory,{accounts}),cause=>cause.code==='DATA_UNSAFE');assert.equal((await stat(file)).size,16*1024*1024+1);
  await rm(file);const outside=path.join(directory,'outside.json');await writeFile(outside,'preserve');await symlink(outside,file);await assert.rejects(createSupport(directory,{accounts}),cause=>cause.code==='DATA_UNSAFE');assert.equal(await readFile(outside,'utf8'),'preserve');
 }finally{await rm(directory,{recursive:true,force:true});}
});

async function paused(f,account,route,method,body){
 const original=f.accounts.identify;let reached,seen=false;const waiting=new Promise(resolve=>{reached=resolve;});f.accounts.identify=async req=>{const actor=await original(req);if(req.url===route&&!seen){seen=true;reached();}return actor;};
 const bytes=Buffer.from(JSON.stringify(body));let request;const result=new Promise((resolve,reject)=>{request=http.request(new URL(route,f.base),{method,headers:{Origin:f.base,Cookie:account.cookie,'Content-Type':'application/json','Content-Length':bytes.length}},response=>{const chunks=[];response.on('data',chunk=>chunks.push(chunk));response.on('end',()=>resolve({status:response.statusCode,data:JSON.parse(Buffer.concat(chunks).toString())}));});request.on('error',reject);request.write(bytes.subarray(0,1));});
 let timer;try{await Promise.race([waiting,new Promise((_resolve,reject)=>{timer=setTimeout(()=>reject(Error('Paused support request was not authenticated')),3000);})]);}catch(cause){request.destroy();await result.catch(()=>{});f.accounts.identify=original;throw cause;}finally{clearTimeout(timer);}
 return {async finish(){request.end(bytes.subarray(1));try{return await result;}finally{f.accounts.identify=original;}},abort(){request.destroy();f.accounts.identify=original;}};
}

test('support rechecks session and administrator role after slow uploads before changing the private thread',async()=>{
 for(const kind of ['create','reply','admin-message','admin-status']){
  const f=await fixture();let upload;try{
   const ticket=(await f.create()).data.ticket,file=path.join(f.directory,'support.json'),before=await readFile(file),admin=kind.startsWith('admin'),account=admin?f.admin:f.owner;
   const route=kind==='create'?'/api/support':(admin?'/api/admin/support/':'/api/support/')+ticket.id+(kind==='admin-status'?'':'/messages'),method=kind==='admin-status'?'PATCH':'POST',body=kind==='create'?createBody():kind==='admin-status'?{requestId:randomUUID(),revision:ticket.revision,status:'resolved'}:{requestId:randomUUID(),revision:ticket.revision,message:'Не сохранять'};
   upload=await paused(f,account,route,method,body);await f.accounts.transact(db=>{if(admin)db.users.find(user=>user.id===account.data.user.id).role='member';else db.sessions=db.sessions.filter(session=>session.userId!==account.data.user.id);});
   const response=await upload.finish();assert.equal(response.status,admin?403:401,kind);assert.deepEqual(await readFile(file),before);
  }finally{upload?.abort();await f.close();}
 }
});

test('support validates authority again inside the serialized write, not merely before entering the queue',async()=>{
 const f=await fixture();try{
  const ticket=(await f.create()).data.ticket,file=path.join(f.directory,'support.json'),before=await readFile(file),lock=file+'.lock';await mkdir(lock,{mode:0o700});await writeFile(path.join(lock,'owner.json'),JSON.stringify({pid:process.pid}));
  const original=f.accounts.identify;let calls=0,reached;const queued=new Promise(resolve=>{reached=resolve;});f.accounts.identify=async req=>{const actor=await original(req);if(req.url==='/api/admin/support/'+ticket.id&&++calls===2)reached();return actor;};
  const operation=f.status(ticket,'resolved');await queued;await f.accounts.transact(db=>{db.users.find(user=>user.id===f.admin.data.user.id).role='member';});await rm(lock,{recursive:true});const response=await operation;f.accounts.identify=original;assert.equal(response.status,403);assert.deepEqual(await readFile(file),before);
 }finally{await f.close();}
});
