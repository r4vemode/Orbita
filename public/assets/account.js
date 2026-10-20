(async()=>{
 const parameters=new URLSearchParams(location.search),A=OrbitaAccess;
 let register=parameters.get('mode')==='register',legalVersion='ORBITA-2026-10-20';
 const selected=parameters.get('plan'),exclusive=selected==='orbita-exclusive',pro=selected==='pro';
 const $=id=>document.getElementById(id),form=$('accountForm'),message=$('message'),submit=$('submit'),switcher=$('switch');
 function render(){ $('title').textContent=register?'Ваша новая орбита.':'С возвращением.';$('subtitle').textContent=register?(exclusive?'Вы выбрали Orbita Exclusive — 4 999 ₽ за 30 дней. Регистрация бесплатна; доступ активируется после оплаты.':pro?'Вы выбрали Orbita Pro — 2 999 ₽ за 30 дней. Регистрация бесплатна; доступ активируется после оплаты.':'Создайте аккаунт. Доступ к сервисам открывается по действующей подписке.'):'Войдите в аккаунт, чтобы проверить подписку и открыть кабинет.';submit.textContent=register?'Создать аккаунт ↗':'Войти ↗';switcher.textContent=register?'Уже есть аккаунт? Войти':'Нет аккаунта? Зарегистрироваться';form.elements.password.autocomplete=register?'new-password':'current-password';$('consents').hidden=!register;for(const input of $('consents').querySelectorAll('input'))input.required=register;message.textContent='';const url=new URL(location.href);url.searchParams.set('mode',register?'register':'login');history.replaceState(null,'',url.pathname+url.search);}
 switcher.onclick=()=>{register=!register;render();};render();
 try{const configuration=await A.request('/api/public-config');legalVersion=configuration.legalVersion;}catch(e){message.textContent=e.message;}
 form.onsubmit=async event=>{event.preventDefault();submit.disabled=switcher.disabled=true;message.textContent='';
  try{if(location.protocol==='file:')throw Error('Регистрация работает через сервер. Запустите npm start и откройте сайт по адресу, указанному в терминале.');
   const body={email:form.elements.email.value,password:form.elements.password.value};
   if(register)Object.assign(body,{acceptTerms:form.elements.acceptTerms.checked,acceptPrivacy:form.elements.acceptPrivacy.checked,legalVersion});
   const data=await A.request(register?'/api/register':'/api/login',{method:'POST',body:JSON.stringify(body)});
   const next=parameters.get('next'),plan=exclusive?'exclusive':pro?'pro':null;
   if(next&&data.user?.access?.hasSubscription)location.href=A.safeNext(next,'/app.html');
   else if(data.user?.access?.isAdmin)location.href='/admin.html';
   else if(data.user?.access?.hasSubscription)location.href='/app.html';
   else location.href='/subscriptions.html'+(plan?'?plan='+plan:'');
  }catch(e){message.textContent=e.message||'Не удалось подключиться к серверу.';}finally{submit.disabled=switcher.disabled=false;}
 };
})();
