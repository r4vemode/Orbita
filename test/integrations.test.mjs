import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createAccounts} from '../lib/accounts.mjs';
import {totp} from '../lib/account-security.mjs';
import {LEGAL_VERSION} from '../lib/access.mjs';

test('real server exposes account settings without subscription, authenticates exact callbacks, and requires admin MFA',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'orbita-integrations-'));
 const child=spawn(process.execPath,['server.mjs'],{cwd:fileURLToPath(new URL('../',import.meta.url)),env:{...process.env,HOST:'127.0.0.1',PORT:'0',ORBITA_DATA_DIR:directory,ORBITA_PUBLIC_ORIGIN:'',ORBITA_REQUIRE_ADMIN_MFA:'true',CLOUDPAYMENTS_PUBLIC_ID:'',CLOUDPAYMENTS_API_SECRET:'',TELEGRAM_BOT_TOKEN:'',ORBITA_BACKUP_DIR:'',ORBITA_BACKUP_PASSPHRASE:''},stdio:['ignore','pipe','pipe']});
 try{
  const base=await new Promise((resolve,reject)=>{let output='';const timeout=setTimeout(()=>reject(Error('Server startup timed out')),10000);child.stdout.on('data',bytes=>{output+=bytes;const match=output.match(/ORBITA: (http:\/\/127\.0\.0\.1:\d+)/);if(match){clearTimeout(timeout);resolve(match[1]);}});child.once('error',reject);child.once('exit',code=>{clearTimeout(timeout);reject(Error('Server exited: '+code));});});
  async function request(path,{body,cookie,origin=base}={}){const response=await fetch(base+path,{redirect:'manual',method:body===undefined?'GET':'POST',headers:{Origin:origin,'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});return {response,status:response.status,data:response.headers.get('content-type')?.includes('application/json')?await response.json():null,cookie:response.headers.get('set-cookie')?.split(';')[0]};}
  const user=await request('/api/register',{body:{email:'server-admin@example.test',password:'long-test-password-2026',acceptTerms:true,acceptPrivacy:true,legalVersion:LEGAL_VERSION}});assert.equal(user.status,200);
  for(const page of ['/security.html','/notifications.html','/subscriptions.html']){assert.equal((await request(page)).status,303);assert.equal((await request(page,{cookie:user.cookie})).status,200);}
  for(const page of ['/verify-email.html','/reset-password.html'])assert.equal((await request(page)).status,200);
  assert.equal((await request('/api/public-config')).data.paymentsAvailable,false);assert.equal((await request('/api/payments/config')).data.configured,false);
  assert.equal((await request('/api/payments/cloudpayments/pay',{body:{},origin:''})).status,503);assert.equal((await request('/api/notifications/telegram/webhook',{body:{},origin:''})).status,503);
  for(const path of ['/api/payments/checkout','/api/notifications/preferences','/api/security/mfa/setup','/api/payments/cloudpayments/%70ay'])assert.equal((await request(path,{body:{},cookie:user.cookie,origin:''})).status,403);
  await(await createAccounts(directory,{publicOrigin:'',requireAdminMfa:true})).promote('server-admin@example.test');
  const pending=await request('/admin.html',{cookie:user.cookie});assert.equal(pending.status,303);assert.equal(pending.response.headers.get('location'),'/security.html?setup=1');
  assert.equal((await request('/api/admin/users',{cookie:user.cookie})).status,403);assert.equal((await request('/api/ideas',{cookie:user.cookie})).status,403);
  const setup=await request('/api/security/mfa/setup',{cookie:user.cookie,body:{password:'long-test-password-2026'}});assert.equal(setup.status,200);
  assert.equal((await request('/api/security/mfa/confirm',{cookie:user.cookie,body:{code:totp(setup.data.secret)}})).status,200);
  assert.equal((await request('/admin.html',{cookie:user.cookie})).status,200);assert.equal((await request('/api/admin/users',{cookie:user.cookie})).status,200);
 }finally{if(child.exitCode===null){const exited=new Promise(resolve=>child.once('exit',resolve));child.kill();await exited;}await rm(directory,{recursive:true,force:true});}
});
