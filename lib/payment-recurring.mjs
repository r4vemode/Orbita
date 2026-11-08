import {randomUUID} from 'node:crypto';
import {error} from './http.mjs';

export const RECURRING_TERMS_VERSION='ORBITA-RECURRING-2026-11-07';
const timestamp=()=>new Date().toISOString();
const terminal=new Set(['cancelled','rejected','expired']);
const providerStatus={Active:'active',PastDue:'past_due',Cancelled:'cancelled',Rejected:'rejected',Expired:'expired'};
const validId=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(value);
const date=value=>{if(value==null||value==='')return null;const normalized=typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value)?value+'Z':value;return typeof normalized==='string'&&Number.isFinite(Date.parse(normalized))?new Date(normalized).toISOString():null;};
export const publicAgreement=item=>Object.fromEntries(['id','plan','amount','currency','days','status','providerStatus','nextChargeAt','createdAt','updatedAt','cancelRequestedAt','cancelledAt','lastFailureAt','lastPaidAt','termsVersion','testMode','simulation','needsReview'].filter(key=>item[key]!==undefined).map(key=>[key,item[key]]));
export function validateRecurringConsent(value){
  if(value===undefined||value===false)return null;
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!['accepted','termsVersion'].includes(key))||value.accepted!==true||value.termsVersion!==RECURRING_TERMS_VERSION)throw error(400,'Подтвердите условия автоматического продления.','RECURRING_CONSENT_REQUIRED');
  return {accepted:true,termsVersion:RECURRING_TERMS_VERSION};
}

export function createRecurringPayments({load,transaction,provider,vault,simulation=false}){
  const flights=new Map();
  function single(key,fn){if(flights.has(key))return flights.get(key);const job=Promise.resolve().then(fn).finally(()=>flights.delete(key));flights.set(key,job);return job;}
  function stage(db,order,consent){
    db.subscriptions??=[];
    if(db.subscriptions.some(item=>item.userId===order.userId&&item.plan===order.plan&&!terminal.has(item.status)))throw error(409,'Для этого тарифа уже оформлено автопродление. Управляйте им в разделе подписок.','RECURRING_ALREADY_EXISTS');
    const at=timestamp(),item={id:'agreement-'+randomUUID(),userId:order.userId,email:order.email,plan:order.plan,amount:order.amount,currency:order.currency,days:order.days,orderId:order.id,description:'ORBITA '+order.plan+' '+order.id,status:'awaiting_payment',testMode:order.testMode,simulation,termsVersion:consent.termsVersion,consentAt:at,createdAt:at,updatedAt:at};
    order.agreementId=item.id;order.recurringConsent={...consent,acceptedAt:at};db.subscriptions.push(item);return item;
  }
  function capture(db,order,fields){
    const item=db.subscriptions?.find(item=>item.id===order.agreementId);if(!item)return;
    item.updatedAt=timestamp();
    if(fields.Status==='Completed'){
      item.lastPaidAt=timestamp();
      if(item.orderId===order.id&&!item.token&&!terminal.has(item.status)&&typeof fields.Token==='string'&&fields.Token.length>=8&&fields.Token.length<=2048)item.token=vault.encrypt(fields.Token);
      if(item.cancelRequestedAt&&order.id!==item.orderId){order.needsReview=true;order.paymentAfterCancellation=true;}
    }else if(['Failed','Declined','Cancelled'].includes(fields.Status))item.lastFailureAt=timestamp();
  }
  function checkModel(item,model){
    if(!model||!validId(model.Id)||model.AccountId!==item.userId||Number(model.Amount)!==item.amount||model.Currency!==item.currency||model.Interval!=='Day'||Number(model.Period)!==item.days||!Object.hasOwn(providerStatus,model.Status))throw error(502,'Параметры автопродления не подтверждены провайдером.','RECURRING_MISMATCH');
  }
  async function saveModel(id,model){
    return transaction(db=>{const item=db.subscriptions.find(item=>item.id===id);checkModel(item,model);if(item.providerId&&item.providerId!==model.Id)throw error(409,'Обнаружено другое соглашение автопродления.');item.providerId=model.Id;item.providerStatus=model.Status;item.status=item.cancelRequestedAt&&model.Status!=='Cancelled'?'cancellation_pending':providerStatus[model.Status];item.nextChargeAt=terminal.has(item.status)?null:date(model.NextTransactionDateIso??model.NextTransactionDate);item.updatedAt=timestamp();if(item.status==='cancelled'){item.cancelledAt??=timestamp();delete item.token;}return item;});
  }
  async function cancel(user,id){
    const item=await transaction(db=>{const item=db.subscriptions?.find(item=>item.id===id&&item.userId===user?.id);if(!item)throw error(404,'Автопродление не найдено.');if(terminal.has(item.status))return item;item.cancelRequestedAt??=timestamp();item.updatedAt=timestamp();if(!item.providerId&&!item.createAttemptAt){item.status='cancelled';item.cancelledAt=timestamp();delete item.token;}else item.status='cancellation_pending';return item;});
    if(item.status==='cancelled')return {subscription:publicAgreement(item)};
    return single('cancel:'+id,async()=>{
      let current=(await load()).subscriptions.find(item=>item.id===id);
      if(!current.providerId){await reconcile(id);current=(await load()).subscriptions.find(item=>item.id===id);}
      if(!current.providerId)throw error(503,'Отмена ожидает подтверждения состояния провайдера.','RECURRING_CANCEL_PENDING');
      await provider('subscriptions/cancel',{Id:current.providerId},current.id+'-cancel');
      current=await transaction(db=>{const item=db.subscriptions.find(item=>item.id===id);item.status='cancelled';item.providerStatus='Cancelled';item.cancelledAt=timestamp();item.updatedAt=timestamp();item.nextChargeAt=null;delete item.token;return item;});
      return {subscription:publicAgreement(current)};
    });
  }
  async function reconcile(id){
    const item=(await load()).subscriptions?.find(item=>item.id===id);if(!item)return null;
    if(item.providerId){const model=await provider('subscriptions/get',{Id:item.providerId});return saveModel(id,model);}
    if(!item.createAttemptAt)return item;
    const models=await provider('subscriptions/find',{AccountId:item.userId});if(!Array.isArray(models))throw error(502,'Некорректный ответ поиска автопродления.');
    const matches=models.filter(model=>model.Description===item.description);
    if(matches.length!==1){await transaction(db=>{const current=db.subscriptions.find(value=>value.id===id);current.needsReview=true;current.updatedAt=timestamp();return current;});throw error(503,'Создание автопродления требует сверки; повторное соглашение не создаётся.','RECURRING_REVIEW_REQUIRED');}
    return saveModel(id,matches[0]);
  }
  async function ensure(orderId){return single('create:'+orderId,async()=>{
    const db=await load(),order=db.orders.find(item=>item.id===orderId);let item=db.subscriptions?.find(item=>item.orderId===orderId);
    if(!item||!order?.creditedAt||order.refund?.full||terminal.has(item.status)||item.providerId)return;
    if(item.createAttemptAt){item=await reconcile(item.id);if(item.cancelRequestedAt&&item.providerId)await cancel({id:item.userId},item.id);return;}
    if(item.cancelRequestedAt)return;
    if(!item.token){await transaction(db=>{const current=db.subscriptions.find(value=>value.id===item.id);current.status='token_unavailable';current.updatedAt=timestamp();return current;});return;}
    const start=order.expiresAt;
    if(!start||Date.parse(start)<=Date.now())throw error(409,'Оплаченный период завершён; повторите оформление после проверки подписки.');
    const claimed=await transaction(db=>{const current=db.subscriptions.find(value=>value.id===item.id);if(current.createAttemptAt||current.cancelRequestedAt||terminal.has(current.status))return null;current.createAttemptAt=timestamp();current.status='creating';return current;});if(!claimed)return;
    const model=await provider('subscriptions/create',{Token:vault.decrypt(claimed.token),AccountId:claimed.userId,Email:claimed.email,Amount:claimed.amount,Currency:claimed.currency,Description:claimed.description,RequireConfirmation:false,StartDate:start,Interval:'Day',Period:claimed.days},claimed.id);
    item=await saveModel(claimed.id,model);if(item.cancelRequestedAt)await cancel({id:item.userId},item.id);
  });}
  async function notification(fields){
    const db=await load(),item=db.subscriptions?.find(value=>value.providerId===fields.Id&&value.userId===fields.AccountId);if(!item)throw error(404,'Автопродление не найдено.');
    // Recurrent is a status hint. Fetch the current provider snapshot so an old
    // signed notification cannot reactivate a cancelled subscription.
    await reconcile(item.id);return {code:0};
  }
  async function orderForCharge(fields){
    if(!fields.SubscriptionId)return fields;
    if(!/^\d{1,25}$/.test(String(fields.TransactionId??'')))throw error(400,'Некорректная транзакция продления.');
    return transaction(db=>{
      const item=db.subscriptions?.find(item=>item.providerId===fields.SubscriptionId&&item.userId===fields.AccountId);if(!item)throw error(404,'Автопродление не найдено.');
      const tx=String(fields.TransactionId),known=db.transactions[tx],id=known||'order-renew-'+tx;
      let order=db.orders.find(order=>order.id===id);
      if(!order){order={id,userId:item.userId,email:item.email,plan:item.plan,amount:item.amount,currency:item.currency,days:item.days,testMode:item.testMode,simulation,agreementId:item.id,renewal:true,status:'pending',createdAt:timestamp(),updatedAt:timestamp(),checkoutUrl:null};db.orders.push(order);}
      if(order.agreementId!==item.id)throw error(409,'Транзакция принадлежит другому соглашению.');
      if(fields.InvoiceId&&fields.InvoiceId!==order.id)throw error(400,'Заказ продления не совпадает.');
      return {...fields,InvoiceId:order.id};
    });
  }
  async function list(user){return {subscriptions:((await load()).subscriptions||[]).filter(item=>item.userId===user?.id).map(publicAgreement)};}
  async function sync(){
    let failed=false;const db=await load();for(const item of db.subscriptions||[]){try{
      if(item.cancelRequestedAt&&!terminal.has(item.status))await cancel({id:item.userId},item.id);
      else if(['awaiting_payment','token_unavailable','creating'].includes(item.status))await ensure(item.orderId);
      else if(item.providerId&&!terminal.has(item.status))await reconcile(item.id);
    }catch{failed=true;}}
    if(failed)throw error(503,'Некоторые автопродления ожидают сверки.','RECURRING_SYNC_INCOMPLETE');
  }
  return {stage,capture,ensure,cancel,list,notification,orderForCharge,sync,reconcile};
}
