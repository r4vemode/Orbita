import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {error,json,readJson} from './http.mjs';
import {requireAdmin} from './access.mjs';
import {createAttemptLimiter} from './auth-limits.mjs';
import {requestAddress} from './request-security.mjs';

const day=86400000,stamp=()=>new Date().toISOString();
const hash=value=>createHash('sha256').update(value).digest('hex');
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const mode=payment=>payment.simulation?'simulation':payment.testMode?'provider-test':'live';
const cookieValue=(headers,name)=>String(headers?.cookie||'').split(';').map(item=>item.trim()).find(item=>item.startsWith(name+'='))?.slice(name.length+1);
const cookie=req=>cookieValue(req.headers,'orbita_ref');
const attributedVisitLimit=10;
const settlementPolicy='first-server-confirmed-v1';
function signedInUser(db,headers,at){const token=cookieValue(headers,'orbita_session');if(!token||token.length>128)return null;const session=(db.sessions||[]).find(item=>item.hash===hash(token)&&item.expires>at);return session?.userId||null;}
const initial=()=>({version:1,partners:[],visits:[],attributions:[],payments:[],refunds:[],entries:[],payouts:[],audit:[]});
const state=db=>db.referrals??=initial();
const commission=(amount,bps)=>Number((BigInt(amount)*BigInt(bps)+5000n)/10000n);
const storedTerms=item=>object(item)&&[item.firstBps,item.repeatBps].every(n=>Number.isInteger(n)&&n>=0&&n<=3000)&&Number.isInteger(item.maxPayments)&&item.maxPayments>=1&&item.maxPayments<=120&&Number.isInteger(item.holdDays)&&item.holdDays>=0&&item.holdDays<=180&&Number.isSafeInteger(item.version)&&item.version>=1&&typeof item.effectiveAt==='string'&&Number.isFinite(Date.parse(item.effectiveAt));
export function validateReferralsState(value){
 if(value===undefined)return true;
 return object(value)&&value.version===1&&['partners','visits','attributions','payments','refunds','entries','payouts','audit'].every(key=>Array.isArray(value[key])&&value[key].length<=100000&&value[key].every(object))&&value.partners.every(item=>typeof item.id==='string'&&typeof item.userId==='string'&&/^[a-f0-9]{24}$/.test(item.code)&&Array.isArray(item.terms)&&item.terms.length>0&&item.terms.every(storedTerms))&&value.entries.every(item=>Number.isSafeInteger(item.amountMinor)&&typeof item.partnerId==='string')&&value.payouts.every(item=>Number.isSafeInteger(item.amountMinor)&&item.amountMinor>0&&['reserved','paid','cancelled'].includes(item.status));
}
function terms(value={},version=1){
 if(!object(value)||Object.keys(value).some(key=>!['firstBps','repeatBps','maxPayments','holdDays'].includes(key)))throw error(400,'Некорректные условия партнёра.');
 const result={firstBps:value.firstBps??1500,repeatBps:value.repeatBps??1000,maxPayments:value.maxPayments??6,holdDays:value.holdDays??30};
 if(![result.firstBps,result.repeatBps].every(n=>Number.isInteger(n)&&n>=0&&n<=3000)||!Number.isInteger(result.maxPayments)||result.maxPayments<1||result.maxPayments>120||!Number.isInteger(result.holdDays)||result.holdDays<0||result.holdDays>180)throw error(400,'Комиссия: 0–30%; оплачиваемых периодов: 1–120; удержание: 0–180 дней.');
 return {...result,version,effectiveAt:stamp()};
}
function audit(s,actor,action,id,detail){s.audit.push({id:randomUUID(),actorId:actor.id,action,objectId:id,detail,at:stamp()});}
export function applyReferralRegistration(db,user,headers,at=Date.now()){
 if(!db.referrals)return;const s=db.referrals,token=cookie({headers});if(!token||!/^[a-f0-9]{48}$/.test(token))return;
 const visit=s.visits.find(item=>item.hash===hash(token)&&item.expiresAt>at),partner=visit&&s.partners.find(item=>item.id===visit.partnerId&&item.active);
 if(!partner||s.attributions.some(item=>item.userId===user.id))return;
 const reused=s.attributions.filter(item=>item.visitId===visit.id).length;
 const reason=partner.userId===user.id||visit.selfReferralUserId===partner.userId||signedInUser(db,headers,at)===partner.userId?'self-referral':reused>=attributedVisitLimit?'visit-limit':null;
 if(reason){s.audit.push({id:randomUUID(),actorId:'registration',action:'attribution-blocked',objectId:partner.id,detail:{reason,userId:user.id,visitId:visit.id},at:new Date(at).toISOString()});return;}
 s.attributions.push({id:randomUUID(),userId:user.id,partnerId:partner.id,visitId:visit.id,registeredAt:new Date(at).toISOString(),...(reused?{riskFlags:['reused-visit']}:{})});
}
function applyRefundEntry(s,payment,refund){
 if(s.entries.some(item=>item.refundId===refund.refundId))return;
 const original=s.entries.find(item=>item.paymentId===payment.paymentId&&item.kind==='commission');if(!original)return;
 const applied=new Set(s.entries.filter(item=>item.paymentId===payment.paymentId&&item.kind==='refund').map(item=>item.refundId));
 const total=s.refunds.filter(item=>item.paymentId===payment.paymentId&&(applied.has(item.refundId)||item.refundId===refund.refundId)).reduce((sum,item)=>sum+item.amountMinor,0);
 if(total>payment.amountMinor)throw error(409,'Возвраты превышают платёж.');
 const desired=original.amountMinor-commission(payment.amountMinor-total,original.rateBps),already=-s.entries.filter(item=>item.paymentId===payment.paymentId&&item.kind==='refund').reduce((sum,item)=>sum+item.amountMinor,0);
 const delta=desired-already;
 s.entries.push({id:randomUUID(),kind:'refund',partnerId:original.partnerId,paymentId:payment.paymentId,refundId:refund.refundId,amountMinor:-delta,mode:original.mode,at:refund.refundedAt,availableAt:refund.refundedAt,reason:'Подтверждённый возврат',termsVersion:original.termsVersion});
}
export function applyReferralPayment(db,payment){
 if(!db.referrals)return;const s=db.referrals;
 if(s.payments.some(item=>item.paymentId===payment.paymentId))return;
 const amountMinor=payment.amountMinor??Math.round(payment.amount*100);
 if(!Number.isSafeInteger(amountMinor)||amountMinor<=0||payment.currency!=='RUB')throw error(400,'Некорректный платёж для партнёрского учёта.');
 const selectedMode=mode(payment),settlementIndex=s.payments.filter(item=>item.userId===payment.userId&&item.mode===selectedMode).length+1;
 const record={paymentId:payment.paymentId,userId:payment.userId,plan:payment.plan,amountMinor,currency:payment.currency,mode:selectedMode,paidAt:payment.paidAt||stamp(),settledAt:stamp(),settlementIndex,settlementPolicy};
 const attribution=s.attributions.find(item=>item.userId===payment.userId),partner=attribution&&s.partners.find(item=>item.id===attribution.partnerId&&item.active);
 s.payments.push(record);if(!partner||partner.userId===payment.userId||Date.parse(attribution.registeredAt)>Date.parse(record.paidAt))return;
 const rule=partner.terms.filter(item=>Date.parse(item.effectiveAt)<=Date.parse(record.paidAt)).at(-1);if(!rule)return;
 // Rates follow durable settlement order, not webhook timestamps. A delayed
 // earlier charge must not rewrite an already accrued or paid commission.
 const period=settlementIndex;if(period>rule.maxPayments)return;
 const rate=period===1?rule.firstBps:rule.repeatBps,amount=commission(amountMinor,rate);
 if(amount)s.entries.push({id:randomUUID(),kind:'commission',partnerId:partner.id,paymentId:record.paymentId,amountMinor:amount,baseMinor:amountMinor,rateBps:rate,period,mode:record.mode,termsVersion:rule.version,at:record.paidAt,availableAt:new Date(Date.parse(record.paidAt)+rule.holdDays*day).toISOString()});
 for(const refund of s.refunds.filter(item=>item.paymentId===record.paymentId))applyRefundEntry(s,record,refund);
}
export function applyReferralRefund(db,refund){
 if(!db.referrals)return;const s=db.referrals,prior=s.refunds.find(item=>item.refundId===refund.refundId);
 if(prior){if(prior.paymentId!==refund.paymentId||prior.amountMinor!==refund.amountMinor)throw error(409,'Повтор возврата содержит другие данные.');return;}
 if(!Number.isSafeInteger(refund.amountMinor)||refund.amountMinor<=0)throw error(400,'Некорректная сумма возврата.');
 const record={refundId:refund.refundId,paymentId:refund.paymentId,amountMinor:refund.amountMinor,refundedAt:refund.refundedAt||stamp()};s.refunds.push(record);
 const payment=s.payments.find(item=>item.paymentId===record.paymentId);if(payment)applyRefundEntry(s,payment,record);
}
function balances(s,partnerId,selectedMode,at=Date.now()){
 const entries=s.entries.filter(item=>item.partnerId===partnerId&&item.mode===selectedMode),payouts=s.payouts.filter(item=>item.partnerId===partnerId&&item.mode===selectedMode);
 const adjustments=new Map();for(const item of entries)if(item.kind==='refund')adjustments.set(item.paymentId,(adjustments.get(item.paymentId)||0)+item.amountMinor);
 const total=entries.reduce((sum,item)=>sum+item.amountMinor,0),pending=entries.filter(item=>item.kind==='commission'&&Date.parse(item.availableAt)>at).reduce((sum,item)=>sum+Math.max(0,item.amountMinor+(adjustments.get(item.paymentId)||0)),0),reserved=payouts.filter(item=>item.status==='reserved').reduce((sum,item)=>sum+item.amountMinor,0),paid=payouts.filter(item=>item.status==='paid').reduce((sum,item)=>sum+item.amountMinor,0);
 return {totalMinor:total,pendingMinor:pending,reservedMinor:reserved,paidMinor:paid,availableMinor:total-pending-reserved-paid};
}
function fraudReview(s,partnerId,users){const records=s.attributions.filter(item=>item.partnerId===partnerId&&item.riskFlags?.length),unreviewed=records.filter(item=>!item.reviewedAt);return {blockedRegistrations:s.audit.filter(item=>item.objectId===partnerId&&item.action==='attribution-blocked').length,reusedVisitRegistrations:records.length,unreviewedRegistrations:unreviewed.length,registrations:unreviewed.slice(-100).map(item=>({id:item.id,userId:item.userId,email:users.find(user=>user.id===item.userId)?.email||null,registeredAt:item.registeredAt,riskFlags:item.riskFlags}))};}

export function createReferrals({accounts,publicOrigin='',simulation=false,now=Date.now}){
 const limits=createAttemptLimiter();
 async function visit(req,res,url){
  const match=url.pathname.match(/^\/r\/([a-f0-9]{24})$/);if(!match)return false;if(req.method!=='GET')throw error(405,'Используйте GET.');
  if(!limits.take([['visit:'+hash(requestAddress(req)),60]]))throw error(429,'Слишком много переходов. Повторите позже.');
  const token=cookie(req),fresh=randomBytes(24).toString('hex'),at=now();
  const result=await accounts.transact(db=>{const s=state(db),partner=s.partners.find(item=>item.code===match[1]&&item.active);if(!partner)throw error(404,'Партнёрская ссылка не найдена.');
   const actorId=signedInUser(db,req.headers,at),existing=token&&/^[a-f0-9]{48}$/.test(token)&&s.visits.find(item=>item.hash===hash(token)&&item.expiresAt>at);if(existing){const attributed=s.partners.find(item=>item.id===existing.partnerId);if(actorId&&attributed?.userId===actorId)existing.selfReferralUserId=actorId;return {token,maxAge:Math.floor((existing.expiresAt-at)/1000)};}
   s.visits=s.visits.filter(item=>item.expiresAt>at);if(s.visits.length>=20000)throw error(503,'Регистрация перехода временно недоступна.');
   s.visits.push({id:randomUUID(),hash:hash(fresh),partnerId:partner.id,at:new Date(at).toISOString(),expiresAt:at+30*day,...(actorId===partner.userId?{selfReferralUserId:actorId}:{})});partner.visits=(partner.visits||0)+1;return {token:fresh,maxAge:30*86400};
  });
  res.writeHead(303,{Location:'/account.html?mode=register','Cache-Control':'no-store','Referrer-Policy':'no-referrer','Set-Cookie':`orbita_ref=${result.token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${result.maxAge}${publicOrigin.startsWith('https://')?'; Secure':''}`});res.end();return true;
 }
 async function authorize(req,db,user,admin=false){return accounts.authorizeInTransaction(req,db,user?.id,{admin});}
 async function snapshot(req,user,admin){
  const db=await accounts.readDatabase();await authorize(req,db,user,admin);const s=db.referrals||initial(),partners=admin?s.partners:s.partners.filter(item=>item.userId===user.id),selectedMode=simulation?'simulation':'live';
  const output=partners.map(partner=>{
   const users=s.attributions.filter(item=>item.partnerId===partner.id).map(item=>item.userId),payments=s.payments.filter(item=>users.includes(item.userId)&&item.mode===selectedMode);
   return {id:partner.id,name:partner.name,code:partner.code,active:partner.active,revision:partner.revision,link:'/r/'+partner.code,terms:partner.terms.at(-1),settlementPolicy,visits:partner.visits||0,registrations:users.length,payingUsers:new Set(payments.map(item=>item.userId)).size,payments:payments.length,salesMinor:payments.reduce((sum,item)=>sum+item.amountMinor,0),mode:selectedMode,balance:balances(s,partner.id,selectedMode,now()),...(admin?{userId:partner.userId,fraudReview:fraudReview(s,partner.id,db.users)}:{}),entries:s.entries.filter(item=>item.partnerId===partner.id&&item.mode===selectedMode).slice(-100).map(({paymentId,...entry})=>entry),payouts:s.payouts.filter(item=>item.partnerId===partner.id&&item.mode===selectedMode).slice(-100).map(({actorId,...payout})=>payout)};
  });
  const current=await accounts.identify(req);if(current?.id!==user?.id)throw error(401,'Сеанс изменился.');if(admin)requireAdmin(current);return {partners:output,simulation};
 }
 async function handle(req,res,url,user){
  const route=url.pathname;if(route!=='/api/referrals/me'&&!route.startsWith('/api/admin/referrals'))return false;
  if(!user?.id)throw error(401,'Войдите в аккаунт.');const admin=route.startsWith('/api/admin/');if(admin)requireAdmin(user);
  if(req.method==='GET'&&['/api/referrals/me','/api/admin/referrals'].includes(route)){json(res,200,await snapshot(req,user,admin));return true;}
  if(req.method!=='POST')throw error(405,'Используйте POST.');const body=await readJson(req,16384);
  if(!object(body))throw error(400,'Некорректные параметры.');
  if(route==='/api/admin/referrals/payouts'&&body.action==='paid'){const current=await accounts.authorizeSensitive(req,{password:body.password,code:body.code});if(current.id!==user.id)throw error(401,'Сеанс изменился.');}
  const result=await accounts.transact(async db=>{
   const actor=await authorize(req,db,user,true),s=state(db);
   if(route==='/api/admin/referrals/partners'){
    const target=db.users.find(item=>item.id===body.userId);if(!target)throw error(404,'Пользователь не найден.');if(s.partners.some(item=>item.userId===target.id))throw error(409,'Этот пользователь уже партнёр.');
    if(typeof body.name!=='string'||!body.name.trim()||body.name.length>100)throw error(400,'Укажите название партнёра до 100 символов.');
    const partner={id:'partner-'+randomUUID(),userId:target.id,name:body.name.trim(),code:randomBytes(12).toString('hex'),active:true,revision:1,terms:[terms(body.terms)],createdAt:stamp(),visits:0};s.partners.push(partner);audit(s,actor,'partner-created',partner.id,'Создание партнёра');return {id:partner.id};
   }
   const partnerRoute=route.match(/^\/api\/admin\/referrals\/partners\/(partner-[a-f0-9-]+)$/);
   if(partnerRoute){const partner=s.partners.find(item=>item.id===partnerRoute[1]);if(!partner)throw error(404,'Партнёр не найден.');if(body.revision!==partner.revision)throw error(409,'Условия уже изменились. Обновите страницу.');if(typeof body.reason!=='string'||body.reason.trim().length<3||body.reason.length>500)throw error(400,'Укажите основание изменения.');
    if(body.terms)partner.terms.push(terms(body.terms,partner.terms.length+1));if(typeof body.active==='boolean')partner.active=body.active;partner.revision++;audit(s,actor,'partner-updated',partner.id,body.reason.trim());return {id:partner.id};}
   if(route==='/api/admin/referrals/payouts'){
    if(typeof body.requestId!=='string'||!/^[A-Za-z0-9_-]{12,100}$/.test(body.requestId))throw error(400,'Укажите идентификатор операции.');
    if(body.action==='reserve'){
     const prior=s.payouts.find(item=>item.requestId===body.requestId);if(prior){if(prior.partnerId!==body.partnerId||prior.amountMinor!==body.amountMinor)throw error(409,'Этот запрос уже использован.');return {payout:prior};}
     const partner=s.partners.find(item=>item.id===body.partnerId);if(!partner)throw error(404,'Партнёр не найден.');const selectedMode=simulation?'simulation':'live',balance=balances(s,partner.id,selectedMode,now());
     if(!Number.isSafeInteger(body.amountMinor)||body.amountMinor<=0||body.amountMinor>balance.availableMinor)throw error(400,'Сумма превышает доступный остаток.');
     const flagged=s.attributions.filter(item=>item.partnerId===partner.id&&item.riskFlags?.length&&!item.reviewedAt);
     if(flagged.length){if(body.reviewAcknowledged!==true)throw error(409,'Есть повторные регистрации с одного перехода. Проверьте их перед резервированием выплаты.','REFERRAL_REVIEW_REQUIRED');const at=stamp();for(const item of flagged){item.reviewedAt=at;item.reviewedBy=actor.id;}audit(s,actor,'attribution-review-acknowledged',partner.id,{attributionIds:flagged.map(item=>item.id)});}
     const payout={id:'payout-'+randomUUID(),requestId:body.requestId,partnerId:partner.id,mode:selectedMode,amountMinor:body.amountMinor,status:'reserved',actorId:actor.id,createdAt:stamp()};s.payouts.push(payout);audit(s,actor,'payout-reserved',payout.id,'Резервирование выплаты');return {payout};
    }
    const payout=s.payouts.find(item=>item.id===body.payoutId);if(!payout)throw error(404,'Выплата не найдена.');
    if(body.action==='cancel'){if(payout.status==='paid')throw error(409,'Подтверждённую выплату нельзя отменить.');payout.status='cancelled';audit(s,actor,'payout-cancelled',payout.id,'Резерв освобождён');return {payout};}
    if(body.action==='paid'){
     if(payout.status==='cancelled')throw error(409,'Резерв отменён.');if(typeof body.reference!=='string'||body.reference.trim().length<3||body.reference.length>150)throw error(400,'Укажите подтверждение фактической выплаты.');
     if(payout.status==='paid'){if(payout.reference!==body.reference.trim())throw error(409,'У выплаты другое подтверждение.');return {payout};}
     if(s.payouts.some(item=>item.status==='paid'&&item.reference===body.reference.trim()&&item.mode===payout.mode))throw error(409,'Подтверждение уже относится к другой выплате.');
     payout.status='paid';payout.reference=body.reference.trim();payout.paidAt=stamp();payout.needsReview=balances(s,payout.partnerId,payout.mode,now()).availableMinor<0;audit(s,actor,'payout-paid',payout.id,'Подтверждена внешняя ручная выплата');return {payout};
    }
   }
   throw error(404,'Операция партнёрской программы не найдена.');
  });json(res,200,result);return true;
 }
 return {handle,visit};
}
