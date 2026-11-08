import {createHash,randomUUID} from 'node:crypto';
import {error} from './http.mjs';

const stamp=()=>new Date().toISOString();
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const tx=value=>{const id=String(value??'');if(!/^[1-9]\d{0,24}$/.test(id)||typeof value==='number'&&!Number.isSafeInteger(value))throw error(400,'Некорректный номер транзакции.');return id;};
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const refundedMinor=order=>(order.partialRefunds||[]).reduce((sum,item)=>sum+Math.round(item.amount*100),0)+(order.refund?.full&&!order.refund.combined?Math.round(order.amount*100):0);
export const publicRefundRequest=item=>Object.fromEntries(['id','orderId','amountMinor','status','reason','actorId','createdAt','updatedAt','attemptedAt','completedAt','providerTransactionId','needsReview'].filter(key=>item[key]!==undefined).map(key=>[key,item[key]]));
export function validateRefundRequests(items){return items===undefined||Array.isArray(items)&&items.length<=100000&&items.every(item=>object(item)&&typeof item.id==='string'&&typeof item.orderId==='string'&&typeof item.actorId==='string'&&Number.isSafeInteger(item.amountMinor)&&item.amountMinor>0&&['prepared','sending','unknown','confirming','completed','review_required'].includes(item.status)&&typeof item.fingerprint==='string');}

// A durable intent is committed before a provider call. Unknown outcomes are
// reconciled with payments/get; the monetary command is never blindly retried.
export function createRefundRequests({load,transaction,provider,receive,simulation,publicId,testMode,money,testFlag}){
 const flights=new Map();
 const single=(key,work)=>{if(flights.has(key))return flights.get(key);const job=Promise.resolve().then(work).finally(()=>flights.delete(key));flights.set(key,job);return job;};
 function available(db,order){return Math.max(0,Math.round(order.amount*100)-refundedMinor(order)-(db.refundRequests||[]).filter(item=>item.orderId===order.id&&item.status!=='completed'&&!item.providerTransactionId /* known refunds already projected below may be completed after a crash */).reduce((sum,item)=>sum+item.amountMinor,0)-(db.refundRequests||[]).filter(item=>item.orderId===order.id&&item.status!=='completed'&&item.providerTransactionId&&!db.refunds[item.providerTransactionId]).reduce((sum,item)=>sum+item.amountMinor,0));}
 function checkedOrder(db,id){const order=db.orders.find(item=>item.id===id);if(!order?.payment?.verified||!order.providerTransactionId)throw error(409,'Возврат доступен только для подтверждённого платежа.');if(order.testMode!==testMode)throw error(409,'Режим заказа не соответствует текущему терминалу.');if(order.simulation===true||simulation)throw error(409,'Для локального теста используйте симулятор.');return order;}
 function validateModel(model,order,{transactionId,amountMinor,refund=false}){
  if(!object(model)||tx(model.TransactionId)!==transactionId||model.Currency!==order.currency||testFlag(model.TestMode)!==order.testMode||money(model.Amount)!==amountMinor||model.PublicId!==undefined&&model.PublicId!==publicId)throw error(502,'Параметры транзакции не соответствуют заказу.','PAYMENT_RECONCILIATION_MISMATCH');
  if(refund){if(tx(model.OriginalTransactionId)!==order.providerTransactionId||transactionId===order.providerTransactionId||model.AccountId!=null&&model.AccountId!==order.userId||model.InvoiceId!=null&&model.InvoiceId!==order.id)throw error(502,'Возврат относится к другой оплате.','PAYMENT_RECONCILIATION_MISMATCH');}
  else if(model.AccountId!==order.userId||model.InvoiceId!==order.id||model.OriginalTransactionId!=null)throw error(502,'Оплата относится к другому заказу.','PAYMENT_RECONCILIATION_MISMATCH');
  if(model.Status!=='Completed')throw error(409,'Провайдер пока не подтвердил завершение транзакции.','PAYMENT_RECONCILIATION_PENDING');
 }
 function fields(model,order,refund){
  const at=model.ConfirmDateIso??model.CreatedDateIso;
  return {InvoiceId:order.id,AccountId:order.userId,Amount:model.Amount,Currency:model.Currency,TestMode:model.TestMode,TransactionId:String(model.TransactionId),Status:'Completed',OperationType:refund?'Refund':'Payment',...(refund?{PaymentTransactionId:order.providerTransactionId}:{}),...(typeof at==='string'?{DateTime:/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(at)?at+'Z':at}:{}),...(!refund&&typeof model.Token==='string'?{Token:model.Token}:{})};
 }
 async function reconcile(id,{transactionId,authorize}={}){return single('reconcile:'+id,async()=>{
  let db=await load(),item=db.refundRequests?.find(item=>item.id===id);if(!item)throw error(404,'Запрос возврата не найден.');
  if(authorize)await authorize();
  if(item.status==='completed'){if(transactionId&&tx(transactionId)!==item.providerTransactionId)throw error(409,'Возврат уже связан с другой транзакцией.');return {refund:publicRefundRequest(item)};}
  const refundTx=transactionId?tx(transactionId):item.providerTransactionId;
  if(!refundTx)return {refund:publicRefundRequest(item)};
  if(item.providerTransactionId&&item.providerTransactionId!==refundTx)throw error(409,'Возврат уже связан с другой транзакцией.');
  const order=checkedOrder(db,item.orderId),model=await provider('payments/get',{TransactionId:refundTx});validateModel(model,order,{transactionId:refundTx,amountMinor:item.amountMinor,refund:true});
  if(authorize)await authorize();
  await transaction(async current=>{
   if(authorize)await authorize();const request=current.refundRequests.find(value=>value.id===id);
   if(current.refundRequests.some(value=>value.id!==id&&value.providerTransactionId===refundTx))throw error(409,'Транзакция уже связана с другим запросом возврата.');
   if(request.providerTransactionId&&request.providerTransactionId!==refundTx)throw error(409,'Возврат уже связан с другой транзакцией.');
   request.providerTransactionId=refundTx;request.status='confirming';request.updatedAt=stamp();return request;
  });
  await receive('refund',fields(model,order,true));
  item=await transaction(current=>{const request=current.refundRequests.find(value=>value.id===id);request.status='completed';request.completedAt??=stamp();request.updatedAt=stamp();delete request.needsReview;return request;});return {refund:publicRefundRequest(item)};
 });}
 async function request(actor,input,{authorize}={}){
  if(simulation)throw error(409,'Для локального теста используйте симулятор.');
  if(!object(input)||typeof input.requestId!=='string'||!/^[a-zA-Z0-9_-]{12,100}$/.test(input.requestId)||typeof input.orderId!=='string'||!Number.isSafeInteger(input.amountMinor)||input.amountMinor<=0||typeof input.reason!=='string'||input.reason.trim().length<5||input.reason.length>500)throw error(400,'Укажите заказ, сумму в копейках, причину и идентификатор запроса.');
  const fingerprint=digest([actor.id,input.orderId,input.amountMinor,input.reason.trim()]);
  const intent=await transaction(async db=>{
   if(authorize)await authorize();db.refundRequests??=[];
   const prior=db.refundRequests.find(item=>item.requestId===input.requestId);
   if(prior){if(prior.fingerprint!==fingerprint)throw error(409,'Этот идентификатор запроса уже использован для другого возврата.');return prior;}
   if(db.refundRequests.length>=100000)throw error(409,'Журнал возвратов заполнен.');
   const order=checkedOrder(db,input.orderId);if(input.amountMinor>available(db,order))throw error(409,'Сумма превышает доступный остаток с учётом возвратов, ожидающих подтверждения.');
   const at=stamp(),item={id:'refund-'+randomUUID(),requestId:input.requestId,fingerprint,actorId:actor.id,orderId:order.id,amountMinor:input.amountMinor,reason:input.reason.trim(),createdAt:at,updatedAt:at,status:'prepared'};db.refundRequests.push(item);return item;
  });
  return single('request:'+intent.id,async()=>{
   let current=(await load()).refundRequests.find(item=>item.id===intent.id);
   if(current.status==='completed')return {refund:publicRefundRequest(current)};
   if(current.attemptedAt)return reconcile(current.id,{authorize});
   const order=checkedOrder(await load(),current.orderId);
   // Verify original payment again immediately before asking for money back.
   const payment=await provider('payments/get',{TransactionId:order.providerTransactionId});validateModel(payment,order,{transactionId:order.providerTransactionId,amountMinor:Math.round(order.amount*100)});if(payment.Refunded===true)throw error(409,'Провайдер уже отмечает возврат. Сначала сверьте его транзакции.','PAYMENT_REFUND_REVIEW_REQUIRED');
   const claimed=await transaction(async db=>{if(authorize)await authorize();const item=db.refundRequests.find(value=>value.id===current.id);if(item.attemptedAt)return false;item.attemptedAt=stamp();item.updatedAt=stamp();item.status='sending';return true;});
   if(!claimed)return reconcile(current.id,{authorize});
   try{
    if(authorize)await authorize();const response=await provider('payments/refund',{TransactionId:order.providerTransactionId,Amount:current.amountMinor/100,JsonData:{orbitaRefundRequestId:current.id}},current.id);
    const transactionId=tx(response?.TransactionId);
    await transaction(db=>{const item=db.refundRequests.find(value=>value.id===current.id);item.providerTransactionId=transactionId;item.status='confirming';item.updatedAt=stamp();return item;});
    return await reconcile(current.id,{authorize});
   }catch(cause){
    current=await transaction(db=>{const item=db.refundRequests.find(value=>value.id===current.id);if(item.status!=='completed'){item.status=item.providerTransactionId?'confirming':'unknown';item.needsReview=true;item.updatedAt=stamp();}return item;});
    if(cause.status===401||cause.status===403)throw cause;
    return {refund:publicRefundRequest(current)};
   }
  });
 }
 async function retry(actor,id,{authorize}={}){const item=(await load()).refundRequests?.find(value=>value.id===id);if(!item)throw error(404,'Запрос возврата не найден.');if(item.actorId!==actor.id)throw error(403,'Продолжить неподтверждённый запрос может его автор.');if(item.attemptedAt)return reconcile(id,{authorize});return request(actor,{orderId:item.orderId,amountMinor:item.amountMinor,reason:item.reason,requestId:item.requestId},{authorize});}
 async function reconcileOrder(orderId,{transactionId,authorize}={}){
  if(simulation)throw error(409,'Для локального теста используйте симулятор.');
  const db=await load(),order=db.orders.find(item=>item.id===orderId);if(!order)throw error(404,'Заказ не найден.');if(order.testMode!==testMode||order.simulation===true)throw error(409,'Режим заказа не соответствует текущему терминалу.');
  const paymentTx=tx(transactionId??order.providerTransactionId);if(order.providerTransactionId&&order.providerTransactionId!==paymentTx)throw error(409,'Заказ уже связан с другой транзакцией.');
  if(authorize)await authorize();const model=await provider('payments/get',{TransactionId:paymentTx});validateModel(model,order,{transactionId:paymentTx,amountMinor:Math.round(order.amount*100)});
  // Refunded=true gives no unique refund transaction/amount. Do not invent one
  // or credit an invoice from a snapshot missing the corresponding Refund.
  if(model.Refunded===true){await transaction(current=>{const item=current.orders.find(value=>value.id===orderId);item.needsReview=true;item.updatedAt=stamp();return item;});throw error(409,'Провайдер отмечает возврат. Сверьте транзакции возврата прежде чем восстанавливать оплату.','PAYMENT_REFUND_REVIEW_REQUIRED');}
  if(authorize)await authorize();await receive('pay',fields(model,order,false));return {ok:true};
 }
 async function sync(){let failed=false;const items=(await load()).refundRequests||[];for(const item of items){if(item.status==='completed'||!item.providerTransactionId)continue;try{await reconcile(item.id);}catch{failed=true;}}if(failed)throw error(503,'Некоторые возвраты ожидают подтверждения.','REFUNDS_SYNC_INCOMPLETE');}
 return {request,retry,reconcile,reconcileOrder,sync,available};
}
