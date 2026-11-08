// Explicit, isolated local beta fixtures. Production startup never imports this module.
import {randomBytes} from 'node:crypto';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createAccounts} from '../lib/accounts.mjs';
import {createIdeas} from '../lib/ideas.mjs';
import {LEGAL_VERSION} from '../lib/access.mjs';
import {createRadar} from '../lib/radar/service.mjs';

const project=fileURLToPath(new URL('../',import.meta.url));
export function localBetaEnvironment(directory,source=process.env){
  const environment={};
  for(const key of ['PATH','SystemRoot','SYSTEMROOT','WINDIR','TEMP','TMP','TMPDIR'])if(source[key]!==undefined)environment[key]=source[key];
  return {...environment,HOST:'127.0.0.1',PORT:'0',ORBITA_DATA_DIR:directory,ORBITA_PUBLIC_ORIGIN:'',ORBITA_REQUIRE_ADMIN_MFA:'false',CLOUDPAYMENTS_PUBLIC_ID:'',CLOUDPAYMENTS_API_SECRET:'',RESEND_API_KEY:'',ORBITA_MAIL_FROM:'',TELEGRAM_BOT_TOKEN:'',TELEGRAM_BOT_USERNAME:'',TELEGRAM_WEBHOOK_SECRET:'',ORBITA_BACKUP_DIR:'',ORBITA_BACKUP_PASSPHRASE:'',RADAR_ENABLED:'true',RADAR_PROVIDER_MODE:'off',RADAR_NOTIFICATIONS_ENABLED:'true'};
}

async function request(base,route,body,cookie,signal){
  signal?.throwIfAborted();const controller=new AbortController(),abort=()=>controller.abort(),timer=setTimeout(abort,10000);signal?.addEventListener('abort',abort,{once:true});
  try{
    const response=await fetch(base+route,{method:'POST',redirect:'manual',headers:{Origin:base,'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},body:JSON.stringify(body),signal:controller.signal});
    if(!response.ok)throw Error('Не удалось подготовить учебные аккаунты.');
    return {data:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};
  }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
}

export async function startLocalBeta({environment=process.env,signal,payments=false,port=0,verifyFixtureEmails=false}={}){
  if(Number(process.versions.node.split('.')[0])<22)throw Error('Для локальной беты нужен Node.js 22 или новее.');
  signal?.throwIfAborted();
  if(!Number.isInteger(port)||port<0||port>65535)throw Error('Порт должен быть целым числом от 0 до 65535.');
  const root=await mkdtemp(path.join(tmpdir(),`orbita-local-beta-${process.pid}-`)),directory=path.join(root,'data');
  let child,closed=null,childExited=false,prepared=false,resolveExit;
  const done=new Promise(resolve=>{resolveExit=resolve;});
  async function close(){
    if(closed)return closed;
    closed=(async()=>{
      if(child&&!childExited){
        child.kill('SIGTERM');let timer;
        const stopped=await Promise.race([done.then(()=>true),new Promise(resolve=>{timer=setTimeout(()=>resolve(false),12000);})]);clearTimeout(timer);
        if(!stopped){
          child.kill('SIGKILL');
          // A process stuck in an OS operation may not exit even after SIGKILL.
          // Never remove its data while it could still be using that directory.
          await Promise.race([done,new Promise(resolve=>{timer=setTimeout(resolve,3000);})]);clearTimeout(timer);
        }
      }
      if(child&&!childExited)throw Error('Учебный процесс ещё работает; временные данные сохранены.');
      await rm(root,{recursive:true,force:true});
    })();return closed;
  }
  // During preparation, finish any trusted fixture write before removing its
  // directory. Aborting HTTP requests and the child makes preparation unwind.
  const abort=()=>{if(prepared)void close().catch(()=>{});else child?.kill('SIGTERM');};signal?.addEventListener('abort',abort,{once:true});
  try{
    signal?.throwIfAborted();
    child=spawn(process.execPath,['server.mjs'],{cwd:project,env:{...localBetaEnvironment(directory,environment),PORT:String(port),...(payments?{ORBITA_PAYMENTS_MODE:'simulation'}:{})},stdio:['ignore','pipe','pipe']});
    child.once('exit',(code,exitSignal)=>{childExited=true;resolveExit({code,signal:exitSignal});});
    child.once('error',()=>{childExited=true;resolveExit({code:null,signal:'spawn-error'});});
    const base=await new Promise((resolve,reject)=>{
      let output='',diagnostic='',settled=false;
      const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',cancel);error?reject(error):resolve(value);};
      const cancel=()=>finish(Error('Подготовка учебной среды остановлена.'));
      const timer=setTimeout(()=>finish(Error('Учебный процесс не запустился вовремя.')),10000);
      signal?.addEventListener('abort',cancel,{once:true});
      child.stdout.on('data',chunk=>{output=(output+chunk.toString()).slice(-4096);const match=output.match(/ORBITA: (http:\/\/127\.0\.0\.1:\d+)/);if(match)finish(null,match[1]);});
      child.stderr.on('data',chunk=>{diagnostic=(diagnostic+chunk.toString()).slice(-4096);if(diagnostic.includes('EADDRINUSE')||diagnostic.includes('Port '+port+' is busy.'))finish(Object.assign(Error('Порт '+port+' занят. Остановите предыдущий локальный запуск или используйте npm run beta:local для свободного порта.'),{code:'LOCAL_PORT_IN_USE'}));}); // Never echo exception payloads or configuration.
      child.once('error',()=>finish(Error('Не удалось создать учебный процесс Node.js.')));
      child.once('exit',()=>finish(Error('Учебный процесс завершился до готовности.')));
      if(signal?.aborted)cancel();
    });
    const password='Beta-'+randomBytes(18).toString('base64url');
    const definitions=[['admin','Редакция','editor@local-beta.example.test'],['pro','Клиент Pro','pro@local-beta.example.test'],['exclusive','Клиент Exclusive','exclusive@local-beta.example.test'],['free','Без подписки','free@local-beta.example.test']],registered=[];
    for(const [role,label,email] of definitions){
      const registration=await request(base,'/api/register',{email,password,acceptTerms:true,acceptPrivacy:true,legalVersion:LEGAL_VERSION},null,signal);
      if(!registration.data.user?.id||!registration.cookie)throw Error('Учебный аккаунт не подготовлен.');
      registered.push({role,label,email,password,user:registration.data.user,cookie:registration.cookie});
    }
    signal?.throwIfAborted();
    const accounts=await createAccounts(directory,{publicOrigin:'',requireAdminMfa:false,mailer:{configured:false}}),owner=registered[0];
    await accounts.promote(owner.email);
    if(verifyFixtureEmails)await accounts.transact(db=>{const ids=new Set(registered.map(item=>item.user.id));for(const user of db.users)if(ids.has(user.id)){user.emailVerified=true;user.emailVerifiedAt=new Date().toISOString();}});
    for(const plan of ['pro','exclusive']){
      const member=registered.find(account=>account.role===plan);
      await request(base,'/api/admin/subscriptions',{userId:member.user.id,plan,expiresAt:new Date(Date.now()+30*86400000).toISOString(),reason:'Учебный доступ в отдельной временной базе локальной беты'},owner.cookie,signal);
    }
    signal?.throwIfAborted();
    const ideas=await createIdeas(directory);await ideas.importDemo({id:owner.user.id,role:'admin'});
    const radar=await createRadar(directory,{accounts,ideas,env:{...localBetaEnvironment(directory,environment),...(payments?{ORBITA_PAYMENTS_MODE:'simulation'}:{})}});
    try{await radar.seedDemo();}finally{await radar.close();}
    signal?.throwIfAborted();
    const fixtures=registered.map(({role,label,email,password})=>({role,label,email,password}));prepared=true;
    return {base,directory,root,accounts:fixtures,done,close:async()=>{signal?.removeEventListener('abort',abort);return close();}};
  }catch(cause){signal?.removeEventListener('abort',abort);await close();throw cause;}
}

export async function runLocalBeta(args=process.argv.slice(2)){
  if(args.includes('--help')){console.log('Usage: npm run beta:local -- [--payments] [--port=3000]\nОтдельная временная учебная база, четыре тестовых аккаунта, без реальных писем и платежей. Ctrl+C завершает процесс и удаляет только её данные.');return;}
  const portArgs=args.filter(value=>value.startsWith('--port='));
  if(args.some(value=>value!=='--payments'&&!/^--port=\d{1,5}$/.test(value))||portArgs.length>1||args.filter(value=>value==='--payments').length>1||Number(portArgs[0]?.slice(7)||0)>65535){console.error('Допустимы --payments и --port=0..65535. Используйте --help.');process.exitCode=2;return;}
  const port=Number(portArgs[0]?.slice(7)||0);
  const controller=new AbortController(),stop=()=>controller.abort();process.once('SIGINT',stop);process.once('SIGTERM',stop);
  let session;
  try{
    session=await startLocalBeta({signal:controller.signal,payments:args.includes('--payments'),port,verifyFixtureEmails:true});
    console.log('ORBITA · ЛОКАЛЬНАЯ УЧЕБНАЯ БЕТА');
    console.log('Адрес: '+session.base+'/account.html');
    console.log('Данные вымышленные. Реальные аккаунты проекта не используются. Почта, Telegram и реальные платежи отключены.');
    if(args.includes('--payments'))console.log('Включён локальный симулятор оплаты без обращения к CloudPayments.');
    console.log('ТЕСТОВЫЕ АККАУНТЫ (пароль создан заново для этого запуска):');
    for(const account of session.accounts)console.log(`${account.label}: ${account.email} | ${account.password}`);
    console.log('После входа откройте редакцию: '+session.base+'/admin.html');
    console.log('Или кабинет клиента: '+session.base+'/app.html');
    console.log('Radar с учебными событиями (Pro или редакция): '+session.base+'/radar.html');
    console.log('Email вымышленных аккаунтов отмечен подтверждённым только в этой временной базе: реальные письма не отправлялись.');
    console.log('Для одновременной проверки ролей используйте разные браузеры или отдельное приватное окно.');
    console.log('Ctrl+C остановит учебный процесс и удалит его временную базу. Следующий запуск начнётся с чистой учебной среды.');
    const result=await session.done;
    if(!controller.signal.aborted&&result.code!==0)throw Error('Учебный процесс неожиданно завершился.');
  }catch(cause){if(!controller.signal.aborted){console.error('Локальная бета не запущена. '+(cause?.code==='LOCAL_PORT_IN_USE'||cause?.message==='Для локальной беты нужен Node.js 22 или новее.'?cause.message:'Проверьте версию Node.js и доступность временного каталога.'));process.exitCode=1;}}
  finally{process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);if(session)try{await session.close();}catch{console.error('Учебный процесс не остановлен; временные данные не удалены.');process.exitCode=1;}}
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await runLocalBeta();
