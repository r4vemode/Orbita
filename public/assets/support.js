(() => {
 'use strict';
 const $=id=>document.getElementById(id),A=window.OrbitaAccess,newForm=$('supportNewForm'),replyForm=$('supportReplyForm');
 const categories={account:'Аккаунт и вход',payment:'Оплата и подписка',ideas:'Идеи и сделки',other:'Другой вопрос'},statuses={open:'Открыто',in_progress:'В работе',waiting_customer:'Нужен ваш ответ',resolved:'Решено'};
 const pageOptions=new Map([...newForm.elements.page.options].filter(option=>option.value).map(option=>[option.value,option.textContent]));
 const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value),ticketId=value=>typeof value==='string'&&/^ticket-[a-f0-9-]{36}$/i.test(value);
 const node=(tag,className,text)=>{const element=document.createElement(tag);if(className)element.className=className;if(text!==undefined)element.textContent=String(text);return element;};
 const date=value=>Number.isFinite(Date.parse(value))?new Intl.DateTimeFormat('ru-RU',{timeZone:'Europe/Moscow',day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'}).format(new Date(value))+' МСК':'Время не указано';
 const requests=new Set(),drafts=new Map(),replyPending=new Map(),replyBaseline=new Map();
 let ownerId=null,epoch=0,ready=false,invalidated=false,booting=false,checking=null,timer=null,tickets=[],selected=null,current=null,newPending=null,mutating=false,listSequence=0,detailSequence=0,focusState=null;
 const initialVisibility=$('supportWorkspace').style.visibility,initialInert=$('supportWorkspace').inert;
 function status(id,text,error=false){$(id).textContent=text;$(id).classList.toggle('error',error);}
 function countText(){ $('supportMessageCount').textContent=newForm.elements.message.value.length+' / 3000';$('supportReplyCount').textContent=replyForm.elements.message.value.length+' / 3000'; }
 function mask(text){const root=$('supportWorkspace');if(!focusState&&root.contains(document.activeElement)){const element=document.activeElement;focusState={element};try{focusState.start=element.selectionStart;focusState.end=element.selectionEnd;focusState.direction=element.selectionDirection;}catch{}}root.style.visibility='hidden';root.inert=true;$('supportIdentity').hidden=true;status('supportInitialStatus',text);}
 function reveal(){if(!ready||invalidated||document.hidden)return;const root=$('supportWorkspace');root.style.visibility=initialVisibility;root.inert=initialInert;$('supportIdentity').hidden=false;status('supportInitialStatus','');$('supportAccessRetry').hidden=true;const saved=focusState;focusState=null;if(saved?.element.isConnected&&!saved.element.disabled){saved.element.focus({preventScroll:true});if(Number.isInteger(saved.start)&&Number.isInteger(saved.end))try{saved.element.setSelectionRange(saved.start,saved.end,saved.direction);}catch{}}}
 function clearPrivate(){tickets=[];selected=current=null;newPending=null;drafts.clear();replyPending.clear();replyBaseline.clear();newForm.reset();replyForm.reset();for(const id of ['supportList','supportMessages','supportHistory','supportTicketContext'])$(id).replaceChildren();for(const id of ['supportIdentity','supportTicketNumber','supportTicketSubject','supportTicketStatus','supportTicketMeta','supportReplyStatus','supportCreateStatus','supportThreadStatus','supportListStatus'])$(id).textContent='';$('supportCount').textContent='0';countText();}
 function invalidate(next){if(invalidated)return;invalidated=true;epoch++;listSequence++;detailSequence++;clearTimeout(timer);for(const controller of requests)controller.abort();clearPrivate();$('supportWorkspace').hidden=true;focusState=null;status('supportInitialStatus','Аккаунт изменился. Открываем поддержку заново…');$('supportAccessRetry').hidden=true;location.replace(next?.id?'/support.html':'/account.html?next=%2Fsupport.html');}
 async function raw(path,options={}){
  const controller=new AbortController();requests.add(controller);const timeout=setTimeout(()=>controller.abort(),8000);
  try{
   let response;try{response=await fetch(path,{credentials:'same-origin',cache:'no-store',...options,headers:{...(options.body?{'Content-Type':'application/json'}:{}),...options.headers},signal:controller.signal});}catch(cause){if(invalidated)throw Object.assign(Error('Аккаунт изменился.'),{handled:true});throw Error(cause.name==='AbortError'?'Ответ не получен вовремя. Повторите запрос.':'Нет связи с поддержкой. Проверьте подключение и повторите запрос.');}
   let data;try{if(!response.headers.get('content-type')?.includes('application/json'))throw Error();data=await response.json();}catch{throw Error('Сервис поддержки не ответил. Откройте проект через npm start и повторите запрос.');}
   if(!response.ok)throw Object.assign(Error(A.supportMessage(data,'Не удалось выполнить запрос.')),{status:response.status,code:data.code});return data;
  }finally{clearTimeout(timeout);requests.delete(controller);}
 }
 function schedule(){clearTimeout(timer);if(ready&&!invalidated&&!document.hidden)timer=setTimeout(()=>{void refresh({quiet:true});},30000);}
 async function verify(){
  if(invalidated)return false;if(checking)return checking;mask('Проверяем доступ к вашим обращениям…');$('supportAccessRetry').hidden=true;
  checking=(async()=>{try{const data=await raw('/api/me');if(invalidated)return false;if(!Object.hasOwn(data,'user'))throw Error('Не удалось проверить аккаунт.');if(!data.user?.id||ownerId&&data.user.id!==ownerId){invalidate(data.user);return false;}reveal();return true;}catch(cause){if(!invalidated){if(cause.status===401){invalidate(null);return false;}mask('Не удалось проверить аккаунт. Ваши несохранённые поля остаются в этой вкладке.');$('supportAccessRetry').hidden=false;}return false;}})();
  try{return await checking;}finally{checking=null;schedule();}
 }
 async function ensure(){if(!await verify())throw Object.assign(Error('Доступ к обращениям пока не подтверждён.'),{handled:true});}
 async function api(path,options={}){const lifecycle=epoch;await ensure();let data,problem;try{data=await raw(path,options);}catch(cause){problem=cause;}if(problem?.status===401){invalidate(null);throw Object.assign(Error('Войдите в аккаунт.'),{handled:true});}if(lifecycle!==epoch||invalidated)throw Object.assign(Error('Аккаунт изменился.'),{handled:true});await ensure();if(lifecycle!==epoch||invalidated)throw Object.assign(Error('Аккаунт изменился.'),{handled:true});if(problem)throw problem;return data;}
 function confirmedTicket(ticket,expectedId){
  const timed=value=>typeof value==='string'&&Number.isFinite(Date.parse(value)),text=value=>typeof value==='string';
  if(!ticket||!ticketId(ticket.id)||expectedId&&ticket.id!==expectedId||!text(ticket.number)||!/^ORB-\d{6}$/.test(ticket.number)||!text(ticket.subject)||!Object.hasOwn(categories,ticket.category)||!Object.hasOwn(statuses,ticket.status)||!Number.isSafeInteger(ticket.revision)||ticket.revision<1||!timed(ticket.createdAt)||!timed(ticket.updatedAt)||!Array.isArray(ticket.messages)||!ticket.messages.length||ticket.messages.length>50||!Array.isArray(ticket.history)||!ticket.history.length||ticket.history.length>200)throw Error('Сервер не подтвердил обращение. Ваш текст сохранён; повторите запрос.');
  if(ticket.messages.some(message=>!message||!text(message.id)||!text(message.text)||!['customer','admin'].includes(message.author)||!timed(message.createdAt))||ticket.history.some(event=>!event||!['created','reply','status'].includes(event.action)||!timed(event.at)))throw Error('Сервер не подтвердил переписку. Ваш текст сохранён; повторите запрос.');
  return ticket;
 }
 function controls(){
  for(const id of ['supportRefresh','supportRefreshTicket','supportNew','supportFilter'])$(id).disabled=mutating||invalidated;
  for(const button of $('supportList').querySelectorAll('button'))button.disabled=mutating||invalidated;
  for(const element of newForm.querySelectorAll('input,textarea,select'))element.disabled=mutating||Boolean(newPending)||invalidated;
  for(const element of replyForm.querySelectorAll('input,textarea,select'))element.disabled=mutating||Boolean(replyPending.get(selected))||invalidated;
  $('supportCreate').disabled=mutating||invalidated;$('supportSendReply').disabled=mutating||!current||invalidated;
  $('supportCreate').textContent=newPending?'Повторить отправку →':'Отправить обращение →';$('supportSendReply').textContent=replyPending.has(selected)?'Повторить отправку →':'Отправить дополнение →';$('supportCreatePending').hidden=mutating||!newPending;$('supportReplyPending').hidden=mutating||!replyPending.has(selected);
 }
 function badge(value){const element=node('span','support-badge',statuses[value]||'Статус уточняется');element.dataset.status=value;return element;}
 function renderList(){
  const filter=$('supportFilter').value,visible=tickets.filter(ticket=>filter==='all'||filter==='resolved'&&ticket.status==='resolved'||filter==='active'&&ticket.status!=='resolved'),fragment=document.createDocumentFragment();
  for(const ticket of visible){const button=node('button','support-ticket');button.type='button';button.dataset.supportTicket=ticket.id;button.setAttribute('aria-current',String(ticket.id===selected));const top=node('span','support-ticket-top');top.append(node('span','',ticket.number),badge(ticket.status));button.append(top,node('strong','',ticket.subject),node('small','',(categories[ticket.category]||'Обращение')+' · '+date(ticket.updatedAt)));button.addEventListener('click',()=>{if(!mutating)void openTicket(ticket.id);});fragment.append(button);}
  $('supportList').replaceChildren(fragment);$('supportList').setAttribute('aria-busy','false');$('supportCount').textContent=String(tickets.length);$('supportEmpty').hidden=visible.length>0;$('supportEmpty').textContent=tickets.length?'В этом разделе пока нет обращений. Выберите «Все», чтобы вернуться к списку.':'Здесь появятся ваши обращения. Нажмите «Новое обращение», чтобы написать команде.';controls();
 }
 function renderTicket(ticket,{focus=false}={}){
  confirmedTicket(ticket);
  const changing=selected!==ticket.id;selected=ticket.id;current=ticket;$('supportCompose').hidden=true;$('supportWelcome').hidden=true;$('supportDetail').hidden=false;
  $('supportTicketNumber').textContent=ticket.number;$('supportTicketSubject').textContent=ticket.subject;$('supportTicketStatus').textContent=statuses[ticket.status]||'Статус уточняется';$('supportTicketStatus').dataset.status=ticket.status;$('supportTicketMeta').textContent=(categories[ticket.category]||'Обращение')+' · Создано '+date(ticket.createdAt);
  const context=document.createDocumentFragment();if(pageOptions.has(ticket.page)){const paragraph=node('p');paragraph.append('Страница: ');const link=node('a','',pageOptions.get(ticket.page)+' ↗');link.href=ticket.page;paragraph.append(link);context.append(paragraph);}if(uuid(ticket.reference))context.append(node('p','','Код обращения из ошибки: '+ticket.reference));$('supportTicketContext').replaceChildren(context);
  const messages=document.createDocumentFragment();for(const message of ticket.messages){const article=node('article','support-message');article.dataset.author=message.author==='admin'?'admin':'customer';const head=node('div','support-message-head');head.append(node('strong','',message.author==='admin'?'Команда Orbita':'Вы'),node('time','',date(message.createdAt)));article.append(head,node('p','',message.text));messages.append(article);}$('supportMessages').replaceChildren(messages);
  const history=document.createDocumentFragment();for(const event of ticket.history){let text=event.action==='created'?'Обращение создано':event.action==='reply'?(event.author==='admin'?'Команда добавила ответ':'Вы добавили сообщение'):'Статус: '+(statuses[event.from]||'—')+' → '+(statuses[event.to]||'—');history.append(node('li','',date(event.at)+' · '+text));}$('supportHistory').replaceChildren(history);
  if(changing){replyForm.elements.message.value=drafts.get(ticket.id)||'';status('supportReplyStatus','');}
  $('supportReplyHint').textContent=ticket.status==='resolved'?'Новое сообщение снова откроет обращение. Не отправляйте пароли и платёжные данные.':'Ответ увидит команда Orbita. Не указывайте пароли и платёжные данные.';
  replyForm.action='/api/support/'+encodeURIComponent(ticket.id)+'/messages';countText();renderList();controls();if(focus&&!document.hidden)$('supportTicketSubject').focus({preventScroll:true});
 }
 function showCompose({focus=true}={}){if(mutating||invalidated)return;detailSequence++;selected=current=null;$('supportDetail').hidden=true;$('supportWelcome').hidden=true;$('supportCompose').hidden=false;renderList();controls();if(focus&&!document.hidden)newForm.elements.subject.focus({preventScroll:true});}
 async function loadList(){const sequence=++listSequence;const data=await api('/api/support');if(invalidated||sequence!==listSequence)return;if(!Array.isArray(data.tickets))throw Error('Не удалось получить список обращений.');tickets=data.tickets;renderList();status('supportListStatus','');}
 async function openTicket(id,{focus=true}={}){
  if(mutating||invalidated||!ticketId(id))return;const sequence=++detailSequence;status('supportThreadStatus','Загружаем переписку…');
  try{const data=await api('/api/support/'+encodeURIComponent(id));if(invalidated||sequence!==detailSequence)return;renderTicket(confirmedTicket(data.ticket,id),{focus});status('supportThreadStatus','');}
  catch(cause){if(cause.handled)return;status('supportThreadStatus',cause.message,true);if($('supportDetail').hidden)status('supportListStatus',cause.message,true);}
 }
 async function refresh({quiet=false}={}){if(invalidated||mutating)return;try{await loadList();if(selected)await openTicket(selected,{focus:false});else if(!$('supportCompose').hidden||newPending)controls();}catch(cause){if(!cause.handled)status('supportListStatus',cause.message,true);}finally{schedule();}}
 const conflict=cause=>cause.status===409&&['SUPPORT_REVISION_CONFLICT','SUPPORT_REQUEST_CONFLICT'].includes(cause.code);
 const definite=cause=>Number.isInteger(cause.status)&&cause.status>=400&&cause.status<500&&cause.status!==408&&(cause.status!==409||conflict(cause)||cause.code==='SUPPORT_CAPACITY')&&(cause.status!==429||['SUPPORT_DAILY_LIMIT','SUPPORT_ACTIVE_LIMIT'].includes(cause.code));
 async function createTicket(event){
  event.preventDefault();if(mutating||invalidated||!ready)return;if(!newPending&&!newForm.reportValidity())return;
  if(!newPending){const subject=newForm.elements.subject.value.trim(),message=newForm.elements.message.value.trim(),reference=newForm.elements.reference.value.trim();if(!subject||!message){status('supportCreateStatus','Заполните тему и сообщение.',true);return;}if(reference&&!uuid(reference)){status('supportCreateStatus','Укажите код из ошибки целиком или оставьте поле пустым.',true);newForm.elements.reference.focus();return;}newPending={requestId:crypto.randomUUID(),subject,category:newForm.elements.category.value,message,page:newForm.elements.page.value,reference};}
  mutating=true;listSequence++;detailSequence++;controls();status('supportCreateStatus','Отправляем обращение…');
  try{const data=await api('/api/support',{method:'POST',body:JSON.stringify(newPending)});if(invalidated)return;const ticket=confirmedTicket(data.ticket);if(ticket.subject!==newPending.subject||ticket.category!==newPending.category||!ticket.messages.some(message=>message.author==='customer'&&message.text===newPending.message))throw Error('Сервер не подтвердил отправку вашего текста. Поля сохранены; повторите запрос.');newPending=null;newForm.reset();status('supportCreateStatus','');countText();renderTicket(ticket,{focus:true});status('supportReplyStatus','Обращение отправлено. Ответ команды появится здесь.');try{await loadList();}catch(cause){if(!cause.handled)status('supportListStatus',cause.message,true);}}
  catch(cause){if(cause.handled)return;if(definite(cause))newPending=null;status('supportCreateStatus',cause.message,true);}
  finally{mutating=false;if(!invalidated)controls();schedule();}
 }
 async function sendReply(event){
  event.preventDefault();if(mutating||invalidated||!current)return;const id=current.id;
  if(!replyPending.has(id)){if(!replyForm.reportValidity())return;const message=replyForm.elements.message.value.trim();if(!message){status('supportReplyStatus','Напишите сообщение.',true);return;}replyPending.set(id,{requestId:crypto.randomUUID(),revision:current.revision,message});replyBaseline.set(id,new Set(current.messages.map(item=>item.id)));}
  mutating=true;listSequence++;detailSequence++;controls();status('supportReplyStatus','Отправляем дополнение…');
  try{const data=await api('/api/support/'+encodeURIComponent(id)+'/messages',{method:'POST',body:JSON.stringify(replyPending.get(id))});if(invalidated)return;const ticket=confirmedTicket(data.ticket,id),pending=replyPending.get(id);if(ticket.revision<=pending.revision||!ticket.messages.some(message=>message.author==='customer'&&message.text===pending.message&&!replyBaseline.get(id)?.has(message.id)))throw Error('Сервер не подтвердил дополнение. Ваш текст сохранён; повторите запрос.');replyPending.delete(id);replyBaseline.delete(id);drafts.delete(id);replyForm.elements.message.value='';renderTicket(ticket);status('supportReplyStatus','Дополнение отправлено.');try{await loadList();}catch(cause){if(!cause.handled)status('supportListStatus',cause.message,true);}}
  catch(cause){if(cause.handled)return;if(definite(cause)){replyPending.delete(id);replyBaseline.delete(id);}status('supportReplyStatus',conflict(cause)?'Переписка изменилась. Ваш текст сохранён. Обновляем сообщения; проверьте их перед повторной отправкой.':cause.message,true);if(conflict(cause)){try{const data=await api('/api/support/'+encodeURIComponent(id));if(!invalidated&&selected===id)renderTicket(confirmedTicket(data.ticket,id));}catch(problem){if(!problem.handled)status('supportThreadStatus',problem.message,true);}}}
  finally{mutating=false;if(!invalidated){controls();countText();}schedule();}
 }
 async function bootstrap(){
  if(booting||invalidated)return;booting=true;$('supportAccessRetry').hidden=true;status('supportInitialStatus','Открываем поддержку…');
  try{const data=await raw('/api/me');if(!data.user?.id){invalidate(null);return;}if(ownerId&&ownerId!==data.user.id){invalidate(data.user);return;}ownerId=data.user.id;$('supportIdentity').textContent=data.user.email||'';ready=true;$('supportWorkspace').hidden=false;await loadList();const requested=new URLSearchParams(location.search).get('ticket');if(ticketId(requested))await openTicket(requested,{focus:false});else if(tickets.length)await openTicket(tickets[0].id,{focus:false});else showCompose({focus:false});reveal();}
  catch(cause){if(!cause.handled&&!invalidated){status('supportInitialStatus',cause.message,true);$('supportAccessRetry').hidden=false;}}
  finally{booting=false;controls();schedule();}
 }
 newForm.addEventListener('submit',createTicket);replyForm.addEventListener('submit',sendReply);newForm.addEventListener('input',countText);replyForm.elements.message.addEventListener('input',()=>{if(selected)drafts.set(selected,replyForm.elements.message.value);countText();});
 $('supportNew').addEventListener('click',()=>showCompose());$('supportRefresh').addEventListener('click',()=>{void refresh();});$('supportRefreshTicket').addEventListener('click',()=>{if(selected)void openTicket(selected,{focus:false});});$('supportFilter').addEventListener('change',renderList);$('supportAccessRetry').addEventListener('click',()=>{if(!ready)void bootstrap();else void refresh();});
 document.addEventListener('visibilitychange',()=>{if(document.hidden){clearTimeout(timer);if(ready)mask('Проверяем доступ к вашим обращениям…');}else if(ready)void refresh({quiet:true});});
 window.addEventListener('pagehide',()=>{clearTimeout(timer);for(const controller of requests)controller.abort();});
 window.addEventListener('beforeunload',event=>{if(!invalidated&&(newPending||replyPending.size||newForm.elements.subject.value.trim()||newForm.elements.message.value.trim()||[...drafts.values()].some(value=>value.trim()))){event.preventDefault();event.returnValue='';}});
 const params=new URLSearchParams(location.search),from=params.get('from'),reference=params.get('reference');if(pageOptions.has(from))newForm.elements.page.value=from;if(uuid(reference))newForm.elements.reference.value=reference;
 countText();void bootstrap();
})();
