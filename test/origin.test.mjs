import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createAccounts} from '../lib/accounts.mjs';
import {LEGAL_VERSION} from '../lib/access.mjs';
test('configured HTTPS origin permits registration behind proxy and issues Secure cookie',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'orbita-https-'));let server;
 try{const accounts=await createAccounts(directory,{publicOrigin:'https://orbita.example'});server=http.createServer(async(req,res)=>{if(!await accounts.handle(req,res,new URL(req.url,'http://localhost')))res.writeHead(404).end();});await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
 const body={email:'https@example.test',password:'secure-origin-password',acceptTerms:true,acceptPrivacy:true,legalVersion:LEGAL_VERSION};
 const ok=await fetch(base+'/api/register',{method:'POST',headers:{Origin:'https://orbita.example','Content-Type':'application/json',Host:'orbita.example'},body:JSON.stringify(body)});assert.equal(ok.status,200);assert.match(ok.headers.get('set-cookie'),/; Secure/);assert.equal((await ok.json()).user.access.hasSubscription,false);
 const forbidden=await fetch(base+'/api/login',{method:'POST',headers:{Origin:'https://other.example','Content-Type':'application/json'},body:JSON.stringify(body)});assert.equal(forbidden.status,403);
 const proxy=await fetch(base+'/api/login',{method:'POST',headers:{Origin:'https://orbita.example','Content-Type':'application/json'},body:JSON.stringify(body)});assert.equal(proxy.status,200);
 const no=await createAccounts(directory,{publicOrigin:''});assert.throws(()=>no.checkRequest({method:'GET',headers:{host:'other.example'}}),/не настроен/);
 }finally{if(server?.listening)await new Promise(r=>server.close(r));await rm(directory,{recursive:true,force:true});}
});
test('deployment origin configuration rejects credential-bearing or insecure public URLs',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'orbita-bad-origin-'));try{for(const publicOrigin of ['http://orbita.example','https://user:password@orbita.example','https://orbita.example/path'])await assert.rejects(()=>createAccounts(directory,{publicOrigin}));}finally{await rm(directory,{recursive:true,force:true});}
});
