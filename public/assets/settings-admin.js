(async()=>{
  'use strict';
  const A=window.OrbitaAccess,$=id=>document.getElementById(id),form=$('settingsForm');
  const markets=[['stocks','Акции'],['futures','Фьючерсы'],['crypto','Криптовалюты']];
  let revision=0,dirty=false,busy=false;
  function node(tag,content){const element=document.createElement(tag);if(content!==undefined)element.textContent=content;return element;}
  function message(text,isError=false){$('settingsMessage').textContent=text;$('settingsMessage').className=isError?'error':'success';}
  function markDirty(value){dirty=value;$('dirtyState').textContent=value?'Есть несохранённые изменения':'';}
  function fields(){return {supportEmail:form.elements.supportEmail.value.trim(),authorName:form.elements.authorName.value.trim(),editorialNote:form.elements.editorialNote.value.trim(),partnerOffers:markets.map(([id])=>({id,markets:[id],name:form.elements[id+'-name'].value.trim(),url:form.elements[id+'-url'].value.trim()}))};}
  function preview(){
    const settings=fields(),root=$('settingsPreview');root.replaceChildren();
    for(const [title,value] of [['Поддержка',settings.supportEmail],['Автор / редакция',settings.authorName],['Порядок публикаций',settings.editorialNote]]){const item=node('div');item.className='preview-item';item.append(node('small',title.toUpperCase()),node('p',value||'Не заполнено'));root.append(item);}
    for(const [id,title] of markets){const offer=settings.partnerOffers.find(value=>value.id===id),item=node('div');item.className='preview-item';item.append(node('small',title.toUpperCase()),node('p',offer.name||'Предложение не подключено'));
      let url;try{url=new URL(offer.url);}catch{}
      if(offer.name&&url?.protocol==='https:'&&!url.username&&!url.password){const link=node('a',url.href);link.href=url.href;link.target='_blank';link.rel='sponsored noopener noreferrer';item.append(link,node('small','ПАРТНЁРСКОЕ РАЗМЕЩЕНИЕ'));}else item.append(node('p','Переход отключён'));root.append(item);
    }
  }
  function fill(settings){form.elements.supportEmail.value=settings.supportEmail;form.elements.authorName.value=settings.authorName;form.elements.editorialNote.value=settings.editorialNote;for(const [id] of markets){const offer=settings.partnerOffers.find(value=>value.id===id);form.elements[id+'-name'].value=offer?.name||'';form.elements[id+'-url'].value=offer?.url||'';}markDirty(false);preview();}
  async function load(){const result=await A.request('/api/admin/settings');revision=result.revision;fill(result.settings);$('settingsStatus').textContent='Настройки продукта доступны только администратору.';$('settingsWorkspace').hidden=false;}
  function setBusy(value){busy=value;$('saveSettings').disabled=value;$('reloadSettings').disabled=value;for(const input of form.querySelectorAll('input,textarea'))input.disabled=value;}
  for(const [id,title] of markets){const fieldset=node('fieldset');fieldset.append(node('legend',title));for(const [field,label,type,max] of [['name','Название брокера или биржи','text',100],['url','Партнёрская HTTPS-ссылка','url',2048]]){const labelNode=node('label',label),input=node('input');input.name=id+'-'+field;input.type=type;input.maxLength=max;input.autocomplete='off';if(field==='url'){input.placeholder='https://…';input.spellcheck=false;input.inputMode='url';}labelNode.append(input);fieldset.append(labelNode);}$('partnerFields').append(fieldset);}
  form.addEventListener('input',()=>{markDirty(true);preview();});
  form.addEventListener('submit',async event=>{
    event.preventDefault();if(busy||!form.reportValidity())return;const settings=fields();
    for(const offer of settings.partnerOffers){if(offer.url&&!offer.name){message('Заполните название площадки рядом с партнёрской ссылкой.',true);form.elements[offer.id+'-name'].focus();return;}}
    setBusy(true);message('Сохраняем…');try{const result=await A.request('/api/admin/settings',{method:'PUT',body:JSON.stringify({revision,settings})});revision=result.revision;fill(result.settings);message('Настройки сохранены для всего проекта.');}
    catch(error){message(error.status===409?'Настройки уже изменены в другой вкладке. Ваши поля сохранены в форме. Скопируйте нужные значения и нажмите «Загрузить актуальные».':error.message,true);if(error.status===401||error.status===403)await A.requireAdmin();}
    finally{setBusy(false);}
  });
  $('reloadSettings').addEventListener('click',async()=>{if(busy||dirty&&!confirm('Загрузить сохранённые настройки? Несохранённые изменения формы будут потеряны.'))return;setBusy(true);try{await load();message('Загружены актуальные настройки.');}catch(error){message(error.message,true);}finally{setBusy(false);}});
  window.addEventListener('beforeunload',event=>{if(dirty){event.preventDefault();event.returnValue='';}});
  try{if(!await A.requireAdmin())return;await load();}catch(error){$('settingsStatus').textContent=error.message;$('settingsStatus').className='error';}
})();
