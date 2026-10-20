import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAccounts} from '../lib/accounts.mjs';
test('private manual positions survive server recreation and remain isolated between accounts',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'orbita-accounts-'));let server,base,accounts;
 async function start(){accounts=await createAccounts(dir);server=http.createServer(async(req,res)=>{if(!await accounts.handle(req,res,new URL(req.url,base)))res.writeHead(404).end()});await new Promise(r=>server.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+server.address().port}
 const request=async(path,{method='GET',body,cookie,origin=base}={})=>{const r=await fetch(base+path,{method,headers:{'Content-Type':'application/json',Origin:origin,...(cookie?{Cookie:cookie}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,body:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]}};
 try{
  await start();assert.equal((await request('/api/positions')).status,401);
  const a=await request('/api/register',{method:'POST',body:{email:'first@example.test',password:'password-first',acceptTerms:true,acceptPrivacy:true,legalVersion:'ORBITA-2026-10-20'}});assert.equal(a.status,200);assert.equal((await request('/api/positions',{cookie:a.cookie})).status,403);await accounts.promote('first@example.test');
  const trade={ideaId:'demo-test',entry:312,quantity:10,pointValue:1,enteredAt:'2026-10-01T10:00:00.000Z',exit:null,closedAt:null};
  assert.equal((await request('/api/positions',{method:'PUT',cookie:a.cookie,body:trade,origin:'https://outside.example'})).status,403);
  assert.equal((await request('/api/positions',{method:'PUT',cookie:a.cookie,body:{...trade,quantity:-1}})).status,400);
  assert.equal((await request('/api/positions',{method:'PUT',cookie:a.cookie,body:trade})).status,200);
  const b=await request('/api/register',{method:'POST',body:{email:'second@example.test',password:'password-second',acceptTerms:true,acceptPrivacy:true,legalVersion:'ORBITA-2026-10-20'}});
  assert.equal((await request('/api/positions',{cookie:b.cookie})).status,403);assert.equal((await request('/api/admin/subscriptions',{method:'POST',cookie:a.cookie,body:{userId:b.body.user.id,plan:'pro',expiresAt:new Date(Date.now()+86400000).toISOString(),reason:'Проверка приватности аккаунтов'}})).status,200);assert.deepEqual((await request('/api/positions',{cookie:b.cookie})).body.positions,[]);
  await new Promise(r=>server.close(r));await start();
  assert.deepEqual((await request('/api/positions',{cookie:a.cookie})).body.positions,[trade]);
  assert.equal((await request('/api/positions',{method:'PUT',cookie:a.cookie,body:{...trade,exit:325,closedAt:'2026-10-10T10:00:00Z'}})).status,200);
  assert.equal((await request('/api/positions',{cookie:a.cookie})).body.positions[0].exit,325);
  assert.equal((await request('/api/positions',{method:'DELETE',cookie:b.cookie,body:{ideaId:trade.ideaId}})).status,200);
  assert.equal((await request('/api/positions',{cookie:a.cookie})).body.positions.length,1);
 }finally{if(server?.listening)await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true})}
});
