import {randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual, createHash} from 'node:crypto';
import {promisify} from 'node:util';
import {mkdir,readFile,writeFile,rename} from 'node:fs/promises';
import path from 'node:path';
import {validatePosition} from './positions.mjs';
const scrypt=promisify(scryptCallback), digest=s=>createHash('sha256').update(s).digest('hex');
export async function createAccounts(directory){
 await mkdir(directory,{recursive:true,mode:0o700});const file=path.join(directory,'accounts.json');
 let db;try{db=JSON.parse(await readFile(file,'utf8'));if(db.version!==1||!Array.isArray(db.users)||!Array.isArray(db.sessions))throw Error('Invalid accounts database')}catch(e){if(e.code!=='ENOENT')throw e;db={version:1,users:[],sessions:[]}}
 let queue=Promise.resolve();
 function transaction(fn){const job=queue.then(async()=>{const next=structuredClone(db),value=fn(next);await writeFile(file+'.tmp',JSON.stringify(next),{mode:0o600});await rename(file+'.tmp',file);db=next;return value});queue=job.catch(()=>{});return job}
 const attempts=new Map();
 function limited(req){const key=req.socket.remoteAddress,now=Date.now();let a=attempts.get(key);if(!a||now>a.until){a={count:0,until:now+900000};attempts.set(key,a)}return ++a.count>25}
 function session(req){const token=req.headers.cookie?.split(';').map(x=>x.trim()).find(x=>x.startsWith('orbita_session='))?.slice(15);return token?db.sessions.find(s=>s.hash===digest(token)&&s.expires>Date.now()):null}
 function user(req){const s=session(req);return s?db.users.find(u=>u.id===s.userId):null}
 function reply(res,status,obj,cookie){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...(cookie?{'Set-Cookie':cookie}:{})});res.end(JSON.stringify(obj))}
 const cookie=(token,age=604800)=>`orbita_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${age}`;
 async function body(req){let chunks=[],size=0;for await(const c of req){size+=c.length;if(size>16384)throw Object.assign(Error('Слишком большой запрос'),{status:413});chunks.push(c)}try{return JSON.parse(Buffer.concat(chunks).toString())}catch{throw Object.assign(Error('Некорректный запрос'),{status:400})}}
 const publicUser=u=>({id:u.id,email:u.email});
 async function handle(req,res,url){if(!url.pathname.startsWith('/api/'))return false;
 try{
  if(!['localhost','127.0.0.1'].includes(url.hostname)){reply(res,403,{error:'Локальный сервер'});return true}
  if(!['GET','HEAD'].includes(req.method)&&req.headers.origin!==url.origin){reply(res,403,{error:'Недопустимый источник запроса'});return true}
  const route=url.pathname;
  if(route==='/api/me'&&req.method==='GET'){const u=user(req);reply(res,200,{user:u?publicUser(u):null});return true}
  if(['/api/register','/api/login'].includes(route)&&req.method==='POST'){
   if(limited(req)){reply(res,429,{error:'Слишком много попыток. Подождите 15 минут.'});return true}
   const b=await body(req),email=String(b.email||'').trim().toLowerCase(),password=b.password;
   if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||email.length>254||typeof password!=='string'||password.length<10||password.length>128){reply(res,400,{error:'Укажите email и пароль от 10 до 128 символов.'});return true}
   let u=db.users.find(u=>u.email===email);
   if(route==='/api/register'){
    const salt=randomBytes(16).toString('hex'),hash=(await scrypt(password,salt,64)).toString('hex');
    u=await transaction(d=>{if(d.users.some(x=>x.email===email))throw Object.assign(Error('Этот email уже зарегистрирован. Войдите в аккаунт.'),{status:409});const n={id:randomUUID(),email,salt,hash,watchlist:[],createdAt:new Date().toISOString()};d.users.push(n);return n});
   }else{
    const hash=await scrypt(password,u?.salt||'orbita-dummy-salt',64);
    if(!u||!timingSafeEqual(hash,Buffer.from(u.hash,'hex'))){reply(res,401,{error:'Неверный email или пароль.'});return true}
   }
   const token=randomBytes(32).toString('hex'),old=session(req);
   await transaction(d=>{d.sessions=d.sessions.filter(s=>s.expires>Date.now()&&s.hash!==old?.hash);d.sessions.push({hash:digest(token),userId:u.id,expires:Date.now()+604800000})});
   reply(res,200,{user:publicUser(u)},cookie(token));return true;
  }
  if(route==='/api/logout'&&req.method==='POST'){const s=session(req);if(s)await transaction(d=>{d.sessions=d.sessions.filter(x=>x.hash!==s.hash)});reply(res,200,{ok:true},cookie('',0));return true}
  if(route==='/api/watchlist'&&['GET','PUT'].includes(req.method)){
   const u=user(req);if(!u){reply(res,401,{error:'Войдите в аккаунт.'});return true}
   if(req.method==='GET'){reply(res,200,{ids:u.watchlist});return true}
   const b=await body(req);if(!Array.isArray(b.ids)||b.ids.length>500||b.ids.some(id=>typeof id!=='string'||!/^[a-zA-Z0-9_-]{1,100}$/.test(id))){reply(res,400,{error:'Некорректный список идей'});return true}
   await transaction(d=>{d.users.find(x=>x.id===u.id).watchlist=[...new Set(b.ids)]});reply(res,200,{ok:true});return true;
  }
  if(route==='/api/positions'&&['GET','PUT','DELETE'].includes(req.method)){
   const u=user(req);if(!u){reply(res,401,{error:'Войдите в аккаунт.'});return true}
   if(req.method==='GET'){reply(res,200,{positions:u.positions||[]});return true}
   const b=await body(req);
   if(req.method==='PUT'){
    const position=validatePosition(b);
    await transaction(d=>{const owner=d.users.find(x=>x.id===u.id);const positions=owner.positions||[];if(positions.length>=500&&!positions.some(p=>p.ideaId===position.ideaId))throw Object.assign(Error('Не больше 500 личных сделок.'),{status:400});owner.positions=[...positions.filter(p=>p.ideaId!==position.ideaId),position]});
   }else{
    if(typeof b.ideaId!=='string'||!/^[a-zA-Z0-9_-]{1,100}$/.test(b.ideaId))throw Object.assign(Error('Некорректная идея'),{status:400});
    await transaction(d=>{const owner=d.users.find(x=>x.id===u.id);owner.positions=(owner.positions||[]).filter(p=>p.ideaId!==b.ideaId)});
   }
   reply(res,200,{ok:true});return true;
  }
  reply(res,404,{error:'Неизвестный запрос'});
 }catch(e){reply(res,e.status||500,{error:e.status?e.message:'Не удалось сохранить данные. Повторите попытку.'})}
 return true;
 }
 return {handle};
}
