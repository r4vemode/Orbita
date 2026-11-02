const METHODS=new Set(['sendMessage','editMessageText','answerCallbackQuery','editMessageReplyMarkup']);
const failure=()=>Object.assign(Error('Telegram временно недоступен. Команда сохранена для повторной обработки.'),{code:'TELEGRAM_ADMIN_DELIVERY'});
// This transport never logs the URL: Telegram embeds the bot secret in its path.
export function createTelegramAdminTransport({botToken,fetchImpl=fetch,timeoutMs=6000}={}){
 return async function send(method,payload){
  if(!METHODS.has(method))throw failure();
  const body=JSON.stringify(payload);if(Buffer.byteLength(body)>24000)throw failure();
  let response;
  try{
   response=await fetchImpl('https://api.telegram.org/bot'+botToken+'/'+method,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json'},body,signal:AbortSignal.timeout(timeoutMs)});
   if(!response.ok&&response.status!==400){await response.body?.cancel();throw failure();}
   if(Number(response.headers.get('content-length'))>65536){await response.body?.cancel();throw failure();}
   const reader=response.body?.getReader();if(!reader)throw failure();const chunks=[];let size=0;
   try{while(true){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>65536){await reader.cancel();throw failure();}chunks.push(Buffer.from(part.value));}}finally{reader.releaseLock();}
   const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));
   if(value?.ok!==true){
    // Updating an already matching card is an idempotent success after retries.
    if(method.startsWith('editMessage')&&value?.error_code===400&&value.description==='Bad Request: message is not modified')return true;
    throw failure();
   }
   if(!response.ok)throw failure();
   return value.result;
  }catch{throw failure();}
 };
}
