import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequestSecurity,parseTrustedProxyIps,resolveClientAddress,requestAddress} from '../lib/request-security.mjs';
import {inspectConfiguration} from '../lib/operations.mjs';
import {LEGAL_VERSION} from '../lib/access.mjs';

const request=(address='192.0.2.1',method='POST',forwarded)=>({method,socket:{remoteAddress:address},headers:forwarded===undefined?{}:{'x-forwarded-for':forwarded}});
function response(){const res=new EventEmitter();res.writeHead=(status,headers)=>{res.status=status;res.headers=headers;};res.end=body=>{res.body=JSON.parse(body);res.emit('finish');};return res;}
function enter(guard,req,options){const res=response(),accepted=guard.enter(req,res,options);return {res,accepted,finish:()=>res.emit('finish')};}

test('proxy addresses are trusted only by exact socket IP and the nearest untrusted hop wins',()=>{
  const trusted=parseTrustedProxyIps('127.0.0.1, ::1, 192.0.2.9');
  assert.equal(resolveClientAddress(request('198.51.100.4','POST','203.0.113.99'),trusted),'198.51.100.4');
  assert.equal(resolveClientAddress(request('::ffff:127.0.0.1','POST','203.0.113.99, 198.51.100.4, 192.0.2.9'),trusted),'198.51.100.4');
  assert.equal(resolveClientAddress(request('::1','POST','2001:0db8:0000:0000:0000:0000:0000:0001'),trusted),'2001:db8::1');
  for(const header of ['not-an-ip','198.51.100.1, evil','198.51.100.1:3000',Array(17).fill('198.51.100.1').join(',')])assert.equal(resolveClientAddress(request('127.0.0.1','POST',header),trusted),'127.0.0.1');
  for(const config of ['*','0.0.0.0/0','127.0.0.0/8','localhost','127.0.0.1,'])assert.throws(()=>parseTrustedProxyIps(config));
  assert.equal(parseTrustedProxyIps('0:0:0:0:0:0:0:1,::1').size,1);
});

test('API read/write budgets are separate and forwarding spoof cannot reset an untrusted client budget',()=>{
  let clock=0;const guard=createRequestSecurity({now:()=>clock,writeLimit:2,readLimit:1,windowMs:1000});
  for(let i=0;i<2;i++){const accepted=enter(guard,request('192.0.2.1','POST','203.0.113.'+i));assert.equal(accepted.accepted,true);accepted.finish();}
  const blocked=enter(guard,request('192.0.2.1','PUT','198.51.100.1'));assert.equal(blocked.accepted,false);assert.equal(blocked.res.status,429);assert.equal(blocked.res.headers['Retry-After'],'1');assert.equal(blocked.res.headers.Connection,'close');
  const read=enter(guard,request('192.0.2.1','GET'));assert.equal(read.accepted,true);read.finish();assert.equal(enter(guard,request('192.0.2.1','GET')).accepted,false);
  clock=1001;const renewed=enter(guard,request());assert.equal(renewed.accepted,true);renewed.finish();
});

test('trusted proxy gives real clients independent budgets and passes that address to auth limits',()=>{
  const guard=createRequestSecurity({trustedProxyIps:'127.0.0.1',writeLimit:1});
  const one=request('127.0.0.1','POST','203.0.113.1'),two=request('127.0.0.1','POST','203.0.113.2');
  const first=enter(guard,one);assert.equal(first.accepted,true);first.finish();assert.equal(requestAddress(one),'203.0.113.1');
  assert.equal(enter(guard,one).accepted,false);const second=enter(guard,two);assert.equal(second.accepted,true);second.finish();
});

test('active API limits release exactly once and reserve independent capacity for provider callbacks',()=>{
  const guard=createRequestSecurity({maxActive:1,maxWebhookActive:1,maxClientActive:2});
  const regular=enter(guard,request());assert.equal(regular.accepted,true);assert.equal(enter(guard,request('192.0.2.2')).res.status,503);
  const hook=enter(guard,request('192.0.2.3'),{webhook:true});assert.equal(hook.accepted,true);assert.equal(enter(guard,request('192.0.2.4'),{webhook:true}).res.status,503);
  regular.res.emit('close');regular.finish();const next=enter(guard,request('192.0.2.2'));assert.equal(next.accepted,true);next.finish();hook.finish();
  const perClient=createRequestSecurity({maxClientActive:1}),held=enter(perClient,request());assert.equal(enter(perClient,request()).res.status,429);held.finish();
});

test('request limiter storage is bounded without evicting live budgets',()=>{
  let clock=0;const guard=createRequestSecurity({maxEntries:2,windowMs:1000,now:()=>clock});
  const one=enter(guard,request('192.0.2.1')),two=enter(guard,request('192.0.2.2'));one.finish();two.finish();
  assert.equal(enter(guard,request('192.0.2.3')).res.status,429);clock=1001;const next=enter(guard,request('192.0.2.3'));assert.equal(next.accepted,true);next.finish();
  const invalid=inspectConfiguration({ORBITA_TRUSTED_PROXY_IPS:'0.0.0.0/0'});assert.equal(invalid.checks.find(item=>item.name==='ORBITA_TRUSTED_PROXY_IPS').status,'fail');
  const missing=inspectConfiguration({}, {production:true});assert.equal(missing.checks.find(item=>item.name==='ORBITA_TRUSTED_PROXY_IPS').status,'fail');
});

test('preflight rejects the obsolete Node 20 minimum and accepts current supported LTS versions',()=>{
  const node=version=>inspectConfiguration({}, {nodeVersion:version}).checks.find(item=>item.name==='NODE_VERSION');
  assert.equal(node('20.19.0').status,'fail');assert.equal(node('20.19.0').reason,'requires_node_22');assert.equal(node('22.21.0').status,'pass');assert.equal(node('24.19.0').status,'pass');
});

async function start(t,{secure=false,mfa='false'}={}){
  const directory=await mkdtemp(join(tmpdir(),'orbita-security-server-'));let port=0;
  if(secure){const reserve=createServer();await new Promise(resolve=>reserve.listen(0,'127.0.0.1',resolve));port=reserve.address().port;await new Promise(resolve=>reserve.close(resolve));}
  const child=spawn(process.execPath,['server.mjs'],{cwd:fileURLToPath(new URL('../',import.meta.url)),env:{PATH:process.env.PATH,HOST:'127.0.0.1',PORT:String(port),ORBITA_DATA_DIR:directory,ORBITA_PUBLIC_ORIGIN:secure?'https://orbita.example':'',ORBITA_REQUIRE_ADMIN_MFA:mfa},stdio:['ignore','pipe','pipe']});
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){const done=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGTERM');await done;}await rm(directory,{recursive:true,force:true});});
  const base=await new Promise((resolve,reject)=>{let output='';const timer=setTimeout(()=>{child.kill();reject(Error('startup timeout'));},10000);child.stdout.on('data',chunk=>{output+=chunk;const match=output.match(/ORBITA: (https?:\/\/\S+)/);if(match){clearTimeout(timer);resolve(secure?'http://127.0.0.1:'+port:match[1]);}});child.stderr.on('data',()=>{});child.once('error',cause=>{clearTimeout(timer);reject(cause);});child.once('exit',()=>{clearTimeout(timer);reject(Error('startup rejected'));});});return base;
}

test('real server throttles mutation flood and ignores forged forwarded IPs while reads and health remain available',async t=>{
  const base=await start(t),registration=await fetch(base+'/api/register',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({email:'security-limit@example.test',password:'security-fixture-password',acceptTerms:true,acceptPrivacy:true,legalVersion:LEGAL_VERSION})});
  assert.equal(registration.status,200);const cookie=registration.headers.get('set-cookie').split(';')[0];await registration.json();
  const results=await Promise.all(Array.from({length:160},async(_,index)=>{const res=await fetch(base+'/api/notifications/preferences',{method:'PUT',headers:{Origin:base,Cookie:cookie,'Content-Type':'application/json','X-Forwarded-For':'198.51.100.'+(index%200+1)},body:JSON.stringify({ideaUpdates:true})});await res.text();return res.status;}));
  assert.ok(results.includes(200));assert.ok(results.includes(429));assert.ok(results.filter(status=>status===200).length<=59);assert.ok(results.every(status=>[200,429].includes(status)));
  const me=await fetch(base+'/api/me',{headers:{Cookie:cookie}});assert.equal(me.status,200);assert.equal((await me.json()).user.email,'security-limit@example.test');
  const health=await fetch(base+'/healthz');assert.equal(health.status,200);assert.equal(health.headers.get('strict-transport-security'),null);assert.match(health.headers.get('content-security-policy'),/script-src 'self'/);assert.equal(health.headers.get('x-frame-options'),'DENY');assert.equal(health.headers.get('cross-origin-resource-policy'),'same-origin');assert.match(health.headers.get('permissions-policy'),/camera=\(\)/);
  for(const path of ['/.env','/%2eenv','/.git/config','/.security-key','/assets/.env'])assert.equal((await fetch(base+path)).status,403,path);
});

test('public HTTPS configuration adds HSTS and refuses disabling administrator MFA',async t=>{
  const base=await start(t,{secure:true,mfa:'true'}),res=await fetch(base+'/healthz');assert.equal(res.status,200);assert.equal(res.headers.get('strict-transport-security'),'max-age=31536000');
  await assert.rejects(start(t,{secure:true,mfa:'false'}),/startup rejected/);
});
