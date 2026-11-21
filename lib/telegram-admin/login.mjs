import {createTelegramAdminTransport} from './transport.mjs';

const MAX_TELEGRAM_ID=2**52-1;
export function validTelegramLoginId(value){
 return typeof value==='string'&&/^[1-9]\d{0,15}$/.test(value)&&Number(value)<=MAX_TELEGRAM_ID;
}

export function telegramLoginConfiguration(env=process.env){
 const mode=env.TELEGRAM_ADMIN_LOGIN_ENABLED??'false';
 const token=env.TELEGRAM_ADMIN_BOT_TOKEN||'';
 const enabled=['true','1'].includes(mode);
 const validMode=enabled||['false','0'].includes(mode);
 const validToken=/^\d{5,20}:[A-Za-z0-9_-]{20,}$/.test(token)&&token!==env.TELEGRAM_BOT_TOKEN;
 if(!validMode||(enabled&&!validToken)){
  throw Error('Проверьте TELEGRAM_ADMIN_LOGIN_ENABLED и отдельный TELEGRAM_ADMIN_BOT_TOKEN.');
 }
 return {enabled,botToken:enabled?token:null};
}

export function createTelegramLoginSender({env=process.env,fetchImpl=fetch}={}){
 const config=telegramLoginConfiguration(env);
 if(!config.enabled)return null;
 const send=createTelegramAdminTransport({botToken:config.botToken,fetchImpl});
 return async (telegramId,code)=>{
  if(!validTelegramLoginId(telegramId)||typeof code!=='string'||!/^\d{6}$/.test(code))throw Error('Некорректные данные для Telegram.');
  const message=await send('sendMessage',{
   chat_id:Number(telegramId),
   text:`Код входа в ORBITA: ${code}\nКод действует 5 минут. Введите его только на странице входа ORBITA.`,
   protect_content:true
  });
  if(message?.chat?.type!=='private'||message.chat.id!==Number(telegramId))throw Error('Telegram не подтвердил доставку в личный чат.');
 };
}
