import {randomUUID} from 'node:crypto';
import {lstat,mkdir,open,readFile,realpath,rename,rm} from 'node:fs/promises';
import path from 'node:path';
import {validateNews} from './news.mjs';
import {validateContentDatabase} from './content.mjs';
import {validateProductSettingsDatabase} from './product-settings.mjs';

const MAX_STORE_BYTES=64*1024*1024;
const STORAGE_CODES=new Set(['EACCES','EPERM','EROFS','ENOSPC','EDQUOT','EIO','ENOENT','ENOTDIR','EISDIR']);
const isObject=value=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value);
const integer=value=>Number.isInteger(value)&&value>=0;
const storeDefinitions=[
  ['accounts.json',db=>db?.version===1&&Array.isArray(db.users)&&Array.isArray(db.sessions)],
  ['ideas.json',db=>db?.version===1&&integer(db.revision)&&Array.isArray(db.records)],
  ['billing.json',db=>db?.version===1&&integer(db.revision)&&Array.isArray(db.orders)&&isObject(db.transactions)&&isObject(db.refunds)],
  ['notifications.json',db=>db?.version===1&&isObject(db.preferences)&&isObject(db.bindings)&&Array.isArray(db.links)&&Array.isArray(db.outbox)],
  ['news.json',db=>{try{validateNews(db);return true;}catch{return false;}}],
  ['content.json',db=>{try{return validateContentDatabase(db);}catch{return false;}}],
  ['product-settings.json',validateProductSettingsDatabase]
];

function safeCode(error){return typeof error?.code==='string'&&/^[A-Z][A-Z0-9_]{1,63}$/.test(error.code)?error.code:'UNEXPECTED';}
function inside(parent,child){return child===parent||child.startsWith(parent+path.sep);}
function invalid(code,store){const error=new Error(code);error.code=code;error.store=store;return error;}
async function rejectPathSymlinks(location){
  const absolute=path.resolve(location),parsed=path.parse(absolute);let cursor=parsed.root;
  for(const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)){
    cursor=path.join(cursor,part);try{if((await lstat(cursor)).isSymbolicLink())throw invalid('DIRECTORY_SYMLINK',null);}catch(error){if(error.code==='ENOENT')continue;throw error;}
  }
}

async function validateStore(directory,name,validate){
  const file=path.join(directory,name);
  try{
    const metadata=await lstat(file);
    if(!metadata.isFile()||metadata.isSymbolicLink()||metadata.size>MAX_STORE_BYTES)throw invalid('DATA_UNSAFE',name);
    const value=JSON.parse(await readFile(file,'utf8'));
    if(!validate(value))throw invalid('DATA_INVALID',name);
    return true;
  }catch(error){
    if(error.code==='ENOENT')return false;
    if(['DATA_UNSAFE','DATA_INVALID'].includes(error.code))throw error;
    if(error instanceof SyntaxError)throw invalid('DATA_INVALID',name);
    error.store=name;throw error;
  }
}

export async function checkStorage({directory,publicDir,write=true,validate=true,requirePrivate=false,rejectSymlinks=false}={}){
  let handle,temp,moved,actual;
  try{
    if(typeof directory!=='string'||!directory)throw invalid('DATA_DIR_MISSING',null);
    if(rejectSymlinks)await rejectPathSymlinks(directory);
    await mkdir(directory,{recursive:true,mode:0o700});actual=await realpath(directory);
    const directoryInfo=await lstat(actual);if(!directoryInfo.isDirectory()||directoryInfo.isSymbolicLink())throw invalid('DATA_DIR_UNSAFE',null);
    if(requirePrivate&&process.platform!=='win32'&&(directoryInfo.mode&0o077))throw invalid('DATA_DIR_PERMISSIONS',null);
    if(publicDir){const publicRoot=await realpath(publicDir);if(inside(publicRoot,actual))throw invalid('DATA_DIR_PUBLIC',null);}
    const stores=[];
    if(validate)for(const [name,validator] of storeDefinitions)if(await validateStore(actual,name,validator))stores.push(name);
    if(write){
      const id=`${process.pid}-${randomUUID()}`;temp=path.join(actual,`.orbita-readiness-${id}.tmp`);moved=path.join(actual,`.orbita-readiness-${id}.ok`);
      handle=await open(temp,'wx',0o600);await handle.writeFile('orbita-readiness');await handle.sync();await handle.close();handle=null;
      await rename(temp,moved);temp=null;await rm(moved);moved=null;
    }
    return {ok:true,code:'OK',stores};
  }catch(error){
    return {ok:false,code:safeCode(error),store:typeof error.store==='string'?error.store:null,storageFailure:STORAGE_CODES.has(error.code)};
  }finally{
    await handle?.close().catch(()=>{});if(temp)await rm(temp,{force:true}).catch(()=>{});if(moved)await rm(moved,{force:true}).catch(()=>{});
  }
}

const present=(env,name)=>typeof env[name]==='string'&&env[name].trim()!=='';
const email=value=>/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(String(value||'').trim());
const fromAddress=value=>{const match=String(value||'').trim().match(/^(?:[^<>\r\n]{1,100}\s<)?([^<>\s]+@[^<>\s]+)>?$/);return Boolean(match&&email(match[1]));};
function exactHttpsOrigin(value){try{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password&&url.pathname==='/'&&!url.search&&!url.hash&&!['localhost','127.0.0.1','[::1]'].includes(url.hostname);}catch{return false;}}
function overlap(a,b){const first=path.resolve(a),second=path.resolve(b);return inside(first,second)||inside(second,first);}

export function inspectConfiguration(env=process.env,{production=false,directory,publicDir,nodeVersion=process.versions.node}={}){
  const checks=[];
  const add=(name,status,reason)=>checks.push({name,status,reason});
  const required=(ok,reason)=>ok?'pass':production?'fail':'warn';
  const major=Number(String(nodeVersion).split('.')[0]);add('NODE_VERSION',major>=20?'pass':'fail',major>=20?'supported':'requires_node_20');

  const origin=env.ORBITA_PUBLIC_ORIGIN||'';
  if(!origin)add('ORBITA_PUBLIC_ORIGIN',required(false,'missing'),'missing');
  else add('ORBITA_PUBLIC_ORIGIN',exactHttpsOrigin(origin)?'pass':'fail',exactHttpsOrigin(origin)?'https_origin':'invalid_https_origin');
  add('ORBITA_SUPPORT_EMAIL',email(env.ORBITA_SUPPORT_EMAIL)?'pass':required(false,'missing_or_invalid'),email(env.ORBITA_SUPPORT_EMAIL)?'valid':'missing_or_invalid');

  const paymentNames=['CLOUDPAYMENTS_PUBLIC_ID','CLOUDPAYMENTS_API_SECRET'],paymentCount=paymentNames.filter(name=>present(env,name)).length;
  if(paymentCount===paymentNames.length)add('CLOUDPAYMENTS','pass','configured');
  else if(paymentCount)add('CLOUDPAYMENTS','fail','partial_configuration');
  else add('CLOUDPAYMENTS',required(false,'missing'),'missing');
  const paymentMode=env.CLOUDPAYMENTS_TEST_MODE;
  if(paymentMode!==undefined&&!['true','false','1','0'].includes(paymentMode))add('CLOUDPAYMENTS_TEST_MODE','fail','invalid_boolean');
  else if(production&&paymentCount===paymentNames.length&&!['false','0'].includes(paymentMode))add('CLOUDPAYMENTS_TEST_MODE','fail',paymentMode===undefined?'must_be_explicit':'test_mode_enabled');
  else add('CLOUDPAYMENTS_TEST_MODE','pass',['true','1'].includes(paymentMode)?'test_mode':'live_or_default');

  const mailNames=['RESEND_API_KEY','ORBITA_MAIL_FROM'],mailCount=mailNames.filter(name=>present(env,name)).length;
  if(mailCount===mailNames.length)add('RESEND_MAIL',fromAddress(env.ORBITA_MAIL_FROM)?'pass':'fail',fromAddress(env.ORBITA_MAIL_FROM)?'configured':'invalid_sender');
  else if(mailCount)add('RESEND_MAIL','fail','partial_configuration');
  else add('RESEND_MAIL',required(false,'missing'),'missing');

  const mfa=env.ORBITA_REQUIRE_ADMIN_MFA;
  if(mfa!==undefined&&!['true','false','1','0'].includes(mfa))add('ORBITA_REQUIRE_ADMIN_MFA','fail','invalid_boolean');
  else add('ORBITA_REQUIRE_ADMIN_MFA',['true','1'].includes(mfa)?'pass':required(false,'disabled'),['true','1'].includes(mfa)?'enabled':'true_required');

  const backupNames=['ORBITA_BACKUP_DIR','ORBITA_BACKUP_PASSPHRASE'],backupCount=backupNames.filter(name=>present(env,name)).length;
  if(backupCount===backupNames.length){
    let valid=true,reason='configured';
    if(String(env.ORBITA_BACKUP_PASSPHRASE).length<16){valid=false;reason='passphrase_too_short';}
    if(valid&&directory&&overlap(directory,env.ORBITA_BACKUP_DIR)){valid=false;reason='backup_overlaps_data';}
    if(valid&&publicDir&&overlap(publicDir,env.ORBITA_BACKUP_DIR)){valid=false;reason='backup_overlaps_public';}
    add('ENCRYPTED_BACKUPS',valid?'pass':'fail',reason);
  }else if(backupCount)add('ENCRYPTED_BACKUPS','fail','partial_configuration');
  else add('ENCRYPTED_BACKUPS',required(false,'missing'),'missing');

  const telegramNames=['TELEGRAM_BOT_TOKEN','TELEGRAM_BOT_USERNAME','TELEGRAM_WEBHOOK_SECRET'],telegramCount=telegramNames.filter(name=>present(env,name)).length;
  if(!telegramCount)add('TELEGRAM','warn','optional_not_configured');
  else if(telegramCount!==telegramNames.length)add('TELEGRAM','fail','partial_configuration');
  else{
    const token=/^\d{5,20}:[A-Za-z0-9_-]{20,}$/.test(env.TELEGRAM_BOT_TOKEN),username=/^@?[A-Za-z][A-Za-z0-9_]{4,31}$/.test(env.TELEGRAM_BOT_USERNAME),secret=/^[A-Za-z0-9_-]{16,256}$/.test(env.TELEGRAM_WEBHOOK_SECRET);
    add('TELEGRAM',token&&username&&secret?'pass':'fail',token&&username&&secret?'configured':'invalid_format');
  }
  return {ok:checks.every(check=>check.status!=='fail'),production,checks};
}

export function createReadiness({directory,publicDir,env=process.env,cacheMs=5000,now=Date.now}={}){
  let draining=false,cached=null,cachedAt=0,inFlight=null;
  async function status({force=false}={}){
    if(draining)return {ready:false,draining:true,storage:{ok:false,reason:'draining'}};
    const current=now();if(!force&&cached&&current-cachedAt<Math.max(0,cacheMs))return cached;if(inFlight)return inFlight;
    inFlight=(async()=>{const storage=await checkStorage({directory,publicDir,write:true,validate:true});cached={ready:storage.ok,draining:false,storage:{ok:storage.ok,reason:storage.ok?'ok':storage.store?`${storage.code}:${storage.store}`:storage.code}};cachedAt=now();return cached;})().finally(()=>{inFlight=null;});return inFlight;
  }
  return {
    status,
    setDraining(){draining=true;},
    async adminReport({supportEmail}={}){
      const current=await status({force:true}),privateStorage=await checkStorage({directory,publicDir,write:false,validate:true,requirePrivate:true}),configuration=inspectConfiguration({...env,ORBITA_SUPPORT_EMAIL:supportEmail||env.ORBITA_SUPPORT_EMAIL},{production:true,directory,publicDir});
      let backup={ok:false,reason:'not_configured'};
      if(configuration.checks.find(check=>check.name==='ENCRYPTED_BACKUPS')?.status==='pass'){const result=await checkStorage({directory:path.resolve(env.ORBITA_BACKUP_DIR),publicDir,write:true,validate:false,requirePrivate:true,rejectSymlinks:true});backup={ok:result.ok,reason:result.ok?'ok':result.code};}
      return {ready:current.ready,launchReady:current.ready&&privateStorage.ok&&backup.ok&&configuration.ok,draining:current.draining,storage:{...current.storage,privatePermissions:privateStorage.ok},backup,configuration:configuration.checks};
    }
  };
}
