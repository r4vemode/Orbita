(async () => {
  'use strict';
  const A=window.OrbitaAccess,$=id=>document.getElementById(id),form=$('contentForm');
  let db={revision:0,lessons:[]},currentId=null,currentPublished=false,dirty=false,busy=false,pendingDiscard=null,privateSession;
  const date=value=>{const parsed=new Date(value);return value&&Number.isFinite(parsed.getTime())?new Intl.DateTimeFormat('ru-RU',{dateStyle:'short',timeStyle:'short',timeZone:'Europe/Moscow'}).format(parsed)+' МСК':'';};
  function node(tag,className,text){const result=document.createElement(tag);if(className)result.className=className;if(text!==undefined)result.textContent=text;return result;}
  function message(text,error=false){$('contentMessage').textContent=text;$('contentMessage').classList.toggle('error',error);}
  function markDirty(value=true){dirty=value;$('unsavedStatus').hidden=!dirty;}
  function syncBusy(){
    $('contentFields').disabled=busy;
    for(const id of ['newLesson','refreshContent','loadLatest','saveDraft','publishLesson','unpublishLesson'])$(id).disabled=busy;
    for(const button of $('contentList').querySelectorAll('button'))button.disabled=busy;
  }
  async function api(url,options={}){
    try{return await(privateSession?privateSession.request(url,options):A.request(url,options));}catch(error){
      if(error.status===401)location.replace('account.html?next=%2Fcontent-admin.html');
      if(error.status===403){$('contentMain').hidden=true;$('contentAuth').hidden=false;$('contentAuth').replaceChildren(node('h1','','Доступ к редакции закрыт'),node('p','','Права аккаунта изменились. Войдите с аккаунтом администратора.'));}
      throw error;
    }
  }
  function readForm(){return {title:form.elements.title.value.trim(),category:form.elements.category.value.trim(),intro:form.elements.intro.value.trim(),access:form.elements.access.value,sections:[...$('lessonSections').children].map(section=>({title:section.querySelector('[data-section-title]').value.trim(),text:section.querySelector('[data-section-text]').value.trim()}))};}
  function preview(){
    const draft=readForm(),root=$('lessonPreview');root.replaceChildren();
    root.append(node('div','preview-kicker',(draft.category||'ТЕМА МАТЕРИАЛА')+' / '+(draft.access==='exclusive'?'ORBITA EXCLUSIVE':'БАЗОВОЕ ОБУЧЕНИЕ')));
    root.append(node('h2','',draft.title||'Название материала'),node('p','preview-intro',draft.intro||'Короткое описание появится здесь.'));
    for(const section of draft.sections){const block=node('section');block.append(node('h3','',section.title||'Заголовок раздела'),node('p','',section.text||'Текст раздела появится здесь.'));root.append(block);}
    $('accessExplanation').textContent=draft.access==='exclusive'?'Этот материал смогут читать только подписчики Orbita Exclusive и администратор.':'Материал смогут читать все пользователи с действующей подпиской Pro или Exclusive.';
  }
  function updateSectionControls(){
    const sections=[...$('lessonSections').children];sections.forEach((section,index)=>{section.querySelector('.section-number').textContent='РАЗДЕЛ '+String(index+1).padStart(2,'0');section.querySelector('[data-remove-section]').disabled=busy||sections.length===1;});$('addSection').disabled=busy||sections.length>=20;
  }
  function addSection(value={title:'',text:''},focus=false){
    if($('lessonSections').children.length>=20)return;
    const section=node('section','section-fields'),top=node('div','section-top'),number=node('span','section-number'),remove=node('button','','Убрать раздел');remove.type='button';remove.dataset.removeSection='';top.append(number,remove);
    const titleLabel=node('label','','Заголовок раздела'),title=node('input');title.type='text';title.maxLength=160;title.required=true;title.value=value.title||'';title.dataset.sectionTitle='';titleLabel.append(title);
    const textLabel=node('label','','Текст раздела'),text=node('textarea');text.rows=7;text.maxLength=10000;text.required=true;text.value=value.text||'';text.dataset.sectionText='';textLabel.append(text);
    remove.addEventListener('click',()=>{if(busy||$('lessonSections').children.length<=1)return;section.remove();markDirty();updateSectionControls();preview();});
    section.append(top,titleLabel,textLabel);$('lessonSections').append(section);updateSectionControls();if(focus)title.focus();
  }
  function renderList(){
    const query=$('contentSearch').value.trim().toLocaleLowerCase('ru'),rows=db.lessons.filter(lesson=>[lesson.title,lesson.category,lesson.intro].join(' ').toLocaleLowerCase('ru').includes(query));
    $('contentCount').textContent=String(db.lessons.length);$('contentEmpty').hidden=rows.length>0;$('contentList').replaceChildren();
    for(const lesson of rows){
      const button=node('button','content-item'+(lesson.id===currentId?' active':''));button.type='button';button.dataset.lesson=lesson.id;button.setAttribute('aria-pressed',String(lesson.id===currentId));button.append(node('strong','',lesson.title),node('small','',(lesson.published?'Опубликован':'Черновик')+' · '+(lesson.access==='exclusive'?'Exclusive':'Базовое обучение')+' · '+lesson.category));
      button.disabled=busy;button.addEventListener('click',()=>guard(()=>select(lesson)));$('contentList').append(button);
    }
  }
  function select(lesson=null){
    currentId=lesson?.id||null;currentPublished=lesson?.published===true;
    form.elements.title.value=lesson?.title||'';form.elements.category.value=lesson?.category||'';form.elements.intro.value=lesson?.intro||'';form.elements.access.value=lesson?.access||'member';
    $('lessonSections').replaceChildren();for(const value of lesson?.sections||[{title:'',text:''}])addSection(value);
    $('lessonState').textContent=currentPublished?'ОПУБЛИКОВАННЫЙ МАТЕРИАЛ':currentId?'ЧЕРНОВИК':'НОВЫЙ ЧЕРНОВИК';$('editorHeading').textContent=currentId?'Редактировать материал':'Подготовить материал';
    const dates=[lesson?.createdAt?'Создан '+date(lesson.createdAt):'',lesson?.updatedAt?'Обновлён '+date(lesson.updatedAt):''].filter(Boolean);$('lessonDates').textContent=dates.join(' · ');
    $('saveDraft').hidden=currentPublished;$('publishLesson').textContent=currentPublished?'Сохранить изменения':'Опубликовать';$('unpublishLesson').hidden=!currentPublished;
    markDirty(false);$('contentConflict').hidden=true;preview();renderList();
  }
  function guard(action){
    if(busy)return;if(!dirty){action();return;}pendingDiscard=action;$('discardDialog').showModal();$('keepEditing').focus();
  }
  async function refresh(){
    busy=true;syncBusy();message('Загружаем материалы…');
    try{const result=await api('/api/admin/content');if(!Number.isInteger(result.revision)||!Array.isArray(result.lessons))throw Error('Сервер вернул некорректный список материалов.');db=result;select(db.lessons.find(lesson=>lesson.id===currentId)||null);message('Материалы обновлены.');}
    catch(error){message(error.message,true);}finally{busy=false;syncBusy();updateSectionControls();}
  }
  async function save(published){
    if(busy||!form.reportValidity())return false;
    const lesson={...readForm(),published};
    if(!lesson.title||!lesson.category||!lesson.intro||lesson.sections.some(section=>!section.title||!section.text)){message('Заполните название, тему, описание и текст каждого раздела.',true);return false;}
    const body=JSON.stringify({revision:db.revision,lesson});if(new TextEncoder().encode(body).length>65536){message('Материал слишком большой. Сократите текст: общий размер запроса — до 64 КиБ.',true);return false;}
    busy=true;syncBusy();message('Сохраняем материал…');
    try{
      const result=await api('/api/admin/content'+(currentId?'/'+encodeURIComponent(currentId):''),{method:currentId?'PUT':'POST',body});
      db.revision=result.revision;const index=db.lessons.findIndex(value=>value.id===result.lesson.id);if(index<0)db.lessons.unshift(result.lesson);else db.lessons[index]=result.lesson;select(result.lesson);message(published?'Материал опубликован. Он доступен подписчикам выбранного формата.':'Черновик сохранён. В обучении подписчиков он не отображается.');return true;
    }catch(error){
      if(error.status===409){$('contentConflict').hidden=false;message('Сохранение остановлено: список изменился. Ваш текст остаётся в форме.',true);}
      else message(error.message,true);return false;
    }finally{busy=false;syncBusy();updateSectionControls();}
  }
  $('newLesson').addEventListener('click',()=>guard(()=>{select();message('Новый материал. Заполните поля и сохраните черновик.');$('lessonTitle').focus();}));
  $('contentSearch').addEventListener('input',renderList);
  $('refreshContent').addEventListener('click',()=>guard(refresh));$('loadLatest').addEventListener('click',()=>guard(refresh));
  $('addSection').addEventListener('click',()=>{addSection(undefined,true);markDirty();preview();});
  form.addEventListener('input',()=>{markDirty();preview();});form.addEventListener('change',()=>{markDirty();preview();});
  form.addEventListener('submit',event=>{event.preventDefault();void save(currentPublished||event.submitter?.dataset.action==='publish');});
  $('keepEditing').addEventListener('click',()=>{$('discardDialog').close();});
  $('discardChanges').addEventListener('click',()=>{const action=pendingDiscard;pendingDiscard=null;$('discardDialog').close();action?.();});
  $('discardDialog').addEventListener('close',()=>{pendingDiscard=null;});
  $('unpublishLesson').addEventListener('click',()=>{if(!form.reportValidity())return;$('unpublishDialog').showModal();});
  $('cancelUnpublish').addEventListener('click',()=>$('unpublishDialog').close());$('confirmUnpublish').addEventListener('click',()=>{$('unpublishDialog').close();void save(false);});
  window.addEventListener('beforeunload',event=>{if(dirty){event.preventDefault();event.returnValue='';}});
  try{const user=await A.requireAdmin();if(!user)return;privateSession=window.OrbitaAdminSession.watch(user,{workspace:'contentMain',clear(){db={revision:0,lessons:[]};currentId=null;dirty=false;pendingDiscard=null;for(const id of ['contentList','lessonPreview','lessonSections','lessonDates'])$(id).replaceChildren();}});$('contentAuth').hidden=true;$('contentMain').hidden=false;select();await refresh();}
  catch(error){$('contentAuth').replaceChildren(node('h1','','Не удалось открыть редакцию'),node('p','',error.message));}
})();
