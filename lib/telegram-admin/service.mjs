import {createHash,timingSafeEqual} from 'node:crypto';
import {requireAdmin} from '../access.mjs';
import {error,json,readJson,safeFailure} from '../http.mjs';
import {telegramAdminConfiguration} from './config.mjs';
import {createTelegramAdminStore} from './accounts.mjs';
import {createTelegramAdminEngine} from './engine.mjs';
import {createRadarAdminWorkflow} from './radar-workflow.mjs';
import {createTelegramAdminTransport} from './transport.mjs';

export const TELEGRAM_ADMIN_WEBHOOK='/api/telegram/webhook';
const ROOT='/api/admin/telegram',routes=new Set([ROOT,ROOT+'/link',ROOT+'/preferences',TELEGRAM_ADMIN_WEBHOOK]);
const hash=value=>createHash('sha256').update(value).digest();
function only(value,keys){if(!value||Array.isArray(value)||typeof value!=='object'||Object.keys(value).some(key=>!keys.includes(key)))throw error(400,'Запрос содержит неизвестные поля.');}
export function createTelegramAdmin({accounts,ideas,radar,env=process.env,send,now=Date.now}={}){
 const config=telegramAdminConfiguration(env),store=createTelegramAdminStore({accounts,now,requireMfa:config.publicOrigin!==null,draftTtlMs:config.draftTtlMs});
 const transport=config.configured?(send||createTelegramAdminTransport({botToken:config.botToken})):null;
 const workflow=createRadarAdminWorkflow({radar,ideas,store,send:transport,publicOrigin:config.publicOrigin,now,draftTtlMs:config.draftTtlMs});
 const engine=config.configured?createTelegramAdminEngine({store,ideas,send:transport,publicOrigin:config.publicOrigin,now,draftTtlMs:config.draftTtlMs,radarWorkflow:workflow}):null;
 let closed=false,running=null,timer=null;
 const attempts=new Map();
 function limit(update){
  const id=update?.message?.from?.id??update?.callback_query?.from?.id;
  if(!Number.isSafeInteger(id)||id<=0)return;
  const at=now();for(const [key,state]of attempts)if(state.until<=at)attempts.delete(key);
  const key=String(id),state=attempts.get(key)||{count:0,until:at+60000};
  if(state.count>=30||!attempts.has(key)&&attempts.size>=2000)throw error(429,'Слишком много команд. Повторите позже.');
  state.count++;attempts.set(key,state);
 }
 async function pump(){
  if(closed||!config.configured)return;if(running)return running;
  const job=(async()=>{
   const pending=await store.pendingUpdates();
   for(const update of pending){
    if(closed)break;
    try{await engine.process(update);await store.completeUpdate(update.update_id);}
    catch{await store.failUpdate(update.update_id);console.error('[ORBITA] telegram-admin code=UPDATE_RETRY');}
   }
   if(!closed)await workflow.pump();
  })().catch(()=>console.error('[ORBITA] telegram-admin code=QUEUE_UNAVAILABLE')).finally(()=>{running=null;});
  running=job;return job;
 }
 async function handle(req,res,url,user){
  if(await workflow.handle(req,res,url,user))return true;
  if(!routes.has(url.pathname))return false;
  try{
   if(url.search)throw error(400,'Параметры адреса не поддерживаются.');
   if(url.pathname===TELEGRAM_ADMIN_WEBHOOK){
    if(req.method!=='POST')throw error(405,'Используйте POST.');
    if(!config.configured)throw error(503,'Telegram администратора пока не подключён.');
    const secret=req.headers['x-telegram-bot-api-secret-token'];
    if(typeof secret!=='string'||secret.length>256||!timingSafeEqual(hash(secret),hash(config.webhookSecret)))throw error(403,'Недопустимый webhook.');
    const update=await readJson(req,16384);limit(update);
    await store.acceptUpdate(update);json(res,200,{ok:true});queueMicrotask(()=>{void pump();});return true;
   }
   requireAdmin(user);accounts.checkRequest(req);
   if(url.pathname===ROOT&&req.method==='GET'){
    const state=await store.status(req);json(res,200,{...state,enabled:config.enabled,configured:config.configured,botUsername:config.botUsername});return true;
   }
   if(url.pathname===ROOT+'/link'&&req.method==='POST'){
    const input=await readJson(req);only(input,[]);if(!config.configured)throw error(503,'Сначала настройте отдельного бота в приватном окружении сервера.');
    json(res,201,{...await store.issueLink(req),botUrl:'https://t.me/'+config.botUsername});return true;
   }
   if(url.pathname===ROOT+'/link'&&req.method==='DELETE'){
    const input=await readJson(req);only(input,[]);await store.unlink(req);json(res,200,{ok:true});return true;
   }
   if(url.pathname===ROOT+'/preferences'&&req.method==='PUT'){
    const input=await readJson(req);only(input,['instantPublish','strategy']);const state=await store.setPreferences(req,input);json(res,200,state);return true;
   }
   throw error(405,'Метод не поддерживается.');
  }catch(cause){if(cause.status)json(res,cause.status,{error:cause.message,...(cause.code?{code:cause.code}:{})});else safeFailure(res,cause,{scope:'telegram-admin',route:url.pathname});}return true;
 }
 return {handle,config,store,engine,workflow,webhookPaths:[TELEGRAM_ADMIN_WEBHOOK],pump,start(){if(!config.configured||closed||timer)return;timer=setInterval(()=>{void pump();},1000);timer.unref();void pump();},async close(){closed=true;clearInterval(timer);await running;}};
}
