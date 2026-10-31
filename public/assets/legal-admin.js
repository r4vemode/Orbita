(async()=>{
  'use strict';
  const A=window.OrbitaAccess,$=id=>document.getElementById(id),form=$('legalForm'),publishForm=$('legalPublishForm');
  const fields=['ownerKind','ownerName','inn','ogrn','address','supportEmail','privacyEmail','hostingDetails','processorsDetails'];
  let revision=0,dirty=false,busy=false,loaded=false,ready=false,user=null,privateSession;
  const api=(...args)=>privateSession?privateSession.request(...args):A.request(...args);
  const stamp=value=>{const date=new Date(value);return Number.isFinite(date.getTime())?new Intl.DateTimeFormat('ru-RU',{timeZone:'Europe/Moscow',day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'}).format(date)+' МСК':'Дата не указана';};
  function node(tag,text){const element=document.createElement(tag);if(text!==undefined)element.textContent=text;return element;}
  function message(text,error=false,target=$('legalMessage')){target.textContent=text;target.className=error?'error':'success';}
  function clearCredentials(){publishForm.elements.password.value='';publishForm.elements.code.value='';$('legalReviewed').checked=false;}
  function closePublish(){clearCredentials();$('publishPanel').hidden=true;message('',false,$('publishMessage'));}
  function controls(){
    $('openPublish').disabled=!loaded||busy||dirty||!ready;
    $('saveLegal').disabled=$('reloadLegal').disabled=busy;
    $('publishLegal').disabled=busy||dirty||!ready;
    $('cancelPublish').disabled=busy;
    $('publishAvailability').textContent=dirty?'Есть несохранённые изменения. Сохраните черновик перед публикацией.':ready?'Проверьте сохранённые документы, затем подтвердите публикацию.':'Заполните и сохраните обязательные поля. Публикация пока недоступна.';
  }
  function markDirty(value){dirty=value;$('legalDirtyState').textContent=value?'Есть несохранённые изменения':'';controls();}
  function setBusy(value){busy=value;for(const field of document.querySelectorAll('#legalForm input,#legalForm textarea,#legalForm select,#legalPublishForm input'))field.disabled=value;controls();}
  function profile(){return Object.fromEntries(fields.map(name=>[name,form.elements[name].value.trim()]));}
  function updateCode(){const enabled=user?.security?.mfaEnabled===true;$('publishCodeField').hidden=!enabled;publishForm.elements.code.required=enabled;}
  function renderReadiness(readiness){
    ready=readiness?.ready===true;const root=$('legalReadiness');root.replaceChildren();
    if(ready){const text=node('p','Сохранённый черновик заполнен. Перед публикацией проверьте тексты.');text.className='ready';root.append(text);}
    else{root.append(node('p','Перед публикацией нужно проверить:'));const list=node('ul');for(const label of Array.isArray(readiness?.missing)?readiness.missing:['Обязательные реквизиты и контакты'])list.append(node('li',String(label)));root.append(list);}
  }
  function renderVersions(versions){
    const root=$('legalVersions');root.replaceChildren();
    if(!versions?.length){root.append(node('p','Пока нет опубликованных редакций. Посетители видят проект документов без реквизитов.'));return;}
    for(const version of [...versions].reverse()){
      const section=node('article');section.className='legal-version';section.append(node('strong',version.version),node('small',stamp(version.publishedAt)));const links=node('nav');links.setAttribute('aria-label','Документы редакции '+version.version);
      for(const [document,label]of [['offer','Оферта'],['privacy','Конфиденциальность'],['refunds','Возврат']]){const link=node('a',label+' ↗');link.href=document+'.html?version='+encodeURIComponent(version.version);link.target='_blank';link.rel='noopener noreferrer';links.append(link);}section.append(links);root.append(section);
    }
  }
  function fill(result){
    if(!Number.isInteger(result.revision)||!result.draft||!Array.isArray(result.versions))throw Error('Сервер не вернул документы. Повторите загрузку.');
    revision=result.revision;for(const field of fields)form.elements[field].value=typeof result.draft[field]==='string'?result.draft[field]:'';
    $('legalCurrentVersion').textContent=result.currentVersion?'Действующая редакция: '+result.currentVersion:'Опубликованной редакции пока нет. Посетителям доступен проект документов.';
    renderReadiness(result.readiness);renderVersions(result.versions);loaded=true;markDirty(false);updateCode();$('legalWorkspace').hidden=false;
  }
  async function load(){fill(await api('/api/admin/legal'));$('legalStatus').textContent='Закрытый раздел администратора. Черновики не публикуются автоматически.';}
  async function checkAccess(error){if([401,403].includes(error.status))try{const current=await A.requireAdmin();if(current){user=current;updateCode();}}catch{}}
  form.addEventListener('input',()=>{markDirty(true);if(!$('publishPanel').hidden)closePublish();});
  form.addEventListener('change',()=>{markDirty(true);if(!$('publishPanel').hidden)closePublish();});
  form.addEventListener('submit',async event=>{
    event.preventDefault();if(busy||!loaded||!form.reportValidity())return;const draft=profile();setBusy(true);message('Сохраняем частный черновик…');
    try{fill(await api('/api/admin/legal',{method:'PUT',body:JSON.stringify({revision,profile:draft})}));closePublish();message('Черновик сохранён. Публичная редакция не изменена.');}
    catch(error){message(error.status===409?'Документы уже изменены в другой вкладке. Ваши поля сохранены в форме. Скопируйте нужные значения и загрузите актуальную версию.':error.message,true);await checkAccess(error);}
    finally{setBusy(false);}
  });
  $('reloadLegal').addEventListener('click',async()=>{if(busy||dirty&&!confirm('Загрузить сохранённый черновик? Несохранённые поля формы будут потеряны.'))return;setBusy(true);closePublish();try{await load();message('Загружен актуальный черновик.');}catch(error){message(error.message,true);await checkAccess(error);}finally{setBusy(false);}});
  $('openPublish').addEventListener('click',()=>{if(busy||dirty||!ready)return;clearCredentials();message('',false,$('publishMessage'));updateCode();$('publishPanel').hidden=false;$('publishPanel').scrollIntoView({behavior:'smooth',block:'start'});publishForm.elements.password.focus();});
  $('cancelPublish').addEventListener('click',closePublish);
  publishForm.addEventListener('submit',async event=>{
    event.preventDefault();if(busy||dirty||!ready||!publishForm.reportValidity())return;
    const body={revision,password:publishForm.elements.password.value,...(publishForm.elements.code.value.trim()?{code:publishForm.elements.code.value.trim()}:{})};
    if(!confirm('Опубликовать новую редакцию документов с сохранёнными реквизитами? Она появится на сайте и останется в истории.')){clearCredentials();return;}
    clearCredentials();setBusy(true);message('Подтверждаем доступ и публикуем…',false,$('publishMessage'));
    try{fill(await api('/api/admin/legal/publish',{method:'POST',body:JSON.stringify(body)}));closePublish();message('Новая редакция опубликована. Предыдущие редакции сохранены в истории.');}
    catch(error){message(error.status===409?'Черновик изменился в другой вкладке. Публикация остановлена; ваши поля сохранены. Загрузите и проверьте актуальную версию.':error.message,true,$('publishMessage'));await checkAccess(error);}
    finally{clearCredentials();setBusy(false);}
  });
  window.addEventListener('pagehide',clearCredentials);
  window.addEventListener('beforeunload',event=>{if(dirty){event.preventDefault();event.returnValue='';}});
  try{user=await A.requireAdmin();if(!user)return;privateSession=window.OrbitaAdminSession.watch(user,{workspace:'legalWorkspace',clear(){dirty=false;loaded=ready=false;revision=0;clearCredentials();for(const id of ['legalVersions','legalReadiness','legalCurrentVersion'])$(id).replaceChildren();}});await load();}catch(error){$('legalStatus').textContent=error.message;$('legalStatus').className='error';}
})();
