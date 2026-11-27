import {reclaimAbandonedLock} from './storage-lock.mjs';
import {randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile,rename,rm,stat,lstat} from 'node:fs/promises';
import path from 'node:path';
import {canReadTier,isAdmin,requireAdmin,requireMember} from './access.mjs';
import {error,json,readJson,safeFailure} from './http.mjs';

const MAX_LESSONS=500;
const MAX_EDITORIAL_EVENTS=2000;
const lessonFields=['title','category','intro','sections','access','published'];
const editorialFields=['kind','sources','attachmentUrl','tickers','scheduledAt','draftOrigin'];
const metadataFields=['id','createdAt','createdBy','updatedAt','updatedBy'];
const isObject=value=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value);
const clone=value=>structuredClone(value);
function only(value,keys){if(!isObject(value)||Object.keys(value).some(key=>!keys.includes(key)))throw error(400,'Запрос содержит недопустимые поля.');}
function text(value,limit,label){
  if(typeof value!=='string'||!value.trim()||value.trim().length>limit||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value))throw error(400,`${label}: заполните текст до ${limit} символов.`);
  return value.trim();
}
const idPattern=/^[a-zA-Z0-9_-]{1,100}$/;
const editorialAction=['created','edited','published','unpublished','scheduled','schedule-revoked'];
const isoPattern=/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:\d\d)$/;
function time(value){
  if(typeof value!=='string'||!isoPattern.test(value)||!Number.isFinite(Date.parse(value)))throw error(400,'Укажите дату и часовой пояс.');
  const [year,month,day]=value.slice(0,10).split('-').map(Number);
  const calendar=new Date(0);calendar.setUTCFullYear(year,month-1,day);
  if(calendar.getUTCMonth()!==month-1||calendar.getUTCDate()!==day)throw error(400,'Укажите существующую календарную дату.');
  return new Date(value).toISOString();
}
function link(value){
  try{
    if(typeof value!=='string'||value.length>2048||/[\u0000-\u0020\u007f]/.test(value))throw Error();
    const url=new URL(value);
    if(url.protocol!=='https:'||url.username||url.password)throw Error();
    return url.href;
  }catch{throw error(400,'Используйте HTTPS-ссылки без логина и пароля.');}
}
const editorial=lesson=>lesson.kind==='article'||lesson.kind==='news';
const selectFields=(value,fields)=>Object.fromEntries(fields.filter(key=>Object.hasOwn(value,key)).map(key=>[key,value[key]]));
export function validateLesson(value){
  only(value,[...lessonFields,...editorialFields]);
  if(!['public','member','exclusive'].includes(value.access)||typeof value.published!=='boolean')throw error(400,'Выберите доступ к материалу и состояние публикации.');
  if(!Array.isArray(value.sections)||value.sections.length<1||value.sections.length>20)throw error(400,'Добавьте от 1 до 20 разделов материала.');
  const sections=value.sections.map(section=>{only(section,['title','text']);return {title:text(section.title,160,'Заголовок раздела'),text:text(section.text,10000,'Текст раздела')};});
  const result={title:text(value.title,120,'Название'),category:text(value.category,60,'Тема'),intro:text(value.intro,500,'Краткое описание'),sections,access:value.access,published:value.published};
  if(Object.hasOwn(value,'kind')){
    if(!['lesson','article','news'].includes(value.kind))throw error(400,'Выберите вид материала.');
    result.kind=value.kind;
  }
  if(Object.hasOwn(value,'sources')){
    if(!Array.isArray(value.sources)||value.sources.length>8)throw error(400,'Можно добавить до восьми источников.');
    result.sources=[...new Set(value.sources.map(link))];
  }
  if(Object.hasOwn(value,'attachmentUrl'))result.attachmentUrl=value.attachmentUrl==null?null:link(value.attachmentUrl);
  if(Object.hasOwn(value,'tickers')){
    if(!Array.isArray(value.tickers)||value.tickers.length>10||value.tickers.some(ticker=>typeof ticker!=='string'||!/^[A-Z0-9._-]{1,20}$/i.test(ticker)))throw error(400,'Укажите до десяти тикеров без пробелов.');
    result.tickers=[...new Set(value.tickers.map(ticker=>ticker.toUpperCase()))];
  }
  if(Object.hasOwn(value,'scheduledAt'))result.scheduledAt=value.scheduledAt===null?null:time(value.scheduledAt);
  if(Object.hasOwn(value,'draftOrigin')){
    if(!['manual','ai'].includes(value.draftOrigin))throw error(400,'Укажите происхождение черновика.');
    result.draftOrigin=value.draftOrigin;
  }
  if(result.scheduledAt&&result.published)throw error(400,'Выберите один режим публикации.');
  if(result.kind==='news'&&(!['stocks','crypto','macro'].includes(result.category)||!result.sources?.length))throw error(400,'Для новости выберите рынок и добавьте первоисточник.');
  if(Buffer.byteLength(JSON.stringify(result))>60000)throw error(400,'Материал слишком большой. Сократите текст до 60 КБ.');
  return result;
}
export function validateContentDatabase(db){
  if(!isObject(db)||![1,2].includes(db.version)||!Number.isSafeInteger(db.revision)||db.revision<0||!Array.isArray(db.lessons)||db.lessons.length>MAX_LESSONS)throw Error('Invalid content database');
  if(db.version===2){
    only(db,['version','revision','lessons','editorialEvents']);
    if(!Array.isArray(db.editorialEvents)||db.editorialEvents.length>MAX_EDITORIAL_EVENTS)throw Error('Invalid content events');
    const eventIds=new Set(),operationIds=new Set();
    for(const event of db.editorialEvents){
      only(event,['id','lessonId','action','at','author','operationId']);
      if(![event.id,event.lessonId,event.author].every(value=>typeof value==='string'&&idPattern.test(value))||eventIds.has(event.id)||!editorialAction.includes(event.action)||!Number.isFinite(Date.parse(event.at)))throw Error('Invalid content event');
      if(event.operationId!==null&&(typeof event.operationId!=='string'||!opPattern.test(event.operationId)||operationIds.has(event.operationId)))throw Error('Invalid content operation');
      eventIds.add(event.id);if(event.operationId!==null)operationIds.add(event.operationId);
    }
  }
  const ids=new Set();
  for(const lesson of db.lessons){
    const writable=[...lessonFields,...(db.version===2?editorialFields:[])];
    only(lesson,[...writable,...metadataFields,...(db.version===2?['publication']:[])]);
    if(typeof lesson.id!=='string'||!idPattern.test(lesson.id)||ids.has(lesson.id)||db.version===1&&lesson.access==='public')throw Error('Invalid content lesson id');
    ids.add(lesson.id);validateLesson(selectFields(lesson,writable));
    if(editorial(lesson)&&lesson.published&&!lesson.publication)throw Error('Missing content publication');
    if(lesson.publication!==undefined){
      only(lesson.publication,['id','publishedAt','audience']);
      if(!editorial(lesson)||!lesson.published||typeof lesson.publication.id!=='string'||!idPattern.test(lesson.publication.id)||!Number.isFinite(Date.parse(lesson.publication.publishedAt))||!['public','member','exclusive'].includes(lesson.publication.audience))throw Error('Invalid content publication');
    }
    for(const key of ['createdAt','updatedAt'])if(lesson[key]!==null&&!Number.isFinite(Date.parse(lesson[key])))throw Error('Invalid content timestamp');
    for(const key of ['createdBy','updatedBy'])if(typeof lesson[key]!=='string'||!lesson[key]||lesson[key].length>100)throw Error('Invalid content author');
  }
  return true;
}

const opPattern=/^[a-zA-Z0-9_:-]{1,160}$/;
function migrate(db){
  if(db.version===1){db.version=2;db.editorialEvents=[];}
}
function journal(db,lesson,action,at,author,operationId=null){
  migrate(db);
  const event={id:'content-'+randomUUID(),lessonId:lesson.id,action,at,author,operationId};
  db.editorialEvents.push(event);
  db.editorialEvents=db.editorialEvents.slice(-MAX_EDITORIAL_EVENTS);
  return event;
}
const mayRead=(user,level,now)=>level==='public'||canReadTier(user,level==='exclusive'?'exclusive':'pro',now());
const articleUrl=id=>'/article.html?id='+encodeURIComponent(id);
const publicLesson=lesson=>({id:lesson.id,...selectFields(lesson,[...lessonFields,'kind','sources','attachmentUrl','tickers','publication']),updatedAt:lesson.updatedAt});
export async function createContent(directory,{accounts,now=Date.now}={}){
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
          if(Number.isInteger(owner.pid)&&owner.pid>0)try{process.kill(owner.pid,0);}catch(gone){if(gone.code==='ESRCH'&&await reclaimAbandonedLock(lock)){continue;}}
        }catch(missing){if(missing.code==='ENOENT')try{if(Date.now()-(await stat(lock)).mtimeMs>30000&&await reclaimAbandonedLock(lock)){continue;}}catch{}}
        if(Date.now()>=deadline)throw error(409,'Материалы заняты. Обновите список и повторите действие.');
        await new Promise(resolve=>setTimeout(resolve,25));
      }
    }
  }
  function transact(mutate){
    const job=queue.then(async()=>{
      await acquire();let temp;
      try{
        const db=await load(),value=await mutate(db);if(value===null)return null;if(value.replayed)return {revision:db.revision,lesson:clone(value.lesson)};
        if(db.revision>=Number.MAX_SAFE_INTEGER)throw error(409,'Достигнут предел версий материалов. История сохранена.');db.revision++;validateContentDatabase(db);
        temp=file+'.tmp-'+randomUUID();await writeFile(temp,JSON.stringify(db),{mode:0o600});await rename(temp,file);temp=null;
        return {revision:db.revision,...clone(value)};
      }finally{if(temp)await rm(temp,{force:true});await rm(lock,{recursive:true,force:true});}
    });queue=job.catch(()=>{});return job;
  }
  async function readAdmin(user){requireAdmin(user);await queue;const db=await load();return {revision:db.revision,lessons:clone(db.lessons)};}
  async function visible(user){
    await queue;
    return (await load()).lessons.filter(lesson=>lesson.published&&mayRead(user,lesson.access,now));
  }
  async function readPublished(user){
    requireMember(user);
    return {lessons:(await visible(user)).filter(lesson=>lesson.kind!=='news').map(publicLesson)};
  }
  async function readArticles(user){return {lessons:(await visible(user)).filter(lesson=>lesson.kind==='article').map(publicLesson)};}
  async function readArticle(user,id){
    const lesson=(await visible(user)).find(lesson=>lesson.id===id&&editorial(lesson));
    if(!lesson)throw error(404,'Материал недоступен.');
    return {lesson:publicLesson(lesson)};
  }
  async function readNews(user){
    const items=(await visible(user)).filter(lesson=>lesson.kind==='news').map(lesson=>({id:lesson.id,title:lesson.title,summary:lesson.intro,source:new URL(lesson.sources[0]).hostname,url:lesson.sources[0],detailUrl:articleUrl(lesson.id),publishedAt:lesson.publication.publishedAt,topics:[lesson.category],tickers:lesson.tickers||[],urgent:false,sentiment:'neutral'}));
    return {items};
  }
  async function notificationsFor(user,{since=0}={}){
    const cutoff=typeof since==='number'?since:Date.parse(since);
    return (await visible(user)).filter(lesson=>lesson.publication&&Date.parse(lesson.publication.publishedAt)>cutoff&&mayRead(user,lesson.publication.audience,now))
      .map(lesson=>({id:lesson.publication.id,title:lesson.title,summary:lesson.intro,publishedAt:lesson.publication.publishedAt,kind:lesson.kind,url:articleUrl(lesson.id),audience:lesson.access}));
  }
  async function save(user,payload,id=null,{operationId=null,authorize}={}){
    requireAdmin(user);only(payload,['revision','lesson']);
    if(!Number.isSafeInteger(payload.revision)||payload.revision<0)throw error(400,'Укажите актуальную ревизию списка материалов.');
    const lesson=validateLesson(payload.lesson);
    if(id!==null&&(typeof id!=='string'||!idPattern.test(id)))throw error(400,'Некорректный идентификатор материала.');
    if(operationId!==null&&(typeof operationId!=='string'||!opPattern.test(operationId)))throw error(400,'Некорректный ключ запроса.');
    return transact(async db=>{
      if(authorize){const current=await authorize();requireAdmin(current);if(current.id!==user.id)throw error(403,'Сеанс изменился.');}
      const prior=operationId&&db.editorialEvents?.find(event=>event.operationId===operationId&&event.author===user.id);
      if(prior)return {replayed:true,lesson:db.lessons.find(value=>value.id===prior.lessonId)};
      if(db.revision!==payload.revision)throw error(409,'Список материалов изменился. Обновите его перед сохранением.');
      if(lesson.scheduledAt&&Date.parse(lesson.scheduledAt)<=now())throw error(400,'Время публикации уже наступило.');
      const at=new Date(now()).toISOString();let result,previous;
      if(id===null){
        if(db.lessons.length>=MAX_LESSONS)throw error(400,'В базе может быть не более 500 материалов.');
        result={id:'lesson-'+randomUUID(),...lesson,createdAt:at,createdBy:user.id,updatedAt:at,updatedBy:user.id};db.lessons.push(result);
      }else{
        const index=db.lessons.findIndex(value=>value.id===id);if(index<0)throw error(404,'Материал не найден.');
        previous=db.lessons[index];
        if(editorial(previous)&&lesson.kind&&previous.kind!==lesson.kind)throw error(400,'Вид существующего материала изменить нельзя.');
        result={...previous,...lesson,updatedAt:at,updatedBy:user.id};db.lessons[index]=result;
      }
      if(result.published&&result.scheduledAt)result.scheduledAt=null;
      if(result.scheduledAt&&!editorial(result))throw error(400,'Запланировать можно статью или новость.');
      if(!result.published)delete result.publication;
      if(editorial(result)||result.access==='public'||editorialFields.some(key=>Object.hasOwn(result,key))||operationId){
        const action=result.published&&!previous?.published?'published':!result.published&&previous?.published?'unpublished':result.scheduledAt?'scheduled':previous?'edited':'created';
        const event=journal(db,result,action,at,user.id,operationId);
        if(editorial(result)&&result.published&&!result.publication)result.publication={id:event.id,publishedAt:at,audience:result.access};
      }
      return {lesson:result};
    });
  }
  async function publishDue(){
    await queue;
    const due=lesson=>editorial(lesson)&&!lesson.published&&lesson.scheduledAt&&Date.parse(lesson.scheduledAt)<=now();
    if(!(await load()).lessons.some(due))return {published:0};
    return await transact(async db=>{
      const lessons=db.lessons.filter(due);
      if(!lessons.length)return null;
      const at=new Date(now()).toISOString();let published=0;
      for(const lesson of lessons){
        if(accounts?.getUser&&!isAdmin(await accounts.getUser(lesson.updatedBy))){
          lesson.scheduledAt=null;journal(db,lesson,'schedule-revoked',at,lesson.updatedBy);continue;
        }
        const event=journal(db,lesson,'published',at,lesson.updatedBy);
        lesson.scheduledAt=null;lesson.published=true;lesson.updatedAt=at;
        lesson.publication={id:event.id,publishedAt:at,audience:lesson.access};published++;
      }
      return {published};
    })||{published:0};
  }
  async function handle(req,res,url,user){
    const route=url.pathname,detail=route.match(/^\/api\/admin\/content\/([a-zA-Z0-9_-]{1,100})$/),article=route.match(/^\/api\/articles\/([a-zA-Z0-9_-]{1,100})$/);
    if(!['/api/lessons','/api/admin/content','/api/articles'].includes(route)&&!detail&&!article)return false;
    try{
      if(route==='/api/lessons'){requireMember(user);if(req.method!=='GET')throw error(405,'Метод не поддерживается.');json(res,200,await readPublished(user));return true;}
      if(route==='/api/articles'||article){if(req.method!=='GET')throw error(405,'Метод не поддерживается.');json(res,200,article?await readArticle(user,article[1]):await readArticles(user));return true;}
      requireAdmin(user);
      if(route==='/api/admin/content'&&req.method==='GET'){json(res,200,await readAdmin(user));return true;}
      if(route==='/api/admin/content'&&req.method==='POST'){const payload=await readJson(req),actor=accounts?await accounts.identify(req):user;requireAdmin(actor);if(actor.id!==user.id)throw error(401,'Сеанс изменился. Войдите заново.');json(res,201,await save(actor,payload));return true;}
      if(detail&&req.method==='PUT'){const payload=await readJson(req),actor=accounts?await accounts.identify(req):user;requireAdmin(actor);if(actor.id!==user.id)throw error(401,'Сеанс изменился. Войдите заново.');json(res,200,await save(actor,payload,detail[1]));return true;}
      throw error(405,'Метод не поддерживается.');
    }catch(cause){if(cause.status)json(res,cause.status,{error:cause.message});else safeFailure(res,cause,{scope:'content',route,storageCode:'CONTENT_STORAGE_UNAVAILABLE',failureCode:'CONTENT_REQUEST_FAILED'});}
    return true;
  }
  return {handle,webhookPaths:[],readAdmin,readPublished,readArticles,readArticle,readNews,notificationsFor,publishDue,save,check:async()=>{await queue;await load();return true;},close:()=>queue};
}
