(async()=>{
 'use strict';
 const A=window.OrbitaAccess,$=id=>document.getElementById(id),form=$('telegramPreferencesForm');
 const strategies=['Momentum RU','Trend RU','Импульс','Crypto Momentum','Crypto Trend','Orbita Exclusive'];
 let session,state=null,busy=false,stopped=false,generation=0,expiryTimer=null,command='';
 const date=value=>new Intl.DateTimeFormat('ru-RU',{timeZone:'Europe/Moscow',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}).format(new Date(value))+' МСК';
 function status(text,isError=false){$('telegramStatus').textContent=text;$('telegramStatus').classList.toggle('error',isError);}
 function clearCode(){generation++;clearTimeout(expiryTimer);expiryTimer=null;command='';$('telegramCode').textContent='';$('telegramCodeExpiry').textContent='';$('telegramCodePanel').hidden=true;$('telegramBotUrl').removeAttribute('href');}
 function clearPrivate(){stopped=true;clearCode();state=null;$('telegramBinding').textContent='';$('telegramBinding').hidden=true;$('telegramConnectionState').textContent='';$('telegramExplanation').textContent='';$('telegramPreferencesMessage').textContent='';form.reset();$('telegramWorkspace').hidden=true;}
 function controls(){
  const linked=state?.linked===true,configured=state?.configured===true&&state?.enabled===true;
  $('telegramLink').disabled=busy||stopped||!configured;$('telegramRefresh').disabled=busy||stopped;
  $('telegramUnlink').disabled=busy||stopped||!linked;$('telegramUnlink').hidden=!linked;
  $('telegramStrategy').disabled=busy||stopped||!linked;$('telegramInstant').disabled=busy||stopped||!linked;$('telegramSave').disabled=busy||stopped||!linked;
  $('telegramCopy').disabled=busy||stopped||!command;
 }
 function validate(value){
  if(!value||typeof value.enabled!=='boolean'||typeof value.configured!=='boolean'||typeof value.linked!=='boolean'||typeof value.preferences?.instantPublish!=='boolean'||!strategies.includes(value.preferences?.strategy))throw Error('Не удалось прочитать настройки бота.');
  if(value.botUsername!==null&&(typeof value.botUsername!=='string'||!(/^[A-Za-z][A-Za-z0-9_]{4,31}$/).test(value.botUsername)))throw Error('Не удалось проверить адрес бота.');
  if(value.linked&&(!value.binding||typeof value.binding.telegramUserId!=='string'||!/^\d{1,20}$/.test(value.binding.telegramUserId)||!Number.isFinite(Date.parse(value.binding.linkedAt))))throw Error('Не удалось проверить привязку Telegram.');
  return value;
 }
 function render(value){
  state=validate(value);$('telegramConnectionState').textContent=state.linked?'Telegram подключён':!state.enabled?'Бот выключен':!state.configured?'Бот ещё не настроен':'Ожидает подключения';$('telegramConnectionState').dataset.linked=String(state.linked);
  $('telegramExplanation').textContent=state.linked?(state.enabled&&state.configured?'Публикация доступна в вашем личном чате с ботом. Каждое действие проверяет текущие права редактора.':'Привязка сохранена, но бот сейчас недоступен. Можно отключить её здесь; публикация возобновится после настройки сервера.'):(state.enabled&&state.configured?'Создайте одноразовую команду и отправьте её боту в личном чате. Username сам по себе не даёт доступа.':'Администратор сервера должен настроить и включить отдельного бота редакции. Токен хранится в приватном окружении и не передаётся в эту форму.');
  $('telegramLink').textContent=state.linked?'Переподключить Telegram':'Подключить Telegram';
  $('telegramBinding').textContent=state.linked?'Telegram ID: '+state.binding.telegramUserId+' · подключён '+date(state.binding.linkedAt):'';$('telegramBinding').hidden=!state.linked;
  $('telegramStrategy').value=state.preferences.strategy;$('telegramInstant').checked=state.preferences.instantPublish;
  if(state.linked)clearCode();$('telegramWorkspace').hidden=false;controls();
 }
 async function refresh(){const value=await session.request('/api/admin/telegram');if(!stopped)render(value);return value;}
 async function action(work){if(busy||stopped)return;busy=true;controls();try{await work();}catch(cause){if(!stopped)status(cause.message||'Операция не завершена. Повторите попытку.',true);}finally{busy=false;controls();}}
 $('telegramLink').addEventListener('click',()=>action(async()=>{
  clearCode();const current=generation;const value=await session.request('/api/admin/telegram/link',{method:'POST',body:'{}'});
  if(stopped||document.hidden||current!==generation)return;
  const expires=Date.parse(value?.expiresAt);let url;try{url=new URL(value?.botUrl);}catch{}
  if(typeof value?.code!=='string'||!(/^[A-Za-z0-9_-]{16,128}$/).test(value.code)||!Number.isFinite(expires)||expires<=Date.now()||expires>Date.now()+11*60000||!url||url.origin!=='https://t.me'||url.username||url.password||url.search||url.hash||url.pathname!=='/'+state.botUsername)throw Error('Не удалось подтвердить команду подключения. Создайте новую.');
  command='/connect '+value.code;$('telegramCode').textContent=command;$('telegramCodeExpiry').textContent='Одноразовая команда действует до '+date(value.expiresAt)+'.';$('telegramBotUrl').href=url.href;$('telegramCodePanel').hidden=false;expiryTimer=setTimeout(()=>{clearCode();controls();status('Срок команды истёк. При необходимости создайте новую.');},expires-Date.now());status('Отправьте команду в личный чат с ботом.');
 }));
 $('telegramRefresh').addEventListener('click',()=>action(async()=>{const value=await refresh();if(!stopped)status(value.linked?'Telegram подключён.':'Привязка пока не подтверждена. Отправьте боту одноразовую команду.');}));
 $('telegramUnlink').addEventListener('click',()=>action(async()=>{
  if(!confirm('Отключить Telegram от этого аккаунта редактора? Бот перестанет принимать ваши команды.'))return;
  await session.request('/api/admin/telegram/link',{method:'DELETE',body:'{}'});clearCode();await refresh();if(!stopped)status('Telegram отключён от аккаунта редактора.');
 }));
 $('telegramCopy').addEventListener('click',()=>{void (async()=>{if(!command||stopped)return;try{if(!navigator.clipboard?.writeText)throw Error();await navigator.clipboard.writeText(command);if(!stopped&&command)status('Команда скопирована. Отправьте её в личный чат с ботом.');}catch{if(!stopped)status('Скопируйте команду вручную из блока подключения.',true);}})();});
 form.addEventListener('submit',event=>{event.preventDefault();void action(async()=>{
  if(!state?.linked)return;const preferences={strategy:$('telegramStrategy').value,instantPublish:$('telegramInstant').checked};
  if(!strategies.includes(preferences.strategy))throw Error('Выберите стратегию из списка.');
  if(preferences.instantPublish&&!state.preferences.instantPublish&&!confirm('Включить публикацию без предпросмотра? Каждое полное корректное сообщение с уровнями сразу появится у подписчиков.')){$('telegramInstant').checked=false;status('Мгновенная публикация остаётся выключенной.');return;}
  await session.request('/api/admin/telegram/preferences',{method:'PUT',body:JSON.stringify(preferences)});await refresh();if(!stopped){$('telegramPreferencesMessage').textContent='Настройки сохранены для вашей привязки Telegram.';status('');}
 });});
 document.addEventListener('visibilitychange',()=>{if(document.hidden){clearCode();controls();}});window.addEventListener('pagehide',()=>{clearPrivate();session?.stop();});
 try{const user=await A.requireAdmin();if(!user)return;session=window.OrbitaAdminSession.watch(user,{workspace:'telegramWorkspace',clear:clearPrivate});await refresh();if(!stopped)status('');}catch(cause){if(!stopped)status(cause.message||'Не удалось открыть настройки бота.',true);}
})();
