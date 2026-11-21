// Web Push without dependencies: RFC 8291 (aes128gcm payload encryption) and
// RFC 8292 (VAPID). Subscriptions are per user; endpoints are restricted to the
// browsers' push services so the server never POSTs to arbitrary hosts.
import {createECDH,createCipheriv,createPrivateKey,generateKeyPairSync,hkdfSync,randomBytes,sign,randomUUID} from 'node:crypto';
import {mkdir} from 'node:fs/promises';
import path from 'node:path';
import {readPrivateJson,writeDurable} from './durable-file.mjs';
import {error,json,readJson,safeFailure} from './http.mjs';
import {hasSubscription} from './access.mjs';

const b64u=buffer=>Buffer.from(buffer).toString('base64url');
const fromB64u=text=>Buffer.from(String(text),'base64url');
const PUSH_HOSTS=[/^fcm\.googleapis\.com$/,/^updates\.push\.services\.mozilla\.com$/,/^push\.services\.mozilla\.com$/,/(^|\.)push\.apple\.com$/,/(^|\.)notify\.windows\.com$/];
const MAX_PER_USER=10,MAX_TOTAL=50000,RECORD_SIZE=4096;

export function validEndpoint(value){
 try{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password&&(!url.port||url.port==='443')&&value.length<=1024&&PUSH_HOSTS.some(re=>re.test(url.hostname));}catch{return false;}
}

/** RFC 8291 §3-4. `asPrivate`/`salt` are injectable only for the RFC test vector. */
export function encryptPayload(plaintext,{p256dh,auth},{asPrivate=null,salt=randomBytes(16)}={}){
 const uaPublic=fromB64u(p256dh),authSecret=fromB64u(auth);
 if(uaPublic.length!==65||uaPublic[0]!==4||authSecret.length!==16)throw Object.assign(Error('Invalid subscription keys'),{code:'PUSH_KEYS'});
 const ecdh=createECDH('prime256v1');if(asPrivate)ecdh.setPrivateKey(fromB64u(asPrivate));else ecdh.generateKeys();
 const asPublic=ecdh.getPublicKey(),shared=ecdh.computeSecret(uaPublic);
 const ikm=Buffer.from(hkdfSync('sha256',shared,authSecret,Buffer.concat([Buffer.from('WebPush: info\0'),uaPublic,asPublic]),32));
 const cek=Buffer.from(hkdfSync('sha256',ikm,salt,Buffer.from('Content-Encoding: aes128gcm\0'),16)),nonce=Buffer.from(hkdfSync('sha256',ikm,salt,Buffer.from('Content-Encoding: nonce\0'),12));
 const data=Buffer.concat([Buffer.from(plaintext),Buffer.from([2])]);if(data.length+16>RECORD_SIZE-86)throw Object.assign(Error('Payload too large'),{code:'PUSH_SIZE'});
 const cipher=createCipheriv('aes-128-gcm',cek,nonce),body=Buffer.concat([cipher.update(data),cipher.final(),cipher.getAuthTag()]);
 const header=Buffer.alloc(21);salt.copy(header,0);header.writeUInt32BE(RECORD_SIZE,16);header[20]=asPublic.length;
 return Buffer.concat([header,asPublic,body]);
}

export function vapidKeys(){const {publicKey,privateKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'});const jwk=publicKey.export({format:'jwk'});return {publicKey:b64u(Buffer.concat([Buffer.from([4]),fromB64u(jwk.x),fromB64u(jwk.y)])),privateJwk:privateKey.export({format:'jwk'})};}
export function vapidHeader(endpoint,{publicKey,privateJwk},subject,now=Date.now()){
 const header=b64u(JSON.stringify({typ:'JWT',alg:'ES256'})),claims=b64u(JSON.stringify({aud:new URL(endpoint).origin,exp:Math.floor(now/1000)+12*3600,sub:subject}));
 const signature=sign('sha256',Buffer.from(header+'.'+claims),{key:createPrivateKey({key:privateJwk,format:'jwk'}),dsaEncoding:'ieee-p1363'});
 return `vapid t=${header}.${claims}.${b64u(signature)}, k=${publicKey}`;
}

export const validatePushDatabase=db=>db&&db.version===1&&db.vapid&&typeof db.vapid.publicKey==='string'&&db.vapid.privateJwk&&Array.isArray(db.subscriptions)&&db.subscriptions.length<=MAX_TOTAL&&db.subscriptions.every(s=>s&&typeof s.userId==='string'&&validEndpoint(s.endpoint)&&typeof s.p256dh==='string'&&typeof s.auth==='string');

export function pushConfiguration(env=process.env){
 const enabled=env.ORBITA_PUSH_ENABLED||'true';
 if(!['true','false','1','0'].includes(enabled))throw Error('ORBITA_PUSH_ENABLED: используйте true или false.');
 const origin=(()=>{try{const u=new URL(env.ORBITA_PUBLIC_ORIGIN||'');return u.protocol==='https:'?u.origin:null;}catch{return null;}})();
 const subject=env.ORBITA_PUSH_SUBJECT||origin||'mailto:support@orbita.invalid';
 if(!/^mailto:[^@\s<>]+@[^@\s<>.]+(?:\.[^@\s<>.]+)+$/i.test(subject)){
  let url;
  try{url=new URL(subject);}catch{}
  if(url?.protocol!=='https:'||url.username||url.password||/\s/.test(subject))throw Error('ORBITA_PUSH_SUBJECT: укажите контакт mailto: или HTTPS-адрес.');
 }
 return {configured:enabled==='true'||enabled==='1',subject};
}

export async function createPush(directory,{accounts,env=process.env,fetchImpl=globalThis.fetch,now=Date.now}={}){
 const file=path.join(directory,'push.json');await mkdir(directory,{recursive:true,mode:0o700});
 let queue=Promise.resolve();
 const {configured,subject}=pushConfiguration(env);
 async function load(){try{return await readPrivateJson(file,validatePushDatabase,{maxBytes:16*1024*1024});}catch(cause){if(cause.code!=='ENOENT')throw cause;const db={version:1,vapid:vapidKeys(),subscriptions:[]};await writeDurable(file,Buffer.from(JSON.stringify(db)));return db;}}
 function transact(work){const job=queue.then(async()=>{const db=await load(),result=await work(db);if(!validatePushDatabase(db))throw Object.assign(Error('Invalid push store'),{code:'DATA_INVALID'});await writeDurable(file,Buffer.from(JSON.stringify(db)));return result;});queue=job.catch(()=>{});return job;}
 await queue.then(load);
 async function has(userId){await queue;return (await load()).subscriptions.some(s=>s.userId===userId);}
 async function earliest(userId){await queue;const list=(await load()).subscriptions.filter(s=>s.userId===userId).map(s=>s.createdAt).sort();return list[0]||null;}
 async function send(userId,{title,body,url,tag}){
  if(!configured)return {sent:0};await queue;const db=await load(),subs=db.subscriptions.filter(s=>s.userId===userId),gone=[];let sent=0;
  const payload=JSON.stringify({userId,title:String(title).slice(0,120),body:String(body).slice(0,900),url:typeof url==='string'&&url.startsWith('/')?url:'/strategies.html',tag:tag?String(tag).slice(0,64):undefined});
  for(const s of subs){
   try{const response=await fetchImpl(s.endpoint,{method:'POST',headers:{Authorization:vapidHeader(s.endpoint,db.vapid,subject,now()),TTL:'86400',Urgency:'high','Content-Encoding':'aes128gcm','Content-Type':'application/octet-stream'},body:encryptPayload(payload,s),signal:AbortSignal.timeout(10000)});
    if(response.status===404||response.status===410)gone.push(s.endpoint);else if(response.ok)sent++;}catch{}
  }
  if(gone.length)await transact(store=>{store.subscriptions=store.subscriptions.filter(s=>!gone.includes(s.endpoint));});
  return {sent,devices:subs.length};
 }
 async function handle(req,res,url,user){
  if(!['/api/push/config','/api/push/subscription'].includes(url.pathname))return false;
  try{
   accounts.checkRequest(req);if(!user?.id)throw error(401,'Войдите в аккаунт.');
   if(url.pathname==='/api/push/config'){
    if(req.method!=='GET')throw error(405,'Метод не поддерживается.');
    await queue;const db=await load(),devices=db.subscriptions.filter(s=>s.userId===user.id);
    json(res,200,{configured,publicKey:db.vapid.publicKey,devices:devices.length,userId:user.id,eligible:hasSubscription(user,now()),registered:devices.some(s=>s.endpoint===req.headers['x-orbita-push-endpoint'])});return true;
   }
   if(!['POST','DELETE'].includes(req.method))throw error(405,'Метод не поддерживается.');
   const input=await readJson(req,4096);
   async function currentAccount(){
    const current=await accounts.identify(req);
    if(!current||current.id!==user.id||input.userId!==undefined&&input.userId!==current.id)throw error(401,'Сеанс изменился.');
    return current;
   }
   if(req.method==='POST'){
    if(!configured)throw error(503,'Push-уведомления выключены на сервере.');
    const endpoint=input.endpoint,keys=input.keys||{};if(!validEndpoint(endpoint))throw error(400,'Неподдерживаемый сервис push-уведомлений.');
    try{encryptPayload('x',{p256dh:keys.p256dh,auth:keys.auth});}catch{throw error(400,'Некорректные ключи подписки.');}
    const result=await transact(async db=>{
     const current=await currentAccount();
     if(!hasSubscription(current,now()))throw error(403,'Уведомления доступны по подписке PRO или EXCLUSIVE.','SUBSCRIPTION_REQUIRED');
     const existing=db.subscriptions.find(s=>s.endpoint===endpoint&&s.userId===user.id);
     if(existing&&existing.p256dh===keys.p256dh&&existing.auth===keys.auth)return {devices:db.subscriptions.filter(s=>s.userId===user.id).length};
     db.subscriptions=db.subscriptions.filter(s=>s.endpoint!==endpoint);const mine=db.subscriptions.filter(s=>s.userId===user.id);
     if(mine.length>=MAX_PER_USER)db.subscriptions=db.subscriptions.filter(s=>s!==mine[0]);
     if(db.subscriptions.length>=MAX_TOTAL)throw error(409,'Хранилище подписок заполнено.');
     db.subscriptions.push({id:randomUUID(),userId:user.id,endpoint,p256dh:keys.p256dh,auth:keys.auth,createdAt:existing?.createdAt||new Date(now()).toISOString()});
     return {devices:db.subscriptions.filter(s=>s.userId===user.id).length};
    });
    json(res,200,result);return true;
   }
   const result=await transact(async db=>{await currentAccount();db.subscriptions=db.subscriptions.filter(s=>!(s.userId===user.id&&(!input.endpoint||s.endpoint===input.endpoint)));return {devices:db.subscriptions.filter(s=>s.userId===user.id).length};});
   json(res,200,result);return true;
  }catch(cause){if(cause.status)json(res,cause.status,{error:cause.message,...(cause.code?{code:cause.code}:{})});else safeFailure(res,cause,{scope:'push',route:url.pathname});}
  return true;
 }
 return {configured,handle,send,has,earliest};
}
