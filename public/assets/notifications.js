(() => {
  'use strict';
  const $=id=>document.getElementById(id),flags=['ideaUpdates','newSignals','expiryReminders','radarEvents'];
  let state=null,poll=null,dirty=false,saving=false,editRevision=0;
  const form=$('notificationForm');
  function status(text,isError=false){$('notificationStatus').textContent=text;$('notificationStatus').classList.toggle('error',isError);}
  async function request(path,options={}){
    let response;try{response=await fetch(path,{credentials:'same-origin',cache:'no-store',...options,headers:{'Content-Type':'application/json',...options.headers}});}catch{throw new Error('Не удалось связаться с сервером. Попробуйте ещё раз.');}
    let data;try{data=await response.json();}catch{throw new Error('Не удалось получить настройки. Обновите страницу.');}
    if(response.status===401){location.replace('account.html?next=%2Fnotifications.html');throw new Error('Войдите в аккаунт.');}
    if(!response.ok)throw new Error(OrbitaAccess.supportMessage(data,'Не удалось сохранить настройки.'));return data;
  }
  function stopPolling(){if(poll){clearInterval(poll);poll=null;}}
  function render(updateFields=true){
    if(!state)return;
    $('notificationSettings').hidden=false;
    if(updateFields){flags.forEach(flag=>form.elements[flag].checked=!!state.preferences[flag]);dirty=false;}
    const linked=state.telegram.linked;
    $('telegramState').textContent=linked?'Подключён':state.configured?'Не подключён':'Пока недоступен';
    $('telegramState').classList.toggle('linked',linked);
    $('telegramExplanation').textContent=linked?'Настройки применяются к вашему личному чату с ботом.':state.configured?'Подтвердите подключение в личном чате с ботом. Без вашего согласия сообщения не отправляются.':'Telegram ещё готовится к подключению. Вы можете сохранить предпочтения и вернуться позже.';
    $('connectTelegram').hidden=linked;
    $('connectTelegram').disabled=!state.configured;
    $('disconnectTelegram').hidden=!linked;
    if(linked){$('telegramLinkPanel').hidden=true;$('telegramDeepLink').removeAttribute('href');stopPolling();}
  }
  async function refresh(updateFields=false){state=await request('/api/notifications/preferences');render(updateFields);return state;}
  form.addEventListener('change',()=>{dirty=true;editRevision++;});
  form.addEventListener('submit',async event=>{
    event.preventDefault();if(saving)return;saving=true;$('saveNotifications').disabled=true;const revision=editRevision;
    try{const preferences=Object.fromEntries(flags.map(flag=>[flag,form.elements[flag].checked]));state=await request('/api/notifications/preferences',{method:'PUT',body:JSON.stringify(preferences)});const changed=revision!==editRevision;render(!changed);status(changed?'Предыдущие настройки сохранены. В форме есть новые изменения — сохраните их отдельно.':state.telegram.linked?'Настройки сохранены.':'Настройки сохранены. Подключите Telegram, чтобы получать сообщения.');}
    catch(error){status(error.message,true);}finally{saving=false;$('saveNotifications').disabled=false;}
  });
  $('connectTelegram').addEventListener('click',async()=>{
    $('connectTelegram').disabled=true;
    try{const data=await request('/api/notifications/telegram/link',{method:'POST',body:'{}'});const link=new URL(data.deepLink);if(link.origin!=='https://t.me'||link.username||link.password)throw new Error('Не удалось получить ссылку подключения.');$('telegramDeepLink').href=link.href;$('telegramLinkPanel').hidden=false;$('telegramLinkExpiry').textContent='Ссылка действует до '+new Intl.DateTimeFormat('ru-RU',{timeZone:'Europe/Moscow',hour:'2-digit',minute:'2-digit'}).format(new Date(data.expiresAt))+' МСК.';status('Откройте бота и нажмите Start.');stopPolling();let attempts=0;poll=setInterval(async()=>{if(++attempts>120){stopPolling();return;}try{await refresh(false);if(state.telegram.linked)status('Telegram подключён. Выберите нужные сообщения.');}catch{stopPolling();}},5000);}
    catch(error){status(error.message,true);}finally{$('connectTelegram').disabled=!state?.configured;}
  });
  $('checkTelegramLink').addEventListener('click',async()=>{try{await refresh(false);status(state.telegram.linked?'Telegram подключён.':'Привязка пока не подтверждена. Нажмите Start в чате с ботом.');}catch(error){status(error.message,true);}});
  $('disconnectTelegram').addEventListener('click',async()=>{
    $('disconnectTelegram').disabled=true;
    try{await request('/api/notifications/telegram/link',{method:'DELETE'});stopPolling();$('telegramLinkPanel').hidden=true;await refresh(!dirty);status('Telegram отключён. Сообщения больше не отправляются.');}
    catch(error){status(error.message,true);}finally{$('disconnectTelegram').disabled=false;}
  });
  window.addEventListener('pagehide',stopPolling);
  (async()=>{try{const account=await request('/api/me');if(!account.user){location.replace('account.html?next=%2Fnotifications.html');return;}$('notificationIdentity').textContent=account.user.email;await refresh(true);status('');}catch(error){status(error.message,true);}})();
})();
