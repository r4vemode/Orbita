import {createHash,randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {mkdir,lstat,open,readFile,writeFile,rename,rm,stat} from 'node:fs/promises';
import path from 'node:path';
import {requireAdmin} from './access.mjs';
import {error,json,readJson,safeFailure} from './http.mjs';

const MAX_BYTES=16*1024*1024,MAX_TICKETS=2000,MAX_MESSAGES=50,MAX_HISTORY=200,DAY=86400000;
const CATEGORIES=['account','payment','ideas','other'],STATUSES=['open','in_progress','waiting_customer','resolved'];
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const userId=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(value);
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const own=(value,key)=>Object.hasOwn(value,key);
const sameKeys=(value,fields)=>object(value)&&Object.keys(value).length===fields.length&&fields.every(key=>own(value,key));
const invalid=code=>Object.assign(Error('Invalid support store'),{code:code||'DATA_INVALID'});
const clone=value=>structuredClone(value);
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const safeText=(value,max)=>typeof value==='string'&&value.length>0&&value.length<=max&&value.trim()===value&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
const iso=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
const namedId=(value,prefix)=>typeof value==='string'&&value.startsWith(prefix)&&UUID.test(value.slice(prefix.length));
export const SUPPORT_PAGES=Object.freeze(['','/','/account.html','/admin.html','/app.html','/brokers.html','/calculator.html','/content-admin.html','/guide.html','/index.html','/launch-admin.html','/learn.html','/legal-admin.html','/market-demo.html','/notifications.html','/offer.html','/participants.html','/privacy.html','/radar-admin.html','/radar.html','/refunds.html','/reset-password.html','/security.html','/settings-admin.html','/strategies.html','/strategy.html','/subscriptions.html','/verify-email.html','/support.html','/support-admin.html']);
const pages=new Set(SUPPORT_PAGES);
function only(value,fields){if(!object(value)||Object.keys(value).some(key=>!fields.includes(key)))throw error(400,'Запрос содержит неизвестные поля.');}
function text(value,max,label){if(typeof value!=='string')throw error(400,'Проверьте поле «'+label+'».');const next=value.trim();if(!safeText(next,max))throw error(400,'Проверьте поле «'+label+'»: до '+max+' символов.');return next;}
function requestId(value){if(typeof value!=='string'||!UUID.test(value.toLowerCase()))throw error(400,'Нужен идентификатор отправки. Обновите страницу.');return value.toLowerCase();}
function revision(value){if(!Number.isSafeInteger(value)||value<1)throw error(400,'Укажите версию обращения.');return value;}
function requireUser(user){if(!user||!userId(user.id))throw error(401,'Войдите в аккаунт.');}
const intent=(kind,ticketId,payload,admin=false)=>hash({kind,audience:admin?'admin':'customer',ticketId,payload});
const ticketFields=['id','number','userId','subject','category','status','page','reference','createdAt','updatedAt','revision','messages','history','requests'];
const messageFields=['id','author','actorId','text','createdAt'];
const historyFields=['id','action','at','from','to','author','actorId','messageId'];
const requestFields=['id','actorId','kind','hash','historyId'];

// Validation checks the immutable chain, not merely the presence of arrays.
// Only a valid file may be reopened, included in readiness or written back.
export function validateSupportDatabase(db){
 try{
  if(!sameKeys(db,['version','revision','nextNumber','tickets'])||db.version!==1||!Number.isSafeInteger(db.revision)||db.revision<0||!Array.isArray(db.tickets)||db.tickets.length>MAX_TICKETS||db.nextNumber!==db.tickets.length+1||!Number.isSafeInteger(db.nextNumber))return false;
  const ids=new Set(),requests=new Set();let operations=0;
  for(let index=0;index<db.tickets.length;index++){
   const ticket=db.tickets[index];
   if(!sameKeys(ticket,ticketFields)||!namedId(ticket.id,'ticket-')||ids.has(ticket.id)||ticket.number!=='ORB-'+String(index+1).padStart(6,'0')||!userId(ticket.userId)||!safeText(ticket.subject,120)||/[\r\n]/.test(ticket.subject)||!CATEGORIES.includes(ticket.category)||!STATUSES.includes(ticket.status)||!pages.has(ticket.page)||ticket.page==='/'||ticket.reference!==''&&!UUID.test(ticket.reference)||!iso(ticket.createdAt)||!iso(ticket.updatedAt)||!Array.isArray(ticket.messages)||!ticket.messages.length||ticket.messages.length>MAX_MESSAGES||!Array.isArray(ticket.history)||!ticket.history.length||ticket.history.length>MAX_HISTORY||!Array.isArray(ticket.requests)||ticket.requests.length!==ticket.history.length||ticket.revision!==ticket.history.length)return false;
   ids.add(ticket.id);operations+=ticket.revision;
   const messageIds=new Set(),historyIds=new Set();
   for(const message of ticket.messages){if(!sameKeys(message,messageFields)||!namedId(message.id,'message-')||messageIds.has(message.id)||!['customer','admin'].includes(message.author)||!userId(message.actorId)||message.author==='customer'&&message.actorId!==ticket.userId||!safeText(message.text,3000)||!iso(message.createdAt))return false;messageIds.add(message.id);}
   let state=null,lastTime=null,messageIndex=0;
   for(let i=0;i<ticket.history.length;i++){
    const event=ticket.history[i],operation=ticket.requests[i];
    if(!sameKeys(event,historyFields)||!namedId(event.id,'history-')||historyIds.has(event.id)||!['created','reply','status'].includes(event.action)||!iso(event.at)||lastTime!==null&&event.at<lastTime||event.from!==state||!STATUSES.includes(event.to)||!['customer','admin'].includes(event.author)||!userId(event.actorId)||event.author==='customer'&&event.actorId!==ticket.userId||i===0&&(event.action!=='created'||event.to!=='open'||event.author!=='customer')||i>0&&event.action==='created'||event.action==='status'&&event.author!=='admin')return false;
    if(event.action==='reply'&&event.to!==(event.author==='admin'?'waiting_customer':['waiting_customer','resolved'].includes(event.from)?'open':event.from))return false;
    historyIds.add(event.id);lastTime=event.at;state=event.to;
    let payload,kind;
    if(event.action==='status'){if(event.messageId!==null)return false;kind='status';payload={revision:i,status:event.to};}
    else{const message=ticket.messages[messageIndex++];if(!message||event.messageId!==message.id||event.author!==message.author||event.actorId!==message.actorId||event.at!==message.createdAt)return false;kind=i===0?'create':'message';payload=i===0?{subject:ticket.subject,category:ticket.category,message:message.text,page:ticket.page,reference:ticket.reference}:{revision:i,message:message.text};}
    if(!sameKeys(operation,requestFields)||!UUID.test(operation.id)||operation.actorId!==event.actorId||operation.kind!==kind||operation.hash!==intent(kind,i===0?null:ticket.id,payload,event.author==='admin')||operation.historyId!==event.id)return false;
    const key=operation.actorId+':'+operation.id;if(requests.has(key))return false;requests.add(key);
   }
   if(messageIndex!==ticket.messages.length||state!==ticket.status||ticket.updatedAt!==lastTime||ticket.createdAt!==ticket.history[0].at||ticket.createdAt!==ticket.messages[0].createdAt)return false;
  }
  return db.revision===operations&&Buffer.byteLength(JSON.stringify(db))<=MAX_BYTES;
 }catch{return false;}
}

export async function createSupport(directory,{accounts,now=Date.now}={}){
 if(!accounts||typeof accounts.identify!=='function'||typeof accounts.checkRequest!=='function')throw Error('Support requires trusted accounts.');
 await mkdir(directory,{recursive:true,mode:0o700});const info=await lstat(directory);if(!info.isDirectory()||info.isSymbolicLink())throw invalid('DATA_UNSAFE');
 const file=path.join(directory,'support.json'),lock=file+'.lock';let queue=Promise.resolve(),closed=false;
 const initial=()=>({version:1,revision:0,nextNumber:1,tickets:[]});
 const stamp=previous=>new Date(Math.max(now(),previous?Date.parse(previous):0)).toISOString();
 async function load(){let handle;try{
  const meta=await lstat(file);if(!meta.isFile()||meta.isSymbolicLink()||meta.size>MAX_BYTES)throw invalid('DATA_UNSAFE');
  handle=await open(file,constants.O_RDONLY|(constants.O_NOFOLLOW||0)|(constants.O_NONBLOCK||0));const actual=await handle.stat();if(!actual.isFile()||actual.size>MAX_BYTES)throw invalid('DATA_UNSAFE');
  const bytes=await handle.readFile();if(bytes.length>MAX_BYTES)throw invalid('DATA_UNSAFE');const db=JSON.parse(bytes);if(!validateSupportDatabase(db))throw invalid();return db;
 }catch(cause){if(cause.code==='ENOENT')return initial();if(cause instanceof SyntaxError)throw invalid();if(cause.code==='ELOOP')throw invalid('DATA_UNSAFE');throw cause;}finally{await handle?.close();}}
 await load();
 async function acquire(){
  const deadline=Date.now()+5000;
  while(true){
   try{await mkdir(lock,{mode:0o700});try{await writeFile(path.join(lock,'owner.json'),JSON.stringify({pid:process.pid}),{mode:0o600,flag:'wx'});}catch(cause){await rm(lock,{recursive:true,force:true});throw cause;}return;}
   catch(cause){
    if(cause.code!=='EEXIST')throw cause;
    let metadata;try{metadata=await lstat(lock);}catch(gone){if(gone.code==='ENOENT')continue;throw gone;}if(!metadata.isDirectory()||metadata.isSymbolicLink())throw invalid('DATA_UNSAFE');
    try{const ownerFile=path.join(lock,'owner.json'),ownerInfo=await lstat(ownerFile);if(!ownerInfo.isFile()||ownerInfo.isSymbolicLink()||ownerInfo.size>1024)throw invalid('DATA_UNSAFE');const owner=JSON.parse(await readFile(ownerFile,'utf8'));if(Number.isSafeInteger(owner.pid)&&owner.pid>0)try{process.kill(owner.pid,0);}catch(gone){if(gone.code==='ESRCH'){await rm(lock,{recursive:true,force:true});continue;}}}
    catch(missing){if(missing.code==='DATA_UNSAFE')throw missing;if(missing.code==='ENOENT')try{if(Date.now()-(await stat(lock)).mtimeMs>30000){await rm(lock,{recursive:true,force:true});continue;}}catch{}}
    if(Date.now()>=deadline)throw error(409,'Обращения заняты. Повторите действие.');await new Promise(resolve=>setTimeout(resolve,25));
   }
  }
 }
 function transact(work){
  const job=queue.then(async()=>{if(closed)throw error(503,'Поддержка временно недоступна.');await acquire();let temporary;try{
   const db=await load(),result=await work(db);
   if(result.duplicate)return clone(result);
   if(db.revision>=Number.MAX_SAFE_INTEGER)throw error(409,'Хранилище обращений заполнено.');db.revision++;
   const bytes=JSON.stringify(db);if(Buffer.byteLength(bytes)>MAX_BYTES)throw error(409,'Хранилище обращений заполнено. История сохранена.','SUPPORT_CAPACITY');if(!validateSupportDatabase(db))throw invalid();
   temporary=file+'.tmp-'+randomUUID();await writeFile(temporary,bytes,{mode:0o600,flag:'wx'});await rename(temporary,file);temporary=null;return clone(result);
  }finally{if(temporary)await rm(temporary,{force:true});await rm(lock,{recursive:true,force:true});}});queue=job.catch(()=>{});return job;
 }
 async function readDatabase(){await queue;return load();}
 async function current(req,original,{admin=false}={}){const actor=await accounts.identify(req);requireUser(actor);if(actor.id!==original.id)throw error(401,'Сеанс изменился. Войдите заново.');if(admin)requireAdmin(actor);return actor;}
 function find(db,id,user,{admin=false}={}){const ticket=db.tickets.find(ticket=>ticket.id===id&&(admin||ticket.userId===user.id));if(!ticket)throw error(404,'Обращение не найдено.');return ticket;}
 function replay(db,actor,request,operationHash){
  for(const ticket of db.tickets){const operation=ticket.requests.find(operation=>operation.actorId===actor.id&&operation.id===request);if(operation){if(operation.hash!==operationHash)throw error(409,'Эта отправка уже содержит другой текст. Загрузите обращение перед новым действием.','SUPPORT_REQUEST_CONFLICT');return ticket;}}
  return null;
 }
 function record(ticket,{actor,author,action,to,text:body,operationId,operationHash,kind}){
  if(ticket.history.length>=MAX_HISTORY||ticket.revision>=Number.MAX_SAFE_INTEGER)throw error(409,'Достигнут предел истории обращения. История сохранена.','SUPPORT_CAPACITY');
  const at=action==='created'?ticket.createdAt:stamp(ticket.updatedAt),message=body===undefined?null:{id:'message-'+randomUUID(),author,actorId:actor.id,text:body,createdAt:at};
  if(message&&ticket.messages.length>=MAX_MESSAGES)throw error(409,'Достигнут предел сообщений в обращении.','SUPPORT_CAPACITY');
  const event={id:'history-'+randomUUID(),action,at,from:ticket.status,to,author,actorId:actor.id,messageId:message?.id||null};
  if(message)ticket.messages.push(message);ticket.history.push(event);ticket.requests.push({id:operationId,actorId:actor.id,kind,hash:operationHash,historyId:event.id});ticket.status=to;ticket.updatedAt=at;ticket.revision++;
 }
 function summary(ticket){return Object.fromEntries(['id','number','subject','category','status','createdAt','updatedAt','revision'].map(key=>[key,ticket[key]]).concat([['messageCount',ticket.messages.length]]));}
 function detail(ticket){return {...summary(ticket),page:ticket.page,reference:ticket.reference,messages:ticket.messages.map(({id,author,text,createdAt})=>({id,author,text,createdAt})),history:ticket.history.map(({id,action,at,from,to,author})=>({id,action,at,from,to,author}))};}
 async function emails(){const db=typeof accounts.readDatabase==='function'?await accounts.readDatabase():null;return new Map((db?.users||[]).map(user=>[user.id,typeof user.email==='string'&&user.email.length<=254?user.email:'Аккаунт недоступен']));}
 function validateCreate(payload){
  only(payload,['requestId','subject','category','message','page','reference']);const id=requestId(payload.requestId),subject=text(payload.subject,120,'Тема'),message=text(payload.message,3000,'Сообщение');
  if(/[\r\n]/.test(subject)||!CATEGORIES.includes(payload.category))throw error(400,'Проверьте тему и раздел обращения.');
  const page=payload.page??'',reference=payload.reference??'';if(typeof page!=='string'||!pages.has(page)||typeof reference!=='string'||reference!==''&&!UUID.test(reference.toLowerCase()))throw error(400,'Укажите страницу без параметров и корректный код ошибки.');
  return {id,body:{subject,category:payload.category,message,page:page==='/'?'/index.html':page,reference:reference.toLowerCase()}};
 }
 function validateAction(payload,kind){only(payload,kind==='message'?['requestId','revision','message']:['requestId','revision','status']);const id=requestId(payload.requestId),body={revision:revision(payload.revision)};if(kind==='message')body.message=text(payload.message,3000,'Сообщение');else{if(!STATUSES.includes(payload.status))throw error(400,'Выберите состояние обращения.');body.status=payload.status;}return {id,body};}
 function quota(db,actor){
  const owned=db.tickets.filter(ticket=>ticket.userId===actor.id);if(owned.length>=100)throw error(409,'Достигнут предел обращений аккаунта. Используйте существующее обращение.','SUPPORT_CAPACITY');
  if(owned.filter(ticket=>ticket.status!=='resolved').length>=5)throw error(429,'У вас уже пять открытых обращений. Продолжите переписку в существующем.','SUPPORT_ACTIVE_LIMIT');
  const recent=owned.filter(ticket=>Date.parse(ticket.createdAt)>now()-DAY);if(recent.length>=5)throw Object.assign(error(429,'Можно создать до пяти обращений за 24 часа.','SUPPORT_DAILY_LIMIT'),{retryAfter:Math.max(1,Math.ceil((Math.min(...recent.map(ticket=>Date.parse(ticket.createdAt)))+DAY-now())/1000))});
  if(db.tickets.length>=MAX_TICKETS)throw error(409,'Хранилище обращений заполнено.','SUPPORT_CAPACITY');
 }
 async function create(req,original,payload){
  const input=validateCreate(payload),operationHash=intent('create',null,input.body);
  return transact(async db=>{const actor=await current(req,original),duplicate=replay(db,actor,input.id,operationHash);if(duplicate)return {ticket:duplicate,duplicate:true};quota(db,actor);
   const at=stamp(),ticket={id:'ticket-'+randomUUID(),number:'ORB-'+String(db.nextNumber).padStart(6,'0'),userId:actor.id,subject:input.body.subject,category:input.body.category,status:null,page:input.body.page,reference:input.body.reference,createdAt:at,updatedAt:at,revision:0,messages:[],history:[],requests:[]};
   record(ticket,{actor,author:'customer',action:'created',to:'open',text:input.body.message,operationId:input.id,operationHash,kind:'create'});db.tickets.push(ticket);db.nextNumber++;return {ticket,duplicate:false};
  });
 }
 async function mutate(req,original,id,payload,{admin,kind}){
  const input=validateAction(payload,kind),operationHash=intent(kind,id,input.body,admin);
  return transact(async db=>{
   const actor=await current(req,original,{admin}),ticket=find(db,id,actor,{admin}),duplicate=replay(db,actor,input.id,operationHash);if(duplicate)return {ticket:duplicate,duplicate:true};
   if(ticket.revision!==input.body.revision)throw error(409,'Обращение изменилось. Загрузите актуальную версию; ваш текст можно отправить после проверки.','SUPPORT_REVISION_CONFLICT');
   if(kind==='message'&&!admin){const owned=db.tickets.filter(ticket=>ticket.userId===actor.id),replies=owned.flatMap(ticket=>ticket.history.filter(event=>event.action==='reply'&&event.author==='customer'&&Date.parse(event.at)>now()-DAY));if(replies.length>=20)throw Object.assign(error(429,'Можно отправить до двадцати ответов за 24 часа.','SUPPORT_DAILY_LIMIT'),{retryAfter:Math.max(1,Math.ceil((Math.min(...replies.map(event=>Date.parse(event.at)))+DAY-now())/1000))});if(ticket.status==='resolved'&&owned.filter(item=>item.status!=='resolved').length>=5)throw error(429,'У вас уже пять открытых обращений. Сначала завершите другое обращение.','SUPPORT_ACTIVE_LIMIT');}
   const to=kind==='status'?input.body.status:admin?'waiting_customer':['waiting_customer','resolved'].includes(ticket.status)?'open':ticket.status;
   record(ticket,{actor,author:admin?'admin':'customer',action:kind==='status'?'status':'reply',to,text:kind==='message'?input.body.message:undefined,operationId:input.id,operationHash,kind});return {ticket,duplicate:false};
  });
 }
 async function handle(req,res,url,user){
  const match=url.pathname.match(/^\/api\/(admin\/)?support(?:\/(ticket-[a-f0-9-]+)(\/messages)?)?$/);
  if(!match&&!['/api/support','/api/admin/support'].some(prefix=>url.pathname.startsWith(prefix+'/')))return false;
  try{
   requireUser(user);const admin=Boolean(match?.[1]);if(admin)requireAdmin(user);accounts.checkRequest(req);
   if(!match||match[2]&&!namedId(match[2],'ticket-'))throw error(404,'Обращение не найдено.');
   if(url.search)throw error(400,'Параметры адреса не поддерживаются.');
   const id=match[2],messages=Boolean(match[3]);
   if(req.method==='GET'&&!messages){
    const actor=await current(req,user,{admin}),db=await readDatabase(),emailMap=admin?await emails():null;
    const decorate=(value,ticket)=>admin?{...value,userEmail:emailMap.get(ticket.userId)||'Аккаунт недоступен'}:value;
    if(id){const ticket=find(db,id,actor,{admin});json(res,200,{ticket:decorate(detail(ticket),ticket)});}
    else json(res,200,{tickets:db.tickets.filter(ticket=>admin||ticket.userId===actor.id).slice().sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)||b.number.localeCompare(a.number)).map(ticket=>decorate(summary(ticket),ticket)),checkedAt:stamp()});
   }else if(req.method==='POST'&&!id&&!admin){
    const payload=await readJson(req,16384);await current(req,user);const result=await create(req,user,payload);json(res,result.duplicate?200:201,{ticket:detail(result.ticket)});
   }else if(id&&(messages&&req.method==='POST'||!messages&&admin&&req.method==='PATCH')){
    const payload=await readJson(req,16384);await current(req,user,{admin});const result=await mutate(req,user,id,payload,{admin,kind:messages?'message':'status'}),emailMap=admin?await emails():null;json(res,200,{ticket:{...detail(result.ticket),...(admin?{userEmail:emailMap.get(result.ticket.userId)||'Аккаунт недоступен'}:{})}});
   }else throw error(405,'Метод не поддерживается.');
  }catch(cause){if(cause.status)json(res,cause.status,{error:cause.message,...(cause.code?{code:cause.code}:{})},cause.status===429&&Number.isSafeInteger(cause.retryAfter)&&cause.retryAfter>0?{'Retry-After':String(cause.retryAfter)}:{});else safeFailure(res,cause,{scope:'support',route:url.pathname});}
  return true;
 }
 async function close(){closed=true;await queue;}
 return {handle,readDatabase,close,webhookPaths:[]};
}
