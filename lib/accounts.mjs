import {randomBytes,randomUUID,scrypt as scryptCallback,timingSafeEqual,createHash} from 'node:crypto';
import {promisify} from 'node:util';
import {mkdir,readFile,writeFile,rename,rm,stat} from 'node:fs/promises';
import path from 'node:path';
import {validatePosition} from './positions.mjs';
import {LEGAL_VERSION,PLANS,publicUser,requireAdmin,requireMember} from './access.mjs';
import {json,readJson,error,originPolicy} from './http.mjs';
const scrypt=promisify(scryptCallback),digest=s=>createHash('sha256').update(s).digest('hex');
export async function createAccounts(directory,{publicOrigin=process.env.ORBITA_PUBLIC_ORIGIN||''}={}){
 await mkdir(directory,{recursive:true,mode:0o700});const file=path.join(directory,'accounts.json'),policy=originPolicy(publicOrigin);
 async function load(){try{const db=JSON.parse(await readFile(file,'utf8'));if(db.version!==1||!Array.isArray(db.users)||!Array.isArray(db.sessions))throw Error('Invalid accounts database');return db;}catch(e){if(e.code==='ENOENT')return {version:1,users:[],sessions:[],accessAudit:[]};throw e;}}
 await load();let queue=Promise.resolve();
 async function acquire(){const lock=file+'.lock',deadline=Date.now()+5000;while(true){try{await mkdir(lock,{mode:0o700});try{await writeFile(path.join(lock,'owner.json'),JSON.stringify({pid:process.pid}),{mode:0o600});}catch(e){await rm(lock,{recursive:true,force:true});throw e;}return lock;}catch(e){if(e.code!=='EEXIST')throw e;try{const owner=JSON.parse(await readFile(path.join(lock,'owner.json'),'utf8'));try{process.kill(owner.pid,0);}catch(gone){if(gone.code==='ESRCH'){await rm(lock,{recursive:true,force:true});continue;}}}catch(missing){if(missing.code==='ENOENT'){try{if(Date.now()-(await stat(lock)).mtimeMs>30000){await rm(lock,{recursive:true,force:true});continue;}}catch{}}}if(Date.now()>deadline)throw error(409,'База аккаунтов занята. Повторите запрос.');await new Promise(resolve=>setTimeout(resolve,25));}}}
 function transaction(fn){const job=queue.then(async()=>{const lock=await acquire();let temp;try{const db=await load(),value=await fn(db);temp=file+'.tmp-'+randomUUID();await writeFile(temp,JSON.stringify(db),{mode:0o600});await rename(temp,file);temp=null;return value;}finally{if(temp)await rm(temp,{force:true});await rm(lock,{recursive:true,force:true});}});queue=job.catch(()=>{});return job;}
 function session(req,db){const token=req.headers.cookie?.split(';').map(x=>x.trim()).find(x=>x.startsWith('orbita_session='))?.slice(15);return token?db.sessions.find(s=>s.hash===digest(token)&&s.expires>Date.now()):null;}
 async function identify(req){const db=await load(),s=session(req,db);return s?publicUser(db.users.find(u=>u.id===s.userId)):null;}
 const cookie=(token,age=604800)=>`orbita_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${age}${policy.secure?'; Secure':''}`;
 const attempts=new Map();
 function limited(req,email){const now=Date.now();for(const [key,value]of attempts)if(value.until<now)attempts.delete(key);const keys=['ip:'+req.socket.remoteAddress,'email:'+email];let blocked=false;for(const key of keys){let a=attempts.get(key);if(!a){a={count:0,until:now+900000};attempts.set(key,a);}a.count++;if(a.count>(key.startsWith('email:')?12:100))blocked=true;}return blocked;}
 const known=new Set(['/api/me','/api/register','/api/login','/api/logout','/api/watchlist','/api/positions','/api/admin/users','/api/admin/subscriptions']);
 async function handle(req,res,url){if(!known.has(url.pathname))return false;
 try{
  policy.check(req);const route=url.pathname;
  if(route==='/api/me'&&req.method==='GET'){json(res,200,{user:await identify(req),legalVersion:LEGAL_VERSION});return true;}
  if(['/api/register','/api/login'].includes(route)&&req.method==='POST'){
   const b=await readJson(req),email=String(b.email||'').trim().toLowerCase(),password=b.password;
   if(limited(req,email)){json(res,429,{error:'Слишком много попыток. Подождите 15 минут.'});return true;}
   if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||email.length>254||typeof password!=='string'||password.length<10||password.length>128)throw error(400,'Укажите email и пароль от 10 до 128 символов.');
   let u;
   if(route==='/api/register'){
    if(b.acceptTerms!==true||b.acceptPrivacy!==true||b.legalVersion!==LEGAL_VERSION)throw error(400,'Для регистрации подтвердите оферту и согласие на обработку персональных данных.');
    const salt=randomBytes(16).toString('hex'),hash=(await scrypt(password,salt,64)).toString('hex');
    u=await transaction(db=>{if(db.users.some(x=>x.email===email))throw error(409,'Этот email уже зарегистрирован. Войдите в аккаунт.');const n={id:randomUUID(),email,salt,hash,role:'member',subscriptions:[],watchlist:[],positions:[],createdAt:new Date().toISOString(),consents:{legalVersion:LEGAL_VERSION,terms:true,privacy:true,acceptedAt:new Date().toISOString()}};db.users.push(n);return n;});
   }else{
    const db=await load();u=db.users.find(x=>x.email===email);const hash=await scrypt(password,u?.salt||'orbita-dummy-salt',64);const expected=u?Buffer.from(u.hash,'hex'):null;
    if(!expected||expected.length!==hash.length||!timingSafeEqual(hash,expected))throw error(401,'Неверный email или пароль.');
   }
   const token=randomBytes(32).toString('hex');await transaction(db=>{const old=session(req,db);db.sessions=db.sessions.filter(s=>s.expires>Date.now()&&s.hash!==old?.hash);db.sessions.push({hash:digest(token),userId:u.id,expires:Date.now()+604800000});});json(res,200,{user:publicUser(u)},{'Set-Cookie':cookie(token)});return true;
  }
  if(route==='/api/logout'&&req.method==='POST'){await transaction(db=>{const old=session(req,db);if(old)db.sessions=db.sessions.filter(s=>s.hash!==old.hash);});json(res,200,{ok:true},{'Set-Cookie':cookie('',0)});return true;}
  const owner=await identify(req);
  if(route==='/api/admin/users'&&req.method==='GET'){requireAdmin(owner);const db=await load();json(res,200,{users:db.users.map(publicUser)});return true;}
  if(route==='/api/admin/subscriptions'&&req.method==='POST'){
   requireAdmin(owner);const b=await readJson(req);if(typeof b.userId!=='string'||!Object.hasOwn(PLANS,b.plan)||typeof b.reason!=='string'||!b.reason.trim()||b.reason.length>1000)throw error(400,'Укажите пользователя, тариф и основание изменения доступа.');
   let expiresAt=null;if(b.expiresAt!==null){const expiry=Date.parse(b.expiresAt);if(!Number.isFinite(expiry)||expiry<=Date.now()||expiry>Date.now()+3660*86400000)throw error(400,'Укажите будущую дату окончания подписки.');expiresAt=new Date(expiry).toISOString();}
   const updated=await transaction(db=>{const u=db.users.find(x=>x.id===b.userId);if(!u)throw error(404,'Аккаунт не найден.');u.subscriptions=(u.subscriptions||[]).filter(s=>s.plan!==b.plan);if(expiresAt)u.subscriptions.push({plan:b.plan,expiresAt});db.accessAudit??=[];db.accessAudit.push({id:randomUUID(),actorId:owner.id,userId:u.id,plan:b.plan,expiresAt,reason:b.reason.trim(),at:new Date().toISOString()});return publicUser(u);});json(res,200,{user:updated});return true;
  }
  if(route==='/api/watchlist'&&['GET','PUT'].includes(req.method)){
   requireMember(owner);const db=await load(),u=db.users.find(x=>x.id===owner.id);if(req.method==='GET'){json(res,200,{ids:u.watchlist||[]});return true;}
   const b=await readJson(req);if(!Array.isArray(b.ids)||b.ids.length>500||b.ids.some(id=>typeof id!=='string'||!/^[a-zA-Z0-9_-]{1,100}$/.test(id)))throw error(400,'Некорректный список идей.');await transaction(db=>{db.users.find(x=>x.id===owner.id).watchlist=[...new Set(b.ids)];});json(res,200,{ok:true});return true;
  }
  if(route==='/api/positions'&&['GET','PUT','DELETE'].includes(req.method)){
   requireMember(owner);if(req.method==='GET'){const db=await load();json(res,200,{positions:db.users.find(x=>x.id===owner.id).positions||[]});return true;}
   const b=await readJson(req);if(req.method==='PUT'){const position=validatePosition(b);await transaction(db=>{const u=db.users.find(x=>x.id===owner.id),positions=u.positions||[];if(positions.length>=500&&!positions.some(p=>p.ideaId===position.ideaId))throw error(400,'Не больше 500 личных сделок.');u.positions=[...positions.filter(p=>p.ideaId!==position.ideaId),position];});}else{if(typeof b.ideaId!=='string'||!/^[a-zA-Z0-9_-]{1,100}$/.test(b.ideaId))throw error(400,'Некорректная идея.');await transaction(db=>{const u=db.users.find(x=>x.id===owner.id);u.positions=(u.positions||[]).filter(p=>p.ideaId!==b.ideaId);});}json(res,200,{ok:true});return true;
  }
  throw error(405,'Метод не поддерживается.');
 }catch(e){json(res,e.status||500,{error:e.status?e.message:'Не удалось обработать запрос. Повторите попытку.',...(e.code&&e.status?{code:e.code}:{})});}return true;
 }
 async function promote(email){return transaction(db=>{const u=db.users.find(x=>x.email===String(email).trim().toLowerCase());if(!u)throw Error('Сначала зарегистрируйте этот email через сайт.');u.role='admin';db.accessAudit??=[];db.accessAudit.push({id:randomUUID(),actorId:'server-cli',userId:u.id,action:'promote-admin',at:new Date().toISOString()});return publicUser(u);});}
 return {handle,identify,checkRequest:policy.check,promote};
}
