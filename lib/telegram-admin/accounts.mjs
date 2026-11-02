import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {requireAdmin} from '../access.mjs';
import {error} from '../http.mjs';

const LINK_TTL=10*60000,RECEIPT_TTL=7*86400000,UPDATE_TTL=2*86400000;
const MAX_PENDING=64,MAX_BINDINGS=1000,MAX_RECEIPTS=2000,MAX_UPDATES=1000,MAX_AUDIT=2000;
const STRATEGIES=new Set(['Momentum RU','Trend RU','Импульс','Crypto Momentum','Crypto Trend','Orbita Exclusive']);
const clone=value=>structuredClone(value),object=value=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value);
const named=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(value);
const digest=value=>createHash('sha256').update(value).digest('hex');
const integer=value=>Number.isSafeInteger(value)&&value>=0;
const bounded=(value,max)=>typeof value==='string'&&value.length<=max;
const stamp=user=>digest(JSON.stringify({id:user.id,hash:user.hash,salt:user.salt,role:user.role,mfaEnabled:user.mfa?.enabled===true,mfaSecret:user.mfa?.enabled===true?user.mfa.secret:null}));
const settings=binding=>({instantPublish:binding?.instantPublish===true,strategy:binding?.strategy||'Momentum RU'});
const absent=()=>({version:1,bindings:[],links:[],sessions:[],updates:[],audit:[],receipts:[],attempts:[]});
const unavailable=()=>error(403,'Telegram не подключён к действующему аккаунту администратора. Подключите его снова через сайт.','TELEGRAM_ADMIN_UNLINKED');
function telegramId(value){const string=typeof value==='number'&&Number.isSafeInteger(value)?String(value):value;return typeof string==='string'&&/^[1-9]\d{0,15}$/.test(string)&&Number.isSafeInteger(Number(string))?string:null;}
function serialized(value,max){let bytes;try{bytes=JSON.stringify(value);}catch{throw error(400,'Некорректные данные Telegram.');}if(bytes===undefined||Buffer.byteLength(bytes)>max)throw error(400,'Слишком большой запрос Telegram.');return clone(value);}

/** Optional account metadata only; signals remain exclusively in ideas.json. */
export function validateTelegramAdminState(value){
 if(value===undefined)return true;
 if(!object(value)||value.version!==1||!['bindings','links','sessions','updates','audit','receipts','attempts'].every(key=>Array.isArray(value[key])))return false;
 if(value.bindings.length>MAX_BINDINGS||value.links.length>MAX_BINDINGS||value.sessions.length>MAX_BINDINGS||value.updates.length>MAX_UPDATES+MAX_PENDING||value.receipts.length>MAX_RECEIPTS||value.audit.length>MAX_AUDIT||value.attempts.length>MAX_BINDINGS)return false;
 const ids=new Set(),owners=new Set(),telegrams=new Set();
 for(const b of value.bindings){if(!object(b)||!named(b.id)||!named(b.userId)||!telegramId(b.telegramUserId)||b.chatId!==b.telegramUserId||typeof b.authStamp!=='string'||!/^\w{64}$/.test(b.authStamp)||!integer(b.linkedAt)||typeof b.instantPublish!=='boolean'||!STRATEGIES.has(b.strategy)||ids.has(b.id)||owners.has(b.userId)||telegrams.has(b.telegramUserId))return false;ids.add(b.id);owners.add(b.userId);telegrams.add(b.telegramUserId);}
 for(const item of value.links)if(!object(item)||!named(item.userId)||!bounded(item.hash,64)||!integer(item.expiresAt)||!bounded(item.authStamp,64))return false;
 for(const item of value.sessions)if(!object(item)||!named(item.bindingId)||!integer(item.expiresAt)||!object(item.value))return false;
 const updates=new Set();for(const item of value.updates){if(!object(item)||!integer(item.id)||updates.has(item.id)||!integer(item.acceptedAt)||!integer(item.attempts)||!integer(item.nextAttemptAt)||!['pending','complete','failed'].includes(item.status)||(item.status==='pending'?!object(item.update):item.update!==null))return false;updates.add(item.id);}
 for(const item of value.receipts)if(!object(item)||!named(item.bindingId)||!bounded(item.key,200)||!integer(item.expiresAt)||!object(item.value))return false;
 for(const item of value.audit)if(!object(item)||!bounded(item.action,80)||!integer(item.at)||!named(item.userId))return false;
 for(const item of value.attempts)if(!object(item)||!telegramId(item.telegramUserId)||!integer(item.startedAt)||!integer(item.count))return false;
 try{return Buffer.byteLength(JSON.stringify(value))<=8*1024*1024;}catch{return false;}
}

export function createTelegramAdminStore({accounts,now=Date.now,requireMfa=false,draftTtlMs=30*60000}={}){
 if(typeof accounts?.identify!=='function'||typeof accounts?.readDatabase!=='function'||typeof accounts?.transact!=='function'||typeof now!=='function'||!Number.isSafeInteger(draftTtlMs)||draftTtlMs<60000||draftTtlMs>86400000)throw Error('Invalid Telegram admin store dependencies');
 function clock(){const value=now();if(!integer(value))throw Error('Invalid Telegram clock');return value;}
 function state(db){if(!validateTelegramAdminState(db.telegramAdmin))throw Object.assign(Error('Invalid Telegram admin account metadata'),{code:'DATA_INVALID'});return db.telegramAdmin||absent();}
 function writable(db){const value=state(db);db.telegramAdmin=value;return value;}
 function prune(value,at){value.links=value.links.filter(item=>item.expiresAt>at);value.sessions=value.sessions.filter(item=>item.expiresAt>at&&value.bindings.some(binding=>binding.id===item.bindingId));value.receipts=value.receipts.filter(item=>item.expiresAt>at&&value.bindings.some(binding=>binding.id===item.bindingId));value.attempts=value.attempts.filter(item=>item.startedAt+15*60000>at);value.updates=value.updates.filter(item=>item.status==='pending'||item.acceptedAt+UPDATE_TTL>at);const complete=value.updates.filter(item=>item.status!=='pending').sort((a,b)=>b.acceptedAt-a.acceptedAt).slice(0,MAX_UPDATES);value.updates=[...value.updates.filter(item=>item.status==='pending'),...complete];}
 function rawAdmin(db,userId){const user=db.users?.find(user=>user.id===userId);if(!user||user.role!=='admin'||(requireMfa&&!user.mfa?.enabled))throw unavailable();return user;}
 function bindingIdentity(db,binding){const user=rawAdmin(db,binding.userId);if(binding.authStamp!==stamp(user))throw unavailable();return {id:user.id,role:'admin',bindingId:binding.id,telegramUserId:binding.telegramUserId,chatId:binding.chatId,authStamp:binding.authStamp};}
 function owned(db,identity){if(!object(identity))throw unavailable();const value=state(db),binding=value.bindings.find(item=>item.id===identity.bindingId&&item.userId===identity.id&&item.telegramUserId===identity.telegramUserId&&item.chatId===identity.chatId&&item.authStamp===identity.authStamp);if(!binding)throw unavailable();return {value,binding,identity:bindingIdentity(db,binding)};}
 async function web(req,db=null,expected=null){accounts.checkRequest?.(req);const user=await accounts.identify(req);requireAdmin(user);if(expected&&user.id!==expected)throw unavailable();if(db){const raw=rawAdmin(db,user.id);return {user,raw};}return {user};}
 function auditRow(value,identity,action,ideaId=null,detail=null){const row={id:randomUUID(),at:clock(),userId:identity.id,telegramUserId:identity.telegramUserId||null,action:action.slice(0,80),ideaId:typeof ideaId==='string'?ideaId.slice(0,100):null};if(detail!==null)row.detail=serialized(detail,2048);value.audit.push(row);value.audit=value.audit.slice(-MAX_AUDIT);}
 async function issueLink(req){if(req.method!=='POST')throw error(405,'Используйте POST.');const {user}=await web(req),code='orbadmin_'+randomBytes(24).toString('base64url'),at=clock();return accounts.transact(async db=>{const {raw}=await web(req,db,user.id),value=writable(db);prune(value,at);value.links=value.links.filter(link=>link.userId!==raw.id);if(value.links.length>=MAX_BINDINGS)throw error(429,'Слишком много активных подключений.');value.links.push({userId:raw.id,hash:digest(code),authStamp:stamp(raw),expiresAt:at+LINK_TTL});auditRow(value,{id:raw.id},'link-code-created');return {code,expiresAt:new Date(at+LINK_TTL).toISOString()};});}
 async function status(req){const {user}=await web(req),db=await accounts.readDatabase();await web(req,db,user.id);const value=state(db),candidate=value.bindings.find(item=>item.userId===user.id);let binding=null;if(candidate){try{bindingIdentity(db,candidate);binding={telegramUserId:candidate.telegramUserId,linkedAt:new Date(candidate.linkedAt).toISOString()};}catch{}}return {linked:Boolean(binding),binding,preferences:settings(binding?candidate:null)};}
 async function unlink(req){if(!['POST','DELETE'].includes(req.method))throw error(405,'Используйте POST или DELETE.');const {user}=await web(req);return accounts.transact(async db=>{await web(req,db,user.id);const value=writable(db),ids=new Set(value.bindings.filter(b=>b.userId===user.id).map(b=>b.id));value.bindings=value.bindings.filter(b=>b.userId!==user.id);value.links=value.links.filter(b=>b.userId!==user.id);value.sessions=value.sessions.filter(s=>!ids.has(s.bindingId));value.receipts=value.receipts.filter(s=>!ids.has(s.bindingId));auditRow(value,{id:user.id},'unlinked');return {linked:false,preferences:settings(null)};});}
 async function setPreferences(req,input){if(!['POST','PUT','PATCH'].includes(req.method))throw error(405,'Используйте POST, PUT или PATCH.');if(!object(input)||Object.keys(input).some(key=>!['instantPublish','strategy'].includes(key))||Object.hasOwn(input,'instantPublish')&&typeof input.instantPublish!=='boolean'||Object.hasOwn(input,'strategy')&&!STRATEGIES.has(input.strategy))throw error(400,'Проверьте настройки Telegram.');const {user}=await web(req);return accounts.transact(async db=>{await web(req,db,user.id);const value=writable(db),binding=value.bindings.find(b=>b.userId===user.id);if(!binding)throw unavailable();const identity=bindingIdentity(db,binding);Object.assign(binding,input);value.sessions=value.sessions.filter(item=>item.bindingId!==binding.id);auditRow(value,identity,'preferences-changed',null,settings(binding));return {preferences:settings(binding)};});}
 async function connect(tg,chat,code){const telegramUserId=telegramId(tg),chatId=telegramId(chat);if(!telegramUserId||chatId!==telegramUserId)throw unavailable();let hash;if(typeof code==='string'&&/^orbadmin_[A-Za-z0-9_-]{32}$/.test(code))hash=digest(code);else if(object(code)&&Object.keys(code).length===1&&typeof code.codeHash==='string'&&/^[a-f0-9]{64}$/.test(code.codeHash))hash=code.codeHash;else throw error(400,'Проверьте код подключения.');const result=await accounts.transact(db=>{const value=writable(db),at=clock();prune(value,at);let attempts=value.attempts.find(item=>item.telegramUserId===telegramUserId);if(!attempts){if(value.attempts.length>=MAX_BINDINGS)throw error(429,'Подключения временно ограничены.');attempts={telegramUserId,startedAt:at,count:0};value.attempts.push(attempts);}if(attempts.count>=5)return {limited:true};attempts.count++;const link=value.links.find(item=>item.hash===hash&&item.expiresAt>at);if(!link)return {invalid:true};let user;try{user=rawAdmin(db,link.userId);if(link.authStamp!==stamp(user))return {invalid:true};}catch{return {invalid:true};}if(value.bindings.some(b=>b.telegramUserId===telegramUserId&&b.userId!==user.id))return {invalid:true};const former=value.bindings.find(b=>b.userId===user.id);if(!former&&value.bindings.length>=MAX_BINDINGS)throw error(429,'Достигнут лимит подключений.');const binding={id:randomUUID(),userId:user.id,telegramUserId,chatId,authStamp:stamp(user),linkedAt:at,instantPublish:false,strategy:'Momentum RU'};value.links=value.links.filter(item=>item.userId!==user.id);value.bindings=value.bindings.filter(item=>item.userId!==user.id);value.bindings.push(binding);if(former){value.sessions=value.sessions.filter(item=>item.bindingId!==former.id);value.receipts=value.receipts.filter(item=>item.bindingId!==former.id);}const identity=bindingIdentity(db,binding);auditRow(value,identity,'connected');return {identity};});if(result.limited)throw error(429,'Слишком много попыток подключения. Подождите 15 минут.');if(result.invalid)throw error(400,'Код недействителен или уже использован. Создайте новый код на сайте.');return result.identity;}
 async function getIdentity(tg,chat){const telegramUserId=telegramId(tg),chatId=telegramId(chat);if(!telegramUserId||chatId!==telegramUserId)return null;const db=await accounts.readDatabase(),binding=state(db).bindings.find(item=>item.telegramUserId===telegramUserId&&item.chatId===chatId);if(!binding)return null;try{return bindingIdentity(db,binding);}catch{return null;}}
 async function authorize(identity){return owned(await accounts.readDatabase(),identity).identity;}
 async function preferences(identity){return settings(owned(await accounts.readDatabase(),identity).binding);}
 async function session(identity){const {value,binding}=owned(await accounts.readDatabase(),identity),entry=value.sessions.find(item=>item.bindingId===binding.id&&item.expiresAt>clock());return entry?clone(entry.value):null;}
 async function saveSession(identity,input){if(input!==null&&!object(input))throw error(400,'Некорректный черновик.');const safe=input===null?null:serialized(input,32768);return accounts.transact(db=>{const {value,binding}=owned(db,identity);writable(db);prune(value,clock());value.sessions=value.sessions.filter(item=>item.bindingId!==binding.id);if(safe!==null)value.sessions.push({bindingId:binding.id,value:safe,expiresAt:clock()+draftTtlMs});return clone(safe);});}
 async function getReceipt(identity,key){const {value,binding}=owned(await accounts.readDatabase(),identity);const entry=value.receipts.find(item=>item.bindingId===binding.id&&item.key===key&&item.expiresAt>clock());return entry?clone(entry.value):null;}
 async function saveReceipt(identity,key,input){if(!bounded(key,200)||!key||!object(input))throw error(400,'Некорректное подтверждение Telegram.');const safe=serialized(input,32768);return accounts.transact(db=>{const {value,binding}=owned(db,identity);writable(db);prune(value,clock());const previous=value.receipts.find(item=>item.bindingId===binding.id&&item.key===key);if(previous)return clone(previous.value);if(value.receipts.length>=MAX_RECEIPTS)throw error(429,'Журнал подтверждений заполнен. Повторите позже.');value.receipts.push({bindingId:binding.id,key,value:safe,expiresAt:clock()+RECEIPT_TTL});return clone(safe);});}
 async function audit(identity,action,ideaId=null,detail=null){if(!bounded(action,80)||!action)throw error(400,'Некорректное действие.');return accounts.transact(db=>{const {value}=owned(db,identity);writable(db);auditRow(value,identity,action,ideaId,detail);return {ok:true};});}

 // Durable inbox contains only Telegram's fields that this admin interface uses.
 // Link codes are hashed before they enter accounts.json, including queued work.
 function canonical(update){
  if(!object(update)||!integer(update.update_id))return null;const result={update_id:update.update_id};
  function message(input,requireText){if(!object(input)||!object(input.chat)||input.chat.type!=='private'||!telegramId(input.chat.id)||!object(input.from)||input.from.is_bot===true||telegramId(input.from.id)!==telegramId(input.chat.id)||!integer(input.message_id)||requireText&&!bounded(input.text,4096))return null;return {message_id:input.message_id,chat:{id:Number(input.chat.id),type:'private'},from:{id:Number(input.from.id),is_bot:false},...(requireText?{text:input.text}:{})};}
  if(update.message){const value=message(update.message,true);if(!value)return null;result.message=value;const match=value.text.trim().match(/^\/connect(?:@[A-Za-z0-9_]+)?\s+(orbadmin_[A-Za-z0-9_-]{32})$/);if(match){result.connectCodeHash=digest(match[1]);result.message.text='/connect';}}
  else if(object(update.callback_query)){const q=update.callback_query;if(!bounded(q.id,200)||!q.id||!bounded(q.data,64)||!object(q.from)||q.from.is_bot===true)return null;const value=message({...q.message,from:q.from},false);if(!value)return null;result.callback_query={id:q.id,data:q.data,from:{id:Number(q.from.id),is_bot:false},message:value};}
  else return null;return result;
 }
 async function acceptUpdate(input){
  const update=canonical(input);if(!update)return {accepted:false};const source=update.message||update.callback_query.message,tg=String(source.from.id),chat=String(source.chat.id);
  return accounts.transact(db=>{
   const value=writable(db),at=clock();prune(value,at);const previous=value.updates.find(item=>item.id===update.update_id);if(previous)return {accepted:false,duplicate:true};
   let authorized=false;const binding=value.bindings.find(b=>b.telegramUserId===tg&&b.chatId===chat);if(binding){try{bindingIdentity(db,binding);authorized=true;}catch{}}
   if(update.connectCodeHash){
    const attempts=value.attempts.find(item=>item.telegramUserId===tg);if(attempts?.count>=5)return {accepted:false};
    const link=value.links.find(item=>item.hash===update.connectCodeHash&&item.expiresAt>at);let valid=false;
    if(link){try{const user=rawAdmin(db,link.userId);valid=link.authStamp===stamp(user)&&!value.bindings.some(item=>item.telegramUserId===tg&&item.userId!==user.id);}catch{}}
    if(!valid){if(attempts)attempts.count++;else if(value.attempts.length<MAX_BINDINGS)value.attempts.push({telegramUserId:tg,startedAt:at,count:1});return {accepted:false};}
    // One live link cannot reserve the inbox repeatedly, even under many IDs.
    if(value.updates.some(item=>item.status==='pending'&&item.update.connectCodeHash===update.connectCodeHash))return {accepted:false,duplicate:true};
   }else{
    if(!authorized)return {accepted:false};
    // Generated here, never copied from the external Telegram envelope.
    update.acceptedBindingId=binding.id;update.acceptedAuthStamp=binding.authStamp;
   }
   if(value.updates.filter(item=>item.status==='pending').length>=MAX_PENDING)throw error(429,'Очередь Telegram заполнена. Повторите запрос.','TELEGRAM_ADMIN_QUEUE_FULL');
   value.updates.push({id:update.update_id,status:'pending',acceptedAt:at,attempts:0,nextAttemptAt:at,update});return {accepted:true};
  });
 }
 function currentUpdate(db,item){const update=item.update;if(!update?.acceptedBindingId)return true;const binding=state(db).bindings.find(binding=>binding.id===update.acceptedBindingId&&binding.authStamp===update.acceptedAuthStamp);if(!binding)return false;try{bindingIdentity(db,binding);return true;}catch{return false;}}
 async function pendingUpdates(){
  const db=await accounts.readDatabase(),at=clock(),pending=state(db).updates.filter(item=>item.status==='pending'),stale=pending.filter(item=>!currentUpdate(db,item));
  if(stale.length)await accounts.transact(current=>{const value=writable(current);for(const entry of value.updates)if(entry.status==='pending'&&!currentUpdate(current,entry)){entry.status='complete';entry.update=null;}return {ok:true};});
  return pending.filter(item=>item.nextAttemptAt<=at&&currentUpdate(db,item)).sort((a,b)=>a.id-b.id).slice(0,MAX_PENDING).map(item=>clone(item.update));
 }
 async function completeUpdate(updateId){return accounts.transact(db=>{const value=writable(db);prune(value,clock());const entry=value.updates.find(item=>item.id===updateId);if(entry){entry.status='complete';entry.update=null;}return {ok:true};});}
 async function failUpdate(updateId){return accounts.transact(db=>{const value=writable(db),at=clock();prune(value,at);const entry=value.updates.find(item=>item.id===updateId&&item.status==='pending');if(!entry)return {ok:true};entry.attempts++;if(entry.attempts>=5){entry.status='failed';entry.update=null;}else entry.nextAttemptAt=at+Math.min(60000,1000*2**(entry.attempts-1));return {ok:true,retry:entry.status==='pending'};});}
 return {issueLink,status,unlink,setPreferences,connect,getIdentity,authorize,settings:preferences,session,saveSession,getReceipt,saveReceipt,audit,acceptUpdate,pendingUpdates,completeUpdate,failUpdate};
}
