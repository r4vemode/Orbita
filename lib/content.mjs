import {randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile,rename,rm,stat,lstat} from 'node:fs/promises';
import path from 'node:path';
import {activePlans,isAdmin,requireAdmin,requireMember} from './access.mjs';
import {error,json,readJson,safeFailure} from './http.mjs';

const MAX_LESSONS=500;
const lessonFields=['title','category','intro','sections','access','published'];
const metadataFields=['id','createdAt','createdBy','updatedAt','updatedBy'];
const isObject=value=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value);
const clone=value=>structuredClone(value);
function only(value,keys){if(!isObject(value)||Object.keys(value).some(key=>!keys.includes(key)))throw error(400,'Запрос содержит недопустимые поля.');}
function text(value,limit,label){
  if(typeof value!=='string'||!value.trim()||value.trim().length>limit||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value))throw error(400,`${label}: заполните текст до ${limit} символов.`);
  return value.trim();
}
export function validateLesson(value){
  only(value,lessonFields);
  if(!['member','exclusive'].includes(value.access)||typeof value.published!=='boolean')throw error(400,'Выберите доступ к материалу и состояние публикации.');
  if(!Array.isArray(value.sections)||value.sections.length<1||value.sections.length>20)throw error(400,'Добавьте от 1 до 20 разделов материала.');
  const sections=value.sections.map(section=>{only(section,['title','text']);return {title:text(section.title,160,'Заголовок раздела'),text:text(section.text,10000,'Текст раздела')};});
  const result={title:text(value.title,120,'Название'),category:text(value.category,60,'Тема'),intro:text(value.intro,500,'Краткое описание'),sections,access:value.access,published:value.published};
  if(Buffer.byteLength(JSON.stringify(result))>60000)throw error(400,'Материал слишком большой. Сократите текст до 60 КБ.');
  return result;
}
export function validateContentDatabase(db){
  if(!isObject(db)||db.version!==1||!Number.isSafeInteger(db.revision)||db.revision<0||!Array.isArray(db.lessons)||db.lessons.length>MAX_LESSONS)throw Error('Invalid content database');
  const ids=new Set();
  for(const lesson of db.lessons){
    only(lesson,[...lessonFields,...metadataFields]);
    if(typeof lesson.id!=='string'||!/^[a-zA-Z0-9_-]{1,100}$/.test(lesson.id)||ids.has(lesson.id))throw Error('Invalid content lesson id');
    ids.add(lesson.id);validateLesson(Object.fromEntries(lessonFields.map(key=>[key,lesson[key]])));
    for(const key of ['createdAt','updatedAt'])if(lesson[key]!==null&&!Number.isFinite(Date.parse(lesson[key])))throw Error('Invalid content timestamp');
    for(const key of ['createdBy','updatedBy'])if(typeof lesson[key]!=='string'||!lesson[key]||lesson[key].length>100)throw Error('Invalid content author');
  }
  return true;
}

export async function createContent(directory,{accounts}={}){
  if(accounts&&typeof accounts.identify!=='function')throw Error('Content requires a trusted account identifier.');
  await mkdir(directory,{recursive:true,mode:0o700});
  const file=path.join(directory,'content.json'),lock=file+'.lock';let queue=Promise.resolve();
  const seeds=JSON.parse(await readFile(new URL('../fixtures/lessons.json',import.meta.url),'utf8'));
  const initial=()=>({version:1,revision:0,lessons:seeds.map(lesson=>({...clone(lesson),access:lesson.id.startsWith('exclusive-')?'exclusive':'member',published:true,createdAt:null,createdBy:'orbita-bundled',updatedAt:null,updatedBy:'orbita-bundled'}))});
  validateContentDatabase(initial());
  async function load(){
    try{
      const info=await lstat(file);if(!info.isFile()||info.isSymbolicLink()||info.size>32*1024*1024)throw Object.assign(Error('Unsafe content database'),{code:'DATA_UNSAFE'});
      const bytes=await readFile(file);if(bytes.length>32*1024*1024)throw Object.assign(Error('Content database too large'),{code:'DATA_UNSAFE'});
      const db=JSON.parse(bytes.toString('utf8'));try{validateContentDatabase(db);}catch{throw Object.assign(Error('Invalid content database'),{code:'DATA_INVALID'});}return db;
    }catch(cause){if(cause.code==='ENOENT')return initial();if(cause instanceof SyntaxError)throw Object.assign(Error('Invalid content database'),{code:'DATA_INVALID'});throw cause;}
  }
  await load();
  async function acquire(){
    const deadline=Date.now()+5000;
    while(true){
      try{
        await mkdir(lock,{mode:0o700});
        try{await writeFile(path.join(lock,'owner.json'),JSON.stringify({pid:process.pid}),{mode:0o600});}catch(cause){await rm(lock,{recursive:true,force:true});throw cause;}
        return;
      }catch(cause){
        if(cause.code!=='EEXIST')throw cause;
        try{
          const owner=JSON.parse(await readFile(path.join(lock,'owner.json'),'utf8'));
          if(Number.isInteger(owner.pid)&&owner.pid>0)try{process.kill(owner.pid,0);}catch(gone){if(gone.code==='ESRCH'){await rm(lock,{recursive:true,force:true});continue;}}
        }catch(missing){if(missing.code==='ENOENT')try{if(Date.now()-(await stat(lock)).mtimeMs>30000){await rm(lock,{recursive:true,force:true});continue;}}catch{}}
        if(Date.now()>=deadline)throw error(409,'Материалы заняты. Обновите список и повторите действие.');
        await new Promise(resolve=>setTimeout(resolve,25));
      }
    }
  }
  function transact(mutate){
    const job=queue.then(async()=>{
      await acquire();let temp;
      try{
        const db=await load(),value=mutate(db);if(db.revision>=Number.MAX_SAFE_INTEGER)throw error(409,'Достигнут предел версий материалов. История сохранена.');db.revision++;validateContentDatabase(db);
        temp=file+'.tmp-'+randomUUID();await writeFile(temp,JSON.stringify(db),{mode:0o600});await rename(temp,file);temp=null;
        return {revision:db.revision,...clone(value)};
      }finally{if(temp)await rm(temp,{force:true});await rm(lock,{recursive:true,force:true});}
    });queue=job.catch(()=>{});return job;
  }
  async function readAdmin(user){requireAdmin(user);await queue;const db=await load();return {revision:db.revision,lessons:clone(db.lessons)};}
  async function readPublished(user){
    requireMember(user);await queue;const db=await load(),exclusive=isAdmin(user)||activePlans(user).includes('exclusive');
    return {lessons:db.lessons.filter(lesson=>lesson.published&&(lesson.access==='member'||exclusive)).map(lesson=>({id:lesson.id,...clone(Object.fromEntries(lessonFields.map(key=>[key,lesson[key]]))),updatedAt:lesson.updatedAt}))};
  }
  async function save(user,payload,id=null){
    requireAdmin(user);only(payload,['revision','lesson']);
    if(!Number.isSafeInteger(payload.revision)||payload.revision<0)throw error(400,'Укажите актуальную ревизию списка материалов.');
    const lesson=validateLesson(payload.lesson);
    if(id!==null&&!/^[a-zA-Z0-9_-]{1,100}$/.test(id))throw error(400,'Некорректный идентификатор материала.');
    return transact(db=>{
      if(db.revision!==payload.revision)throw error(409,'Список материалов изменился. Обновите его перед сохранением.');
      const at=new Date().toISOString();let result;
      if(id===null){
        if(db.lessons.length>=MAX_LESSONS)throw error(400,'В базе может быть не более 500 материалов.');
        result={id:'lesson-'+randomUUID(),...lesson,createdAt:at,createdBy:user.id,updatedAt:at,updatedBy:user.id};db.lessons.push(result);
      }else{
        const index=db.lessons.findIndex(value=>value.id===id);if(index<0)throw error(404,'Материал не найден.');
        const previous=db.lessons[index];result={...previous,...lesson,updatedAt:at,updatedBy:user.id};db.lessons[index]=result;
      }
      return {lesson:result};
    });
  }
  async function handle(req,res,url,user){
    const route=url.pathname,detail=route.match(/^\/api\/admin\/content\/([a-zA-Z0-9_-]{1,100})$/);
    if(!['/api/lessons','/api/admin/content'].includes(route)&&!detail)return false;
    try{
      if(route==='/api/lessons'){requireMember(user);if(req.method!=='GET')throw error(405,'Метод не поддерживается.');json(res,200,await readPublished(user));return true;}
      requireAdmin(user);
      if(route==='/api/admin/content'&&req.method==='GET'){json(res,200,await readAdmin(user));return true;}
      if(route==='/api/admin/content'&&req.method==='POST'){const payload=await readJson(req),actor=accounts?await accounts.identify(req):user;requireAdmin(actor);if(actor.id!==user.id)throw error(401,'Сеанс изменился. Войдите заново.');json(res,201,await save(actor,payload));return true;}
      if(detail&&req.method==='PUT'){const payload=await readJson(req),actor=accounts?await accounts.identify(req):user;requireAdmin(actor);if(actor.id!==user.id)throw error(401,'Сеанс изменился. Войдите заново.');json(res,200,await save(actor,payload,detail[1]));return true;}
      throw error(405,'Метод не поддерживается.');
    }catch(cause){if(cause.status)json(res,cause.status,{error:cause.message});else safeFailure(res,cause,{scope:'content',route,storageCode:'CONTENT_STORAGE_UNAVAILABLE',failureCode:'CONTENT_REQUEST_FAILED'});}
    return true;
  }
  return {handle,webhookPaths:[],readAdmin,readPublished,save,check:async()=>{await queue;await load();return true;},close:()=>queue};
}
