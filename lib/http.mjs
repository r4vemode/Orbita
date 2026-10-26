import {randomUUID} from 'node:crypto';

export function error(status,message,code){return Object.assign(new Error(message),{status,code});}
export function json(res,status,data,headers={}){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Vary':'Cookie',...headers});res.end(JSON.stringify(data));}
export function safeFailure(res,cause,{scope='request',route='unknown',storageMessage='Сервис временно не может сохранить данные. Обратитесь в поддержку и укажите код обращения.',failureMessage='Не удалось обработать запрос. Повторите попытку или обратитесь в поддержку.',storageCode='STORAGE_UNAVAILABLE',failureCode='REQUEST_FAILED',codeKey='code',extra={}}={}){
 const errorId=randomUUID(),storageCodes=new Set(['EACCES','EPERM','EROFS','ENOSPC','EDQUOT','EIO','ENOENT','ENOTDIR','EISDIR']),storage=storageCodes.has(cause?.code);
 const diagnostic=typeof cause?.code==='string'&&/^[A-Z][A-Z0-9_]{1,63}$/.test(cause.code)?cause.code:'UNEXPECTED';
 const safeScope=/^[a-z][a-z0-9_-]{0,31}$/.test(scope)?scope:'request',safeRoute=typeof route==='string'&&/^\/[a-zA-Z0-9._/-]{0,200}$/.test(route)?route:'unknown';
 // Raw exception messages, request bodies, cookies, emails and tokens are intentionally excluded.
 console.error(`[ORBITA] ${safeScope} errorId=${errorId} route=${safeRoute} code=${diagnostic}`);
 const status=storage?503:500,internalCode=storage?storageCode:failureCode;json(res,status,{...extra,error:storage?storageMessage:failureMessage,[codeKey]:internalCode,errorId});return {status,errorId};
}
export async function readJson(req,limit=65536){let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>limit)throw error(413,'Слишком большой запрос.');chunks.push(chunk);}let value;try{value=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw error(400,'Некорректный JSON.');}if(!value||typeof value!=='object'||Array.isArray(value))throw error(400,'Ожидается объект JSON.');return value;}
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
