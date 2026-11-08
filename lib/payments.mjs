import {reclaimAbandonedLock} from './storage-lock.mjs';
import {createHmac,randomUUID,timingSafeEqual} from 'node:crypto';
import {mkdir,readFile,writeFile,rename,rm,stat} from 'node:fs/promises';
import path from 'node:path';
import {error,json,readBody,readJson,safeFailure} from './http.mjs';
import {writeDurable,readPrivateJson} from './durable-file.mjs';
import {createSecretVault} from './account-security.mjs';
import {cloudPaymentsGateway} from './payment-gateway.mjs';
import {createRecurringPayments,validateRecurringConsent,RECURRING_TERMS_VERSION} from './payment-recurring.mjs';
import {createRefundRequests,validateRefundRequests,publicRefundRequest} from './payment-refunds.mjs';
import {requireAdmin} from './access.mjs';
import {validLegalVersion} from './sales-gate.mjs';

const PLANS=Object.freeze({pro:{id:'pro',amount:2999,currency:'RUB',days:30},exclusive:{id:'exclusive',amount:4999,currency:'RUB',days:30}});
const API='https://api.cloudpayments.ru/orders/create';
const WEBHOOKS=Object.freeze(['check','pay','fail','refund','recurrent'].map(name=>'/api/payments/cloudpayments/'+name));
const initial=()=>({version:1,revision:0,orders:[],transactions:{},refunds:{}});
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const now=()=>new Date().toISOString();
const own=(value,key)=>Object.prototype.hasOwnProperty.call(value,key);
function requireUser(user){if(!user?.id)throw error(401,'Войдите в аккаунт.');}
function normalizeConfig(config){
  const source=config||{},publicId=source.publicId??source.CLOUDPAYMENTS_PUBLIC_ID??process.env.CLOUDPAYMENTS_PUBLIC_ID??'',apiSecret=source.apiSecret??source.CLOUDPAYMENTS_API_SECRET??process.env.CLOUDPAYMENTS_API_SECRET??'';
  const originValue=source.publicOrigin??source.origin??source.ORBITA_PUBLIC_ORIGIN??process.env.ORBITA_PUBLIC_ORIGIN??'';
  const mode=source.mode??process.env.ORBITA_PAYMENTS_MODE??'cloudpayments';
  if(!['cloudpayments','simulation'].includes(mode))throw Error('ORBITA_PAYMENTS_MODE: cloudpayments или simulation.');
  if(mode==='simulation'){
    let local=!originValue;try{const u=new URL(originValue);local=u.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(u.hostname)&&!u.username&&!u.password&&u.pathname==='/'&&!u.search&&!u.hash;}catch{}
    if(!local||(source.nodeEnv??process.env.NODE_ENV)==='production'||!['127.0.0.1','localhost','::1'].includes(source.host??process.env.HOST??'127.0.0.1'))throw Error('Симулятор платежей разрешён только локально, без production и публичного адреса.');
  }
  let origin='';try{const u=new URL(originValue);if(u.protocol==='https:'&&!u.username&&!u.password&&u.pathname==='/'&&!u.search&&!u.hash)origin=u.origin;}catch{}
  const testMode=source.testMode??(['1','true'].includes(process.env.CLOUDPAYMENTS_TEST_MODE));
  return {publicId:typeof publicId==='string'?publicId.trim():'',apiSecret:typeof apiSecret==='string'?apiSecret:'',origin,simulation:mode==='simulation',testMode:mode==='simulation'||testMode===true,recurringEnabled:source.recurringEnabled===true||['1','true'].includes(process.env.ORBITA_RECURRING_ENABLED)};
}
function hostedUrl(value){
  let url;try{url=new URL(value);}catch{throw error(502,'CloudPayments вернул некорректную ссылку оплаты.');}
  if(url.protocol!=='https:'||url.hostname!=='orders.cloudpayments.ru'||url.username||url.password||(url.port&&url.port!=='443')||url.hash)throw error(502,'CloudPayments вернул недопустимый адрес оплаты.');
  return url.href;
}
function publicOrder(order){return Object.fromEntries(['id','plan','amount','currency','days','status','checkoutUrl','createdAt','updatedAt','paidAt','refundedAt','expiresAt','needsReview','legalVersion','agreementId','recurringConsent','renewal','simulation','paymentAfterCancellation'].filter(key=>order[key]!==undefined).map(key=>[key,order[key]]));}
function money(value){
  const string=typeof value==='number'?String(value):value;
  if(typeof string!=='string'||!/^\d{1,10}(?:\.\d{1,2})?$/.test(string))throw error(400,'Некорректная сумма уведомления.');
  const [whole,fraction='']=string.split('.');return Number(whole)*100+Number(fraction.padEnd(2,'0'));
}
function transactionId(value){const id=String(value??'');if(!/^\d{1,25}$/.test(id)||/^0+$/.test(id)||(typeof value==='number'&&!Number.isSafeInteger(value)))throw error(400,'Некорректный идентификатор транзакции.');return id;}
function testFlag(value){if(value===true||value===1||value==='1'||value==='true')return true;if(value===false||value===0||value==='0'||value==='false')return false;throw error(400,'Не указан режим транзакции.');}
function providerDate(value){
  if(value===undefined||value==='')return now();
  if(typeof value!=='string')throw error(400,'Некорректная дата транзакции.');
  const normalized=/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)?value.replace(' ','T')+'Z':value;
  if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(normalized)||!Number.isFinite(Date.parse(normalized)))throw error(400,'Некорректная дата транзакции.');
  return new Date(normalized).toISOString();
}
function verifySignature(req,raw,secret){
  // Content-HMAC authenticates the exact encoded body. Prefer it when present.
  // X-Content-HMAC is the provider's URL-decoded variant for form requests.
  const name=req.headers['content-hmac']!==undefined?'content-hmac':'x-content-hmac',value=req.headers[name];
  if(typeof value!=='string'||!/^[A-Za-z0-9+/]{43}=$/.test(value))return false;
  let bytes=raw;
  if(name==='x-content-hmac'&&String(req.headers['content-type']||'').split(';')[0].trim().toLowerCase()==='application/x-www-form-urlencoded'){
    try{bytes=Buffer.from(decodeURIComponent(raw.toString('utf8').replace(/\+/g,' ')));}catch{return false;}
  }
  const expected=createHmac('sha256',secret).update(bytes).digest(),actual=Buffer.from(value,'base64');
  return actual.length===expected.length&&timingSafeEqual(actual,expected);
}

function notification(req,raw){
  const type=String(req.headers['content-type']||'').split(';')[0].trim().toLowerCase();let result;
  if(type==='application/json'){try{result=JSON.parse(raw.toString('utf8'));}catch{throw error(400,'Некорректное уведомление.');}}
  else if(type==='application/x-www-form-urlencoded'){
    result={};for(const [key,value]of new URLSearchParams(raw.toString('utf8'))){if(own(result,key)||['__proto__','constructor','prototype'].includes(key))throw error(400,'Повторяющееся поле уведомления.');result[key]=value;}
  }else throw error(415,'Неподдерживаемый формат уведомления.');
  if(!object(result))throw error(400,'Некорректное уведомление.');return result;
}

export function validateBillingDatabase(db){return db?.version===1&&Number.isInteger(db.revision)&&db.revision>=0&&Array.isArray(db.orders)&&object(db.transactions)&&object(db.refunds)&&(db.subscriptions===undefined||Array.isArray(db.subscriptions)&&db.subscriptions.every(item=>object(item)&&typeof item.id==='string'&&typeof item.userId==='string'&&typeof item.status==='string'))&&(db.simulations===undefined||Array.isArray(db.simulations))&&validateRefundRequests(db.refundRequests);}

export async function createPayments(directory,{accounts,config,fetchImpl=globalThis.fetch,checkoutGate,recurringGate}={}){
  const cfg=normalizeConfig(config),configured=Boolean((cfg.simulation||cfg.publicId&&cfg.apiSecret&&cfg.origin)&&typeof accounts?.creditPayment==='function');
  await mkdir(directory,{recursive:true,mode:0o700});const file=path.join(directory,'billing.json'),lock=file+'.lock';let queue=Promise.resolve();const flights=new Map();
  async function load(){try{return await readPrivateJson(file,validateBillingDatabase);}catch(e){if(e.code==='ENOENT')return initial();throw e;}}
  await load();const vault=await createSecretVault(directory);
  async function acquire(){
    const deadline=Date.now()+5000;
    while(true){try{await mkdir(lock,{mode:0o700});try{await writeFile(path.join(lock,'owner.json'),JSON.stringify({pid:process.pid}),{mode:0o600});}catch(e){await rm(lock,{recursive:true,force:true});throw e;}return;}catch(e){
      if(e.code!=='EEXIST')throw e;
      try{const owner=JSON.parse(await readFile(path.join(lock,'owner.json'),'utf8'));try{process.kill(owner.pid,0);}catch(gone){if(gone.code==='ESRCH'&&await reclaimAbandonedLock(lock)){continue;}}}catch(missing){if(missing.code==='ENOENT'){try{if(Date.now()-(await stat(lock)).mtimeMs>30000&&await reclaimAbandonedLock(lock)){continue;}}catch{}}}
      if(Date.now()>=deadline)throw error(409,'База платежей занята. Повторите запрос.');await new Promise(resolve=>setTimeout(resolve,25));
    }}
  }
  function transaction(fn){const job=queue.then(async()=>{await acquire();let temp;try{const db=await load(),result=await fn(db);db.revision++;const bytes=JSON.stringify(db);if(Buffer.byteLength(bytes)>32*1024*1024)throw error(409,'Хранилище платежей заполнено.','BILLING_STORAGE_LIMIT');await writeDurable(file,bytes);return structuredClone(result);}finally{if(temp)await rm(temp,{force:true});await rm(lock,{recursive:true,force:true});}});queue=job.catch(()=>{});return job;}
  const realProvider=cloudPaymentsGateway({publicId:cfg.publicId,apiSecret:cfg.apiSecret,fetchImpl});
  async function provider(method,payload,requestId){
    if(!cfg.simulation)return realProvider(method,payload,requestId);
    if(method==='subscriptions/create')return {...payload,Token:undefined,Id:'sim-'+requestId,Status:'Active',NextTransactionDateIso:payload.StartDate};
    if(method==='subscriptions/cancel')return null;
    const db=await load(),models=(db.subscriptions||[]).filter(item=>item.providerId).map(item=>({Id:item.providerId,AccountId:item.userId,Amount:item.amount,Currency:item.currency,Interval:'Day',Period:item.days,Description:item.description,Status:item.status==='cancelled'?'Cancelled':item.providerStatus||'Active',NextTransactionDateIso:item.nextChargeAt}));
    if(method==='subscriptions/find')return models.filter(item=>item.AccountId===payload.AccountId);
    if(method==='subscriptions/get')return models.find(item=>item.Id===payload.Id);
    throw error(400,'Неизвестная операция симулятора.');
  }
  const recurring=createRecurringPayments({load,transaction,provider,vault,simulation:cfg.simulation});
  const refunds=createRefundRequests({load,transaction,provider,receive,simulation:cfg.simulation,publicId:cfg.publicId,testMode:cfg.testMode,money,testFlag});
  function single(key,fn){if(flights.has(key))return flights.get(key);const promise=Promise.resolve().then(fn).finally(()=>flights.delete(key));flights.set(key,promise);return promise;}
  function requireConfigured(){if(!configured)throw error(503,'Оплата CloudPayments пока не настроена. Подписка не будет активирована.','PAYMENTS_NOT_CONFIGURED');}
  async function checkoutReadiness(){
    if(cfg.testMode)return {ready:true};
    if(typeof checkoutGate!=='function')return {ready:false};
    const state=await checkoutGate();return {ready:state?.ready===true&&validLegalVersion(state.legalVersion),legalVersion:state?.legalVersion};
  }
  async function recurringReadiness(){
    if(cfg.testMode)return {ready:true};
    if(!cfg.recurringEnabled||typeof recurringGate!=='function')return {ready:false};
    const [state,sales]=await Promise.all([recurringGate(),checkoutReadiness()]);return {ready:sales.ready&&state?.ready===true&&state.legalVersion===sales.legalVersion};
  }
  async function publicConfig(){const recurringAvailable=configured&&(await recurringReadiness()).ready;return {configured,checkoutEnabled:configured&&(await checkoutReadiness()).ready,provider:cfg.simulation?'simulation':'cloudpayments',simulation:cfg.simulation,recurringAvailable,recurringTermsVersion:recurringAvailable?RECURRING_TERMS_VERSION:null,testMode:cfg.testMode,plans:Object.values(PLANS).map(plan=>({...plan}))};}
  async function prepareLink(id){return single('checkout:'+id,async()=>{
    let db=await load(),order=db.orders.find(x=>x.id===id);if(!order)throw error(404,'Заказ не найден.');
    if(order.checkoutUrl||!['creating'].includes(order.status))return publicOrder(order);
    if(cfg.simulation)return publicOrder(await transaction(db=>{const item=db.orders.find(item=>item.id===id);item.status='pending';item.simulation=true;return item;}));
    const success=new URL('/subscriptions.html',cfg.origin);success.searchParams.set('paymentOrder',id);success.searchParams.set('paymentReturn','success');
    const failure=new URL(success);failure.searchParams.set('paymentReturn','fail');
    const payload={Amount:order.amount,Currency:'RUB',Description:`ORBITA ${order.plan==='pro'?'Pro':'Exclusive'} · 30 дней`,InvoiceId:order.id,AccountId:order.userId,Email:order.email,RequireConfirmation:false,SendEmail:false,SendSms:false,CultureInfo:'ru-RU',SuccessRedirectUrl:success.href,FailRedirectUrl:failure.href,JsonData:{plan:order.plan,orderId:order.id}};
    try{
      const response=await fetchImpl(API,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json','Authorization':'Basic '+Buffer.from(cfg.publicId+':'+cfg.apiSecret).toString('base64'),'X-Request-ID':order.id},body:JSON.stringify(payload),signal:AbortSignal.timeout(15000)});
      if(!response.ok)throw error(503,'CloudPayments временно недоступен. Повторите оплату с тем же заказом.');
      const result=await response.json();if(result?.Success!==true||!object(result.Model))throw error(503,'CloudPayments не создал ссылку оплаты. Попробуйте позже.');
      const checkoutUrl=hostedUrl(result.Model.Url);
      order=await transaction(db=>{const item=db.orders.find(x=>x.id===id);item.checkoutUrl=checkoutUrl;item.providerOrderId=result.Model.Id==null?null:String(result.Model.Id);if(item.status==='creating')item.status='pending';item.updatedAt=now();delete item.lastError;return item;});
      return publicOrder(order);
    }catch(cause){
      await transaction(db=>{const item=db.orders.find(x=>x.id===id);item.lastError='provider_unavailable';item.updatedAt=now();return item;});
      throw error(cause.status||503,cause.status?cause.message:'Не удалось связаться с CloudPayments. Повторите запрос с тем же идентификатором.','PROVIDER_UNAVAILABLE');
    }
  });}
  async function createCheckout(user,payload){
    requireUser(user);if(user.emailVerified!==true&&!cfg.simulation)throw error(403,'Подтвердите email перед оплатой.','EMAIL_NOT_VERIFIED');requireConfigured();
    if(!object(payload)||Object.keys(payload).some(k=>!['plan','requestId','legalVersion','recurring'].includes(k))||!own(PLANS,payload.plan)||typeof payload.requestId!=='string'||!/^[a-zA-Z0-9_-]{12,100}$/.test(payload.requestId)||(payload.legalVersion!==undefined&&!validLegalVersion(payload.legalVersion)))throw error(400,'Укажите тариф и уникальный идентификатор запроса.');
    const consent=validateRecurringConsent(payload.recurring);if(consent&&!(await recurringReadiness()).ready)throw error(503,'Автоматическое продление пока не включено. Можно оплатить один период.','RECURRING_NOT_READY');
    const readiness=await checkoutReadiness();if(!readiness.ready)throw error(503,'Продажи подписок пока не открыты. Попробуйте позже.','SALES_NOT_OPEN');
    const order=await transaction(db=>{
      const existing=db.orders.find(x=>x.userId===user.id&&x.requestId===payload.requestId);
      if(existing){if(existing.plan!==payload.plan||Boolean(existing.recurringConsent)!==Boolean(consent))throw error(409,'Этот идентификатор уже используется для другого тарифа.');return existing;}
      if(!cfg.testMode&&payload.legalVersion!==readiness.legalVersion)throw error(409,'Условия подписки обновились. Ознакомьтесь с текущей редакцией и повторите оплату.','LEGAL_VERSION_CHANGED');
      if(db.orders.filter(x=>x.userId===user.id&&Date.parse(x.createdAt)>Date.now()-3600000).length>=20)throw error(429,'Слишком много заказов. Попробуйте позже.');
      const at=now(),record={id:'order-'+randomUUID(),userId:user.id,email:user.email,requestId:payload.requestId,...PLANS[payload.plan],status:'creating',checkoutUrl:null,testMode:cfg.testMode,createdAt:at,updatedAt:at,...(payload.legalVersion?{legalVersion:payload.legalVersion,acceptedAt:at}:{})};
      // Plan ids are not order ids.
      record.id='order-'+randomUUID();record.plan=payload.plan;if(cfg.simulation)record.simulation=true;if(consent)recurring.stage(db,record,consent);db.orders.push(record);return record;
    });
    return {order:await prepareLink(order.id)};
  }
  function validateBase(order,fields,kind){
    if(fields.InvoiceId!==order.id||fields.AccountId!==order.userId)throw error(400,'Уведомление не соответствует аккаунту и заказу.');
    if(fields.Currency!==order.currency||testFlag(fields.TestMode)!==order.testMode||order.testMode!==cfg.testMode)throw error(400,'Валюта или режим платежа не соответствуют заказу.');
    const amount=money(fields.Amount);if(amount<=0||(kind==='refund'?amount>order.amount*100:amount!==order.amount*100))throw error(400,'Сумма платежа не соответствует заказу.');
    const operation=fields.OperationType;if(operation!==undefined&&operation!==(kind==='refund'?'Refund':'Payment'))throw error(400,'Неверный тип операции.');
    if(kind==='pay'&&fields.Status!=='Completed')throw error(400,'Платёж ещё не завершён.');
    if(kind==='fail'&&fields.Status!==undefined&&!['Declined','Failed','Cancelled'].includes(fields.Status))throw error(400,'Неверный статус отказа.');
    if(kind==='refund'&&fields.Status!==undefined&&!['Completed','Refunded'].includes(fields.Status))throw error(400,'Возврат ещё не завершён.');
    if(kind==='check'&&fields.Status!==undefined&&!['Created','AwaitingAuthentication','Authorized'].includes(fields.Status))throw error(400,'Неверный статус проверки платежа.');
    return amount;
  }
  async function projectRefunds(id){
    if(typeof accounts.recordPaymentAdjustment!=='function')return;
    const order=(await load()).orders.find(item=>item.id===id);if(!order)return;
    const rows=[...(order.partialRefunds||[]),...(order.refund?.full&&!order.refund.combined?[{transactionId:order.refund.transactionId,amount:order.amount,at:order.refund.at}]:[])];
    for(const row of rows)await accounts.recordPaymentAdjustment({userId:order.userId,paymentId:'cloudpayments:'+order.providerTransactionId,refundId:'cloudpayments-refund:'+row.transactionId,amountMinor:money(row.amount),refundedAt:row.at});
  }
  async function settleRefund(id){return single('refund:'+id,async()=>{
    const order=(await load()).orders.find(x=>x.id===id);if(!order?.refund?.full)return order;
    if(order.refund.applied)return order;
    if(typeof accounts.reversePayment!=='function')return transaction(db=>{const item=db.orders.find(x=>x.id===id);item.status='refund_review';item.needsReview=true;item.updatedAt=now();return item;});
    const result=await accounts.reversePayment({userId:order.userId,paymentId:'cloudpayments:'+order.refund.paymentTransactionId,refundId:'cloudpayments-refund:'+order.refund.transactionId,amount:order.amount,currency:order.currency,refundedAt:order.refund.at});
    if(!result||(!result.reversed&&!result.duplicate&&!result.pending))throw error(503,'Возврат требует проверки состояния подписки.');
    return transaction(db=>{const item=db.orders.find(x=>x.id===id);item.refund.applied=true;item.status='refunded';item.refundedAt=item.refund.at;item.updatedAt=now();return item;});
  });}
  async function settleCredit(id){return single('credit:'+id,async()=>{
    let order=(await load()).orders.find(x=>x.id===id);if(!order?.payment?.verified)return order;
    if(order.refund?.full)return settleRefund(id);
    if(order.creditedAt)return order;
    const result=await accounts.creditPayment({userId:order.userId,paymentId:'cloudpayments:'+order.payment.transactionId,plan:order.plan,days:order.days,amount:order.amount,currency:order.currency,paidAt:order.payment.at,testMode:order.testMode,simulation:order.simulation===true});
    if(!result||(!result.credited&&!result.duplicate&&!result.reversed))throw error(503,'Не удалось подтвердить активацию подписки.');
    order=await transaction(db=>{const item=db.orders.find(x=>x.id===id);item.creditedAt=now();item.paidAt=item.payment.at;if(result.expiresAt)item.expiresAt=result.expiresAt;item.status=item.refund?.full?'refund_pending':item.partialRefunds?.length?'refund_review':'paid';item.updatedAt=now();return item;});
    return order.refund?.full?settleRefund(id):order;
  });}
  async function receive(kind,fields){
    if(kind==='recurrent')return recurring.notification(fields);
    if(fields.SubscriptionId&&kind!=='refund')fields=await recurring.orderForCharge(fields);
    if(kind==='refund'&&!fields.InvoiceId){const db=await load(),id=db.transactions[String(fields.PaymentTransactionId)];if(id)fields={...fields,InvoiceId:id};}
    const staged=await transaction(db=>{
      const order=db.orders.find(x=>x.id===fields.InvoiceId);if(!order)throw error(404,'Заказ не найден.');const amount=validateBase(order,fields,kind),at=providerDate(fields.DateTime);
      if(kind==='check'){order.lastCheckedAt=now();return {id:order.id,code:order.payment||order.refund?.full?13:0};}
      const tx=transactionId(fields.TransactionId);
      if(kind==='fail'){recurring.capture(db,order,{...fields,Status:'Declined'});if(!order.payment&&!order.refund?.full)order.status='failed';order.failedAttempts??=[];if(!order.failedAttempts.some(x=>x.transactionId===tx))order.failedAttempts.push({transactionId:tx,at});order.updatedAt=now();return {id:order.id,code:0};}
      const paymentTx=kind==='refund'?transactionId(fields.PaymentTransactionId):tx;
      // Older stores may have review-only charges that were not indexed yet.
      const assigned=db.transactions[paymentTx]||db.orders.find(item=>item.providerTransactionId===paymentTx||item.payment?.transactionId===paymentTx||item.extraPayments?.some(extra=>extra.transactionId===paymentTx))?.id;
      if(assigned&&assigned!==order.id)throw error(409,'Транзакция уже связана с другим заказом.');
      // Additional charges still belong to this invoice even while awaiting review.
      db.transactions[paymentTx]=order.id;
      if(order.providerTransactionId&&order.providerTransactionId!==paymentTx){
        if(kind==='refund')throw error(400,'Возврат относится к другой транзакции.');
        order.needsReview=true;order.extraPayments??=[];if(!order.extraPayments.some(x=>x.transactionId===tx))order.extraPayments.push({transactionId:tx,at});return {id:order.id,code:0,extra:true};
      }
      order.providerTransactionId=paymentTx;
      if(kind==='pay'){
        if(!order.payment)order.payment={transactionId:tx,at,verified:true};recurring.capture(db,order,fields);
        if(!order.creditedAt&&!order.refund?.full)order.status='crediting';
      }else{
        if(tx===paymentTx)throw error(400,'Укажите отдельную транзакцию возврата.');
        if(db.refunds[tx]&&db.refunds[tx]!==order.id)throw error(409,'Возврат уже связан с другим заказом.');db.refunds[tx]=order.id;
        const prior=order.partialRefunds?.find(item=>item.transactionId===tx)||(order.refund?.transactionId===tx&&!order.refund.combined?{amount:order.amount}:null);
        if(prior&&money(prior.amount)!==amount)throw error(409,'Повтор возврата содержит другую сумму.');
        const refunded=(order.partialRefunds||[]).reduce((sum,item)=>sum+money(item.amount),0)+(order.refund?.full&&!order.refund.combined?order.amount*100:0);
        if(!prior&&refunded+amount>order.amount*100)throw error(409,'Сумма возвратов превышает исходный платёж.');
        if(amount===order.amount*100){
          if(order.refund&&order.refund.transactionId!==tx)throw error(409,'Полный возврат уже зарегистрирован.');
          order.refund??={transactionId:tx,paymentTransactionId:paymentTx,at,full:true,applied:false};if(!order.refund.applied)order.status='refund_pending';
        }else{order.partialRefunds??=[];if(!order.partialRefunds.some(x=>x.transactionId===tx))order.partialRefunds.push({transactionId:tx,amount:amount/100,at});order.needsReview=true;if(!order.refund?.full)order.status='refund_review';
          if(order.partialRefunds.reduce((sum,item)=>sum+money(item.amount),0)===order.amount*100){order.refund??={transactionId:tx,paymentTransactionId:paymentTx,at,full:true,combined:true,applied:false};order.status=order.refund.applied?'refunded':'refund_pending';}
        }
        if(order.refund?.full){const agreement=db.subscriptions?.find(item=>item.id===order.agreementId);if(agreement&&!['cancelled','expired','rejected'].includes(agreement.status)){agreement.cancelRequestedAt??=now();agreement.status='cancellation_pending';}}
      }
      order.updatedAt=now();return {id:order.id,code:0,partial:kind==='refund'&&!order.refund?.full};
    });
    if(kind==='refund')await projectRefunds(staged.id);
    if(staged.code||staged.extra||staged.partial||kind==='check'||kind==='fail')return {code:staged.code};
    if(kind==='pay'){await settleCredit(staged.id);try{await recurring.ensure(staged.id);}catch{/* durable create state is retried by sync; never duplicate a confirmed charge */}}else await settleRefund(staged.id);return {code:0};
  }
  async function getOrder(user,id){
    requireUser(user);await queue;let order=(await load()).orders.find(x=>x.id===id&&x.userId===user.id);if(!order)throw error(404,'Заказ не найден.');
    if(configured&&['crediting','refund_pending'].includes(order.status))order=order.refund?.full?await settleRefund(id):await settleCredit(id);
    return {order:publicOrder(order)};
  }
  async function sync(){
    if(!configured)return;const db=await load();let failed=false;
    // An unavailable account must not hold up independent paid orders or refunds.
    for(const order of db.orders){try{if(order.partialRefunds?.length||order.refund)await projectRefunds(order.id);if(order.status==='crediting')await settleCredit(order.id);else if(order.status==='refund_pending')await settleRefund(order.id);}catch{failed=true;}}
    try{await recurring.sync();}catch{failed=true;}
    try{await refunds.sync();}catch{failed=true;}
    if(failed)throw error(503,'Не все платежи удалось сверить. Необработанные заказы будут проверены повторно.','PAYMENT_SYNC_INCOMPLETE');
  }
  async function simulate(actor,payload){
    if(!cfg.simulation)throw error(404,'Симулятор отключён.');requireAdmin(actor);
    if(!object(payload)||!['create','pay','fail','renew','renew-fail','refund','cancel'].includes(payload.action)||typeof payload.requestId!=='string'||!/^[a-zA-Z0-9_-]{12,100}$/.test(payload.requestId))throw error(400,'Укажите сценарий и уникальный идентификатор.');
    if(payload.action==='create'){
      const target=await accounts.getUser(payload.userId);if(!target)throw error(404,'Пользователь не найден.');
      const result=await createCheckout(target,{plan:payload.plan,requestId:payload.requestId,...(payload.recurring===true?{recurring:{accepted:true,termsVersion:RECURRING_TERMS_VERSION}}:{})});
      await transaction(db=>{const order=db.orders.find(item=>item.id===result.order.id);order.simulatorActorId??=actor.id;return order;});
      return {ok:true,simulation:true,...result};
    }
    const fingerprint=JSON.stringify([payload.action,payload.orderId||null,payload.agreementId||null,payload.amountMinor??null]);
    const task=await transaction(db=>{
      db.simulations??=[];const prior=db.simulations.find(item=>item.requestId===payload.requestId);if(prior){if(prior.actorId!==actor.id||prior.fingerprint!==fingerprint)throw error(409,'Этот запрос уже использован.');return prior;}
      if(db.simulations.length>=10000)throw error(409,'Локальная история симулятора заполнена.');
      const agreement=db.subscriptions?.find(item=>item.id===payload.agreementId),order=db.orders.find(item=>item.id===(payload.orderId||agreement?.orderId));if(!order)throw error(404,'Тестовый заказ не найден.');
      const tx=String(BigInt('0x'+randomUUID().replaceAll('-','').slice(0,16))),fields={InvoiceId:order.id,AccountId:order.userId,Amount:order.amount,Currency:order.currency,TestMode:true,TransactionId:tx,Status:'Completed',DateTime:now()};
      if(payload.action==='pay'){fields.Token='simulation-card-token';if(order.payment)fields.TransactionId=order.payment.transactionId;}
      if(payload.action==='fail'||payload.action==='renew-fail')fields.Status='Declined';
      if(payload.action.startsWith('renew')){if(!agreement?.providerId||agreement.status==='cancelled'||agreement.cancelRequestedAt)throw error(409,'Нет действующего тестового автопродления.');delete fields.InvoiceId;fields.SubscriptionId=agreement.providerId;}
      if(payload.action==='refund'){if(!order.payment)throw error(409,'Сначала подтвердите платёж.');fields.PaymentTransactionId=order.payment.transactionId;fields.OperationType='Refund';if(payload.amountMinor!==undefined){if(!Number.isSafeInteger(payload.amountMinor)||payload.amountMinor<=0)throw error(400,'Некорректная сумма.');fields.Amount=payload.amountMinor/100;}}
      const record={requestId:payload.requestId,actorId:actor.id,fingerprint,action:payload.action,fields,orderId:order.id,agreementId:payload.agreementId,createdAt:now()};db.simulations.push(record);return record;
    });
    if(task.action==='cancel'){const agreement=(await load()).subscriptions?.find(item=>item.id===task.agreementId);if(!agreement)throw error(404,'Соглашение не найдено.');await recurring.cancel({id:agreement.userId},agreement.id);}
    else await receive(task.action==='refund'?'refund':task.action==='fail'||task.action==='renew-fail'?'fail':'pay',task.fields);
    return {ok:true,simulation:true,requestId:task.requestId};
  }
  async function history(user){requireUser(user);return {orders:(await load()).orders.filter(item=>item.userId===user.id).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0,200).map(publicOrder)};}
  async function handle(req,res,url,user){
    const route=url.pathname,webhook=WEBHOOKS.includes(route);if(!webhook&&route!=='/api/payments/config'&&route!=='/api/payments/checkout'&&!['/api/payments/history','/api/payments/subscriptions','/api/admin/payments/simulate','/api/admin/payments/orders','/api/admin/payments/refunds'].includes(route)&&!/^\/api\/admin\/payments\/(?:refunds\/refund-|orders\/order-)[a-z0-9-]+\/(?:reconcile|retry)$/.test(route)&&!/^\/api\/payments\/subscriptions\/agreement-[a-f0-9-]+\/cancel$/.test(route)&&!/^\/api\/payments\/orders\/order-[a-z0-9-]+$/.test(route))return false;
    try{
      if(webhook){requireConfigured();if(cfg.simulation)throw error(404,'В симуляторе внешние платёжные уведомления отключены.');if(req.method!=='POST')throw error(405,'Используйте POST.');const raw=await readBody(req);if(!verifySignature(req,raw,cfg.apiSecret))throw error(403,'Подпись CloudPayments не подтверждена.');const kind=route.split('/').at(-1);if(kind==='check'&&!(await checkoutReadiness()).ready){json(res,200,{code:13});return true;}json(res,200,await receive(kind,notification(req,raw)));return true;}
      if(['/api/payments/history','/api/payments/subscriptions'].includes(route)&&req.method==='GET'){requireUser(user);const result=route.endsWith('/history')?await history(user):await recurring.list(user);const current=await accounts.identify(req);if(current?.id!==user.id)throw error(401,'Сеанс изменился.');json(res,200,result);return true;}
      if(/^\/api\/payments\/subscriptions\/agreement-[a-f0-9-]+\/cancel$/.test(route)&&req.method==='POST'){requireUser(user);await readJson(req,4096);const current=await accounts.identify(req);if(current?.id!==user.id)throw error(401,'Сеанс изменился.');json(res,200,await recurring.cancel(current,route.split('/')[4]));return true;}
      if(route==='/api/admin/payments/orders'&&req.method==='GET'){requireAdmin(user);const db=await load();const current=await accounts.identify(req);requireAdmin(current);if(current.id!==user.id)throw error(401,'Сеанс изменился.');json(res,200,{simulation:cfg.simulation,testMode:cfg.testMode,orders:db.orders.slice(-200).reverse().map(item=>({...publicOrder(item),userId:item.userId,testMode:item.testMode,remainingRefundMinor:refunds.available(db,item)})),refundRequests:(db.refundRequests||[]).slice(-200).reverse().map(publicRefundRequest),subscriptions:(db.subscriptions||[]).map(item=>({id:item.id,userId:item.userId,plan:item.plan,status:item.status}))});return true;}
      if((route==='/api/admin/payments/refunds'||/^\/api\/admin\/payments\/(?:refunds\/refund-|orders\/order-)[a-z0-9-]+\/(?:reconcile|retry)$/.test(route))&&req.method==='POST'){
        requireAdmin(user);accounts.checkRequest(req);if(url.search)throw error(400,'Параметры адреса не поддерживаются.');requireConfigured();
        const body=await readJson(req,8192),create=route==='/api/admin/payments/refunds',refundRoute=create||route.includes('/refunds/');
        const retry=route.endsWith('/retry');if(retry&&!refundRoute)throw error(404,'Действие не найдено.');const keys=create?['orderId','amountMinor','requestId','reason','password','code']:retry?['password','code']:refundRoute?['transactionId','password','code']:['transactionId'];
        if(!object(body)||Object.keys(body).some(key=>!keys.includes(key)))throw error(400,'Запрос содержит неизвестные поля.');
        const authorize=async()=>{const current=await accounts.identify(req);requireAdmin(current);if(current.id!==user.id)throw error(401,'Сеанс изменился.');return current;};
        await authorize();if(refundRoute){const confirmed=await accounts.authorizeSensitive(req,{password:body.password,code:body.code});if(confirmed.id!==user.id)throw error(401,'Сеанс изменился.');}const current=await authorize();
        const result=create?await refunds.request(current,body,{authorize}):retry?await refunds.retry(current,route.split('/')[5],{authorize}):refundRoute?await refunds.reconcile(route.split('/')[5],{transactionId:body.transactionId,authorize}):await refunds.reconcileOrder(route.split('/')[5],{transactionId:body.transactionId,authorize});
        await authorize();json(res,result.refund&&result.refund.status!=='completed'?202:200,result);return true;
      }
      if(route==='/api/admin/payments/simulate'&&req.method==='POST'){if(!cfg.simulation)throw error(404,'Симулятор отключён.');requireAdmin(user);const body=await readJson(req,8192),current=await accounts.identify(req);requireAdmin(current);if(current.id!==user.id)throw error(401,'Сеанс изменился.');json(res,200,await simulate(current,body));return true;}
      if(route==='/api/payments/config'&&req.method==='GET'){json(res,200,await publicConfig());return true;}
      if(route==='/api/payments/checkout'&&req.method==='POST'){
        requireUser(user);const payload=await readJson(req,16384),current=await accounts.identify(req);requireUser(current);
        if(current.id!==user.id)throw error(401,'Войдите в аккаунт.');
        json(res,200,await createCheckout(current,payload));return true;
      }
      if(route.startsWith('/api/payments/orders/')&&req.method==='GET'){const result=await getOrder(user,route.split('/').at(-1)),current=await accounts.identify(req);if(current?.id!==user.id)throw error(401,'Сеанс изменился.');json(res,200,result);return true;}
      throw error(405,'Метод не поддерживается.');
    }catch(e){if(e.status)json(res,e.status,{...(webhook?{code:13}:{}),error:e.message,...(e.code?{[webhook?'reason':'code']:e.code}:{})});else safeFailure(res,e,{scope:'payments',route,storageMessage:'Платёж временно не может быть сохранён. Обратитесь в поддержку и укажите код обращения.',failureMessage:'Не удалось обработать платёж. Повторите запрос или обратитесь в поддержку.',storageCode:'PAYMENT_STORAGE_UNAVAILABLE',failureCode:'PAYMENT_REQUEST_FAILED',codeKey:webhook?'reason':'code',extra:webhook?{code:13}:{}});return true;}
  }
  return {configured,publicConfig,webhookPaths:WEBHOOKS,handle,createCheckout,getOrder,sync,history,recurring,simulate,refunds};
}
