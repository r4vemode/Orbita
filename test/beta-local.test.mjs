import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,readFile,readdir,rm,writeFile,lstat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {localBetaEnvironment,startLocalBeta} from '../scripts/beta-local.mjs';

const project=fileURLToPath(new URL('../',import.meta.url));
const script=path.join(project,'scripts/beta-local.mjs');
async function login(session,role){
  const account=session.accounts.find(value=>value.role===role),response=await fetch(session.base+'/api/login',{method:'POST',headers:{Origin:session.base,'Content-Type':'application/json'},body:JSON.stringify({email:account.email,password:account.password})});
  assert.equal(response.status,200);return {user:(await response.json()).user,cookie:response.headers.get('set-cookie')?.split(';')[0]};
}
async function get(session,route,cookie){const response=await fetch(session.base+route,{redirect:'manual',headers:cookie?{Cookie:cookie}:{}});return {status:response.status,data:response.headers.get('content-type')?.includes('application/json')?await response.json():null};}

test('local beta isolates provider settings, owns temporary data and exposes four genuine roles',async()=>{
  const guard=await mkdtemp(path.join(tmpdir(),'orbita-beta-guard-')),operatorData=path.join(guard,'operator-data'),operatorBackups=path.join(guard,'operator-backups');
  await mkdir(operatorData);await mkdir(operatorBackups);await writeFile(path.join(operatorData,'accounts.json'),'OPERATOR DATA MUST REMAIN UNTOUCHED');await writeFile(path.join(operatorBackups,'keep.txt'),'PRESERVE');
  let session;
  try{
    const source={...process.env,HOST:'0.0.0.0',PORT:'3000',ORBITA_DATA_DIR:operatorData,ORBITA_PUBLIC_ORIGIN:'https://external.example',ORBITA_REQUIRE_ADMIN_MFA:'true',CLOUDPAYMENTS_PUBLIC_ID:'operator-merchant',CLOUDPAYMENTS_API_SECRET:'operator-secret',RESEND_API_KEY:'operator-mail-key',ORBITA_MAIL_FROM:'operator@example.test',TELEGRAM_BOT_TOKEN:'operator-bot',ORBITA_BACKUP_DIR:operatorBackups,ORBITA_BACKUP_PASSPHRASE:'operator-passphrase',NODE_OPTIONS:'--not-a-real-option'};
    const environment=localBetaEnvironment('/private/test-only',source);assert.equal(environment.HOST,'127.0.0.1');assert.equal(environment.PORT,'0');assert.equal(environment.ORBITA_DATA_DIR,'/private/test-only');assert.equal(environment.CLOUDPAYMENTS_API_SECRET,'');assert.equal(environment.RESEND_API_KEY,'');assert.equal(environment.ORBITA_BACKUP_DIR,'');assert.equal(environment.NODE_OPTIONS,undefined);
    session=await startLocalBeta({environment:source});assert.match(session.base,/^http:\/\/127\.0\.0\.1:\d+$/);assert.notEqual(session.directory,operatorData);assert.equal(session.accounts.length,4);
    if(process.platform!=='win32')assert.equal((await lstat(session.root)).mode&0o077,0);
    assert.ok(session.accounts.every(account=>account.password.length>=20));assert.equal(new Set(session.accounts.map(account=>account.email)).size,4);
    const admin=await login(session,'admin'),pro=await login(session,'pro'),exclusive=await login(session,'exclusive'),free=await login(session,'free');
    assert.equal(admin.user.role,'admin');assert.deepEqual(pro.user.access.activePlans,['pro']);assert.deepEqual(exclusive.user.access.activePlans,['exclusive']);assert.equal(free.user.access.hasSubscription,false);
    assert.equal((await get(session,'/api/admin/ideas',admin.cookie)).status,200);assert.equal((await get(session,'/api/admin/ideas',pro.cookie)).status,403);assert.equal((await get(session,'/api/ideas',free.cookie)).status,403);assert.equal((await get(session,'/api/ideas')).status,401);
    const proIdeas=(await get(session,'/api/ideas',pro.cookie)).data.records,exclusiveIdeas=(await get(session,'/api/ideas',exclusive.cookie)).data.records;
    assert.ok(proIdeas.length>0&&proIdeas.every(record=>record.demo===true&&record.d.strategy!=='Orbita Exclusive'));assert.ok(exclusiveIdeas.length>0&&exclusiveIdeas.every(record=>record.demo===true&&record.d.strategy==='Orbita Exclusive'));
    const config=(await get(session,'/api/public-config')).data;assert.equal(config.paymentsAvailable,false);assert.equal(config.mailEnabled,false);assert.equal(config.telegramEnabled,false);
    const settings=(await get(session,'/api/product-settings')).data;assert.equal(settings.supportEmail,'');assert.ok(settings.partnerOffers.every(offer=>offer.url===''));
    assert.equal(await readFile(path.join(operatorData,'accounts.json'),'utf8'),'OPERATOR DATA MUST REMAIN UNTOUCHED');assert.equal(await readFile(path.join(operatorBackups,'keep.txt'),'utf8'),'PRESERVE');
    const firstRoot=session.root,firstPassword=session.accounts[0].password;await session.close();await assert.rejects(lstat(firstRoot),{code:'ENOENT'});
    session=await startLocalBeta({environment:source});assert.notEqual(session.root,firstRoot);assert.notEqual(session.accounts[0].password,firstPassword);
  }finally{await session?.close();await rm(guard,{recursive:true,force:true});}
});

test('local beta rejects an already cancelled startup without making a temporary fixture',async()=>{
  const controller=new AbortController();controller.abort();await assert.rejects(startLocalBeta({signal:controller.signal}),error=>error.name==='AbortError');
});

test('cancelling preparation waits for its child and removes the incomplete fixture',async()=>{
  const prefix=`orbita-local-beta-${process.pid}-`,before=new Set((await readdir(tmpdir())).filter(name=>name.startsWith(prefix))),controller=new AbortController();
  const pending=startLocalBeta({signal:controller.signal}),timer=setTimeout(()=>controller.abort(),20);
  try{await assert.rejects(pending);}finally{clearTimeout(timer);}
  const remaining=(await readdir(tmpdir())).filter(name=>name.startsWith(prefix)&&!before.has(name));assert.deepEqual(remaining,[]);
});

test('CLI interruption stops its child and removes only its owned fixture',async()=>{
  const child=spawn(process.execPath,[script],{cwd:project,env:{PATH:process.env.PATH},stdio:['ignore','pipe','pipe']});let output='';const done=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
  try{
    await new Promise((resolve,reject)=>{let settled=false;const timer=setTimeout(()=>{if(!settled){settled=true;reject(Error('Local beta CLI did not become ready.'));}},15000);child.stdout.on('data',chunk=>{output=(output+chunk).slice(-16000);if(!settled&&output.includes('Ctrl+C остановит')){settled=true;clearTimeout(timer);resolve();}});child.stderr.on('data',()=>{});child.once('exit',()=>{if(!settled){settled=true;clearTimeout(timer);reject(Error('Local beta CLI exited before readiness.'));}});});
    assert.ok(output.includes('ЛОКАЛЬНАЯ УЧЕБНАЯ БЕТА'));const names=(await readdir(tmpdir())).filter(name=>name.startsWith(`orbita-local-beta-${child.pid}-`));assert.equal(names.length,1);const root=path.join(tmpdir(),names[0]);
    child.kill('SIGTERM');let timer;const result=await Promise.race([done,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Local beta CLI did not shut down.')),15000);})]).finally(()=>clearTimeout(timer));assert.equal(result.code,0);await assert.rejects(lstat(root),{code:'ENOENT'});
  }finally{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await done;}}
});

test('CLI accepts help only and never accepts a supplied data path',async()=>{
  const run=args=>new Promise((resolve,reject)=>{const child=spawn(process.execPath,[script,...args],{cwd:project,env:{PATH:process.env.PATH},stdio:['ignore','pipe','pipe']});let stdout='';child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',()=>{});child.once('error',reject);child.once('exit',code=>resolve({code,stdout}));});
  const help=await run(['--help']);assert.equal(help.code,0);assert.match(help.stdout,/Usage: npm run beta:local/);
  const invalid=await run(['--data-dir','/must-not-be-used']);assert.equal(invalid.code,2);assert.equal(invalid.stdout,'');
});
