import {randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile,rename,rm,stat,lstat} from 'node:fs/promises';
import path from 'node:path';
import {requireAdmin} from './access.mjs';
import {error,json,readJson,safeFailure} from './http.mjs';

const MARKETS=['stocks','futures','crypto'];
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
function only(value,keys){if(!object(value)||Object.keys(value).some(key=>!keys.includes(key)))throw error(400,'Настройки содержат неизвестные поля.');}
function text(value,max,label){if(typeof value!=='string'||value.length>max||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value))throw error(400,`Проверьте поле «${label}».`);return value.trim();}
export function defaultProductSettings(){return {supportEmail:'',authorName:'',editorialNote:'',partnerOffers:MARKETS.map(id=>({id,markets:[id],name:'',url:''}))};}
export function validateProductSettings(value){
  only(value,['supportEmail','authorName','editorialNote','partnerOffers']);
  const supportEmail=text(value.supportEmail,254,'Email поддержки');
  if(supportEmail&&!/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(supportEmail))throw error(400,'Укажите корректный email поддержки или оставьте поле пустым.');
  const authorName=text(value.authorName,100,'Автор'),editorialNote=text(value.editorialNote,1200,'Порядок публикаций');
  if(!Array.isArray(value.partnerOffers)||value.partnerOffers.length!==3)throw error(400,'Нужны три предложения: акции, фьючерсы и криптовалюты.');
  const partnerOffers=MARKETS.map(id=>{
    const matches=value.partnerOffers.filter(offer=>offer?.id===id);if(matches.length!==1)throw error(400,'Проверьте рынки партнёрских предложений.');
    const offer=matches[0];only(offer,['id','markets','name','url']);
    if(!Array.isArray(offer.markets)||offer.markets.length!==1||offer.markets[0]!==id)throw error(400,'Рынок предложения нельзя изменить.');
    const name=text(offer.name,100,'Название партнёра'),raw=text(offer.url,2048,'Партнёрская ссылка');let url='';
    if(raw){let parsed;try{parsed=new URL(raw);}catch{throw error(400,'Укажите полную партнёрскую HTTPS-ссылку.');}
      if(parsed.protocol!=='https:'||parsed.username||parsed.password||!parsed.hostname||!name)throw error(400,'Для ссылки нужны название и HTTPS-адрес без логина и пароля.');url=parsed.href;
    }
    return {id,markets:[id],name,url};
  });
  return {supportEmail,authorName,editorialNote,partnerOffers};
}
export function validateProductSettingsDatabase(db){
  try{only(db,['version','revision','settings','updatedAt','updatedBy']);if(db.version!==1||!Number.isSafeInteger(db.revision)||db.revision<0)return false;validateProductSettings(db.settings);return true;}catch{return false;}
}

export async function createProductSettings(directory,{accounts}={}){
  if(accounts&&typeof accounts.identify!=='function')throw Error('Product settings requires a trusted account identifier.');
  await mkdir(directory,{recursive:true,mode:0o700});const file=path.join(directory,'product-settings.json'),lock=file+'.lock';let queue=Promise.resolve();
  async function load(){
    try{const info=await lstat(file);if(!info.isFile()||info.isSymbolicLink()||info.size>65536)throw Error('Invalid product settings store');const db=JSON.parse(await readFile(file,'utf8'));if(!validateProductSettingsDatabase(db))throw Error('Invalid product settings store');return db;}
    catch(cause){if(cause.code==='ENOENT')return {version:1,revision:0,settings:defaultProductSettings()};throw cause;}
  }
  await load();
  async function acquire(){
    const deadline=Date.now()+5000;
    while(true){
      try{await mkdir(lock,{mode:0o700});try{await writeFile(path.join(lock,'owner.json'),JSON.stringify({pid:process.pid}),{mode:0o600});}catch(cause){await rm(lock,{recursive:true,force:true});throw cause;}return;}
      catch(cause){
        if(cause.code!=='EEXIST')throw cause;
        try{const owner=JSON.parse(await readFile(path.join(lock,'owner.json'),'utf8'));if(Number.isInteger(owner.pid)&&owner.pid>0){try{process.kill(owner.pid,0);}catch(gone){if(gone.code==='ESRCH'){await rm(lock,{recursive:true,force:true});continue;}}}}
        catch(missing){if(missing.code==='ENOENT'){try{if(Date.now()-(await stat(lock)).mtimeMs>30000){await rm(lock,{recursive:true,force:true});continue;}}catch{}}}
        if(Date.now()>=deadline)throw error(409,'Настройки заняты. Повторите сохранение.');await new Promise(resolve=>setTimeout(resolve,25));
      }
    }
  }
  function transact(work){const job=queue.then(async()=>{await acquire();let temp;try{const db=await load(),result=work(db);temp=file+'.tmp-'+randomUUID();await writeFile(temp,JSON.stringify(db),{mode:0o600});await rename(temp,file);temp=null;return result;}finally{if(temp)await rm(temp,{force:true});await rm(lock,{recursive:true,force:true});}});queue=job.catch(()=>{});return job;}
  async function readPublic(){await queue;return structuredClone((await load()).settings);}
  async function readAdmin(user){requireAdmin(user);await queue;const db=await load();return {revision:db.revision,settings:structuredClone(db.settings)};}
  async function updateAdmin(user,payload){
    requireAdmin(user);only(payload,['revision','settings']);if(!Number.isSafeInteger(payload.revision)||payload.revision<0)throw error(400,'Укажите версию настроек.');const settings=validateProductSettings(payload.settings);
    return transact(db=>{if(db.revision!==payload.revision)throw error(409,'Настройки изменились в другой вкладке. Загрузите актуальную версию перед сохранением.');if(db.revision>=Number.MAX_SAFE_INTEGER)throw error(409,'Достигнут предел версий настроек.');db.revision++;db.settings=settings;db.updatedAt=new Date().toISOString();db.updatedBy=user.id;return {revision:db.revision,settings:structuredClone(settings)};});
  }
  async function handle(req,res,url,user){
    if(!['/api/product-settings','/api/admin/settings'].includes(url.pathname))return false;
    try{
      if(url.pathname==='/api/product-settings'){if(req.method!=='GET')throw error(405,'Метод не поддерживается.');json(res,200,await readPublic());}
      else{requireAdmin(user);if(req.method==='GET')json(res,200,await readAdmin(user));else if(req.method==='PUT'){const payload=await readJson(req),actor=accounts?await accounts.identify(req):user;requireAdmin(actor);if(actor.id!==user.id)throw error(401,'Сеанс изменился. Войдите заново.');json(res,200,await updateAdmin(actor,payload));}else throw error(405,'Метод не поддерживается.');}
    }catch(cause){if(cause.status)json(res,cause.status,{error:cause.message});else safeFailure(res,cause,{scope:'product-settings',route:url.pathname});}
    return true;
  }
  return {readPublic,readAdmin,updateAdmin,handle,webhookPaths:[]};
}
