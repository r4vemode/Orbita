(async()=>{
 const A=window.OrbitaAccess,$=id=>document.getElementById(id),admin=document.body.dataset.referralAdmin==='true';
 const owner=admin?await A.requireAdmin():await A.current();if(!owner){location.replace('/account.html?next='+encodeURIComponent(location.pathname));return;}
 let busy=false,stopped=false,refreshEpoch=0;const pending=new Map();
 const clear=()=>{$('referralList').replaceChildren();if($('partnerUser'))$('partnerUser').replaceChildren();};
 const guard=admin?window.OrbitaAdminSession.watch(owner,{workspace:'referralWorkspace',clear}):null;
 async function identity(){if(stopped)throw Error('Сеанс закрыт.');if(guard){await guard.ensure();return;}const user=await A.current();if(!user||user.id!==owner.id){stopped=true;clear();location.replace('/partner.html');throw Error('Сеанс изменился.');}}
 async function request(...args){if(guard)return guard.request(...args);await identity();const data=await A.request(...args);await identity();return data;}
 const text=(tag,value,cls)=>{const node=document.createElement(tag);node.textContent=value;if(cls)node.className=cls;return node;};
 const money=value=>(value/100).toLocaleString('ru-RU',{style:'currency',currency:'RUB'});
 const date=value=>new Date(value).toLocaleString('ru-RU',{timeZone:'Europe/Moscow'})+' МСК';
 const conversion=(count,total)=>total>0?(count/total*100).toLocaleString('ru-RU',{maximumFractionDigits:1})+'%':'—';
 function input(label,value,type='number'){const box=document.createElement('label'),field=document.createElement('input');box.append(text('span',label));field.type=type;field.value=value;field.required=true;if(type==='number'){field.min='0';field.step='0.01';}box.append(field);return {box,field};}
 function button(label,callback){const node=text('button',label);node.type='button';node.onclick=callback;return node;}
 async function mutate(url,body){
  if(busy||stopped)return;busy=true;const key=JSON.stringify({...body,password:undefined,code:undefined}),requestId=pending.get(key)||crypto.randomUUID();pending.set(key,requestId);
  try{await request(url,{method:'POST',body:JSON.stringify({...body,requestId})});pending.delete(key);$('referralMessage').textContent='Изменения сохранены.';await refresh();}
  catch(cause){$('referralMessage').textContent=cause.message;}finally{busy=false;}
 }
 function adminControls(partner,card){
  if(partner.fraudReview){const risk=partner.fraudReview;card.append(text('p',`Проверка привлечений: саморефералы и превышения лимита — ${risk.blockedRegistrations}; повторные регистрации с одного перехода — ${risk.reusedVisitRegistrations}; ожидают проверки перед выплатой — ${risk.unreviewedRegistrations}.`));for(const item of risk.registrations||[])card.append(text('p',(item.email||item.userId)+' · '+date(item.registeredAt)+' · повторный переход','referral-entry'));}
  card.append(button(partner.active?'Остановить новые начисления':'Возобновить партнёра',()=>{const reason=prompt('Основание изменения');if(reason)void mutate('/api/admin/referrals/partners/'+partner.id,{revision:partner.revision,active:!partner.active,reason});}));
  const details=document.createElement('details');details.append(text('summary','Условия будущих начислений'));const form=document.createElement('form'),fields=document.createElement('div');fields.className='referral-fields';
  const first=input('Первый платёж, %',partner.terms.firstBps/100),repeat=input('Повторные, %',partner.terms.repeatBps/100),periods=input('Количество оплат',partner.terms.maxPayments),hold=input('Удержание, дней',partner.terms.holdDays),reason=input('Основание','','text');
  for(const item of [first,repeat,periods,hold])fields.append(item.box);form.append(fields,reason.box);const save=text('button','Сохранить условия');save.type='submit';form.append(save);form.onsubmit=event=>{event.preventDefault();void mutate('/api/admin/referrals/partners/'+partner.id,{revision:partner.revision,reason:reason.field.value,terms:{firstBps:Math.round(Number(first.field.value)*100),repeatBps:Math.round(Number(repeat.field.value)*100),maxPayments:Number(periods.field.value),holdDays:Number(hold.field.value)}});};details.append(form);card.append(details);
  const reserve=document.createElement('form'),amount=input('Сумма резерва выплаты, ₽',Math.max(partner.balance.availableMinor,0)/100);reserve.append(amount.box);const submit=text('button','Зарезервировать выплату');submit.type='submit';submit.disabled=partner.balance.availableMinor<=0;reserve.append(submit);reserve.onsubmit=event=>{event.preventDefault();const reviewRequired=partner.fraudReview?.unreviewedRegistrations>0;if(reviewRequired&&!confirm('Есть повторные регистрации с одного перехода: '+partner.fraudReview.unreviewedRegistrations+'. Подтверждаете, что проверили привлечения и разрешаете резерв выплаты? Один браузер может использовать семья; это признак для проверки, а не доказательство мошенничества.'))return;void mutate('/api/admin/referrals/payouts',{action:'reserve',partnerId:partner.id,amountMinor:Math.round(Number(amount.field.value)*100),...(reviewRequired?{reviewAcknowledged:true}:{})});};card.append(reserve);
 }
 function payout(partner,item){
  const box=document.createElement('div');box.className='referral-entry';const labels={reserved:'Зарезервировано',paid:'Выплачено',cancelled:'Резерв отменён'};box.append(text('p',money(item.amountMinor)+' · '+labels[item.status]+' · '+date(item.createdAt)));
  if(admin&&item.status==='reserved'){
   box.append(button('Отменить резерв',()=>{if(confirm('Освободить зарезервированную сумму?'))void mutate('/api/admin/referrals/payouts',{action:'cancel',payoutId:item.id});}));
   const form=document.createElement('form'),reference=input('Номер подтверждённой внешней выплаты','','text'),password=input('Ваш пароль','','password'),code=input('Код MFA, если включён','','text');password.field.autocomplete='current-password';code.field.autocomplete='one-time-code';code.field.required=owner.security?.mfaEnabled===true;form.append(reference.box,password.box,code.box);
   const submit=text('button','Зафиксировать выполненную выплату');submit.type='submit';form.append(submit);
   form.onsubmit=event=>{event.preventDefault();if(!confirm('Подтверждаете, что '+money(item.amountMinor)+' уже выплачены партнёру? Перевод денег здесь не выполняется.'))return;const body={action:'paid',payoutId:item.id,reference:reference.field.value,password:password.field.value,code:code.field.value};password.field.value='';code.field.value='';void mutate('/api/admin/referrals/payouts',body);};box.append(form);
  }
  return box;
 }
 function render(partner){
  const card=document.createElement('article');card.className='panel referral-card';card.append(text('h2',partner.name),text('p',partner.active?'Партнёрская ссылка активна':'Новые привлечения и начисления остановлены'));
  if(/^\/r\/[a-f0-9]{24}$/.test(partner.link)){const link=text('a',location.origin+partner.link,'referral-link');link.href=partner.link;card.append(link);}
  card.append(text('p',`Первая подтверждённая сервером оплата: ${partner.terms.firstBps/100}%; последующие: ${partner.terms.repeatBps/100}%. До ${partner.terms.maxPayments} оплат. Порядок определяется подтверждением на сервере; задержанные уведомления не меняют уже начисленные комиссии. Удержание: ${partner.terms.holdDays} дней. Условия №${partner.terms.version}.`));
  const stats=document.createElement('div');stats.className='referral-stats';
  for(const [label,value] of [['Переходы',partner.visits],['Регистрации',partner.registrations],['Оплатившие клиенты',partner.payingUsers],['Оплаты, всего',partner.payments],['Продажи до возвратов',money(partner.salesMinor)],['Регистрации / переходы',conversion(partner.registrations,partner.visits)],['Оплатившие / регистрации',conversion(partner.payingUsers,partner.registrations)],['Комиссии после возвратов',money(partner.balance.totalMinor)],['Доступно к выплате',money(partner.balance.availableMinor)],['На удержании',money(partner.balance.pendingMinor)],['Выплачено',money(partner.balance.paidMinor)]]){const box=document.createElement('div');box.className='referral-stat';box.append(text('span',label),text('strong',String(value)));stats.append(box);}card.append(stats,text('p','Переходы считаются по cookie браузера, а не по уникальным людям. Один переход может привести к нескольким регистрациям.'));
  if(admin)adminControls(partner,card);
  const entries=document.createElement('details');entries.append(text('summary','Начисления и корректировки'));
  for(const entry of [...partner.entries].reverse())entries.append(text('p',(entry.kind==='refund'?'Возврат: ':'Начисление: ')+money(entry.amountMinor)+' · '+date(entry.at),'referral-entry'));
  if(!partner.entries.length)entries.append(text('p','Начислений пока нет.'));card.append(entries);
  const payouts=document.createElement('details');payouts.append(text('summary','История выплат'));for(const item of [...partner.payouts].reverse())payouts.append(payout(partner,item));if(!partner.payouts.length)payouts.append(text('p','Выплат пока нет.'));card.append(payouts);return card;
 }
 async function refresh(){if(stopped||document.hidden)return;const revision=++refreshEpoch;try{const data=await request(admin?'/api/admin/referrals':'/api/referrals/me');if(stopped||document.hidden||revision!==refreshEpoch)return;$('referralList').replaceChildren();for(const partner of data.partners)$('referralList').append(render(partner));if(!data.partners.length)$('referralList').append(text('p',admin?'Партнёров пока нет.':'Партнёрская программа для вашего аккаунта пока не подключена. Обратитесь в поддержку.'));if(data.simulation)$('referralMessage').textContent='Локальный тест: здесь показаны только симулированные комиссии и выплаты. Реальные деньги не переводятся.';}catch(cause){$('referralList').replaceChildren();$('referralMessage').textContent=cause.message;}}
 $('referralWorkspace').hidden=false;$('referralRefresh').onclick=refresh;
 if(admin){try{const {users}=await request('/api/admin/users');for(const user of users){const option=text('option',user.email);option.value=user.id;$('partnerUser').append(option);}}catch(cause){$('referralMessage').textContent=cause.message;}
  $('partnerCreate').onsubmit=event=>{event.preventDefault();void mutate('/api/admin/referrals/partners',{userId:$('partnerUser').value,name:$('partnerName').value,terms:{firstBps:Math.round(Number($('partnerFirst').value)*100),repeatBps:Math.round(Number($('partnerRepeat').value)*100),maxPayments:Number($('partnerPeriods').value),holdDays:Number($('partnerHold').value)}});};
 }
 if(!admin)document.addEventListener('visibilitychange',()=>{if(document.hidden){refreshEpoch++;$('referralList').replaceChildren();}else void refresh();});
 window.addEventListener('pagehide',()=>{stopped=true;refreshEpoch++;clear();});$('referralMessage').textContent='Подтверждённые оплаты, комиссии и ручные выплаты.';await refresh();
})();
