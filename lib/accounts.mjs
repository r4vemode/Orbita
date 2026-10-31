import {randomBytes,randomUUID,timingSafeEqual,createHash} from 'node:crypto';
import {mkdir,readFile,writeFile,rename,rm,stat,lstat,open} from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {validatePosition} from './positions.mjs';
import {LEGAL_VERSION,PLANS,publicUser,requireAdmin,requireMember} from './access.mjs';
import {json,readJson,error,originPolicy,safeFailure} from './http.mjs';
import {createSecretVault,newToken,tokenHash,base32,verifyTotp,makeRecoveryCodes,recoveryHash} from './account-security.mjs';
import {createMailer,securityEmail} from './mail.mjs';
import {derivePassword} from './password-work.mjs';
import {requestAddress} from './request-security.mjs';
import {createAttemptLimiter} from './auth-limits.mjs';
const digest=s=>createHash('sha256').update(s).digest('hex');
export const MAX_ACCOUNT_BYTES=32*1024*1024;
export function validateAccountsDatabase(db){try{return db?.version===1&&Array.isArray(db.users)&&Array.isArray(db.sessions)&&[...db.users,...db.sessions].every(value=>value!==null&&typeof value==='object'&&!Array.isArray(value))&&Buffer.byteLength(JSON.stringify(db))<=MAX_ACCOUNT_BYTES;}catch{return false;}}
export async function createAccounts(directory,{publicOrigin=process.env.ORBITA_PUBLIC_ORIGIN||'',mailer=createMailer(),requireAdminMfa=publicOrigin.startsWith('https://'),legalVersionProvider=()=>LEGAL_VERSION}={}){
 if(typeof legalVersionProvider!=='function')throw Error('legalVersionProvider must be a function');
 async function currentLegalVersion(){
  let version;try{version=await legalVersionProvider();}catch{throw error(503,'Условия регистрации временно недоступны. Повторите попытку позже.','LEGAL_VERSION_UNAVAILABLE');}
  if(typeof version!=='string'||!/^ORBITA-[A-Za-z0-9.-]{1,100}$/.test(version))throw error(503,'Условия регистрации временно недоступны. Повторите попытку позже.','LEGAL_VERSION_UNAVAILABLE');
  return version;
 }
 const changedLegalVersion=()=>error(409,'Документы обновились. Ознакомьтесь с новой редакцией и подтвердите согласия ещё раз.','LEGAL_VERSION_CHANGED');
 await mkdir(directory,{recursive:true,mode:0o700});const file=path.join(directory,'accounts.json'),policy=originPolicy(publicOrigin);
 async function load(){let handle;try{const info=await lstat(file);if(!info.isFile()||info.isSymbolicLink()||info.size>MAX_ACCOUNT_BYTES)throw Object.assign(Error('Unsafe accounts database'),{code:'DATA_UNSAFE'});handle=await open(file,constants.O_RDONLY|(constants.O_NOFOLLOW||0));const actual=await handle.stat();if(!actual.isFile()||actual.size>MAX_ACCOUNT_BYTES)throw Object.assign(Error('Unsafe accounts database'),{code:'DATA_UNSAFE'});const bytes=await handle.readFile();if(bytes.length>MAX_ACCOUNT_BYTES)throw Object.assign(Error('Oversized accounts database'),{code:'DATA_UNSAFE'});const db=JSON.parse(bytes.toString('utf8'));if(!validateAccountsDatabase(db))throw Object.assign(Error('Invalid accounts database'),{code:'DATA_INVALID'});return db;}catch(e){if(e.code==='ENOENT')return {version:1,users:[],sessions:[],accessAudit:[]};if(e instanceof SyntaxError)throw Object.assign(Error('Invalid accounts database'),{code:'DATA_INVALID'});if(e.code==='ELOOP')throw Object.assign(Error('Unsafe accounts database'),{code:'DATA_UNSAFE'});throw e;}finally{await handle?.close();}}
 await load();const vault=await createSecretVault(directory),mailConfigured=Boolean(publicOrigin&&(typeof mailer==='function'||mailer.configured));let queue=Promise.resolve();
 async function acquire(){const lock=file+'.lock',deadline=Date.now()+5000;while(true){try{await mkdir(lock,{mode:0o700});try{await writeFile(path.join(lock,'owner.json'),JSON.stringify({pid:process.pid}),{mode:0o600});}catch(e){await rm(lock,{recursive:true,force:true});throw e;}return lock;}catch(e){if(e.code!=='EEXIST')throw e;try{const owner=JSON.parse(await readFile(path.join(lock,'owner.json'),'utf8'));try{process.kill(owner.pid,0);}catch(gone){if(gone.code==='ESRCH'){await rm(lock,{recursive:true,force:true});continue;}}}catch(missing){if(missing.code==='ENOENT'){try{if(Date.now()-(await stat(lock)).mtimeMs>30000){await rm(lock,{recursive:true,force:true});continue;}}catch{}}}if(Date.now()>deadline)throw error(409,'База аккаунтов занята. Повторите запрос.');await new Promise(resolve=>setTimeout(resolve,25));}}}
 function transaction(fn){const job=queue.then(async()=>{const lock=await acquire();let temp;try{const db=await load(),value=await fn(db),bytes=JSON.stringify(db);if(Buffer.byteLength(bytes)>MAX_ACCOUNT_BYTES)throw error(409,'Хранилище аккаунтов заполнено. Обратитесь в поддержку.','ACCOUNT_STORAGE_LIMIT');if(!validateAccountsDatabase(db))throw Object.assign(Error('Invalid accounts update'),{code:'DATA_INVALID'});temp=file+'.tmp-'+randomUUID();await writeFile(temp,bytes,{mode:0o600,flag:'wx'});await rename(temp,file);temp=null;return value;}finally{if(temp)await rm(temp,{force:true});await rm(lock,{recursive:true,force:true});}});queue=job.catch(()=>{});return job;}
 function session(req,db){const token=req.headers.cookie?.split(';').map(x=>x.trim()).find(x=>x.startsWith('orbita_session='))?.slice(15);return token?db.sessions.find(s=>s.hash===digest(token)&&s.expires>Date.now()):null;}
 function expose(u,s=null,trusted=false){if(!u)return null;const enabled=Boolean(u.mfa?.enabled),adminEnrollmentRequired=u.role==='admin'&&requireAdminMfa&&!enabled;const effective={...u,role:u.role==='admin'&&((adminEnrollmentRequired)||(!trusted&&enabled&&!s?.mfa))?'member':u.role};return {...publicUser(effective),emailVerified:u.emailVerified===true,security:{mfaEnabled:enabled,adminEnrollmentRequired,mfaRequiredForAdmin:u.role==='admin'&&requireAdminMfa}};}
 async function identify(req){const db=await load(),s=session(req,db);return s?expose(db.users.find(u=>u.id===s.userId),s):null;}
 async function passwordMatches(u,password){if(typeof password!=='string'||password.length>128)return false;const actual=await derivePassword(password,u?.salt||'orbita-dummy-salt',64),expected=u?Buffer.from(u.hash,'hex'):null;return Boolean(expected&&expected.length===actual.length&&timingSafeEqual(actual,expected));}
 function auth(req,db){const s=session(req,db),u=s&&db.users.find(x=>x.id===s.userId);if(!u)throw error(401,'Войдите в аккаунт.');return {u,s};}
 function authorizedAccount(req,db,expectedId,{admin=false}={}){const current=auth(req,db);if(current.u.id!==expectedId)throw error(401,'Сеанс изменился. Войдите заново.');(admin?requireAdmin:requireMember)(expose(current.u,current.s));return current;}
 function issueToken(db,u,purpose,ttl){const token=newToken();db.securityTokens=(db.securityTokens||[]).filter(t=>t.expires>Date.now()&&!(t.userId===u.id&&t.purpose===purpose));db.securityTokens.push({hash:tokenHash(token),userId:u.id,purpose,expires:Date.now()+ttl});return token;}
 async function sendSecurityMail(u,purpose,token,context={}){if(!mailConfigured)return {sent:false,reason:'not_configured'};try{const payload=securityEmail(purpose,u.email,token,publicOrigin,context),result=await (typeof mailer==='function'?mailer(payload):mailer.send(payload));return result?.delivered===true?{sent:true}:{sent:false,reason:result?.reason||'delivery_failed'};}catch{return {sent:false,reason:'delivery_failed'};}}
 const pendingMail=new Set();
 function dispatchSecurityMail(u,purpose,token){if(pendingMail.size>=32)return;const job=sendSecurityMail(u,purpose,token);pendingMail.add(job);job.finally(()=>pendingMail.delete(job));}
 function consumeMfa(u,code){const counter=verifyTotp(vault.decrypt(u.mfa.secret),code,{lastCounter:u.mfa.lastCounter??-1});if(counter!==null){u.mfa.lastCounter=counter;return true;}const hash=recoveryHash(code),index=(u.mfa.recoveryHashes||[]).indexOf(hash);if(index<0)return false;u.mfa.recoveryHashes.splice(index,1);return true;}
 function mintSession(db,req,u,mfa=false){const token=newToken(),old=session(req,db);db.sessions=db.sessions.filter(s=>s.expires>Date.now()&&s.hash!==old?.hash);const s={hash:digest(token),userId:u.id,expires:Date.now()+604800000,mfa};db.sessions.push(s);return {token,user:expose(u,s)};}
 const securityAttempts=createAttemptLimiter();
 function securityLimit(req,scope,key,max=8){if(!securityAttempts.take([[scope+':ip:'+requestAddress(req),max*5],[scope+':key:'+tokenHash(key),max]]))throw error(429,'Слишком много попыток. Подождите 15 минут.');}

 async function authorizeSensitive(req,{password,code}={}){
  policy.check(req);if(req.method!=='POST')throw error(405,'Для подтверждения действия используйте POST.');
  const {u,s}=auth(req,await load());requireAdmin(expose(u,s));securityLimit(req,'sensitive-admin',u.id,5);
  if(!await passwordMatches(u,password))throw error(401,'Неверный пароль.');
  const outcome=await transaction(db=>{
   const {u:current,s:currentSession}=auth(req,db);requireAdmin(expose(current,currentSession));
   if(current.id!==u.id||current.hash!==u.hash||currentSession.hash!==s.hash)throw error(401,'Сеанс изменился. Войдите заново и повторите действие.');
   // Consume a fresh second factor atomically. An already authenticated MFA
   // session alone must not authorize a new sensitive publication.
   if(current.mfa?.enabled&&!consumeMfa(current,code))return {failed:true};
   return {user:expose(current,currentSession)};
  });
  if(outcome.failed)throw error(401,'Неверный или использованный код. Подтвердите действие новым кодом второго фактора.');
  return outcome.user;
 }

 const cookie=(token,age=604800)=>`orbita_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${age}${policy.secure?'; Secure':''}`;
 const attempts=createAttemptLimiter();
 function limited(req,email){return !attempts.take([['ip:'+requestAddress(req),100],['email:'+tokenHash(email),12]]);}
 const securityPaths=['status','verify-email','resend-verification','request-password-reset','reset-password','mfa/setup','mfa/confirm','mfa/login','mfa/disable','mfa/recovery'];
 const known=new Set([...securityPaths.map(x=>'/api/security/'+x),'/api/me','/api/register','/api/login','/api/logout','/api/watchlist','/api/positions','/api/admin/users','/api/admin/subscriptions']);
 async function handle(req,res,url){if(!known.has(url.pathname))return false;
 try{
  policy.check(req);const route=url.pathname;
  if(route==='/api/me'&&req.method==='GET'){json(res,200,{user:await identify(req),legalVersion:await currentLegalVersion()});return true;}
  if(route.startsWith('/api/security/'))return await handleSecurity(req,res,route);
  if(['/api/register','/api/login'].includes(route)&&req.method==='POST'){
   const b=await readJson(req),email=String(b.email||'').trim().toLowerCase(),password=b.password;
   if(limited(req,email)){json(res,429,{error:'Слишком много попыток. Подождите 15 минут.'});return true;}
   if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||email.length>254||typeof password!=='string'||password.length<10||password.length>128)throw error(400,'Укажите email и пароль от 10 до 128 символов.');
   let u;
   if(route==='/api/register'){
    if(b.acceptTerms!==true||b.acceptPrivacy!==true)throw error(400,'Для регистрации подтвердите оферту и согласие на обработку персональных данных.');
    const acceptedVersion=await currentLegalVersion();if(b.legalVersion!==acceptedVersion)throw changedLegalVersion();
    const salt=randomBytes(16).toString('hex'),hash=(await derivePassword(password,salt,64)).toString('hex');
    const registration=await transaction(async db=>{
     if(await currentLegalVersion()!==acceptedVersion)throw changedLegalVersion();
     // Aggregate valid submissions only; no email, body, IP or attempt history is recorded.
     const at=new Date().toISOString();db.registrationStats??={startedAt:at,validAttempts:0,successful:0};const stats=db.registrationStats;
     if(!stats||typeof stats.startedAt!=='string'||!Number.isFinite(Date.parse(stats.startedAt))||!Number.isSafeInteger(stats.validAttempts)||stats.validAttempts<0||stats.validAttempts>=Number.MAX_SAFE_INTEGER||!Number.isSafeInteger(stats.successful)||stats.successful<0||stats.successful>stats.validAttempts)throw Object.assign(Error('Invalid registration counters'),{code:'DATA_INVALID'});
     stats.validAttempts++;
     if(db.users.some(x=>x.email===email))return {duplicate:true};
     const n={id:randomUUID(),email,salt,hash,role:'member',subscriptions:[],watchlist:[],positions:[],createdAt:at,emailVerified:false,consents:{legalVersion:acceptedVersion,terms:true,privacy:true,acceptedAt:at}};db.users.push(n);stats.successful++;return {user:n};
    });
    if(registration.duplicate)throw error(409,'Этот email уже зарегистрирован. Войдите в аккаунт.');u=registration.user;
   }else{
    const db=await load();u=db.users.find(x=>x.email===email);if(!await passwordMatches(u,password))throw error(401,'Неверный email или пароль.');
   }
   const result=await transaction(db=>{const current=db.users.find(x=>x.id===u.id);if(!current||current.hash!==u.hash)throw error(401,'Повторите вход.');if(current.mfa?.enabled){const challenge=newToken();db.authChallenges=(db.authChallenges||[]).filter(c=>c.expires>Date.now());db.authChallenges.push({hash:tokenHash(challenge),userId:u.id,passwordHash:u.hash,expires:Date.now()+300000,attempts:0});return {mfaRequired:true,challenge};}return mintSession(db,req,current);});
   if(result.mfaRequired){json(res,200,result);return true;}
   let verification;if(route==='/api/register'){const token=await transaction(db=>issueToken(db,u,'verify',86400000));verification=await sendSecurityMail(u,'verify',token,{plan:b.plan});}
   json(res,200,{user:result.user,...(verification?{verification}:{})},{'Set-Cookie':cookie(result.token)});return true;
  }
  if(route==='/api/logout'&&req.method==='POST'){await transaction(db=>{const old=session(req,db);if(old)db.sessions=db.sessions.filter(s=>s.hash!==old.hash);});json(res,200,{ok:true},{'Set-Cookie':cookie('',0)});return true;}
  const owner=await identify(req);
  if(route==='/api/admin/users'&&req.method==='GET'){requireAdmin(owner);const db=await load();json(res,200,{users:db.users.map(u=>expose(u,null,true))});return true;}
  if(route==='/api/admin/subscriptions'&&req.method==='POST'){
   requireAdmin(owner);const b=await readJson(req);if(typeof b.userId!=='string'||!Object.hasOwn(PLANS,b.plan)||typeof b.reason!=='string'||!b.reason.trim()||b.reason.length>1000)throw error(400,'Укажите пользователя, тариф и основание изменения доступа.');
   let expiresAt=null;if(b.expiresAt!==null){const expiry=Date.parse(b.expiresAt);if(!Number.isFinite(expiry)||expiry<=Date.now()||expiry>Date.now()+3660*86400000)throw error(400,'Укажите будущую дату окончания подписки.');expiresAt=new Date(expiry).toISOString();}
   const updated=await transaction(db=>{authorizedAccount(req,db,owner.id,{admin:true});const u=db.users.find(x=>x.id===b.userId);if(!u)throw error(404,'Аккаунт не найден.');u.subscriptions=(u.subscriptions||[]).filter(s=>s.plan!==b.plan);if(expiresAt)u.subscriptions.push({plan:b.plan,expiresAt});const ledger=(db.entitlementLedgers||[]).find(x=>x.userId===u.id&&x.plan===b.plan);if(ledger){ledger.events.push({kind:'manual',at:Date.now(),expiresAt});ledger.projection=expiresAt;}db.accessAudit??=[];db.accessAudit.push({id:randomUUID(),actorId:owner.id,userId:u.id,plan:b.plan,expiresAt,reason:b.reason.trim(),at:new Date().toISOString()});return expose(u,null,true);});json(res,200,{user:updated});return true;
  }
  if(route==='/api/watchlist'&&['GET','PUT'].includes(req.method)){
   requireMember(owner);const db=await load(),{u}=authorizedAccount(req,db,owner.id);if(req.method==='GET'){json(res,200,{ids:u.watchlist||[]});return true;}
   const b=await readJson(req);if(!Array.isArray(b.ids)||b.ids.length>500||b.ids.some(id=>typeof id!=='string'||!/^[a-zA-Z0-9_-]{1,100}$/.test(id)))throw error(400,'Некорректный список идей.');await transaction(db=>{const {u:current}=authorizedAccount(req,db,owner.id);current.watchlist=[...new Set(b.ids)];});json(res,200,{ok:true});return true;
  }
  if(route==='/api/positions'&&['GET','PUT','DELETE'].includes(req.method)){
   requireMember(owner);if(req.method==='GET'){const db=await load(),{u}=authorizedAccount(req,db,owner.id);json(res,200,{positions:u.positions||[]});return true;}
   const b=await readJson(req);if(req.method==='PUT'){const position=validatePosition(b);await transaction(db=>{const {u}=authorizedAccount(req,db,owner.id),positions=u.positions||[];if(positions.length>=500&&!positions.some(p=>p.ideaId===position.ideaId))throw error(400,'Не больше 500 личных сделок.');u.positions=[...positions.filter(p=>p.ideaId!==position.ideaId),position];});}else{if(typeof b.ideaId!=='string'||!/^[a-zA-Z0-9_-]{1,100}$/.test(b.ideaId))throw error(400,'Некорректная идея.');await transaction(db=>{const {u}=authorizedAccount(req,db,owner.id);u.positions=(u.positions||[]).filter(p=>p.ideaId!==b.ideaId);});}json(res,200,{ok:true});return true;
  }
  throw error(405,'Метод не поддерживается.');
 }catch(e){
  if(e.status){json(res,e.status,{error:e.message,...(e.code?{code:e.code}:{})});}
  else safeFailure(res,e,{scope:'accounts',route:url.pathname,storageMessage:'Сервер временно не может сохранить данные аккаунта. Обратитесь в поддержку и укажите код обращения.',storageCode:'ACCOUNT_STORAGE_UNAVAILABLE',failureCode:'ACCOUNT_REQUEST_FAILED'});
 }return true;
 }
 async function handleSecurity(req,res,route){
  if(route==='/api/security/status'&&req.method==='GET'){json(res,200,{user:await identify(req),mailConfigured,publicOriginConfigured:Boolean(publicOrigin)});return true;}
  if(req.method!=='POST')throw error(405,'Метод не поддерживается.');
  const b=await readJson(req);
  if(route==='/api/security/verify-email'){
   securityLimit(req,'verify',tokenHash(b.token||''),20);if(typeof b.token!=='string'||!/^[a-f0-9]{64}$/.test(b.token))throw error(400,'Ссылка недействительна или срок её действия истёк.');
   await transaction(db=>{const t=(db.securityTokens||[]).find(t=>t.hash===tokenHash(b.token)&&t.purpose==='verify'&&t.expires>Date.now()),u=t&&db.users.find(x=>x.id===t.userId);if(!u)throw error(400,'Ссылка недействительна или срок её действия истёк.');u.emailVerified=true;u.emailVerifiedAt=new Date().toISOString();db.securityTokens=db.securityTokens.filter(x=>!(x.userId===u.id&&x.purpose==='verify'));});json(res,200,{ok:true});return true;
  }
  if(route==='/api/security/resend-verification'){
   const db=await load(),{u}=auth(req,db);securityLimit(req,'resend',u.id,5);if(u.emailVerified){json(res,200,{ok:true,sent:false,reason:'already_verified'});return true;}
   const token=await transaction(db=>issueToken(db,u,'verify',86400000));json(res,200,{ok:true,...await sendSecurityMail(u,'verify',token,{plan:b.plan})});return true;
  }
  if(route==='/api/security/request-password-reset'){
   const email=String(b.email||'').trim().toLowerCase();securityLimit(req,'reset-request',email,5);const db=await load(),u=db.users.find(x=>x.email===email);
   if(u&&mailConfigured){const token=await transaction(db=>issueToken(db,u,'reset',1800000));dispatchSecurityMail(u,'reset',token);}
   json(res,200,{ok:true,mailConfigured,message:'Если аккаунт существует, письмо с инструкцией будет отправлено на его email.'});return true;
  }
  if(route==='/api/security/reset-password'){
   securityLimit(req,'reset-confirm',tokenHash(b.token||''),12);if(typeof b.password!=='string'||b.password.length<10||b.password.length>128)throw error(400,'Пароль должен содержать от 10 до 128 символов.');
   if(typeof b.token!=='string'||!/^[a-f0-9]{64}$/.test(b.token))throw error(400,'Ссылка недействительна или срок её действия истёк.');
   const resetHash=tokenHash(b.token),snapshot=await load(),token=(snapshot.securityTokens||[]).find(t=>t.hash===resetHash&&t.purpose==='reset'&&t.expires>Date.now()),account=token&&snapshot.users.find(u=>u.id===token.userId);
   if(!account)throw error(400,'Ссылка недействительна или срок её действия истёк.');
   const salt=randomBytes(16).toString('hex'),hash=(await derivePassword(b.password,salt,64)).toString('hex');
   await transaction(db=>{const t=(db.securityTokens||[]).find(t=>t.hash===resetHash&&t.purpose==='reset'&&t.expires>Date.now()&&t.userId===account.id),u=t&&db.users.find(x=>x.id===t.userId);if(!u||u.hash!==account.hash)throw error(400,'Ссылка недействительна или срок её действия истёк.');u.salt=salt;u.hash=hash;delete u.mfaPending;db.sessions=db.sessions.filter(s=>s.userId!==u.id);db.securityTokens=db.securityTokens.filter(t=>t.userId!==u.id);db.authChallenges=(db.authChallenges||[]).filter(c=>c.userId!==u.id);});json(res,200,{ok:true},{'Set-Cookie':cookie('',0)});return true;
  }
  if(route==='/api/security/mfa/login'){
   securityLimit(req,'mfa-login',tokenHash(b.challenge||''),10);if(typeof b.challenge!=='string'||!/^[a-f0-9]{64}$/.test(b.challenge))throw error(401,'Повторите вход в аккаунт.');
   const outcome=await transaction(db=>{const c=(db.authChallenges||[]).find(c=>c.hash===tokenHash(b.challenge)&&c.expires>Date.now()&&c.attempts<5),u=c&&db.users.find(u=>u.id===c.userId);if(!u||!u.mfa?.enabled||u.hash!==c.passwordHash)return {failed:true};c.attempts++;if(!consumeMfa(u,b.code))return {failed:true};db.authChallenges=db.authChallenges.filter(x=>x.hash!==c.hash);return mintSession(db,req,u,true);});
   if(outcome.failed)throw error(401,'Неверный код или срок входа истёк.');json(res,200,{user:outcome.user},{'Set-Cookie':cookie(outcome.token)});return true;
  }
  const db=await load(),{u,s}=auth(req,db);securityLimit(req,'mfa-account',u.id,12);
  if(route==='/api/security/mfa/setup'){
   if(u.mfa?.enabled)throw error(409,'Двухфакторная защита уже включена.');if(!await passwordMatches(u,b.password))throw error(401,'Неверный пароль.');const secret=base32(randomBytes(20));
   await transaction(db=>{const {u:current,s:currentSession}=auth(req,db);if(current.id!==u.id||currentSession.hash!==s.hash||current.hash!==u.hash||current.mfa?.enabled)throw error(409,'Повторите настройку защиты.');current.mfaPending={secret:vault.encrypt(secret),expires:Date.now()+600000,sessionHash:currentSession.hash};});
   const uri='otpauth://totp/'+encodeURIComponent('Orbita:'+u.email)+'?'+new URLSearchParams({secret,issuer:'Orbita',algorithm:'SHA1',digits:'6',period:'30'});json(res,200,{secret,otpauthUri:uri});return true;
  }
  if(route==='/api/security/mfa/confirm'){
   const codes=makeRecoveryCodes();await transaction(db=>{const {u:current,s:currentSession}=auth(req,db),pending=current.mfaPending;if(current.mfa?.enabled||!pending||pending.expires<Date.now()||pending.sessionHash!==currentSession.hash)throw error(400,'Начните настройку двухфакторной защиты заново.');const counter=verifyTotp(vault.decrypt(pending.secret),b.code);if(counter===null)throw error(400,'Неверный код.');current.mfa={enabled:true,secret:pending.secret,lastCounter:counter,recoveryHashes:codes.map(recoveryHash),enabledAt:new Date().toISOString()};delete current.mfaPending;db.sessions=db.sessions.filter(x=>x.userId!==current.id||x.hash===currentSession.hash);currentSession.mfa=true;db.authChallenges=(db.authChallenges||[]).filter(c=>c.userId!==current.id);});json(res,200,{ok:true,recoveryCodes:codes});return true;
  }
  if(['/api/security/mfa/disable','/api/security/mfa/recovery'].includes(route)){
   if(!u.mfa?.enabled)throw error(400,'Двухфакторная защита не включена.');if(route.endsWith('/disable')&&u.role==='admin'&&requireAdminMfa)throw error(403,'Для администратора двухфакторная защита обязательна.');if(!await passwordMatches(u,b.password))throw error(401,'Неверный пароль.');const codes=makeRecoveryCodes();
   const accepted=await transaction(db=>{const {u:current,s:currentSession}=auth(req,db);if(route.endsWith('/disable')&&current.role==='admin'&&requireAdminMfa)throw error(403,'Для администратора двухфакторная защита обязательна.');if(current.id!==u.id||current.hash!==u.hash||!current.mfa?.enabled||!consumeMfa(current,b.code))return false;if(route.endsWith('/disable'))delete current.mfa;else current.mfa.recoveryHashes=codes.map(recoveryHash);db.sessions=db.sessions.filter(x=>x.userId!==current.id||x.hash===currentSession.hash);currentSession.mfa=true;db.authChallenges=(db.authChallenges||[]).filter(c=>c.userId!==current.id);return true;});if(!accepted)throw error(401,'Неверный код.');json(res,200,{ok:true,...(route.endsWith('/recovery')?{recoveryCodes:codes}:{})});return true;
  }
  throw error(404,'Неизвестный запрос.');
 }
 async function promote(email){return transaction(db=>{const u=db.users.find(x=>x.email===String(email).trim().toLowerCase());if(!u)throw Error('Сначала зарегистрируйте этот email через сайт.');u.role='admin';db.accessAudit??=[];db.accessAudit.push({id:randomUUID(),actorId:'server-cli',userId:u.id,action:'promote-admin',at:new Date().toISOString()});return publicUser(u);});}
 async function getUser(id){const db=await load();return expose(db.users.find(u=>u.id===id),null,true);}
 async function getUsers(){return (await load()).users.map(u=>expose(u,null,true));}
 function grantLedger(db,u,plan){db.entitlementLedgers??=[];let ledger=db.entitlementLedgers.find(x=>x.userId===u.id&&x.plan===plan);const current=(u.subscriptions||[]).find(s=>s.plan===plan)?.expiresAt||null;if(!ledger){ledger={userId:u.id,plan,baseExpiresAt:current,projection:current,events:[]};db.entitlementLedgers.push(ledger);}else if(current!==ledger.projection){ledger.events.push({kind:'manual',at:Date.now(),expiresAt:current});ledger.projection=current;}return ledger;}
 function applyLedger(u,ledger){let expiry=Date.parse(ledger.baseExpiresAt)||0;for(const e of ledger.events){if(e.kind==='manual'){expiry=Date.parse(e.expiresAt)||0;}else if(!e.reversedAt){expiry=Math.max(expiry,e.at)+e.days*86400000;}}const expiresAt=expiry?new Date(expiry).toISOString():null;u.subscriptions=(u.subscriptions||[]).filter(s=>s.plan!==ledger.plan);if(expiresAt)u.subscriptions.push({plan:ledger.plan,expiresAt});ledger.projection=expiresAt;return expiresAt;}
 async function creditPayment({userId,paymentId,plan,days,amount,currency,paidAt}){if(typeof paymentId!=='string'||!paymentId||!Object.hasOwn(PLANS,plan)||!Number.isInteger(days)||days<1||days>3660)throw Error('Invalid payment credit');return transaction(db=>{db.paymentCredits??=[];const existing=db.paymentCredits.find(p=>p.paymentId===paymentId);if(existing){if(existing.userId!==userId||existing.plan!==plan)throw error(409,'Платёж уже связан с другой подпиской.');return {credited:false,duplicate:true,user:expose(db.users.find(u=>u.id===existing.userId),null,true),expiresAt:existing.expiresAt};}const u=db.users.find(x=>x.id===userId);if(!u)throw error(404,'Аккаунт не найден.');const pending=(db.paymentRefunds||[]).find(r=>r.paymentId===paymentId);if(pending&&((pending.userId&&pending.userId!==userId)||(pending.amount!==undefined&&Number(pending.amount)!==Number(amount))||(pending.currency&&pending.currency!==currency)))throw error(409,'Данные возврата и платежа не совпадают.');const ledger=grantLedger(db,u,plan),at=Date.now();ledger.events.push({kind:'payment',paymentId,at,days,...(pending?{reversedAt:pending.refundedAt}:{})});const expiresAt=applyLedger(u,ledger);db.paymentCredits.push({userId,paymentId,plan,days,amount,currency,paidAt:paidAt||new Date(at).toISOString(),expiresAt,...(pending?{reversedAt:pending.refundedAt,reverseReason:'refund-before-credit'}:{})});return {credited:!pending,...(pending?{reversed:true}:{}),user:expose(u,null,true),expiresAt};});}
 async function reversePayment({userId,paymentId,refundId=paymentId,amount,currency,refundedAt,reason='refund'}){return transaction(db=>{db.paymentRefunds??=[];if(db.paymentRefunds.some(r=>r.refundId===refundId))return {reversed:false,duplicate:true};const entry=(db.paymentCredits||[]).find(p=>p.paymentId===paymentId);if(!entry){db.paymentRefunds.push({refundId,paymentId,userId,amount,currency,refundedAt:refundedAt||new Date().toISOString(),pending:true});return {reversed:false,pending:true};}if(entry.reversedAt)return {reversed:false};if(userId&&entry.userId!==userId)throw error(409,'Платёж принадлежит другому аккаунту.');if((amount!==undefined&&Number(amount)!==Number(entry.amount))||(currency&&currency!==entry.currency))throw error(400,'Автоматически поддерживается только полный возврат платежа.');const u=db.users.find(x=>x.id===entry.userId);if(!u)throw error(404,'Аккаунт не найден.');const ledger=grantLedger(db,u,entry.plan),grant=ledger.events.find(e=>e.paymentId===paymentId);if(!grant)throw error(409,'Для возврата нужна проверка истории подписки.');entry.reversedAt=refundedAt||new Date().toISOString();entry.reverseReason=reason;grant.reversedAt=entry.reversedAt;const expiresAt=applyLedger(u,ledger);db.paymentRefunds.push({refundId,paymentId,amount:entry.amount,currency:entry.currency,refundedAt:entry.reversedAt});return {reversed:true,user:expose(u,null,true),expiresAt};});}
 return {handle,identify,checkRequest:policy.check,promote,getUser,getUsers,creditPayment,reversePayment,authorizeSensitive,currentLegalVersion,readDatabase:load,transact:transaction,emailConfigured:mailConfigured,flushMail:()=>Promise.allSettled([...pendingMail])};
}
