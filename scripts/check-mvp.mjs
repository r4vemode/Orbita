// This rehearsal owns its temporary directory and child processes. It never opens
// the operator's configured data directory or enables an external provider.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import {createAccounts} from '../lib/accounts.mjs';
import {createBackup,verifyBackup,restoreBackup} from '../lib/backups.mjs';
import {LEGAL_VERSION} from '../lib/access.mjs';
import {createRadar} from '../lib/radar/service.mjs';

const project=fileURLToPath(new URL('../',import.meta.url));
const args=process.argv.slice(2);
if(args.length){
  if(args.length===1&&args[0]==='--help')console.log('Usage: npm run check:mvp\nRuns an isolated local account, signal, restart, load and encrypted-restore rehearsal.');
  else{console.error('Неизвестный параметр. Используйте npm run check:mvp.');process.exitCode=2;}
}else await main();

function runtimeEnvironment(directory){
  const env={};
  for(const key of ['PATH','SystemRoot','SYSTEMROOT','WINDIR','TEMP','TMP','TMPDIR'])if(process.env[key]!==undefined)env[key]=process.env[key];
  return {...env,HOST:'127.0.0.1',PORT:'0',ORBITA_DATA_DIR:directory,ORBITA_PUBLIC_ORIGIN:'',ORBITA_REQUIRE_ADMIN_MFA:'false',CLOUDPAYMENTS_PUBLIC_ID:'',CLOUDPAYMENTS_API_SECRET:'',RESEND_API_KEY:'',ORBITA_MAIL_FROM:'',TELEGRAM_BOT_TOKEN:'',TELEGRAM_BOT_USERNAME:'',TELEGRAM_WEBHOOK_SECRET:'',ORBITA_BACKUP_DIR:'',ORBITA_BACKUP_PASSPHRASE:''};
}

async function start(directory){
  const child=spawn(process.execPath,['server.mjs'],{cwd:project,env:runtimeEnvironment(directory),stdio:['ignore','pipe','pipe']});
  let settled=false,tail='';
  const exited=new Promise(resolve=>{child.once('exit',(code,signal)=>resolve({code,signal}));child.once('error',()=>resolve({code:null,signal:'spawn-error'}));});
  let stopped=false;
  async function stop(){
    if(stopped)return;stopped=true;if(child.exitCode!==null||child.signalCode)return;
    child.kill('SIGTERM');let timer;
    const graceful=await Promise.race([exited,new Promise(resolve=>{timer=setTimeout(()=>resolve(null),12000);})]);clearTimeout(timer);
    if(!graceful){child.kill('SIGKILL');await exited;throw Error('Тестовый сервер не завершился штатно.');}
    if(graceful.code!==0)throw Error('Тестовый сервер завершился с ошибкой.');
  }
  let base;
  try{base=await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{if(!settled){settled=true;child.kill('SIGTERM');reject(Error('Не удалось запустить изолированный тестовый процесс.'));}},10000);
    child.stdout.on('data',chunk=>{tail=(tail+chunk.toString()).slice(-4096);const match=tail.match(/ORBITA: (http:\/\/127\.0\.0\.1:\d+)/);if(match&&!settled){settled=true;clearTimeout(timer);resolve(match[1]);}});
    child.stderr.on('data',()=>{}); // Never echo exception payloads or configuration.
    child.once('error',()=>{if(!settled){settled=true;clearTimeout(timer);reject(Error('Не удалось создать тестовый процесс Node.js.'));}});
    child.once('exit',()=>{if(!settled){settled=true;clearTimeout(timer);reject(Error('Тестовый сервер завершился до готовности.'));}});
  });}catch(error){await stop().catch(()=>{});throw error;}
  return {base,stop};
}

async function request(server,route,{method='GET',body,cookie}={}){
  const response=await fetch(server.base+route,{method,redirect:'manual',headers:{Origin:server.base,...(body!==undefined?{'Content-Type':'application/json'}:{}),...(cookie?{Cookie:cookie}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(10000)});
  const raw=await response.text();let data;try{data=JSON.parse(raw);}catch{}
  return {status:response.status,data,text:raw,cookie:response.headers.get('set-cookie')?.split(';')[0],location:response.headers.get('location')};
}
function status(result,expected,message){if(result.status!==expected)throw Error(message);return result;}
function full(ticker,strategy='Momentum RU'){return {mode:'full',d:{ticker,name:'Учебный инструмент',dir:'ЛОНГ',market:'stocks',strategy,title:'Проверка локального MVP',summary:'Вымышленный сценарий для проверки.',entry:100,stop:95,target:110,horizon:'1–5 дней',thesis:'Учебные условия без связи с рыночными данными.',entryRule:'Подтверждение автора.',cancelRule:'Выход по стопу.'}};}

async function main(){
  let root,server,stage='подготовка';const checks=[],servers=[];
  const mark=label=>{checks.push(label);console.log('✓ '+label);};
  try{
    root=await mkdtemp(path.join(tmpdir(),'orbita-mvp-rehearsal-'));const directory=path.join(root,'data');
    server=await start(directory);servers.push(server);stage='регистрация и права';
    const password='isolated-mvp-password-2026';
    const register=async email=>status(await request(server,'/api/register',{method:'POST',body:{email,password,acceptTerms:true,acceptPrivacy:true,legalVersion:LEGAL_VERSION}}),200,'Регистрация в тестовой среде не прошла.');
    const owner=await register('rehearsal-owner@example.test'),client=await register('rehearsal-client@example.test'),other=await register('rehearsal-other@example.test');
    const accounts=await createAccounts(directory,{publicOrigin:'',requireAdminMfa:false,mailer:{configured:false}});await accounts.promote('rehearsal-owner@example.test');
    const admin=(route,body)=>request(server,route,{method:'POST',cookie:owner.cookie,body});
    const grant=plan=>admin('/api/admin/subscriptions',{userId:client.data.user.id,plan,expiresAt:new Date(Date.now()+86400000).toISOString(),reason:'Изолированная репетиция MVP'});
    status(await request(server,'/api/ideas'),401,'Гость получил доступ к идеям.');status(await request(server,'/api/ideas',{cookie:client.cookie}),403,'Бесплатный аккаунт получил доступ к идеям.');
    status(await request(server,'/api/admin/ideas',{cookie:client.cookie}),403,'Клиент получил права редакции.');
    const unavailable=await request(server,'/api/public-config');assert.equal(unavailable.data.paymentsAvailable,false);assert.equal(unavailable.data.mailEnabled,false);assert.equal(unavailable.data.telegramEnabled,false);
    mark('Регистрация, гость, бесплатный аккаунт и права редакции');

    stage='подписки и история';status(await grant('pro'),200,'Не выдан тестовый Pro.');
    const quick=status(await admin('/api/admin/ideas',{mode:'quick',d:{ticker:'MVPQUICK',dir:'ЛОНГ'}}),201,'Не опубликован быстрый сигнал.').data.record;
    const long=status(await admin('/api/admin/ideas',full('MVPFULL')),201,'Не опубликован полный сценарий.').data.record;
    const exclusive=status(await admin('/api/admin/ideas',full('MVPEXCL','Orbita Exclusive')),201,'Не опубликован сценарий Exclusive.').data.record;
    let visible=status(await request(server,'/api/ideas',{cookie:client.cookie}),200,'Не открылись идеи Pro.').data.records;
    assert.equal(visible.length,2);assert.ok(!visible.some(record=>record.id===exclusive.id));
    status(await request(server,'/api/ideas/'+exclusive.id,{cookie:client.cookie}),404,'Pro открыл Exclusive.');
    stage='настройки и материалы';
    status(await request(server,'/api/admin/settings',{cookie:client.cookie}),403,'Клиент получил настройки продукта.');
    status(await request(server,'/api/admin/content',{cookie:client.cookie}),403,'Клиент получил черновики материалов.');
    const settingsState=status(await request(server,'/api/admin/settings',{cookie:owner.cookie}),200,'Не открылись настройки продукта.').data;
    assert.ok(settingsState.settings.partnerOffers.every(offer=>offer.url===''));
    const settings={...settingsState.settings,authorName:'Редакция теста',supportEmail:''};
    status(await request(server,'/api/admin/settings',{method:'PUT',cookie:owner.cookie,body:{revision:settingsState.revision,settings}}),200,'Не сохранены настройки продукта.');
    const contentState=status(await request(server,'/api/admin/content',{cookie:owner.cookie}),200,'Не открылись материалы редакции.').data;
    const material={title:'Учебная статья репетиции',category:'Репетиция MVP',intro:'Вымышленный материал для проверки доступа и восстановления.',sections:[{title:'Проверяемый раздел',text:'Текст существует только в изолированной временной базе.'}],access:'exclusive',published:false};
    const draft=status(await admin('/api/admin/content',{revision:contentState.revision,lesson:material}),201,'Не сохранён черновик материала.').data;
    assert.ok(!(await request(server,'/api/lessons',{cookie:owner.cookie})).data.lessons.some(lesson=>lesson.id===draft.lesson.id));
    const published=status(await request(server,'/api/admin/content/'+draft.lesson.id,{method:'PUT',cookie:owner.cookie,body:{revision:draft.revision,lesson:{...material,published:true}}}),200,'Не опубликован материал.').data.lesson;
    assert.ok(!(await request(server,'/api/lessons',{cookie:client.cookie})).data.lessons.some(lesson=>lesson.id===published.id));
    status(await grant('exclusive'),200,'Не выдан тестовый Exclusive.');
    assert.ok((await request(server,'/api/lessons',{cookie:client.cookie})).data.lessons.some(lesson=>lesson.id===published.id));
    assert.equal((await request(server,'/api/product-settings')).data.authorName,'Редакция теста');
    mark('Общие настройки, пустые партнёрские ссылки, черновик и публикация статьи Exclusive');
    stage='подписки и история';
    status(await admin('/api/admin/subscriptions',{userId:client.data.user.id,plan:'pro',expiresAt:null,reason:'Проверка независимого тарифа'}),200,'Не отозван Pro.');
    visible=(await request(server,'/api/ideas',{cookie:client.cookie})).data.records;assert.deepEqual(visible.map(record=>record.id),[exclusive.id]);
    status(await grant('pro'),200,'Не восстановлен Pro.');
    const event=(id,body)=>admin('/api/admin/ideas/'+id+'/events',body);
    status(await event(quick.id,{action:'levels',d:{entry:100,stop:95,target:110,entryRule:'Учебное подтверждение.',cancelRule:'Учебный выход.'}}),200,'Не добавлены уровни.');
    status(await event(quick.id,{action:'activate',note:'Учебный вход подтверждён.'}),200,'Не подтверждён вход.');
    status(await event(quick.id,{action:'stop-change',price:101,note:'Учебный перенос стопа.'}),200,'Не перенесён стоп.');
    status(await event(quick.id,{action:'target',note:'Учебное закрытие по цели.'}),200,'Не закрыта идея.');
    const record=status(await request(server,'/api/ideas/'+quick.id,{cookie:client.cookie}),200,'Не открылась история.').data.record;
    assert.equal(record.meta.initial.entry,null);assert.equal(record.meta.initial.stop,null);assert.equal(record.meta.exit,110);assert.equal(record.meta.events.length,5);assert.equal(record.d.state,'closed');
    status(await request(server,'/api/admin/ideas/'+quick.id,{method:'DELETE',cookie:owner.cookie}),409,'Опубликованная история была удалена.');
    mark('Независимые Pro / Exclusive, быстрый сигнал, уровни, стоп и неизменяемая история');

    stage='личные сделки';const enteredAt=new Date(Date.now()-1000).toISOString(),closedAt=new Date().toISOString();
    const position={ideaId:long.id,entry:101,quantity:10,pointValue:1,enteredAt,exit:108,closedAt};
    status(await request(server,'/api/watchlist',{method:'PUT',cookie:client.cookie,body:{ids:[long.id]}}),200,'Не сохранено отслеживание.');
    status(await request(server,'/api/positions',{method:'PUT',cookie:client.cookie,body:position}),200,'Не сохранена личная сделка.');
    status(await admin('/api/admin/subscriptions',{userId:other.data.user.id,plan:'pro',expiresAt:new Date(Date.now()+86400000).toISOString(),reason:'Проверка изоляции'}),200,'Не подготовлен второй клиент.');
    assert.deepEqual((await request(server,'/api/positions',{cookie:other.cookie})).data.positions,[]);mark('Личная сделка, отслеживание и изоляция аккаунтов');

    stage='локальная нагрузка';const samples=[],total=40,workers=4;let next=0,failures=0;
    await Promise.all(Array.from({length:workers},async()=>{while(next++<total){const begin=performance.now();try{const response=await request(server,'/api/ideas',{cookie:client.cookie});if(response.status!==200||response.data.records.length!==3)failures++;}catch{failures++;}samples.push(performance.now()-begin);}}));
    if(failures)throw Error('Локальная нагрузочная репетиция обнаружила ошибки.');samples.sort((a,b)=>a-b);const percentile=fraction=>Math.round(samples[Math.min(samples.length-1,Math.ceil(samples.length*fraction)-1)]);
    mark(`Локальная нагрузка: ${total} запросов, ${workers} параллельно, ошибок 0, p50 ${percentile(.5)} мс, p95 ${percentile(.95)} мс`);

    stage='Radar';
    const radarSeeder=await createRadar(directory,{accounts,env:{}});
    try{assert.ok((await radarSeeder.seedDemo()).inserted>=15);}finally{await radarSeeder.close();}
    status(await request(server,'/api/radar'),401,'Гость открыл Radar.');
    const radarFeed=status(await request(server,'/api/radar?importance=0&limit=50',{cookie:client.cookie}),200,'Не открылась лента Radar.').data;
    assert.ok(radarFeed.events.length>=15);assert.ok(radarFeed.events.every(event=>event.isDemo&&!Object.hasOwn(event,'rawText')));
    const radarEvent=radarFeed.events.find(event=>event.ticker==='SBER');assert.ok(radarEvent);
    status(await request(server,'/api/admin/radar',{cookie:client.cookie}),403,'Клиент открыл редакцию Radar.');
    const radarDetail=status(await request(server,'/api/radar/'+radarEvent.id,{cookie:client.cookie}),200,'Не открылась карточка Radar.').data.event;
    assert.ok(radarDetail.sources.length>0);assert.ok(radarDetail.summary);assert.ok(radarDetail.marketReaction?.isDemo);
    const radarSubscriptions=status(await request(server,'/api/radar/subscriptions',{method:'POST',cookie:client.cookie,body:{companyId:radarEvent.companyId,eventType:null,minimumImportance:9,enabled:true}}),201,'Не сохранено отслеживание компании.').data.subscriptions;
    assert.equal(radarSubscriptions.length,1);assert.deepEqual((await request(server,'/api/radar/subscriptions',{cookie:other.cookie})).data.subscriptions,[]);
    mark('Radar: учебная лента, полный разбор, изоляция редакции и отслеживания компаний');

    stage='юридические документы и согласия';
    const originalOffer=status(await request(server,'/offer.html?version='+LEGAL_VERSION),200,'Не открылась исходная редакция оферты.').text;
    status(await request(server,'/api/admin/legal'),401,'Гость получил юридический черновик.');
    status(await request(server,'/api/admin/legal',{cookie:client.cookie}),403,'Клиент получил юридический черновик.');
    status(await request(server,'/api/admin/legal/preview?document=offer'),401,'Гость открыл юридический предпросмотр.');
    const legalState=status(await request(server,'/api/admin/legal',{cookie:owner.cookie}),200,'Не открылись реквизиты.').data;
    assert.equal(legalState.currentVersion,null);assert.equal(legalState.readiness.ready,false);
    // A checksum-valid, explicitly synthetic identity, used only in this temporary
    // rehearsal. These details must never become defaults for a real operator.
    const digit=(value,weights)=>String(weights.reduce((sum,weight,index)=>sum+weight*Number(value[index]),0)%11%10),prefix='9900000000',eleven=prefix+digit(prefix,[7,2,4,10,3,5,9,4,6,8]);
    const profile={ownerKind:'self-employed',ownerName:'Вымышленный исполнитель репетиции',inn:eleven+digit(eleven,[3,7,2,4,10,3,5,9,4,6,8]),ogrn:'',address:'Учебный адрес изолированной проверки',supportEmail:'support@example.test',privacyEmail:'privacy@example.test',hostingDetails:'Временная локальная среда репетиции; настоящее размещение не настроено.',processorsDetails:'Учебная проверка: внешние провайдеры не подключены, реальные данные не передаются.'};
    const savedLegal=status(await request(server,'/api/admin/legal',{method:'PUT',cookie:owner.cookie,body:{revision:legalState.revision,profile}}),200,'Не сохранён юридический черновик.').data;
    assert.equal(savedLegal.readiness.ready,true);
    const publicDraft=status(await request(server,'/api/legal'),200,'Не открылась публичная версия документов.').data;
    assert.equal(publicDraft.published,false);assert.equal(publicDraft.profile.ownerName,'');
    assert.equal((await request(server,'/offer.html')).text,originalOffer);
    const preview=status(await request(server,'/api/admin/legal/preview?document=offer',{cookie:owner.cookie}),200,'Не открылся приватный предпросмотр.').text;assert.ok(preview.includes(profile.ownerName));
    status(await admin('/api/admin/legal/publish',{revision:savedLegal.revision}),400,'Публикация разрешена без свежего подтверждения.');
    status(await admin('/api/admin/legal/publish',{revision:savedLegal.revision,password:'incorrect-rehearsal-password'}),401,'Публикация разрешена с неверным паролем.');
    assert.equal((await request(server,'/api/legal')).data.published,false);
    const publishedLegal=status(await admin('/api/admin/legal/publish',{revision:savedLegal.revision,password}),200,'Документы не опубликованы после свежего подтверждения.').data;
    const legalVersion=publishedLegal.currentVersion;assert.notEqual(legalVersion,LEGAL_VERSION);assert.equal(publishedLegal.versions.length,1);
    const publicLegal=status(await request(server,'/api/legal'),200,'Не открылась опубликованная редакция.').data;
    assert.equal(publicLegal.version,legalVersion);assert.equal(publicLegal.profile.ownerName,profile.ownerName);assert.equal(publicLegal.published,true);
    const publishedOffer=status(await request(server,'/offer.html?version='+encodeURIComponent(legalVersion)),200,'Не открылась опубликованная оферта.').text;
    assert.ok(publishedOffer.includes(profile.ownerName));assert.ok(publishedOffer.includes(legalVersion));assert.ok(!publishedOffer.includes('class="legal-placeholder"'));
    assert.equal((await request(server,'/offer.html?version='+LEGAL_VERSION)).text,originalOffer);
    assert.equal((await request(server,'/api/public-config')).data.legalVersion,legalVersion);
    const staleConsent=status(await request(server,'/api/register',{method:'POST',body:{email:'rehearsal-new-client@example.test',password,acceptTerms:true,acceptPrivacy:true,legalVersion:LEGAL_VERSION}}),409,'Принято согласие с устаревшей редакцией.');assert.equal(staleConsent.data.code,'LEGAL_VERSION_CHANGED');
    const newClient=status(await request(server,'/api/register',{method:'POST',body:{email:'rehearsal-new-client@example.test',password,acceptTerms:true,acceptPrivacy:true,legalVersion}}),200,'Не зарегистрирован клиент с актуальным согласием.');
    const consentDatabase=await accounts.readDatabase();assert.equal(consentDatabase.users.find(user=>user.id===newClient.data.user.id).consents.legalVersion,legalVersion);assert.equal(consentDatabase.users.find(user=>user.id===client.data.user.id).consents.legalVersion,LEGAL_VERSION);
    const laterDraftOwner='Следующий приватный черновик репетиции';
    status(await request(server,'/api/admin/legal',{method:'PUT',cookie:owner.cookie,body:{revision:publishedLegal.revision,profile:{...profile,ownerName:laterDraftOwner}}}),200,'Не сохранён последующий черновик.');
    assert.equal((await request(server,'/api/legal')).data.profile.ownerName,profile.ownerName);assert.equal((await request(server,'/offer.html')).text,publishedOffer);
    mark('Приватные реквизиты, свежее подтверждение публикации, архив редакций и согласия клиентов');

    stage='перезапуск';await server.stop();server=await start(directory);servers.push(server);
    assert.equal((await request(server,'/api/me',{cookie:client.cookie})).data.user.id,client.data.user.id);assert.equal((await request(server,'/api/positions',{cookie:client.cookie})).data.positions[0].entry,101);assert.deepEqual((await request(server,'/api/watchlist',{cookie:client.cookie})).data.ids,[long.id]);
    status(await request(server,'/api/ideas/'+quick.id,{cookie:client.cookie}),200,'История не пережила перезапуск.');
    assert.equal((await request(server,'/api/product-settings')).data.authorName,'Редакция теста');assert.ok((await request(server,'/api/lessons',{cookie:client.cookie})).data.lessons.some(lesson=>lesson.id===published.id));
    assert.equal((await request(server,'/api/public-config')).data.legalVersion,legalVersion);assert.equal((await request(server,'/offer.html?version='+encodeURIComponent(legalVersion))).text,publishedOffer);
    assert.equal((await request(server,'/api/radar/'+radarEvent.id,{cookie:client.cookie})).data.event.headline,radarDetail.headline);
    mark('Перезапуск сохраняет аккаунты, сессии, подписки, историю, материалы и настройки');

    stage='копия и восстановление';await server.stop();
    const passphrase='isolated rehearsal backup passphrase',backup=await createBackup({dataDir:directory,backupDir:path.join(root,'backups'),passphrase,publicDir:path.join(project,'public')});
    const verified=await verifyBackup({file:backup.file,passphrase});for(const name of ['.security-key','content.json','product-settings.json','legal.json','radar.json'])assert.ok(verified.files.some(file=>file.path===name));const restored=path.join(root,'restored');
    await restoreBackup({file:backup.file,destination:restored,passphrase,publicDir:path.join(project,'public')});
    assert.deepEqual(await readFile(path.join(directory,'.security-key')),await readFile(path.join(restored,'.security-key')));
    server=await start(restored);servers.push(server);assert.equal((await request(server,'/api/positions',{cookie:client.cookie})).data.positions[0].exit,108);assert.equal((await request(server,'/api/ideas/'+quick.id,{cookie:client.cookie})).data.record.meta.events.length,5);
    const recoveredSettings=status(await request(server,'/api/admin/settings',{cookie:owner.cookie}),200,'Настройки не восстановлены.').data.settings;
    assert.equal(recoveredSettings.authorName,'Редакция теста');assert.equal(recoveredSettings.supportEmail,'');assert.ok(recoveredSettings.partnerOffers.every(offer=>offer.url===''));
    const recoveredMaterial=(await request(server,'/api/lessons',{cookie:client.cookie})).data.lessons.find(lesson=>lesson.id===published.id);assert.equal(recoveredMaterial?.title,material.title);assert.equal(recoveredMaterial?.access,'exclusive');
    const recoveredLegal=status(await request(server,'/api/admin/legal',{cookie:owner.cookie}),200,'Юридическая история не восстановлена.').data;
    assert.equal(recoveredLegal.currentVersion,legalVersion);assert.equal(recoveredLegal.draft.ownerName,laterDraftOwner);assert.equal(recoveredLegal.versions.length,1);
    assert.equal((await request(server,'/api/legal')).data.profile.ownerName,profile.ownerName);assert.equal((await request(server,'/api/public-config')).data.legalVersion,legalVersion);
    assert.equal((await request(server,'/offer.html?version='+encodeURIComponent(legalVersion))).text,publishedOffer);assert.equal((await request(server,'/offer.html?version='+LEGAL_VERSION)).text,originalOffer);
    const recoveredAccounts=JSON.parse(await readFile(path.join(restored,'accounts.json'),'utf8'));assert.equal(recoveredAccounts.users.find(user=>user.id===newClient.data.user.id).consents.legalVersion,legalVersion);assert.equal(recoveredAccounts.users.find(user=>user.id===client.data.user.id).consents.legalVersion,LEGAL_VERSION);
    assert.equal((await request(server,'/api/radar/'+radarEvent.id,{cookie:client.cookie})).data.event.headline,radarDetail.headline);assert.equal((await request(server,'/api/radar/subscriptions',{cookie:client.cookie})).data.subscriptions[0].id,radarSubscriptions[0].id);
    status(await request(server,'/api/admin/ideas',{cookie:owner.cookie}),200,'Права редакции не восстановлены.');mark('Зашифрованная копия восстановлена в отдельную базу; приложение открыло её');
    stage='отзыв';
    for(const plan of ['pro','exclusive'])status(await request(server,'/api/admin/subscriptions',{method:'POST',cookie:owner.cookie,body:{userId:client.data.user.id,plan,expiresAt:null,reason:'Проверка отзыва после восстановления'}}),200,'Не отозван доступ после восстановления.');
    status(await request(server,'/api/ideas',{cookie:client.cookie}),403,'Отзыв не закрыл API.');status(await request(server,'/app.html',{cookie:client.cookie}),303,'Отзыв не закрыл страницу кабинета.');mark('Отзыв обоих тарифов немедленно закрывает доступ');
    console.log(`Готово: ${checks.length} групп проверок. Использованы только временные вымышленные данные. Это локальная репетиция, не проверка реальных платежей или производительности рабочего хостинга.`);
  }catch(error){console.error(`MVP-проверка не пройдена: ${stage}. ${error instanceof assert.AssertionError?'Не совпало ожидаемое состояние.':typeof error.message==='string'&&!error.message.includes('http')?error.message:'Сбой локального сценария.'}`);process.exitCode=1;}
  finally{
    for(const instance of servers.reverse())try{await instance.stop();}catch{console.error('Не удалось штатно завершить один тестовый процесс.');process.exitCode=1;}
    if(root)await rm(root,{recursive:true,force:true});
  }
}
