import {createHmac,randomUUID,timingSafeEqual} from 'node:crypto';
import {mkdir,readFile,writeFile,rename,rm,stat} from 'node:fs/promises';
import path from 'node:path';
import {error,json,readBody,readJson,safeFailure} from './http.mjs';
import {validLegalVersion} from './sales-gate.mjs';

const PLANS=Object.freeze({pro:{id:'pro',amount:2999,currency:'RUB',days:30},exclusive:{id:'exclusive',amount:4999,currency:'RUB',days:30}});
const API='https://api.cloudpayments.ru/orders/create';
const WEBHOOKS=Object.freeze(['check','pay','fail','refund'].map(name=>'/api/payments/cloudpayments/'+name));
const initial=()=>({version:1,revision:0,orders:[],transactions:{},refunds:{}});
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const now=()=>new Date().toISOString();
const own=(value,key)=>Object.prototype.hasOwnProperty.call(value,key);
function requireUser(user){if(!user?.id)throw error(401,'Войдите в аккаунт.');}
function normalizeConfig(config){
  const source=config||{},publicId=source.publicId??source.CLOUDPAYMENTS_PUBLIC_ID??process.env.CLOUDPAYMENTS_PUBLIC_ID??'',apiSecret=source.apiSecret??source.CLOUDPAYMENTS_API_SECRET??process.env.CLOUDPAYMENTS_API_SECRET??'';
  const originValue=source.publicOrigin??source.origin??source.ORBITA_PUBLIC_ORIGIN??process.env.ORBITA_PUBLIC_ORIGIN??'';
  let origin='';try{const u=new URL(originValue);if(u.protocol==='https:'&&!u.username&&!u.password&&u.pathname==='/'&&!u.search&&!u.hash)origin=u.origin;}catch{}
  const testMode=source.testMode??(['1','true'].includes(process.env.CLOUDPAYMENTS_TEST_MODE));
  return {publicId:typeof publicId==='string'?publicId.trim():'',apiSecret:typeof apiSecret==='string'?apiSecret:'',origin,testMode:testMode===true};
}
function hostedUrl(value){
  let url;try{url=new URL(value);}catch{throw error(502,'CloudPayments вернул некорректную ссылку оплаты.');}
  if(url.protocol!=='https:'||url.hostname!=='orders.cloudpayments.ru'||url.username||url.password||(url.port&&url.port!=='443')||url.hash)throw error(502,'CloudPayments вернул недопустимый адрес оплаты.');
  return url.href;
}
function publicOrder(order){return Object.fromEntries(['id','plan','amount','currency','days','status','checkoutUrl','createdAt','updatedAt','paidAt','refundedAt','expiresAt','needsReview','legalVersion'].filter(key=>order[key]!==undefined).map(key=>[key,order[key]]));}
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
  const expected=createHmac('sha256',secret).update(raw).digest();
  // Official CloudPayments SDKs sign the unmodified request body. Never rebuild form parameters.
  // X-Content-HMAC is useful when both encoded/decoded header variants are sent by the provider.
  return ['x-content-hmac','content-hmac'].some(name=>{
    const value=req.headers[name];if(typeof value!=='string'||!/^[A-Za-z0-9+/]{43}=$/.test(value))return false;
    const actual=Buffer.from(value,'base64');return actual.length===expected.length&&timingSafeEqual(actual,expected);
  });
}
function notification(req,raw){
  const type=String(req.headers['content-type']||'').split(';')[0].trim().toLowerCase();let result;
  if(type==='application/json'){try{result=JSON.parse(raw.toString('utf8'));}catch{throw error(400,'Некорректное уведомление.');}}
  else if(type==='application/x-www-form-urlencoded'){
    result={};for(const [key,value]of new URLSearchParams(raw.toString('utf8'))){if(own(result,key)||['__proto__','constructor','prototype'].includes(key))throw error(400,'Повторяющееся поле уведомления.');result[key]=value;}
  }else throw error(415,'Неподдерживаемый формат уведомления.');
  if(!object(result))throw error(400,'Некорректное уведомление.');return result;
}

export async function createPayments(directory,{accounts,config,fetchImpl=globalThis.fetch,checkoutGate}={}){
  const cfg=normalizeConfig(config),configured=Boolean(cfg.publicId&&cfg.apiSecret&&cfg.origin&&typeof accounts?.creditPayment==='function');
  await mkdir(directory,{recursive:true,mode:0o700});const file=path.join(directory,'billing.json'),lock=file+'.lock';let queue=Promise.resolve();const flights=new Map();
  async function load(){try{const db=JSON.parse(await readFile(file,'utf8'));if(db.version!==1||!Number.isInteger(db.revision)||!Array.isArray(db.orders)||!object(db.transactions)||!object(db.refunds))throw Error('Invalid billing database');return db;}catch(e){if(e.code==='ENOENT')return initial();throw e;}}
  await load();
  async function acquire(){
    const deadline=Date.now()+5000;
    while(true){try{await mkdir(lock,{mode:0o700});try{await writeFile(path.join(lock,'owner.json'),JSON.stringify({pid:process.pid}),{mode:0o600});}catch(e){await rm(lock,{recursive:true,force:true});throw e;}return;}catch(e){
      if(e.code!=='EEXIST')throw e;
      try{const owner=JSON.parse(await readFile(path.join(lock,'owner.json'),'utf8'));try{process.kill(owner.pid,0);}catch(gone){if(gone.code==='ESRCH'){await rm(lock,{recursive:true,force:true});continue;}}}catch(missing){if(missing.code==='ENOENT'){try{if(Date.now()-(await stat(lock)).mtimeMs>30000){await rm(lock,{recursive:true,force:true});continue;}}catch{}}}
      if(Date.now()>=deadline)throw error(409,'База платежей занята. Повторите запрос.');await new Promise(resolve=>setTimeout(resolve,25));
    }}
  }
  function transaction(fn){const job=queue.then(async()=>{await acquire();let temp;try{const db=await load(),result=fn(db);db.revision++;temp=file+'.tmp-'+randomUUID();await writeFile(temp,JSON.stringify(db),{mode:0o600});await rename(temp,file);temp=null;return structuredClone(result);}finally{if(temp)await rm(temp,{force:true});await rm(lock,{recursive:true,force:true});}});queue=job.catch(()=>{});return job;}
  function single(key,fn){if(flights.has(key))return flights.get(key);const promise=Promise.resolve().then(fn).finally(()=>flights.delete(key));flights.set(key,promise);return promise;}
  function requireConfigured(){if(!configured)throw error(503,'Оплата CloudPayments пока не настроена. Подписка не будет активирована.','PAYMENTS_NOT_CONFIGURED');}
  async function checkoutReadiness(){
    if(cfg.testMode)return {ready:true};
    if(typeof checkoutGate!=='function')return {ready:false};
    const state=await checkoutGate();return {ready:state?.ready===true&&validLegalVersion(state.legalVersion),legalVersion:state?.legalVersion};
  }
  async function publicConfig(){return {configured,checkoutEnabled:configured&&(await checkoutReadiness()).ready,provider:'cloudpayments',testMode:cfg.testMode,plans:Object.values(PLANS).map(plan=>({...plan}))};}
  async function prepareLink(id){return single('checkout:'+id,async()=>{
    let db=await load(),order=db.orders.find(x=>x.id===id);if(!order)throw error(404,'Заказ не найден.');
    if(order.checkoutUrl||!['creating'].includes(order.status))return publicOrder(order);
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
    requireUser(user);if(user.emailVerified!==true)throw error(403,'Подтвердите email перед оплатой.','EMAIL_NOT_VERIFIED');requireConfigured();
    if(!object(payload)||Object.keys(payload).some(k=>!['plan','requestId','legalVersion'].includes(k))||!own(PLANS,payload.plan)||typeof payload.requestId!=='string'||!/^[a-zA-Z0-9_-]{12,100}$/.test(payload.requestId)||(payload.legalVersion!==undefined&&!validLegalVersion(payload.legalVersion)))throw error(400,'Укажите тариф и уникальный идентификатор запроса.');
    const readiness=await checkoutReadiness();if(!readiness.ready)throw error(503,'Продажи подписок пока не открыты. Попробуйте позже.','SALES_NOT_OPEN');
    const order=await transaction(db=>{
      const existing=db.orders.find(x=>x.userId===user.id&&x.requestId===payload.requestId);
      if(existing){if(existing.plan!==payload.plan)throw error(409,'Этот идентификатор уже используется для другого тарифа.');return existing;}
      if(!cfg.testMode&&payload.legalVersion!==readiness.legalVersion)throw error(409,'Условия подписки обновились. Ознакомьтесь с текущей редакцией и повторите оплату.','LEGAL_VERSION_CHANGED');
      if(db.orders.filter(x=>x.userId===user.id&&Date.parse(x.createdAt)>Date.now()-3600000).length>=20)throw error(429,'Слишком много заказов. Попробуйте позже.');
      const at=now(),record={id:'order-'+randomUUID(),userId:user.id,email:user.email,requestId:payload.requestId,...PLANS[payload.plan],status:'creating',checkoutUrl:null,testMode:cfg.testMode,createdAt:at,updatedAt:at,...(payload.legalVersion?{legalVersion:payload.legalVersion,acceptedAt:at}:{})};
      // Plan ids are not order ids.
      record.id='order-'+randomUUID();record.plan=payload.plan;db.orders.push(record);return record;
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
    const result=await accounts.creditPayment({userId:order.userId,paymentId:'cloudpayments:'+order.payment.transactionId,plan:order.plan,days:order.days,amount:order.amount,currency:order.currency,paidAt:order.payment.at});
    if(!result||(!result.credited&&!result.duplicate&&!result.reversed))throw error(503,'Не удалось подтвердить активацию подписки.');
    order=await transaction(db=>{const item=db.orders.find(x=>x.id===id);item.creditedAt=now();item.paidAt=item.payment.at;if(result.expiresAt)item.expiresAt=result.expiresAt;item.status=item.refund?.full?'refund_pending':item.partialRefunds?.length?'refund_review':'paid';item.updatedAt=now();return item;});
    return order.refund?.full?settleRefund(id):order;
  });}
  async function receive(kind,fields){
    const staged=await transaction(db=>{
      const order=db.orders.find(x=>x.id===fields.InvoiceId);if(!order)throw error(404,'Заказ не найден.');const amount=validateBase(order,fields,kind),at=providerDate(fields.DateTime);
      if(kind==='check'){order.lastCheckedAt=now();return {id:order.id,code:order.payment||order.refund?.full?13:0};}
      const tx=transactionId(fields.TransactionId);
      if(kind==='fail'){if(!order.payment&&!order.refund?.full)order.status='failed';order.failedAttempts??=[];if(!order.failedAttempts.some(x=>x.transactionId===tx))order.failedAttempts.push({transactionId:tx,at});order.updatedAt=now();return {id:order.id,code:0};}
      const paymentTx=kind==='refund'?transactionId(fields.PaymentTransactionId):tx;
      if(db.transactions[paymentTx]&&db.transactions[paymentTx]!==order.id)throw error(409,'Транзакция уже связана с другим заказом.');
      if(order.providerTransactionId&&order.providerTransactionId!==paymentTx){
        if(kind==='refund')throw error(400,'Возврат относится к другой транзакции.');
        order.needsReview=true;order.extraPayments??=[];if(!order.extraPayments.some(x=>x.transactionId===tx))order.extraPayments.push({transactionId:tx,at});return {id:order.id,code:0,extra:true};
      }
      db.transactions[paymentTx]=order.id;order.providerTransactionId=paymentTx;
      if(kind==='pay'){
        if(!order.payment)order.payment={transactionId:tx,at,verified:true};
        if(!order.creditedAt&&!order.refund?.full)order.status='crediting';
      }else{
        if(tx===paymentTx)throw error(400,'Укажите отдельную транзакцию возврата.');
        if(db.refunds[tx]&&db.refunds[tx]!==order.id)throw error(409,'Возврат уже связан с другим заказом.');db.refunds[tx]=order.id;
        if(amount===order.amount*100){
          if(order.refund&&order.refund.transactionId!==tx)throw error(409,'Полный возврат уже зарегистрирован.');
          order.refund??={transactionId:tx,paymentTransactionId:paymentTx,at,full:true,applied:false};if(!order.refund.applied)order.status='refund_pending';
        }else{order.partialRefunds??=[];if(!order.partialRefunds.some(x=>x.transactionId===tx))order.partialRefunds.push({transactionId:tx,amount:amount/100,at});order.needsReview=true;if(!order.refund?.full)order.status='refund_review';}
      }
      order.updatedAt=now();return {id:order.id,code:0,partial:kind==='refund'&&amount!==order.amount*100};
    });
    if(staged.code||staged.extra||staged.partial||kind==='check'||kind==='fail')return {code:staged.code};
    if(kind==='pay')await settleCredit(staged.id);else await settleRefund(staged.id);return {code:0};
  }
  async function getOrder(user,id){
    requireUser(user);await queue;let order=(await load()).orders.find(x=>x.id===id&&x.userId===user.id);if(!order)throw error(404,'Заказ не найден.');
    if(configured&&['crediting','refund_pending'].includes(order.status))order=order.refund?.full?await settleRefund(id):await settleCredit(id);
    return {order:publicOrder(order)};
  }
  async function sync(){if(!configured)return;const db=await load();for(const order of db.orders){if(order.status==='crediting')await settleCredit(order.id);else if(order.status==='refund_pending')await settleRefund(order.id);}}
  async function handle(req,res,url,user){
    const route=url.pathname,webhook=WEBHOOKS.includes(route);if(!webhook&&route!=='/api/payments/config'&&route!=='/api/payments/checkout'&&!/^\/api\/payments\/orders\/order-[a-f0-9-]+$/.test(route))return false;
    try{
      if(webhook){requireConfigured();if(req.method!=='POST')throw error(405,'Используйте POST.');const raw=await readBody(req);if(!verifySignature(req,raw,cfg.apiSecret))throw error(403,'Подпись CloudPayments не подтверждена.');const kind=route.split('/').at(-1);if(kind==='check'&&!(await checkoutReadiness()).ready){json(res,200,{code:13});return true;}json(res,200,await receive(kind,notification(req,raw)));return true;}
      if(route==='/api/payments/config'&&req.method==='GET'){json(res,200,await publicConfig());return true;}
      if(route==='/api/payments/checkout'&&req.method==='POST'){json(res,200,await createCheckout(user,await readJson(req,16384)));return true;}
      if(route.startsWith('/api/payments/orders/')&&req.method==='GET'){json(res,200,await getOrder(user,route.split('/').at(-1)));return true;}
      throw error(405,'Метод не поддерживается.');
    }catch(e){if(e.status)json(res,e.status,{...(webhook?{code:13}:{}),error:e.message,...(e.code?{[webhook?'reason':'code']:e.code}:{})});else safeFailure(res,e,{scope:'payments',route,storageMessage:'Платёж временно не может быть сохранён. Обратитесь в поддержку и укажите код обращения.',failureMessage:'Не удалось обработать платёж. Повторите запрос или обратитесь в поддержку.',storageCode:'PAYMENT_STORAGE_UNAVAILABLE',failureCode:'PAYMENT_REQUEST_FAILED',codeKey:webhook?'reason':'code',extra:webhook?{code:13}:{}});return true;}
  }
  return {configured,publicConfig,webhookPaths:WEBHOOKS,handle,createCheckout,getOrder,sync};
}
