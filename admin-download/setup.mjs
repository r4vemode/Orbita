import {createDecipheriv,randomUUID} from 'node:crypto';
import {lstat,mkdir,readFile,realpath,rename,writeFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {createAccounts} from '../lib/accounts.mjs';

const project=fileURLToPath(new URL('../',import.meta.url));
const profileName='.local-admin-profile.json';
const accountMarker='LOCAL_ADMIN_DIRECT_ENTRY';
function localOnly(env){
  if(env.NODE_ENV==='production'||env.ORBITA_PUBLIC_ORIGIN||env.HOST&&!['localhost','127.0.0.1','::1'].includes(env.HOST))throw Error('Этот запуск предназначен только для локальной версии без публичного адреса.');
}
export function decodeConfig(envelope,key){
  try{
    if(typeof key!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(key)||!envelope||envelope.version!==1||typeof envelope.iv!=='string'||typeof envelope.tag!=='string'||typeof envelope.data!=='string'||envelope.data.length>8192)throw Error();
    const bytes=Buffer.from(key,'base64url'),iv=Buffer.from(envelope.iv,'base64'),tag=Buffer.from(envelope.tag,'base64');if(bytes.length!==32||iv.length!==12||tag.length!==16)throw Error();
    const decipher=createDecipheriv('aes-256-gcm',bytes,iv);decipher.setAAD(Buffer.from('ORBITA-LOCAL-ADMIN-v1'));decipher.setAuthTag(tag);
    const config=JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.data,'base64')),decipher.final()]).toString('utf8'));
    if(!config||Object.keys(config).sort().join(',')!=='bundleId,email,hash,salt,version'||config.version!==1||typeof config.email!=='string'||config.email.length>254||!/^\S+@\S+\.\S+$/.test(config.email)||typeof config.salt!=='string'||typeof config.hash!=='string'||typeof config.bundleId!=='string'||!/^[a-f0-9]{32}$/.test(config.salt)||!/^[a-f0-9]{128}$/.test(config.hash)||!/^[a-f0-9-]{36}$/.test(config.bundleId))throw Error();
    return config;
  }catch{throw Error('Не удалось открыть настройку. Вставьте ключ из чата целиком.');}
}
async function localDirectory(root){
  const actual=await realpath(root),directory=path.join(actual,'data');
  try{const info=await lstat(directory);if(info.isSymbolicLink()||!info.isDirectory())throw Error('Папка data должна быть обычной локальной папкой.');}catch(cause){if(cause.code!=='ENOENT')throw cause;}
  await mkdir(directory,{recursive:true,mode:0o700});
  for(const name of ['accounts.json','.security-key',profileName])try{const info=await lstat(path.join(directory,name));if(!info.isFile()||info.isSymbolicLink())throw Error('Локальная база содержит неподдерживаемую ссылку.');}catch(cause){if(cause.code!=='ENOENT')throw cause;}
  return directory;
}
async function patchLocalLogin(root,directory){
  const assets=path.join(root,'public/assets'),file=path.join(assets,'account.js'),info=await lstat(file);
  if(!info.isFile()||info.isSymbolicLink()||await realpath(assets)!==assets)throw Error('Проверьте файлы локального проекта.');
  const source=await readFile(file,'utf8');if(source.includes(accountMarker))return;
  const anchor="    if (user.security?.adminEnrollmentRequired) { location.assign('/security.html?enroll=1'); return; }";
  if(!source.includes(anchor))throw Error('Используйте актуальную версию Orbita из этого архива.');
  const updated=source.replace(anchor,anchor+'\n    // '+accountMarker+"\n    if (user.access?.isAdmin) { location.assign('/admin.html'); return; }");
  try{await writeFile(path.join(directory,'.account-login-before-local-admin.js'),source,{flag:'wx',mode:0o600});}catch(cause){if(cause.code!=='EEXIST')throw cause;}
  const temp=file+'.tmp-'+randomUUID();await writeFile(temp,updated,{mode:0o644});await rename(temp,file);
}
export async function prepared(root,{env=process.env}={}){
  localOnly(env);
  try{
    const actual=await realpath(root);await lstat(path.join(actual,'data',profileName));
    const directory=await localDirectory(actual),profile=JSON.parse(await readFile(path.join(directory,profileName),'utf8'));
    if(profile.version!==1||typeof profile.userId!=='string'||typeof profile.bundleId!=='string')return false;
    const accounts=await createAccounts(directory,{publicOrigin:'',requireAdminMfa:false,mailer:{configured:false}}),db=await accounts.readDatabase();
    const ready=db.users.some(user=>user.id===profile.userId&&user.role==='admin'&&user.localAdminBundleId===profile.bundleId);
    if(ready)await patchLocalLogin(await realpath(root),directory);return ready;
  }catch(cause){if(cause.code==='ENOENT')return false;throw cause;}
}
export async function provision(root,envelope,key,{env=process.env}={}){
  localOnly(env);const config=decodeConfig(envelope,key),actual=await realpath(root),directory=await localDirectory(actual);
  // Validate/patch the known local UI before changing any account. Enrollment
  // and MFA checks still run first; email is not falsely marked verified.
  await patchLocalLogin(actual,directory);
  const accounts=await createAccounts(directory,{publicOrigin:'',requireAdminMfa:false,mailer:{configured:false}});
  const userId=await accounts.transact(db=>{
    let user=db.users.find(value=>value.email===config.email);
    if(user?.localAdminBundleId===config.bundleId&&user.role==='admin')return user.id;
    const at=new Date().toISOString();
    if(!user){user={id:randomUUID(),email:config.email,subscriptions:[],watchlist:[],positions:[],createdAt:at,emailVerified:false};db.users.push(user);}
    user.salt=config.salt;user.hash=config.hash;user.role='admin';user.localAdminBundleId=config.bundleId;
    db.sessions=(db.sessions||[]).filter(item=>item.userId!==user.id);
    db.securityTokens=(db.securityTokens||[]).filter(item=>item.userId!==user.id);
    db.authChallenges=(db.authChallenges||[]).filter(item=>item.userId!==user.id);
    return user.id;
  });
  const file=path.join(directory,profileName),temp=file+'.tmp-'+randomUUID();await writeFile(temp,JSON.stringify({version:1,userId,bundleId:config.bundleId}),{mode:0o600});await rename(temp,file);
  return {userId};
}
export function localEnvironment(root,source=process.env){
  const env={};for(const name of ['PATH','SystemRoot','SYSTEMROOT','WINDIR','TEMP','TMP','TMPDIR'])if(source[name]!==undefined)env[name]=source[name];
  return {...env,HOST:'127.0.0.1',PORT:'0',ORBITA_DATA_DIR:path.join(root,'data'),ORBITA_PUBLIC_ORIGIN:'',ORBITA_REQUIRE_ADMIN_MFA:'false',RADAR_PROVIDER_MODE:'off',RADAR_AI_ENABLED:'false',RADAR_NOTIFICATIONS_ENABLED:'false'};
}
function open(url){
  const command=process.platform==='win32'?'rundll32':process.platform==='darwin'?'open':'xdg-open',args=process.platform==='win32'?['url.dll,FileProtocolHandler',url]:[url];
  const browser=spawn(command,args,{stdio:'ignore'});browser.on('error',()=>{});browser.unref();
}
async function run(){
  if(process.argv.length>2)throw Error('Откройте START-ADMIN без дополнительных параметров.');
  if(Number(process.versions.node.split('.')[0])<22)throw Error('Установите Node.js 22 или новее; рекомендуется 24 LTS.');
  if(!await prepared(project)){
    const cli=createInterface({input:process.stdin,output:process.stdout});let key;
    try{key=(await cli.question('Вставьте ключ установки из чата и нажмите Enter: ')).trim();}finally{cli.close();}
    const file=new URL('./account.enc.json',import.meta.url),info=await lstat(file);if(!info.isFile()||info.isSymbolicLink()||info.size>16384)throw Error('Не найден файл зашифрованной настройки.');
    await provision(project,JSON.parse(await readFile(file,'utf8')),key);key='';
  }
  console.log('Локальная админка готова. Используйте почту и пароль из чата.');
  const child=spawn(process.execPath,['server.mjs'],{cwd:project,env:localEnvironment(project),stdio:['inherit','pipe','inherit']});let tail='',opened=false;
  child.stdout.on('data',chunk=>{process.stdout.write(chunk);tail=(tail+chunk).slice(-4096);const match=tail.match(/ORBITA: (http:\/\/127\.0\.0\.1:\d+)/);if(match&&!opened){opened=true;const url=match[1]+'/account.html?next=%2Fadmin.html';console.log('Вход: '+url+'\nЗакрыть сервер: Ctrl+C.');open(url);}});
  child.once('error',()=>{console.error('Не удалось запустить Node.js.');process.exitCode=1;});
  await new Promise(resolve=>{const stop=()=>child.kill('SIGTERM'),finish=code=>{process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);process.exitCode=code??1;resolve();};process.once('SIGINT',stop);process.once('SIGTERM',stop);child.once('exit',finish);child.once('error',()=>finish(1));});
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))try{await run();}catch{console.error('Локальная настройка не завершена. Проверьте ключ, Node.js 22+, актуальные файлы проекта и папку data. Публичный адрес/production здесь не поддерживаются.');process.exitCode=1;}
