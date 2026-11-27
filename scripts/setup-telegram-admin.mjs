import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {telegramAdminConfiguration} from '../lib/telegram-admin/config.mjs';
import {telegramNotificationConfiguration,TELEGRAM_NOTIFICATION_WEBHOOK} from '../lib/notifications.mjs';

const METHODS=new Set(['getMe','getWebhookInfo','setWebhook']);
const failure=code=>Object.assign(Error(code),{code});
const USAGE='npm run telegram:admin:webhook -- [--notifications] [--status|--set|--help]\nПо умолчанию используется бот администратора. --notifications выбирает клиентского бота. --set регистрирует webhook текущего HTTPS-сайта. Секреты читаются из окружения.';

async function request(config,method,payload,fetchImpl){
 if(!METHODS.has(method))throw failure('METHOD_INVALID');
 try{
  const response=await fetchImpl('https://api.telegram.org/bot'+config.botToken+'/'+method,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(6000)});
  if(!response.ok){await response.body?.cancel();throw failure('PROVIDER_REQUEST_FAILED');}
  if(Number(response.headers.get('content-length'))>65536){await response.body?.cancel();throw failure('PROVIDER_RESPONSE_INVALID');}
  const reader=response.body?.getReader();if(!reader)throw failure('PROVIDER_RESPONSE_INVALID');const chunks=[];let size=0;
  try{while(true){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>65536){await reader.cancel();throw failure('PROVIDER_RESPONSE_INVALID');}chunks.push(Buffer.from(part.value));}}finally{reader.releaseLock();}
  const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if(value?.ok!==true)throw failure('PROVIDER_REQUEST_FAILED');return value.result;
 }catch(cause){if(['PROVIDER_REQUEST_FAILED','PROVIDER_RESPONSE_INVALID'].includes(cause?.code))throw cause;throw failure('PROVIDER_REQUEST_FAILED');}
}

/** Explicit operator command. Importing the module never contacts Telegram. */
export async function configureTelegramAdminWebhook(args=process.argv.slice(2),{env=process.env,fetchImpl=fetch,log=console.log,errorLog=console.error}={}){
 const notifications=args[0]==='--notifications';
 const flags=notifications?args.slice(1):args;
 if(flags.length===1&&flags[0]==='--help'){log(USAGE);return {exitCode:0};}
 if(flags.length>1||flags.length===1&&!['--set','--status'].includes(flags[0])){errorLog(USAGE);return {exitCode:2};}
 const action=flags[0]||'--status',botLabel=notifications?'уведомлений':'администратора';
 try{
  let config;try{config=notifications?telegramNotificationConfiguration({},env):telegramAdminConfiguration(env);}catch{throw failure('CONFIGURATION_INVALID');}
  if(notifications&&config.botToken&&config.botToken===env.TELEGRAM_ADMIN_BOT_TOKEN)throw failure('CONFIGURATION_INVALID');
  if(!config.configured){if(action==='--set')throw failure('BOT_DISABLED');log('Бот '+botLabel+' отключён. Внешние запросы не выполнялись.');return {exitCode:0,enabled:false};}
  const expected=config.publicOrigin+(notifications?TELEGRAM_NOTIFICATION_WEBHOOK:'/api/telegram/webhook');
  if(action==='--set'){
   const bot=await request(config,'getMe',{},fetchImpl);
   if(bot?.is_bot!==true||typeof bot.username!=='string'||bot.username.toLowerCase()!==config.botUsername.toLowerCase())throw failure('BOT_USERNAME_MISMATCH');
   const saved=await request(config,'setWebhook',{url:expected,secret_token:config.webhookSecret,allowed_updates:['message','callback_query'],max_connections:2,drop_pending_updates:false},fetchImpl);
   if(saved!==true)throw failure('WEBHOOK_NOT_CONFIRMED');
   log('Webhook '+botLabel+' зарегистрирован. Ожидающие команды Telegram сохранены.');
  }
  const info=await request(config,'getWebhookInfo',{},fetchImpl);
  if(!info||typeof info.url!=='string'||!Number.isSafeInteger(info.pending_update_count)||info.pending_update_count<0)throw failure('PROVIDER_RESPONSE_INVALID');
  const result={exitCode:0,enabled:true,matches:info.url===expected,pendingUpdates:info.pending_update_count,hasDeliveryError:Number.isSafeInteger(info.last_error_date)&&info.last_error_date>0};
  if(action==='--set'&&!result.matches)throw failure('WEBHOOK_NOT_CONFIRMED');
  log('Webhook соответствует текущему HTTPS-адресу: '+(result.matches?'да':'нет')+'.');
  log('Ожидающих обновлений: '+result.pendingUpdates+'. Ошибка доставки зафиксирована провайдером: '+(result.hasDeliveryError?'да':'нет')+'.');
  return result;
 }catch(cause){const code=['CONFIGURATION_INVALID','BOT_DISABLED','BOT_USERNAME_MISMATCH','WEBHOOK_NOT_CONFIRMED','PROVIDER_REQUEST_FAILED','PROVIDER_RESPONSE_INVALID'].includes(cause?.code)?cause.code:'COMMAND_FAILED';errorLog('Настройка webhook не завершена ('+code+'). Проверьте приватное окружение, доступность Telegram и HTTPS-сайта.');return {exitCode:1,code};}
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))process.exitCode=(await configureTelegramAdminWebhook()).exitCode;
