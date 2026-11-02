// Optional release rehearsal: its Docker resources are unique, labelled and
// removed afterwards. No working database, .env or public port is used.
import {spawn} from 'node:child_process';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdir,writeFile,rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const project=fileURLToPath(new URL('../',import.meta.url));
const LABEL='org.orbita.release-check';
const origin='https://container-check.example.test';
const envNames=['PATH','SystemRoot','SYSTEMROOT','WINDIR','TEMP','TMP','TMPDIR','DOCKER_HOST','DOCKER_CONTEXT','DOCKER_TLS_VERIFY','DOCKER_CERT_PATH','DOCKER_CONFIG'];
const environment=()=>Object.fromEntries(envNames.filter(name=>process.env[name]!==undefined).map(name=>[name,process.env[name]]));
const fail=code=>Object.assign(Error(code),{code});

async function run(args=process.argv.slice(2)){
 if(args.length){
  if(args.length===1&&args[0]==='--help'){
   console.log('node scripts/check-container.mjs\nПроверяет текущий Dockerfile на локальном Docker Engine: закрытый контейнер, новая временная база, HTTPS-режим/MFA, копия, восстановление и перезапуск. Публичные порты и провайдеры выключены. Нужен локальный Docker; удалённый Docker context запрещён. Каждая команда ограничена 30 секундами: для холодного скачивания базового образа сначала выполните docker build по инструкции deploy/README.md. Отчёт: qa-artifacts/container-*/report.json.');
   return;
  }
  console.error('Допустим только параметр --help.');process.exitCode=2;return;
 }
 const id=randomUUID(),suffix=id.replaceAll('-',''),prefix='orbita-release-check-'+suffix;
 const image='orbita-release-check:'+suffix,container=prefix+'-app',initializer=prefix+'-init',data=prefix+'-data',backups=prefix+'-backups';
 const phrase=randomBytes(48).toString('base64url'),baseEnv=environment(),secretEnv={...baseEnv,ORBITA_BACKUP_PASSPHRASE:phrase};
 const report={id,startedAt:new Date().toISOString(),status:'running',synthetic:true,checks:[],cleanup:[],resources:{container,initializer,data,backups,image},pending:['Выбранный VPS, DNS и публичный TLS-сертификат','Реальные письма, платежи и биржевые источники']};
 const outputDir=path.join(project,'qa-artifacts','container-'+report.startedAt.replace(/[:.]/g,'-')+'-'+suffix.slice(0,8));
 await mkdir(outputDir,{recursive:true});
 const buildState=path.join(outputDir,'buildx');await mkdir(buildState,{mode:0o700});baseEnv.BUILDX_CONFIG=buildState;secretEnv.BUILDX_CONFIG=buildState;
 await writeFile(path.join(outputDir,'report.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
 let stage='docker',interrupted=false,resourcesMayExist=false;const children=new Set();
 const abort=()=>{interrupted=true;for(const child of children)child.kill('SIGTERM');};
 process.once('SIGINT',abort);process.once('SIGTERM',abort);
 async function docker(argv,{input='',env=baseEnv,cleanup=false,timeoutMs=30000}={}){
  if(interrupted&&!cleanup)throw fail('INTERRUPTED');
  return new Promise((resolve,reject)=>{
   let bytes=0,stdout='',done=false,timer;
   const child=spawn('docker',argv,{cwd:project,env,stdio:['pipe','pipe','pipe']});children.add(child);
   function finish(cause,code){if(done)return;done=true;clearTimeout(timer);children.delete(child);if(cause)reject(cause);else resolve({code,stdout});}
   timer=setTimeout(()=>{child.kill('SIGKILL');finish(fail('DOCKER_COMMAND_TIMEOUT'));},Math.min(30000,timeoutMs));
   child.stdout.on('data',chunk=>{bytes+=chunk.length;if(bytes>1048576){child.kill('SIGKILL');finish(fail('DOCKER_OUTPUT_LIMIT'));}else stdout+=chunk.toString();});
   // Raw provider/configuration output never enters the report or terminal.
   child.stderr.on('data',()=>{});child.once('error',()=>finish(fail('DOCKER_UNAVAILABLE')));
   child.once('close',code=>finish(null,code));child.stdin.on('error',()=>{});child.stdin.end(input);
  });
 }
 async function must(argv,options){const result=await docker(argv,options);if(result.code!==0)throw fail(interrupted?'INTERRUPTED':'DOCKER_COMMAND_FAILED');return result.stdout;}
 async function check(title,work){const started=Date.now();try{const value=await work();report.checks.push({title,status:'passed',durationMs:Date.now()-started});console.log('✓ '+title);return value;}catch(cause){report.checks.push({title,status:'failed',durationMs:Date.now()-started});throw cause;}}
 async function ownership(kind,name){
  const format=kind==='image'?'{{index .Config.Labels "'+LABEL+'"}}':kind==='container'?'{{index .Config.Labels "'+LABEL+'"}}':'{{index .Labels "'+LABEL+'"}}';
  const value=await docker([kind,'inspect','--format',format,name],{cleanup:true,timeoutMs:10000});if(value.code===0)return value.stdout.trim()===id?'own':'foreign';
  const engine=await docker(['version','--format','{{.Server.Version}}'],{cleanup:true,timeoutMs:10000});return engine.code===0?'absent':'unknown';
 }
 async function remove(kind,name){
  try{const owner=await ownership(kind,name);if(owner==='absent'){report.cleanup.push({kind,removed:true,alreadyAbsent:true});return;}if(owner!=='own'){report.cleanup.push({kind,removed:false,reason:owner});return;}const command=kind==='container'?['container','rm','--force',name]:kind==='volume'?['volume','rm',name]:['image','rm',name];const result=await docker(command,{cleanup:true,timeoutMs:15000});report.cleanup.push({kind,removed:result.code===0});}
  catch{report.cleanup.push({kind,removed:false});}
 }
 const mounts=['--mount','type=volume,src='+data+',dst=/var/lib/orbita','--mount','type=volume,src='+backups+',dst=/var/backups/orbita'];
 try{
  await check('Локальный Docker доступен; удалённый контекст не используется',async()=>{
   let endpoint;
   if(process.env.DOCKER_CONTEXT)endpoint=JSON.parse(await must(['context','inspect',process.env.DOCKER_CONTEXT,'--format','{{json .Endpoints.docker.Host}}']));
   else if(process.env.DOCKER_HOST)endpoint=process.env.DOCKER_HOST;
   else endpoint=JSON.parse(await must(['context','inspect','--format','{{json .Endpoints.docker.Host}}']));
   if(typeof endpoint!=='string'||!endpoint.startsWith('unix://')&&!endpoint.startsWith('npipe://'))throw fail('REMOTE_DOCKER_REJECTED');
   await must(['version','--format','{{.Server.Version}}']);
  });
  resourcesMayExist=true;stage='build';await check('Текущий рабочий образ собран без приватной базы и локального установщика',async()=>{
   await must(['build','--quiet','--label',LABEL+'='+id,'--tag',image,'.']);
   for(const volume of [data,backups])await must(['volume','create','--label',LABEL+'='+id,volume]);
   await must(['run','--rm','--interactive','--name',initializer,'--label',LABEL+'='+id,'--network','none','--read-only','--cap-drop','ALL','--cap-add','CHOWN','--security-opt','no-new-privileges:true','--user','0:0',...mounts,'--entrypoint','node',image,'--input-type=module','-'],{input:"import {chmod,chown} from 'node:fs/promises';for(const dir of ['/var/lib/orbita','/var/backups/orbita']){await chmod(dir,0o700);await chown(dir,1000,1000);}"});
  });
  stage='startup';await check('Контейнер запущен без root, сети и опубликованных портов, код доступен только для чтения',async()=>{
   const values={NODE_ENV:'production',NODE_OPTIONS:'--max-old-space-size=1024',HOST:'0.0.0.0',PORT:'3000',ORBITA_DATA_DIR:'/var/lib/orbita',ORBITA_BACKUP_DIR:'/var/backups/orbita',ORBITA_BACKUP_KEEP:'2',ORBITA_PUBLIC_ORIGIN:origin,ORBITA_REQUIRE_ADMIN_MFA:'true',ORBITA_TRUSTED_PROXY_IPS:'127.0.0.1',ORBITA_LIVE_PAYMENTS_ENABLED:'false',ORBITA_RECEIPTS_CONFIRMED:'false',RADAR_PROVIDER_MODE:'off',MOEX_POSITIONS_MODE:'off',RADAR_AI_ENABLED:'false',RADAR_NOTIFICATIONS_ENABLED:'false'};
   const flags=Object.entries(values).flatMap(([key,value])=>['--env',key+'='+value]);
   await must(['create','--name',container,'--label',LABEL+'='+id,'--init','--network','none','--read-only','--tmpfs','/tmp:rw,noexec,nosuid,nodev,size=64m,mode=1777','--cap-drop','ALL','--security-opt','no-new-privileges:true','--memory','1536m','--cpus','1.5','--pids-limit','128','--stop-timeout','20',...mounts,...flags,'--env','ORBITA_BACKUP_PASSPHRASE',image],{env:secretEnv});
   await must(['start',container]);
   const result=JSON.parse(await must(['container','inspect','--format','{{json .HostConfig}}',container]));
   if(result.ReadonlyRootfs!==true||result.NetworkMode!=='none'||Object.keys(result.PortBindings||{}).length||result.Privileged||!(result.CapDrop||[]).includes('ALL'))throw fail('UNSAFE_CONTAINER_CONFIGURATION');
  });
  stage='application';await check('Регистрация, Secure cookie, «Моя Орбита», MFA и копия с восстановлением работают в образе',async()=>{
   const result=await must(['exec','--interactive',container,'node','--input-type=module','-'],{input:initialProbe});
   const value=JSON.parse(result);if(value.checked!==true)throw fail('INVALID_APPLICATION_PROBE');report.nodeVersion=value.nodeVersion;
  });
  stage='shutdown';await check('SIGTERM завершает приложение штатно',async()=>{await must(['stop','--time','15',container]);if((await must(['inspect','--format','{{.State.ExitCode}}',container])).trim()!=='0')throw fail('UNCLEAN_SHUTDOWN');});
  stage='restart';await check('Перезапуск сохраняет аккаунт, сессию и приватный ключ',async()=>{await must(['start',container]);const result=JSON.parse(await must(['exec','--interactive',container,'node','--input-type=module','-'],{input:restartProbe}));if(result.checked!==true)throw fail('INVALID_RESTART_PROBE');await must(['stop','--time','15',container]);if((await must(['inspect','--format','{{.State.ExitCode}}',container])).trim()!=='0')throw fail('UNCLEAN_SHUTDOWN');});
  report.status='passed';
 }catch(cause){report.status=interrupted?'interrupted':'failed';report.stage=stage;report.code=/^[A-Z_]+$/.test(cause?.code||'')?cause.code:'CONTAINER_CHECK_FAILED';console.error('Проверка контейнера не завершена: '+stage+' ('+report.code+'). Рабочие данные не использовались.');}
 finally{
  if(resourcesMayExist){await remove('container',initializer);await remove('container',container);await remove('volume',data);await remove('volume',backups);await remove('image',image);}
  if(report.cleanup.some(item=>!item.removed)){report.status='failed';report.code='CLEANUP_INCOMPLETE';console.error('Не все собственные тестовые ресурсы удалены. Имена находятся в отчёте запуска; глобальную очистку Docker не выполняйте.');report.resources={container,initializer,data,backups,image};}
  report.finishedAt=new Date().toISOString();await writeFile(path.join(outputDir,'report.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
  await rm(buildState,{recursive:true,force:true});
  process.removeListener('SIGINT',abort);process.removeListener('SIGTERM',abort);
  console.log('Отчёт: '+path.relative(project,path.join(outputDir,'report.json')));
  if(report.status!=='passed')process.exitCode=interrupted?130:1;
 }
 return report;
}

const probePrelude=String.raw`
import assert from 'node:assert/strict';
import {readFile,writeFile,stat,access,rm} from 'node:fs/promises';
import {createHash,randomBytes} from 'node:crypto';
const origin='https://container-check.example.test',base='http://127.0.0.1:3000';
const stateFile='/var/lib/orbita/.orbita-readiness-container-check.json';
const sha=value=>createHash('sha256').update(value).digest('hex');
const request=(route,{method='GET',body,cookie}={})=>fetch(base+route,{method,redirect:'manual',headers:{Host:'container-check.example.test',Origin:origin,...(body?{'Content-Type':'application/json'}:{}),...(cookie?{Cookie:cookie}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(2500)});
async function waitReady(){for(let attempt=0;attempt<80;attempt++){try{if((await request('/readyz')).status===200)return;}catch{}await new Promise(resolve=>setTimeout(resolve,100));}throw Error('not-ready');}
let stage='readiness';
`;
const initialProbe=probePrelude+String.raw`
try{
 await waitReady();assert.equal(process.getuid(),1000);assert.equal((await request('/healthz')).status,200);
 const config=await(await request('/api/public-config')).json();assert.equal(config.paymentsAvailable,false);assert.equal(config.mailEnabled,false);assert.equal(config.telegramEnabled,false);
 stage='image';for(const name of ['/app/.env','/app/.git','/app/admin-download','/app/node_modules'])await assert.rejects(access(name),cause=>cause.code==='ENOENT');
 await assert.rejects(writeFile('/app/.container-check-write','blocked'),cause=>cause.code==='EROFS');
 stage='registration';const email='container-owner@example.test',password='Fixture-'+randomBytes(24).toString('base64url');
 const registered=await request('/api/register',{method:'POST',body:{email,password,acceptTerms:true,acceptPrivacy:true,legalVersion:config.legalVersion}});assert.equal(registered.status,200);const header=registered.headers.get('set-cookie');assert.match(header,/; Secure/i);assert.match(header,/HttpOnly/i);const cookie=header.split(';')[0],user=(await registered.json()).user;
 stage='dashboard';assert.equal((await request('/api/dashboard')).status,401);const response=await request('/api/dashboard',{cookie});assert.equal(response.status,200);const dashboard=await response.json();assert.equal(dashboard.user.id,user.id);assert.deepEqual(dashboard.positions.items,[]);assert.deepEqual(dashboard.updates.items,[]);assert.deepEqual(dashboard.support.items,[]);assert.deepEqual(dashboard.reminders,[]);assert.equal(dashboard.radar.available,false);assert.equal((await request('/dashboard.html',{cookie})).status,200);assert.equal((await request('/assets/dashboard.js',{cookie})).status,200);assert.equal((await request('/api/ideas',{cookie})).status,403);
 stage='mfa';const {execFile}=await import('node:child_process'),{promisify}=await import('node:util');await promisify(execFile)(process.execPath,['scripts/manage-access.mjs','admin',email],{timeout:10000,maxBuffer:65536});
 const me=await(await request('/api/me',{cookie})).json();assert.equal(me.user.security.adminEnrollmentRequired,true);assert.equal(me.user.access.isAdmin,false);assert.equal((await request('/api/admin/support',{cookie})).status,403);assert.equal((await request('/admin.html',{cookie})).status,303);
 stage='storage';const key=await readFile('/var/lib/orbita/.security-key');assert.equal(key.length,32);assert.equal((await stat('/var/lib/orbita')).mode&0o777,0o700);assert.equal((await stat('/var/lib/orbita/.security-key')).mode&0o777,0o600);
 stage='backup';const {createBackup,verifyBackup,restoreBackup}=await import('./lib/backups.mjs'),passphrase=process.env.ORBITA_BACKUP_PASSPHRASE;
 const copied=await createBackup({dataDir:'/var/lib/orbita',backupDir:'/var/backups/orbita',passphrase,publicDir:'/app/public'}),verified=await verifyBackup({file:copied.file,passphrase});for(const name of ['accounts.json','.security-key'])assert.ok(verified.files.some(file=>file.path===name));
 const restored='/var/backups/orbita/restored-fixture';await restoreBackup({file:copied.file,destination:restored,passphrase,publicDir:'/app/public'});assert.equal(sha(await readFile(restored+'/.security-key')),sha(key));const db=JSON.parse(await readFile(restored+'/accounts.json','utf8'));assert.equal(db.users.find(item=>item.id===user.id).role,'admin');await rm(restored,{recursive:true});
 await writeFile(stateFile,JSON.stringify({userId:user.id,cookie,keyHash:sha(key)}),{mode:0o600});
 process.stdout.write(JSON.stringify({checked:true,nodeVersion:process.version}));
}catch{process.stderr.write('Isolated application probe failed: '+stage+'\n');process.exitCode=1;}
`;
const restartProbe=probePrelude+String.raw`
try{
 await waitReady();const saved=JSON.parse(await readFile(stateFile,'utf8')),key=await readFile('/var/lib/orbita/.security-key');assert.equal(sha(key),saved.keyHash);const me=await(await request('/api/me',{cookie:saved.cookie})).json();assert.equal(me.user.id,saved.userId);assert.equal(me.user.security.adminEnrollmentRequired,true);assert.equal(me.user.access.isAdmin,false);assert.equal((await request('/readyz')).status,200);await rm(stateFile);process.stdout.write(JSON.stringify({checked:true}));
}catch{process.stderr.write('Isolated restart probe failed.\n');process.exitCode=1;}
`;

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))try{await run();}catch{console.error('Не удалось подготовить изолированную проверку Docker. Проверьте доступ к каталогу qa-artifacts и локальному Docker Engine.');process.exitCode=1;}
