import {createHash,randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {mkdir,readFile,writeFile,rename,rm,stat,lstat} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {LEGAL_VERSION,requireAdmin} from './access.mjs';
import {error,json,readJson,safeFailure} from './http.mjs';

const documents=['offer','privacy','refunds'];
const fields=['ownerKind','ownerName','inn','ogrn','address','supportEmail','privacyEmail','hostingDetails','processorsDetails'];
const limits={ownerName:300,inn:12,ogrn:15,address:1000,supportEmail:254,privacyEmail:254,hostingDetails:1500,processorsDetails:4000};
const labels={ownerKind:'Статус исполнителя',ownerName:'Имя или наименование исполнителя',inn:'Корректный ИНН',ogrn:'Корректный ОГРН / ОГРНИП',address:'Адрес для обращений',supportEmail:'Email поддержки',privacyEmail:'Email по персональным данным',hostingDetails:'Хостинг и место хранения данных',processorsDetails:'Фактические обработчики персональных данных'};
const kindLabels={ip:'Индивидуальный предприниматель',company:'Юридическое лицо','self-employed':'Самозанятый'};
const MAX_VERSIONS=50,MAX_PAGE_BYTES=131072,MAX_STORE_BYTES=24*1024*1024;
const object=value=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value);
const own=(value,key)=>Object.prototype.hasOwnProperty.call(value,key);
const clone=value=>structuredClone(value);
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const esc=value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const controls=/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
function only(value,keys){if(!object(value)||Object.keys(value).some(key=>!keys.includes(key)))throw error(400,'Юридические данные содержат неизвестные поля.');}
function revision(value){if(!Number.isSafeInteger(value)||value<0)throw error(400,'Укажите версию юридических данных.');return value;}
function iso(value){return typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)&&Number.isFinite(Date.parse(value));}
export const defaultLegalProfile=()=>Object.fromEntries(fields.map(field=>[field,'']));
export function validateLegalProfile(value){
  only(value,fields);const profile=defaultLegalProfile();
  for(const field of fields){
    const input=own(value,field)?value[field]:'';
    if(typeof input!=='string'||input.length>(limits[field]||30)||controls.test(input))throw error(400,`Проверьте поле «${labels[field]}».`);
    profile[field]=input.trim();
  }
  if(!['','ip','company','self-employed'].includes(profile.ownerKind))throw error(400,'Выберите допустимый статус исполнителя.');
  for(const field of ['inn','ogrn'])if(profile[field]&&!/^\d+$/.test(profile[field]))throw error(400,`${labels[field]}: используйте только цифры.`);
  for(const field of ['supportEmail','privacyEmail'])profile[field]=profile[field].toLowerCase();
  return profile;
}
function innValid(value,length){
  if(!new RegExp('^\\d{'+length+'}$').test(value)||/^0+$/.test(value))return false;
  const digit=weights=>weights.reduce((sum,weight,index)=>sum+weight*Number(value[index]),0)%11%10;
  return length===10?digit([2,4,10,3,5,9,4,6,8])===Number(value[9]):digit([7,2,4,10,3,5,9,4,6,8])===Number(value[10])&&digit([3,7,2,4,10,3,5,9,4,6,8])===Number(value[11]);
}
function ogrnValid(value,kind){
  const length=kind==='ip'?15:13;
  return new RegExp('^'+(kind==='ip'?'3':'[15]')+'\\d{'+(length-1)+'}$').test(value)&&Number(BigInt(value.slice(0,-1))%(kind==='ip'?13n:11n)%10n)===Number(value.at(-1));
}
const email=value=>{
  const parts=value.split('@');if(parts.length!==2)return false;
  const [local,domain]=parts,labels=domain.split('.');
  return local.length<=64&&/^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/.test(local)&&labels.length>=2&&labels.every(label=>/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label))&&/^[A-Za-z]{2,63}$/.test(labels.at(-1));
};
export function legalReadiness(value){
  const profile=validateLegalProfile(value),missing=[];
  if(!profile.ownerKind)missing.push(labels.ownerKind);
  for(const field of ['ownerName','address','hostingDetails','processorsDetails'])if(!profile[field])missing.push(labels[field]);
  if(!innValid(profile.inn,profile.ownerKind==='company'?10:12))missing.push(labels.inn);
  if(profile.ownerKind==='self-employed'){if(profile.ogrn)missing.push('Для самозанятого ОГРН должен оставаться пустым');}
  else if(!['ip','company'].includes(profile.ownerKind)||!ogrnValid(profile.ogrn,profile.ownerKind))missing.push(labels.ogrn);
  for(const field of ['supportEmail','privacyEmail'])if(!email(profile[field]))missing.push(labels[field]);
  return {ready:missing.length===0,missing};
}
function pagesValid(pages){
  only(pages,documents);
  return documents.every(name=>typeof pages[name]==='string'&&pages[name].startsWith('<!doctype html>')&&Buffer.byteLength(pages[name])<=MAX_PAGE_BYTES);
}
const baselineDigest=baseline=>hash([baseline.version,baseline.pages]);
const publicationDigest=publication=>hash([publication.version,publication.publishedAt,publication.publishedBy,publication.profile,publication.pages]);
// This source snapshot is the exact previously accepted project document, not
// a rendering of newer templates. Runtime never consults Git or private drafts.
const bundledBaseline=JSON.parse(readFileSync(new URL('../fixtures/legal-baseline.json',import.meta.url),'utf8'));
if(bundledBaseline.version!==LEGAL_VERSION||!pagesValid(bundledBaseline.pages))throw Error('Invalid bundled legal baseline');
bundledBaseline.checksum=baselineDigest(bundledBaseline);
function canonicalProfile(profile){
  const normalized=validateLegalProfile(profile);
  return Object.keys(profile).length===fields.length&&fields.every(field=>profile[field]===normalized[field]);
}
export function validateLegalDatabase(db){
  try{
    only(db,['version','revision','draft','currentVersion','versions','baseline']);
    if(db.version!==1||!Number.isSafeInteger(db.revision)||db.revision<0||!canonicalProfile(db.draft)||!Array.isArray(db.versions)||db.versions.length>MAX_VERSIONS||db.revision<db.versions.length)return false;
    only(db.baseline,['version','pages','checksum']);
    if(db.baseline.version!==LEGAL_VERSION||!pagesValid(db.baseline.pages)||db.baseline.checksum!==baselineDigest(db.baseline)||db.baseline.checksum!==bundledBaseline.checksum)return false;
    const ids=new Set();
    for(const publication of db.versions){
      only(publication,['version','publishedAt','publishedBy','profile','pages','checksum']);
      if(typeof publication.version!=='string'||!/^ORBITA-\d{4}-\d{2}-\d{2}-[1-9]\d{0,3}$/.test(publication.version)||ids.has(publication.version)||!iso(publication.publishedAt)||typeof publication.publishedBy!=='string'||!publication.publishedBy||publication.publishedBy.length>100||controls.test(publication.publishedBy)||!canonicalProfile(publication.profile)||!legalReadiness(publication.profile).ready||!pagesValid(publication.pages)||publication.checksum!==publicationDigest(publication))return false;
      ids.add(publication.version);
    }
    return db.currentVersion===(db.versions.at(-1)?.version??null);
  }catch{return false;}
}

function renderTemplate(template,{profile,version,published,publishedAt,preview=false}){
  const values={...profile,ownerKind:kindLabels[profile.ownerKind]||'',ogrn:profile.ownerKind==='self-employed'?'Не применяется':profile.ogrn};
  let html=template.replace(/<span class="legal-placeholder" data-legal-field="([a-zA-Z]+)">[^<]*<\/span>/g,(match,field)=>values[field]?`<span class="legal-value" data-legal-field="${field}">${esc(values[field]).replace(/\r?\n/g,'<br>')}</span>`:match);
  const date=publishedAt?new Intl.DateTimeFormat('ru-RU',{timeZone:'Europe/Moscow',day:'numeric',month:'long',year:'numeric'}).format(new Date(publishedAt)):null;
  const meta=`Редакция ${version}${date?' от '+date:''}${published?'':' · проект'}`;
  html=html.replace(/(<p class="legal-meta" data-legal-meta>)[\s\S]*?(<\/p>)/,'$1'+esc(meta)+'$2');
  html=html.replace(/(<span class="orbita-legal-version" data-legal-version>)[\s\S]*?(<\/span>)/,'$1'+esc('Редакция '+version+(published?'':' · проект'))+'$2');
  if(published){html=html.replace(/<aside class="legal-draft" data-legal-draft[\s\S]*?<\/aside>/,'').replace(/<span data-legal-draft-note>[\s\S]*?<\/span>/g,'');}
  html=html.replace(/href="(?:\.\/)?(offer|privacy|refunds)\.html"/g,(_match,name)=>`href="${preview?'/api/admin/legal/preview?document='+name:'/'+name+'.html?version='+encodeURIComponent(version)}"`);
  html=html.replace(/(href|src)="assets\//g,'$1="/assets/').replace(/href="(index\.html(?:#[^"]*)?|guide\.html)"/g,'href="/$1"');
  if(published&&html.includes('class="legal-placeholder"'))throw error(400,'В документах остались незаполненные сведения. Проверьте шаблоны перед публикацией.');
  if(Buffer.byteLength(html)>MAX_PAGE_BYTES)throw error(400,'Документ слишком большой для публикации.');
  return html;
}

export async function createLegal(directory,{templateDir=fileURLToPath(new URL('../public/',import.meta.url)),authorizePublish}={}){
  await mkdir(directory,{recursive:true,mode:0o700});
  const file=path.join(directory,'legal.json'),lock=file+'.lock';let queue=Promise.resolve();
  const templates={};
  for(const name of documents){const template=path.join(templateDir,name+'.html'),info=await lstat(template);if(!info.isFile()||info.isSymbolicLink()||info.size>MAX_PAGE_BYTES)throw Error('Invalid legal template');templates[name]=await readFile(template,'utf8');}
  const makePages=options=>Object.fromEntries(documents.map(name=>[name,renderTemplate(templates[name],options)]));
  const initial=()=>({version:1,revision:0,draft:defaultLegalProfile(),currentVersion:null,versions:[],baseline:clone(bundledBaseline)});
  async function load(){
    try{const info=await lstat(file);if(!info.isFile()||info.isSymbolicLink()||info.size>MAX_STORE_BYTES)throw Object.assign(Error('Invalid legal store'),{code:'DATA_INVALID'});const db=JSON.parse(await readFile(file,'utf8'));if(!validateLegalDatabase(db))throw Object.assign(Error('Invalid legal store'),{code:'DATA_INVALID'});return db;}
    catch(cause){if(cause.code==='ENOENT')return initial();throw cause;}
  }
  await load();
  async function acquire(){
    const deadline=Date.now()+5000;
    while(true){
      try{await mkdir(lock,{mode:0o700});try{await writeFile(path.join(lock,'owner.json'),JSON.stringify({pid:process.pid}),{mode:0o600});}catch(cause){await rm(lock,{recursive:true,force:true});throw cause;}return;}
      catch(cause){
        if(cause.code!=='EEXIST')throw cause;
        try{const owner=JSON.parse(await readFile(path.join(lock,'owner.json'),'utf8'));if(Number.isInteger(owner.pid)&&owner.pid>0)try{process.kill(owner.pid,0);}catch(gone){if(gone.code==='ESRCH'){await rm(lock,{recursive:true,force:true});continue;}}}
        catch(missing){if(missing.code==='ENOENT')try{if(Date.now()-(await stat(lock)).mtimeMs>30000){await rm(lock,{recursive:true,force:true});continue;}}catch{}}
        if(Date.now()>=deadline)throw error(409,'Документы заняты. Повторите действие.');await new Promise(resolve=>setTimeout(resolve,25));
      }
    }
  }
  function adminView(db){return {revision:db.revision,draft:clone(db.draft),currentVersion:db.currentVersion,versions:db.versions.map(({version,publishedAt,publishedBy})=>({version,publishedAt,publishedBy})),readiness:legalReadiness(db.draft)};}
  function transact(work){
    const job=queue.then(async()=>{
      await acquire();let temp;
      try{const db=await load(),value=work(db);if(db.revision>=Number.MAX_SAFE_INTEGER)throw error(409,'Достигнут предел версий хранилища.');db.revision++;if(!validateLegalDatabase(db))throw Object.assign(Error('Invalid legal update'),{code:'DATA_INVALID'});const data=JSON.stringify(db);if(Buffer.byteLength(data)>MAX_STORE_BYTES)throw error(400,'История документов слишком велика.');temp=file+'.tmp-'+randomUUID();await writeFile(temp,data,{mode:0o600});await rename(temp,file);temp=null;return value(db);}
      finally{if(temp)await rm(temp,{force:true});await rm(lock,{recursive:true,force:true});}
    });queue=job.catch(()=>{});return job;
  }
  function selectPublication(db,requested){
    if(requested===undefined||requested===null||requested===''){if(!db.currentVersion)return null;requested=db.currentVersion;}
    if(typeof requested!=='string'||requested.length>80)throw error(404,'Редакция документов не найдена.');
    if(requested===LEGAL_VERSION)return null;
    const publication=db.versions.find(item=>item.version===requested);if(!publication)throw error(404,'Редакция документов не найдена.');return publication;
  }
  async function readAdmin(user){requireAdmin(user);await queue;return adminView(await load());}
  async function readPublic({version}={}){await queue;const publication=selectPublication(await load(),version);return publication?{version:publication.version,published:true,publishedAt:publication.publishedAt,profile:clone(publication.profile)}:{version:LEGAL_VERSION,published:false,publishedAt:null,profile:defaultLegalProfile()};}
  async function saveDraft(user,payload){
    requireAdmin(user);only(payload,['revision','profile']);const expected=revision(payload.revision),profile=validateLegalProfile(payload.profile);
    return transact(db=>{if(db.revision!==expected)throw error(409,'Документы изменились в другой вкладке. Загрузите актуальную версию.');db.draft=profile;return adminView;});
  }
  async function publish(user,payload){
    requireAdmin(user);only(payload,['revision']);const expected=revision(payload.revision);
    if(typeof user.id!=='string'||!user.id||user.id.length>100||controls.test(user.id))throw error(400,'Не удалось определить автора публикации.');
    return transact(db=>{
      if(db.revision!==expected)throw error(409,'Документы изменились в другой вкладке. Проверьте актуальную редакцию.');
      const readiness=legalReadiness(db.draft);if(!readiness.ready)throw error(400,'Для публикации заполните: '+readiness.missing.join(', ')+'.');
      if(db.versions.length>=MAX_VERSIONS)throw error(409,'Достигнут предел в 50 опубликованных редакций. История не удаляется.');
      const publishedAt=new Date().toISOString(),date=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(publishedAt)),version='ORBITA-'+date+'-'+(db.versions.length+1),profile=clone(db.draft);
      const publication={version,publishedAt,publishedBy:user.id,profile,pages:makePages({profile,version,published:true,publishedAt})};publication.checksum=publicationDigest(publication);db.versions.push(publication);db.currentVersion=version;return adminView;
    });
  }
  async function renderPage(document,{version}={}){if(!documents.includes(document))throw error(404,'Документ не найден.');await queue;const db=await load(),publication=selectPublication(db,version);return publication?publication.pages[document]:db.baseline.pages[document];}
  async function previewPage(user,document){requireAdmin(user);if(!documents.includes(document))throw error(404,'Документ не найден.');await queue;const db=await load();return renderTemplate(templates[document],{profile:db.draft,version:db.currentVersion||LEGAL_VERSION,published:false,publishedAt:null,preview:true});}
  async function handle(req,res,url,user){
    if(!['/api/legal','/api/admin/legal','/api/admin/legal/publish','/api/admin/legal/preview'].includes(url.pathname))return false;
    try{
      if(url.pathname==='/api/legal'){if(req.method!=='GET')throw error(405,'Метод не поддерживается.');json(res,200,await readPublic({version:url.searchParams.get('version')}));}
      else{
        requireAdmin(user);
        if(url.pathname==='/api/admin/legal'&&req.method==='GET')json(res,200,await readAdmin(user));
        else if(url.pathname==='/api/admin/legal'&&req.method==='PUT')json(res,200,await saveDraft(user,await readJson(req,32768)));
        else if(url.pathname==='/api/admin/legal/preview'&&req.method==='GET'){const html=await previewPage(user,url.searchParams.get('document'));res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Vary':'Cookie'});res.end(html);}
        else if(url.pathname==='/api/admin/legal/publish'&&req.method==='POST'){
          const payload=await readJson(req,4096);only(payload,['revision','password','code']);revision(payload.revision);
          if(typeof payload.password!=='string'||payload.password.length>128||(payload.code!==undefined&&(typeof payload.code!=='string'||payload.code.length>64)))throw error(400,'Подтвердите публикацию паролем и кодом защиты, если он включён.');
          if(typeof authorizePublish!=='function')throw error(503,'Повторное подтверждение публикации пока не настроено.');
          const actor=await authorizePublish(req,{password:payload.password,...(payload.code!==undefined?{code:payload.code}:{})});requireAdmin(actor);if(actor.id!==user.id)throw error(401,'Повторите вход перед публикацией.');
          json(res,200,await publish(actor,{revision:payload.revision}));
        }else throw error(405,'Метод не поддерживается.');
      }
    }catch(cause){if(cause.status)json(res,cause.status,{error:cause.message,...(cause.code?{code:cause.code}:{})});else safeFailure(res,cause,{scope:'legal',route:url.pathname});}
    return true;
  }
  return {readAdmin,readPublic,saveDraft,publish,renderPage,previewPage,handle,webhookPaths:[],close:()=>queue};
}
