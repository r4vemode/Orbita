import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createHmac} from 'node:crypto';
import {once} from 'node:events';
import {readBody,readJson,json} from '../lib/http.mjs';
import {createRequestSecurity} from '../lib/request-security.mjs';

async function fixture({limit=32,timeoutMs=1000,parseJson=false}={}){
 const requests=[],outcomes=[],security=createRequestSecurity({maxActive:1,maxClientActive:1});
 const server=http.createServer(async(req,res)=>{
  if(!security.enter(req,res))return;
  requests.push(req);
  try{const body=await(parseJson?readJson(req,limit):readBody(req,{limit,timeoutMs}));outcomes.push({body});json(res,200,parseJson?body:{hex:body.toString('hex')});}
  catch(cause){outcomes.push({cause});json(res,cause.status||500,{error:cause.message});}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 return {base:'http://127.0.0.1:'+server.address().port,requests,outcomes,async close(){const done=new Promise(resolve=>server.close(resolve));server.closeAllConnections();await done;}};
}

function send(base,{headers={},write}={}){
 let request,timer;
 const response=new Promise((resolve,reject)=>{
  request=http.request(base,{method:'POST',headers},res=>{const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,data:JSON.parse(Buffer.concat(chunks))}));res.on('error',reject);});
  request.on('error',reject);timer=setTimeout(()=>request.destroy(Error('Test upload timed out.')),5000);timer.unref();write?write(request):request.end();
 });
 return {response:response.finally(()=>clearTimeout(timer)),close:()=>request.destroy()};
}

test('declared oversized body is rejected before upload with a readable 413 and closed connection',async()=>{
 const f=await fixture();let client;
 try{client=send(f.base,{headers:{'Content-Length':'1000'},write:req=>req.flushHeaders()});const result=await client.response;assert.equal(result.status,413);assert.equal(result.headers.connection,'close');assert.match(result.data.error,/Слишком большой/);assert.equal(f.outcomes[0].cause.status,413);assert.equal((await send(f.base,{write:req=>req.end('ok')}).response).status,200,'finish releases admission for the next request');}
 finally{client?.close();await f.close();}
});

test('chunked body is bounded by received bytes and preserves the 413 response',async()=>{
 const f=await fixture();let client;
 try{client=send(f.base,{write:req=>{req.write(Buffer.alloc(20,65));req.write(Buffer.alloc(20,66));}});const result=await client.response;assert.equal(result.status,413);assert.equal(result.headers.connection,'close');assert.equal(f.requests[0].readableFlowing,false);}
 finally{client?.close();await f.close();}
});

test('an absolute body deadline stops a trickling upload and returns 408',async()=>{
 const f=await fixture({limit:65536,timeoutMs:70});let client,interval;
 try{const started=Date.now();client=send(f.base,{write:req=>{req.write('a');interval=setInterval(()=>req.write('a'),10);}});const result=await client.response;assert.equal(result.status,408);assert.equal(result.headers.connection,'close');assert.ok(Date.now()-started<1500,'trickle does not renew the deadline');}
 finally{clearInterval(interval);client?.close();await f.close();}
});

test('client abort rejects promptly and removes body listeners without an unhandled reset',async()=>{
 const f=await fixture();let client;
 try{
  client=send(f.base,{headers:{'Content-Length':'20'},write:req=>req.write('partial')});client.response.catch(()=>{});
  while(!f.requests.length)await new Promise(resolve=>setImmediate(resolve));
  const req=f.requests[0],closed=once(req,'close');client.close();await closed.catch(cause=>{assert.equal(cause.code,'ECONNRESET');});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(f.outcomes[0].cause.status,400);
  for(const event of ['data','end','aborted','error','close'])assert.ok(!req.listeners(event).some(listener=>['onData','onEnd','onAbort','onError','onClose','ignore'].includes(listener.name)),event);
  assert.equal((await send(f.base,{write:req=>req.end('ok')}).response).status,200,'peer close releases admission for the next request');
 }finally{client?.close();await f.close();}
});

test('raw reader preserves split UTF-8 and encoded form bytes for provider HMAC',async()=>{
 const f=await fixture({limit:65536});let client;
 try{
  const bytes=Buffer.from('Note=Тест+%D1%81%D1%82%D0%BE%D0%BF&Amount=4999.00&Currency=RUB'),signature=createHmac('sha256','test-key').update(bytes).digest('base64');
  client=send(f.base,{headers:{'Content-Type':'application/x-www-form-urlencoded'},write:req=>{req.write(bytes.subarray(0,6));req.write(bytes.subarray(6,7));req.end(bytes.subarray(7));}});
  const result=await client.response;assert.equal(result.status,200);const received=Buffer.from(result.data.hex,'hex');assert.deepEqual(received,bytes);assert.equal(createHmac('sha256','test-key').update(received).digest('base64'),signature);
 }finally{client?.close();await f.close();}
});

test('JSON reader keeps its limit argument and validates complete JSON objects',async()=>{
 const f=await fixture({limit:12,parseJson:true});
 try{
  const post=body=>fetch(f.base,{method:'POST',body});
  assert.equal((await post('{"ok":true}')).status,200);assert.equal((await post('[]')).status,400);assert.equal((await post('{"long":"aaaaaaaaaaaaaaaa"}')).status,413);
 }finally{await f.close();}
});
