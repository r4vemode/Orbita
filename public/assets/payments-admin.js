(async()=>{
 const A=window.OrbitaAccess,$=id=>document.getElementById(id),owner=await A.requireAdmin();if(!owner)return;
 let guard,busy=false,simulation=false,testMode=false,refreshEpoch=0;const pendingRequests=new Map();
 const labels={creating:'Подготовка',pending:'Ожидает оплаты',crediting:'Подтверждение оплаты',paid:'Оплачено',failed:'Не оплачено',refund_pending:'Возврат обрабатывается',refund_review:'Частичный возврат / проверка',refunded:'Возвращено',prepared:'Подготовлен',sending:'Отправлен провайдеру',unknown:'Результат требует сверки',confirming:'Проверяется подтверждение',completed:'Возврат подтверждён',review_required:'Требует проверки'};
 const text=(tag,value)=>{const node=document.createElement(tag);node.textContent=value;return node;};
 const money=value=>(value/100).toLocaleString('ru-RU',{style:'currency',currency:'RUB'});
 const clear=()=>{refreshEpoch++;for(const id of ['paymentAdminOrders','paymentAdminRefunds','simulationUser'])$(id).replaceChildren();};
 guard=window.OrbitaAdminSession.watch(owner,{workspace:'paymentAdminWorkspace',clear});$('paymentAdminWorkspace').hidden=false;
 async function action(url,body,{idempotent=false}={}){
  if(busy)return;busy=true;
  const key=JSON.stringify([url,{...body,password:undefined,code:undefined}]),requestId=pendingRequests.get(key)||crypto.randomUUID();
  if(idempotent)pendingRequests.set(key,requestId);
  try{
   const result=await guard.request(url,{method:'POST',body:JSON.stringify({...body,...(idempotent?{requestId}:{})})});pendingRequests.delete(key);
   $('paymentAdminMessage').textContent=result.refund?result.refund.status==='completed'?'Возврат подтверждён сервером.':'Запрос сохранён. '+(labels[result.refund.status]||'Проверяем состояние')+'.':simulation?'Тестовая операция обработана.':'Состояние платежа сверено с провайдером.';
  }catch(cause){$('paymentAdminMessage').textContent=cause.message;}
  finally{busy=false;await refresh();}
 }
 function simulationButton(label,body){const node=text('button',label);node.type='button';node.onclick=()=>{if(!confirm(label+'? Это действие изменит только локальные тестовые данные.'))return;void action('/api/admin/payments/simulate',body,{idempotent:true});};return node;}
 function field(label,{type='text',value='',required=true}={}){const box=document.createElement('label'),input=document.createElement('input');box.append(text('span',label));input.type=type;input.value=value;input.required=required;box.append(input);return {box,input};}
 function credentials(form){const password=field('Ваш пароль',{type:'password'}),code=field('Код MFA, если включён',{required:owner.security?.mfaEnabled===true});password.input.autocomplete='current-password';code.input.autocomplete='one-time-code';form.append(password.box,code.box);return ()=>{const result={password:password.input.value,code:code.input.value};password.input.value='';code.input.value='';return result;};}
 function details(title){const node=document.createElement('details');node.append(text('summary',title));return node;}
 function submit(form,label,handler){const button=text('button',label);button.type='submit';form.append(button);form.onsubmit=event=>{event.preventDefault();if(!busy)handler();};}
 function refundForm(order){
  const box=details('Оформить возврат'),form=document.createElement('form');form.className='billing-form';
  const amount=field('Сумма возврата, ₽',{type:'number',value:order.remainingRefundMinor/100}),reason=field('Основание возврата');amount.input.min='0.01';amount.input.max=String(order.remainingRefundMinor/100);amount.input.step='0.01';reason.input.minLength=5;reason.input.maxLength=500;
  form.append(text('p','Доступно с учётом уже оформленных возвратов: '+money(order.remainingRefundMinor)),amount.box,reason.box);const credentialsBody=credentials(form);
  submit(form,'Отправить запрос возврата',()=>{const amountMinor=Math.round(Number(amount.input.value)*100);if(!confirm('Вернуть '+money(amountMinor)+' по заказу '+order.id+'? '+(order.testMode?'Тестовый терминал CloudPayments.':'Это реальная денежная операция.')))return;void action('/api/admin/payments/refunds',{orderId:order.id,amountMinor,reason:reason.input.value,...credentialsBody()},{idempotent:true});});box.append(form);return box;
 }
 function retryForm(item){
  const box=details('Продолжить подготовленный возврат'),form=document.createElement('form');form.className='billing-form';
  form.append(text('p','Запрос сохранён, но денежная команда ещё не отправлялась. Повтор продолжит этот же возврат на '+money(item.amountMinor)+'.'));const credentialsBody=credentials(form);
  submit(form,'Продолжить возврат',()=>{if(!confirm('Продолжить возврат '+money(item.amountMinor)+'? '+(testMode?'Тестовый терминал CloudPayments.':'Это реальная денежная операция.')))return;void action('/api/admin/payments/refunds/'+encodeURIComponent(item.id)+'/retry',credentialsBody());});box.append(form);return box;
 }
 function reconcileForm(item,refund=false){
  const box=details(refund?'Сверить возврат':'Сверить оплату с CloudPayments'),form=document.createElement('form');form.className='billing-form';
  const transaction=field(refund?'ID транзакции возврата из CloudPayments':'ID транзакции оплаты из CloudPayments',{value:item.providerTransactionId||'',required:!refund||!item.providerTransactionId});transaction.input.inputMode='numeric';transaction.input.pattern='[1-9][0-9]{0,24}';form.append(transaction.box);
  if(refund)form.append(text('p','Укажите ID именно возврата. Сумма и исходная оплата проверяются сервером; перевод не повторяется.'));
  const credentialsBody=refund?credentials(form):()=>({});
  submit(form,'Проверить у провайдера',()=>{void action('/api/admin/payments/'+(refund?'refunds/':'orders/')+encodeURIComponent(item.id)+'/reconcile',{...(transaction.input.value?{transactionId:transaction.input.value}:{}),...credentialsBody()});});box.append(form);return box;
 }
 async function refresh(){const epoch=++refreshEpoch;try{
  const data=await guard.request('/api/admin/payments/orders');if(epoch!==refreshEpoch)return;
  simulation=data.simulation===true;testMode=data.testMode===true;$('simulationPanel').hidden=!simulation;$('paymentAdminOrders').replaceChildren();$('paymentAdminRefunds').replaceChildren();
  for(const order of data.orders||[]){
   const card=document.createElement('article');card.className='billing-row';card.append(text('h3',(A.plans[order.plan]?.name||order.plan)+' · '+money(Math.round(order.amount*100))+' · '+(labels[order.status]||'Проверяем состояние')),text('p',order.id+(order.simulation?' · локальная симуляция':order.testMode?' · тестовый терминал CloudPayments':'')));
   if(simulation&&order.simulation){
    if(!['paid','refunded','refund_review'].includes(order.status))card.append(simulationButton('Успешная оплата',{action:'pay',orderId:order.id}),simulationButton('Отказ оплаты',{action:'fail',orderId:order.id}));
    if(order.status==='paid')card.append(simulationButton('Полный возврат',{action:'refund',orderId:order.id}));
    const agreement=data.subscriptions.find(item=>item.id===order.agreementId);
    if(agreement?.status==='active')card.append(simulationButton('Повторное списание',{action:'renew',agreementId:agreement.id}),simulationButton('Отказ продления',{action:'renew-fail',agreementId:agreement.id}),simulationButton('Отключить продление',{action:'cancel',agreementId:agreement.id}));
   }else if(!order.simulation){
    card.append(reconcileForm(order));if(['paid','refund_review'].includes(order.status)&&order.remainingRefundMinor>0)card.append(refundForm(order));
   }
   $('paymentAdminOrders').append(card);
  }
  for(const item of data.refundRequests||[]){const card=document.createElement('article');card.className='billing-row';card.append(text('h3',money(item.amountMinor)+' · '+(labels[item.status]||'Проверяем состояние')),text('p',item.orderId),text('p',item.reason));if(!simulation&&item.status!=='completed')card.append(item.status==='prepared'?retryForm(item):reconcileForm(item,true));$('paymentAdminRefunds').append(card);}
  if(!data.orders?.length)$('paymentAdminOrders').textContent='Платежей пока нет.';
  if(!data.refundRequests?.length)$('paymentAdminRefunds').textContent='Запросов возврата пока нет.';
 }catch(cause){$('paymentAdminMessage').textContent=cause.message;}}
 $('paymentAdminRefresh').onclick=refresh;
 $('simulationCreate').onsubmit=event=>{event.preventDefault();if(!simulation)return;void action('/api/admin/payments/simulate',{action:'create',userId:$('simulationUser').value,plan:$('simulationPlan').value,recurring:$('simulationRecurring').checked},{idempotent:true});};
 try{const {users}=await guard.request('/api/admin/users');for(const user of users){const option=text('option',user.email);option.value=user.id;$('simulationUser').append(option);}$('paymentAdminMessage').textContent='Оплаты и возвраты учитываются по подтверждениям сервера.';await refresh();}catch(cause){$('paymentAdminMessage').textContent=cause.message;}
})();
