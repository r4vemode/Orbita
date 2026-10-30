import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdir,mkdtemp,readFile,readdir,rm,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {checkLegalPublication,checkStorage,createReadiness,inspectConfiguration} from '../lib/operations.mjs';
import {createLegal} from '../lib/legal.mjs';
import {createBackup,restoreBackup} from '../lib/backups.mjs';

const project=fileURLToPath(new URL('../',import.meta.url)),admin={id:'legal-readiness-editor',role:'admin'};
const innPrefix='990000001',inn=innPrefix+([2,4,10,3,5,9,4,6,8].reduce((sum,weight,index)=>sum+weight*Number(innPrefix[index]),0)%11%10);
const ogrnPrefix='126990000001',ogrn=ogrnPrefix+String(BigInt(ogrnPrefix)%11n%10n);
const profile=()=>({ownerKind:'company',ownerName:'Учебная редакция для проверки',inn,ogrn,address:'Учебный адрес, синтетические данные',supportEmail:'support@example.test',privacyEmail:'privacy@example.test',hostingDetails:'Учебный поставщик, тестовая страна и адрес размещения',processorsDetails:'Учебные обработчики для проверки, не рабочие подключения'});
async function fixture(t){
  const root=await mkdtemp(path.join(tmpdir(),'orbita-legal-readiness-')),directory=path.join(root,'data'),publicDir=path.join(root,'public'),backupDir=path.join(root,'backups');
  await mkdir(publicDir);t.after(()=>rm(root,{recursive:true,force:true}));return {root,directory,publicDir,backupDir};
}
const completeEnv=backupDir=>({ORBITA_PUBLIC_ORIGIN:'https://orbita.example',ORBITA_SUPPORT_EMAIL:'support@orbita.example',ORBITA_TRUSTED_PROXY_IPS:'127.0.0.1,::1',CLOUDPAYMENTS_PUBLIC_ID:'fixture-merchant',CLOUDPAYMENTS_API_SECRET:'fixture-api-secret-not-returned',CLOUDPAYMENTS_TEST_MODE:'false',ORBITA_LIVE_PAYMENTS_ENABLED:'true',ORBITA_RECEIPTS_CONFIRMED:'true',RESEND_API_KEY:'fixture-mail-secret-not-returned',ORBITA_MAIL_FROM:'mail@orbita.example',ORBITA_REQUIRE_ADMIN_MFA:'true',ORBITA_BACKUP_DIR:backupDir,ORBITA_BACKUP_PASSPHRASE:'fixture encrypted backup passphrase'});

test('live checkout and receipts declarations must be explicit and their readiness reveals no settings values',()=>{
  const names=['ORBITA_LIVE_PAYMENTS_ENABLED','ORBITA_RECEIPTS_CONFIRMED'];
  for(const name of names){
    for(const value of [undefined,'','false','0']){
      const env={...(value===undefined?{}:{[name]:value})},local=inspectConfiguration(env),production=inspectConfiguration(env,{production:true});
      assert.equal(local.checks.find(check=>check.name===name).status,'warn');assert.equal(production.checks.find(check=>check.name===name).status,'fail');
    }
    for(const value of ['true','1'])assert.equal(inspectConfiguration({[name]:value},{production:true}).checks.find(check=>check.name===name).status,'pass');
    for(const value of ['TRUE','yes',' true ',true,1])assert.equal(inspectConfiguration({[name]:value}).checks.find(check=>check.name===name).status,'fail');
  }
  const env=completeEnv('/private/fixture-backups'),report=inspectConfiguration(env,{production:true});assert.equal(report.ok,true);
  assert.equal(report.checks.find(check=>check.name==='ORBITA_RECEIPTS_CONFIRMED').reason,'receipts_operator_confirmed');
  for(const secret of [env.CLOUDPAYMENTS_API_SECRET,env.RESEND_API_KEY,env.ORBITA_BACKUP_PASSPHRASE,env.ORBITA_BACKUP_DIR])assert.ok(!JSON.stringify(report).includes(secret));
});

test('legal diagnostics do not create stores or expose drafts and require an actual publication for launch',async t=>{
  const f=await fixture(t);assert.deepEqual(await checkLegalPublication(f.directory),{ok:false,reason:'legal_missing'});assert.ok(!(await readdir(f.root)).includes('data'));
  const legal=await createLegal(f.directory);t.after(()=>legal.close());let draft=await legal.saveDraft(admin,{revision:0,profile:profile()});
  assert.deepEqual(await checkLegalPublication(f.directory),{ok:false,reason:'legal_unpublished'});
  const readiness=createReadiness({...f,env:completeEnv(f.backupDir)}),before=await readiness.adminReport();assert.equal(before.ready,true);assert.equal(before.launchReady,false);
  assert.deepEqual(before.configuration.find(check=>check.name==='LEGAL_DOCUMENTS'),{name:'LEGAL_DOCUMENTS',status:'fail',reason:'legal_unpublished'});assert.ok(!JSON.stringify(before).includes(profile().ownerName));
  draft=await legal.publish(admin,{revision:draft.revision});assert.ok(draft.currentVersion);assert.deepEqual(await checkLegalPublication(f.directory),{ok:true,reason:'legal_published'});
  const after=await readiness.adminReport();assert.equal(after.launchReady,true);assert.equal(after.configuration.find(check=>check.name==='LEGAL_DOCUMENTS').status,'pass');assert.ok(!JSON.stringify(after).includes(profile().address));
});

test('invalid, tampered and symbolic legal stores fail readiness without publishing or exposing contents',async t=>{
  const f=await fixture(t);await mkdir(f.directory);const file=path.join(f.directory,'legal.json');
  await writeFile(file,'{"private":"must-not-appear"');assert.deepEqual(await checkLegalPublication(f.directory),{ok:false,reason:'legal_invalid'});
  const storage=await checkStorage({...f,write:false});assert.equal(storage.ok,false);assert.equal(storage.code,'DATA_INVALID');assert.equal(storage.store,'legal.json');assert.ok(!JSON.stringify(storage).includes('must-not-appear'));
  await rm(file);const legal=await createLegal(f.directory);t.after(()=>legal.close());const draft=await legal.saveDraft(admin,{revision:0,profile:profile()});await legal.publish(admin,{revision:draft.revision});
  const db=JSON.parse(await readFile(file,'utf8'));db.versions[0].pages.offer+='tampered';await writeFile(file,JSON.stringify(db));assert.equal((await checkLegalPublication(f.directory)).reason,'legal_invalid');
  await rm(file);const target=path.join(f.root,'outside-legal.json');await writeFile(target,'sensitive content');await symlink(target,file);assert.equal((await checkLegalPublication(f.directory)).reason,'legal_invalid');
});

test('encrypted copies preserve published legal snapshots and restored publication readiness',async t=>{
  const f=await fixture(t),legal=await createLegal(f.directory);t.after(()=>legal.close());const draft=await legal.saveDraft(admin,{revision:0,profile:profile()}),published=await legal.publish(admin,{revision:draft.revision});
  const original=await legal.renderPage('offer',{version:published.currentVersion}),passphrase='legal restore fixture passphrase';
  const backup=await createBackup({dataDir:f.directory,backupDir:f.backupDir,publicDir:f.publicDir,passphrase});assert.ok(backup.files.some(file=>file.path==='legal.json'));
  const destination=path.join(f.root,'restored');await restoreBackup({file:backup.file,destination,publicDir:f.publicDir,passphrase});assert.deepEqual(await checkLegalPublication(destination),{ok:true,reason:'legal_published'});
  const restored=await createLegal(destination);t.after(()=>restored.close());assert.equal(await restored.renderPage('offer',{version:published.currentVersion}),original);assert.equal((await checkStorage({directory:destination,publicDir:f.publicDir,write:false})).ok,true);
});

test('a first legal write lock blocks snapshots even before the legal file exists',async t=>{
  const f=await fixture(t);await mkdir(f.directory);const lock=path.join(f.directory,'legal.json.lock');await mkdir(lock);await writeFile(path.join(lock,'owner.json'),JSON.stringify({pid:process.pid}));
  await assert.rejects(createBackup({dataDir:f.directory,backupDir:f.backupDir,publicDir:f.publicDir,passphrase:'legal backup lock fixture passphrase',lockTimeoutMs:40}),/снимок|база занята/);
  assert.deepEqual((await readdir(f.directory)).filter(name=>name.endsWith('.lock')),['legal.json.lock']);
});

test('production preflight refuses draft-only documents and keeps diagnostics free of profile data',async t=>{
  const f=await fixture(t),legal=await createLegal(f.directory);t.after(()=>legal.close());await legal.saveDraft(admin,{revision:0,profile:profile()});
  const child=spawn(process.execPath,['scripts/preflight.mjs','--production'],{cwd:project,env:{PATH:process.env.PATH,...completeEnv(f.backupDir),ORBITA_DATA_DIR:f.directory},stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);
  const code=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{child.kill();reject(Error('Preflight timeout'));},10000);child.once('error',reject);child.once('exit',code=>{clearTimeout(timer);resolve(code);});});assert.equal(code,1);assert.match(output,/LEGAL_DOCUMENTS: есть только черновик/);assert.ok(!output.includes(profile().ownerName));assert.ok(!output.includes(profile().address));assert.ok(!output.includes('fixture-api-secret-not-returned'));
});
