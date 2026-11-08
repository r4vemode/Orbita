(async()=>{
 const A=window.OrbitaAccess,$=id=>document.getElementById(id);let owner=null,busy=false,stopped=false,epoch=0,refreshQueued=false;
 const labels={paid:'Оплачено',pending:'Ожидает оплаты',creating:'Подготовка',crediting:'Активируем доступ',failed:'Не оплачено',refunded:'Возвращено',refund_pending:'Возврат обрабатывается',refund_review:'Частичный возврат / проверка',active:'Включено',awaiting_payment:'Ожидает первой оплаты',past_due:'Неудачное списание',cancelled:'Отключено',cancellation_pending:'Отмена обрабатывается',token_unavailable:'Автопродление не подключено: провайдер не передал токен карты',rejected:'Отклонено',expired:'Завершено'};
 const terminal=new Set(['cancelled','rejected','expired']);
 const date=value=>value&&Number.isFinite(Date.parse(value))?new Date(value).toLocaleString('ru-RU',{timeZone:'Europe/Moscow'})+' МСК':'Уточняется';
 const amount=item=>Number(item.amount).toLocaleString('ru-RU',{style:'currency',currency:'RUB'});
 function clear(){for(const id of ['billingAgreements','billingOrders'])$(id).replaceChildren();}
 async function identity(){if(stopped)throw Error('Сеанс закрыт.');const current=await A.current();if(!current||owner&&owner!==current.id){stopped=true;clear();location.replace('/subscriptions.html');throw Error('Аккаунт изменился.');}owner=current.id;return current;}
 function row(item,subscription=false){
  const box=document.createElement('article');box.className='billing-row';const title=document.createElement('h3'),text=document.createElement('p');
  title.textContent=(A.plans[item.plan]?.name||item.plan)+' · '+amount(item)+(item.simulation?' · симуляция':'');
  text.textContent=(labels[item.status]||'Проверяем состояние')+' · '+(subscription?(terminal.has(item.status)?'Будущие списания отключены':item.nextChargeAt?'Следующее списание: '+date(item.nextChargeAt):'Дата следующего списания не подтверждена'):'Создан: '+date(item.createdAt));box.append(title,text);
  if(subscription&&!terminal.has(item.status)){
   const button=document.createElement('button');button.type='button';button.textContent='Отключить автопродление';
   button.onclick=async()=>{if(busy||!confirm('Отключить будущие списания? Уже оплаченный период сохранится.'))return;button.disabled=true;try{await identity();await A.request('/api/payments/subscriptions/'+encodeURIComponent(item.id)+'/cancel',{method:'POST',body:'{}'});await refresh();}catch(cause){if(!stopped)$('billingMessage').textContent=cause.message;}finally{button.disabled=false;}};box.append(button);
  }
  return box;
 }
 async function refresh(){if(stopped||document.hidden)return;if(busy){refreshQueued=true;return;}busy=true;const revision=++epoch;$('refreshBilling').disabled=true;try{
  await identity();const [history,agreements]=await Promise.all([A.request('/api/payments/history'),A.request('/api/payments/subscriptions')]);await identity();if(stopped||document.hidden||revision!==epoch)return;clear();
  for(const item of agreements.subscriptions||[])$('billingAgreements').append(row(item,true));
  for(const item of history.orders||[])$('billingOrders').append(row(item));
  $('billingMessage').textContent=history.orders?.length?'Возврат и отключение автопродления — отдельные действия. По вопросам возврата обратитесь в поддержку.':'Платежей пока нет.';
 }catch(cause){clear();if(!stopped)$('billingMessage').textContent=cause.message;}finally{busy=false;$('refreshBilling').disabled=false;if(refreshQueued){refreshQueued=false;void refresh();}}}
 $('refreshBilling').onclick=refresh;
 document.addEventListener('visibilitychange',()=>{if(document.hidden){epoch++;clear();}else void refresh();});
 window.addEventListener('pagehide',()=>{stopped=true;epoch++;clear();});await refresh();
})();
