import {randomUUID} from 'node:crypto';

export function error(status,message,code){return Object.assign(new Error(message),{status,code});}
export function json(res,status,data,headers={}){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Vary':'Cookie',...([408,413].includes(status)?{'Connection':'close'}:{}),...headers});res.end(JSON.stringify(data));}
export function safeFailure(res,cause,{scope='request',route='unknown',storageMessage='Сервис временно не может сохранить данные. Обратитесь в поддержку и укажите код обращения.',failureMessage='Не удалось обработать запрос. Повторите попытку или обратитесь в поддержку.',storageCode='STORAGE_UNAVAILABLE',failureCode='REQUEST_FAILED',codeKey='code',extra={}}={}){
 const errorId=randomUUID(),storageCodes=new Set(['EACCES','EPERM','EROFS','ENOSPC','EDQUOT','EIO','ENOENT','ENOTDIR','EISDIR']),storage=storageCodes.has(cause?.code);
 const diagnostic=typeof cause?.code==='string'&&/^[A-Z][A-Z0-9_]{1,63}$/.test(cause.code)?cause.code:'UNEXPECTED';
 const safeScope=/^[a-z][a-z0-9_-]{0,31}$/.test(scope)?scope:'request',safeRoute=typeof route==='string'&&/^\/[a-zA-Z0-9._/-]{0,200}$/.test(route)?route:'unknown';
 // Raw exception messages, request bodies, cookies, emails and tokens are intentionally excluded.
 console.error(`[ORBITA] ${safeScope} errorId=${errorId} route=${safeRoute} code=${diagnostic}`);
 const status=storage?503:500,internalCode=storage?storageCode:failureCode;json(res,status,{...extra,error:storage?storageMessage:failureMessage,[codeKey]:internalCode,errorId});return {status,errorId};
}
export function readBody(req,{limit=65536,timeoutMs=10000}={}){
 if(!Number.isSafeInteger(limit)||limit<1||!Number.isSafeInteger(timeoutMs)||timeoutMs<1)throw new RangeError('Invalid request body limits');
 return new Promise((resolve,reject)=>{
  let size=0,settled=false,timer;const chunks=[];
  const cleanup=()=>{clearTimeout(timer);req.off('data',onData);req.off('end',onEnd);req.off('aborted',onAbort);req.off('error',onError);req.off('close',onClose);};
  function finish(cause){
   if(settled)return;settled=true;cleanup();
   if(cause){
    // Keep the incoming stream intact long enough to send 408/413. json() closes
    // that connection after the response; destroying here would lose the reply.
    req.pause();chunks.length=0;
    // A peer abort may emit ECONNRESET after "aborted". Retain a listener only
    // until close so cleanup never leaves a late stream error unhandled.
    if(!req.closed){const ignore=()=>{};req.on('error',ignore);req.once('close',()=>req.off('error',ignore));}
    reject(cause);
   }else resolve(Buffer.concat(chunks,size));
  }
  function onData(chunk){const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);size+=bytes.length;if(size>limit){finish(error(413,'Слишком большой запрос.'));return;}chunks.push(bytes);}
  function onEnd(){finish();}
  function onAbort(){finish(error(400,'Передача запроса прервана.'));}
  function onError(){finish(error(400,'Не удалось прочитать запрос.'));}
  function onClose(){if(!settled)onAbort();}
  const length=req.headers?.['content-length'];
  if(typeof length==='string'&&/^\d+$/.test(length)&&Number(length)>limit){finish(error(413,'Слишком большой запрос.'));return;}
  if(req.aborted||(req.destroyed&&!req.readableEnded)){onAbort();return;}
  if(req.readableEnded){finish();return;}
  timer=setTimeout(()=>finish(error(408,'Время передачи запроса истекло. Повторите попытку.')),timeoutMs);timer.unref?.();
  req.on('data',onData);req.once('end',onEnd);req.once('aborted',onAbort);req.once('error',onError);req.once('close',onClose);
 });
}
export async function readJson(req,limit=65536){const raw=await readBody(req,{limit});let value;try{value=JSON.parse(raw.toString('utf8'));}catch{throw error(400,'Некорректный JSON.');}if(!value||typeof value!=='object'||Array.isArray(value))throw error(400,'Ожидается объект JSON.');return value;}
export function originPolicy(configured=''){
 let publicOrigin=null;
 if(configured){const u=new URL(configured);if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.pathname!=='/'||u.search||u.hash)throw Error('ORBITA_PUBLIC_ORIGIN должен содержать только origin сайта, например https://orbita.example');if(u.protocol!=='https:'&&!['localhost','127.0.0.1','[::1]'].includes(u.hostname))throw Error('Для внешнего сайта ORBITA_PUBLIC_ORIGIN должен использовать HTTPS.');publicOrigin=u.origin;}
 function check(req){let actual;try{actual=new URL('http://'+req.headers.host);if(actual.username||actual.password||actual.pathname!=='/'||actual.search||actual.hash)throw Error();}catch{throw error(400,'Некорректный адрес запроса.');}
 const local=['localhost','127.0.0.1','[::1]'].includes(actual.hostname);
 if(!local&&(!publicOrigin||actual.host!==new URL(publicOrigin).host))throw error(403,'Адрес сайта не настроен на сервере. Укажите ORBITA_PUBLIC_ORIGIN.','ORIGIN_NOT_CONFIGURED');
 const expected=publicOrigin||actual.origin;
 if(!['GET','HEAD','OPTIONS'].includes(req.method)&&req.headers.origin!==expected)throw error(403,'Недопустимый источник запроса.');
 return expected;
 }
 return {check,publicOrigin,secure:publicOrigin?.startsWith('https://')||false};
}
