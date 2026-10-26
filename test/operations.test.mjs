import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {chmod,mkdtemp,mkdir,readdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {LEGAL_VERSION} from '../lib/access.mjs';
import {checkStorage,inspectConfiguration} from '../lib/operations.mjs';

const project=fileURLToPath(new URL('../',import.meta.url));
async function temporary(t,prefix='orbita-operations-'){
  const root=await mkdtemp(path.join(tmpdir(),prefix)),publicDir=path.join(root,'public'),directory=path.join(root,'data');
  await mkdir(publicDir);t.after(()=>rm(root,{recursive:true,force:true}));return {root,publicDir,directory};
}

test('storage probe validates known stores and removes its canary',async t=>{
  const {publicDir,directory}=await temporary(t);
  const fresh=await checkStorage({directory,publicDir});assert.equal(fresh.ok,true);
  assert.deepEqual((await readdir(directory)).filter(name=>name.startsWith('.orbita-readiness-')),[]);
  await writeFile(path.join(directory,'ideas.json'),'{"private":"do-not-log"');
  const corrupt=await checkStorage({directory,publicDir});assert.equal(corrupt.ok,false);assert.equal(corrupt.code,'DATA_INVALID');assert.equal(corrupt.store,'ideas.json');
  await writeFile(path.join(directory,'ideas.json'),JSON.stringify({version:1,revision:0,records:[]}));
  assert.equal((await checkStorage({directory,publicDir})).ok,true);
  if(process.platform!=='win32'){await chmod(directory,0o755);assert.equal((await checkStorage({directory,publicDir,requirePrivate:true})).code,'DATA_DIR_PERMISSIONS');await chmod(directory,0o700);}
});

test('production preflight reports missing groups without exposing values',async t=>{
  const {root,publicDir,directory}=await temporary(t),backupDir=path.join(root,'backups');
  const secret='cloud-secret-must-never-appear',env={
    ORBITA_PUBLIC_ORIGIN:'https://orbita.example',ORBITA_SUPPORT_EMAIL:'support@orbita.example',
    CLOUDPAYMENTS_PUBLIC_ID:'public-id',CLOUDPAYMENTS_API_SECRET:secret,CLOUDPAYMENTS_TEST_MODE:'false',
    RESEND_API_KEY:'resend-secret',ORBITA_MAIL_FROM:'ORBITA <mail@orbita.example>',ORBITA_REQUIRE_ADMIN_MFA:'true',
    ORBITA_BACKUP_DIR:backupDir,ORBITA_BACKUP_PASSPHRASE:'a-long-backup-passphrase'
  };
  const ready=inspectConfiguration(env,{production:true,directory,publicDir,nodeVersion:'20.19.0'});
  assert.equal(ready.ok,true);assert.equal(ready.checks.find(check=>check.name==='TELEGRAM').status,'warn');assert.ok(!JSON.stringify(ready).includes(secret));
  const partial=inspectConfiguration({CLOUDPAYMENTS_PUBLIC_ID:'only-half'},{production:false,directory,publicDir,nodeVersion:'20.19.0'});
  assert.equal(partial.ok,false);assert.equal(partial.checks.find(check=>check.name==='CLOUDPAYMENTS').reason,'partial_configuration');
});

async function startServer(t,directory){
  const child=spawn(process.execPath,['server.mjs'],{cwd:project,env:{...process.env,HOST:'127.0.0.1',PORT:'0',ORBITA_DATA_DIR:directory,ORBITA_PUBLIC_ORIGIN:'',ORBITA_REQUIRE_ADMIN_MFA:'false',CLOUDPAYMENTS_PUBLIC_ID:'',CLOUDPAYMENTS_API_SECRET:'',RESEND_API_KEY:'',ORBITA_MAIL_FROM:'',TELEGRAM_BOT_TOKEN:'',TELEGRAM_BOT_USERNAME:'',TELEGRAM_WEBHOOK_SECRET:'',ORBITA_BACKUP_DIR:'',ORBITA_BACKUP_PASSPHRASE:''},stdio:['ignore','pipe','pipe']});
  let output='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);
  const base=await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error('Server did not start. '+output)),10000);child.stdout.on('data',()=>{const match=output.match(/ORBITA: (http:\/\/127\.0\.0\.1:\d+)/);if(match){clearTimeout(timeout);resolve(match[1]);}});child.on('exit',code=>{clearTimeout(timeout);reject(Error(`Server exited ${code}. ${output}`));});});
  t.after(()=>{if(!child.killed)child.kill('SIGTERM');});return {child,base,output:()=>output};
}

test('health and readiness probes detect storage damage; admin diagnostics stay protected',async t=>{
  const {directory}=await temporary(t),server=await startServer(t,directory);
  let response=await fetch(server.base+'/healthz');assert.equal(response.status,200);assert.deepEqual(await response.json(),{status:'ok'});
  response=await fetch(server.base+'/readyz',{method:'HEAD'});assert.equal(response.status,200);assert.equal(await response.text(),'');
  response=await fetch(server.base+'/readyz',{method:'POST'});assert.equal(response.status,405);
  response=await fetch(server.base+'/api/admin/readiness');assert.equal(response.status,401);

  const registration=await fetch(server.base+'/api/register',{method:'POST',headers:{Origin:server.base,'Content-Type':'application/json'},body:JSON.stringify({email:'operator@example.test',password:'test-password-long-2026',acceptTerms:true,acceptPrivacy:true,legalVersion:LEGAL_VERSION})});
  assert.equal(registration.status,200);const cookie=registration.headers.get('set-cookie').split(';')[0];
  const promotion=spawn(process.execPath,['scripts/manage-access.mjs','admin','operator@example.test'],{cwd:project,env:{...process.env,ORBITA_DATA_DIR:directory},stdio:['ignore','pipe','pipe']});
  let promotionOutput='';promotion.stdout.on('data',chunk=>promotionOutput+=chunk);promotion.stderr.on('data',chunk=>promotionOutput+=chunk);const promotionCode=await new Promise(resolve=>promotion.on('exit',resolve));assert.equal(promotionCode,0,promotionOutput);
  response=await fetch(server.base+'/api/admin/readiness',{headers:{Cookie:cookie}});assert.equal(response.status,200);const report=await response.json();assert.equal(report.ready,true);assert.equal(report.launchReady,false);assert.ok(report.configuration.every(item=>!Object.hasOwn(item,'value')));

  await writeFile(path.join(directory,'ideas.json'),'{broken');response=await fetch(server.base+'/readyz');assert.equal(response.status,200,'public readiness uses the short cache');
  response=await fetch(server.base+'/api/admin/readiness',{headers:{Cookie:cookie}});assert.equal(response.status,200);assert.equal((await response.json()).ready,false);
  response=await fetch(server.base+'/readyz');assert.equal(response.status,503);assert.deepEqual(await response.json(),{status:'not_ready'});
  await rm(path.join(directory,'ideas.json'));response=await fetch(server.base+'/api/admin/readiness',{headers:{Cookie:cookie}});assert.equal((await response.json()).ready,true);response=await fetch(server.base+'/readyz');assert.equal(response.status,200);
  server.child.kill('SIGTERM');const exitCode=await new Promise(resolve=>server.child.once('exit',resolve));assert.equal(exitCode,0,server.output());
});

test('server refuses a corrupt database before accepting traffic',async t=>{
  const {directory}=await temporary(t);await mkdir(directory);await writeFile(path.join(directory,'ideas.json'),'{"secret":"not printed"');
  const child=spawn(process.execPath,['server.mjs'],{cwd:project,env:{...process.env,HOST:'127.0.0.1',PORT:'0',ORBITA_DATA_DIR:directory},stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);
  const code=await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>{child.kill();reject(Error('Corrupt startup did not stop.'));},10000);child.on('exit',value=>{clearTimeout(timeout);resolve(value);});});
  assert.notEqual(code,0);assert.match(output,/DATA_INVALID \(ideas\.json\)/);assert.doesNotMatch(output,/not printed/);
});
