(async () => {
  'use strict';
  const A=window.OrbitaAccess,$=id=>document.getElementById(id),form=$('contentForm'),fields=form.elements;
  let db={revision:0,lessons:[]},currentId=null,currentPublished=false,dirty=false,busy=false,pendingDiscard=null,privateSession;
  const date=value=>{const parsed=new Date(value);return value&&Number.isFinite(parsed.getTime())?new Intl.DateTimeFormat('ru-RU',{dateStyle:'short',timeStyle:'short',timeZone:'Europe/Moscow'}).format(parsed)+' МСК':'';};
  const moscowInput=new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
  const kinds={lesson:'Урок',article:'Статья',news:'Новость'},topics={stocks:'Акции',crypto:'Криптовалюты',macro:'Макро'};
  const audiences={public:'Все читатели',member:'PRO и EXCLUSIVE',exclusive:'Только EXCLUSIVE'};
  function node(tag,className,text){const result=document.createElement(tag);if(className)result.className=className;if(text!==undefined)result.textContent=text;return result;}
  function message(text,error=false){$('contentMessage').textContent=text;$('contentMessage').classList.toggle('error',error);}
  function markDirty(value=true){dirty=value;$('unsavedStatus').hidden=!dirty;}
  function syncBusy(){
    $('contentFields').disabled=busy;
    for(const id of ['newLesson','refreshContent','loadLatest','saveDraft','scheduleLesson','publishLesson','unpublishLesson'])$(id).disabled=busy;
    for(const button of $('contentList').querySelectorAll('button'))button.disabled=busy;
  }
  async function api(url,options={}){
    try{return await(privateSession?privateSession.request(url,options):A.request(url,options));}catch(error){
      if(error.status===401)location.replace('account.html?next=%2Fcontent-admin.html');
      if(error.status===403){$('contentMain').hidden=true;$('contentAuth').hidden=false;$('contentAuth').replaceChildren(node('h1','','Доступ к редакции закрыт'),node('p','','Права аккаунта изменились. Войдите с аккаунтом администратора.'));}
      throw error;
    }
  }
  function editorialFields(){
    const kind=fields.kind.value,editorial=kind!=='lesson',news=kind==='news';
    $('contentEditorialFields').hidden=!editorial;
    $('contentCategory').hidden=news;fields.category.disabled=news;
    $('contentTopic').hidden=!news;fields.topic.disabled=!news;
    fields.sources.required=news;
    fields.attachment.disabled=!editorial;fields.sources.disabled=!editorial;fields.tickers.disabled=!editorial;
    $('contentSchedule').hidden=currentPublished;fields.schedule.disabled=!editorial||currentPublished;
    $('scheduleLesson').hidden=!editorial||currentPublished;
    const publicOption=fields.access.querySelector('option[value="public"]');
    publicOption.disabled=!editorial;
    if(!editorial&&fields.access.value==='public')fields.access.value='member';
  }
  function readForm(){
    return {
      title:fields.title.value.trim(),category:fields.kind.value==='news'?fields.topic.value:fields.category.value.trim(),
      intro:fields.intro.value.trim(),access:fields.access.value,
      sections:[...$('lessonSections').children].map(section=>({title:section.querySelector('[data-section-title]').value.trim(),text:section.querySelector('[data-section-text]').value.trim()}))
    };
  }
  function preview(){
    const draft=readForm(),root=$('lessonPreview');root.replaceChildren();
    const category=fields.kind.value==='news'?topics[draft.category]:draft.category;
    root.append(node('div','preview-kicker',[kinds[fields.kind.value],category,audiences[draft.access]].filter(Boolean).join(' · ')));
    root.append(node('h2','',draft.title||'Название материала'),node('p','preview-intro',draft.intro||'Короткое описание появится здесь.'));
    for(const section of draft.sections){const block=node('section');block.append(node('h3','',section.title||'Заголовок раздела'),node('p','',section.text||'Текст раздела появится здесь.'));root.append(block);}
    if(fields.kind.value!=='lesson'){
      if(fields.sources.value.trim())root.append(node('h3','','Источники'),node('p','',fields.sources.value.trim()));
      if(fields.attachment.value.trim())root.append(node('h3','','Вложение'),node('p','',fields.attachment.value.trim()));
    }
    $('accessExplanation').textContent=draft.access==='public'?'Материал можно открыть по ссылке без входа.':'Доступ после входа · '+audiences[draft.access]+'.';
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
    const query=$('contentSearch').value.trim().toLocaleLowerCase('ru'),rows=db.lessons.filter(lesson=>[lesson.title,topics[lesson.category]||lesson.category,lesson.intro,...(lesson.tickers||[])].join(' ').toLocaleLowerCase('ru').includes(query));
    $('contentCount').textContent=String(db.lessons.length);$('contentEmpty').hidden=rows.length>0;$('contentList').replaceChildren();
    for(const lesson of rows){
      const category=lesson.kind==='news'?topics[lesson.category]:lesson.category;
      const status=lesson.published?'Опубликован':lesson.scheduledAt?'Запланирован':'Черновик';
      const button=node('button','content-item'+(lesson.id===currentId?' active':''));button.type='button';button.dataset.lesson=lesson.id;button.setAttribute('aria-pressed',String(lesson.id===currentId));button.append(node('strong','',lesson.title),node('small','',[kinds[lesson.kind||'lesson'],status,audiences[lesson.access],category].join(' · ')));
      button.disabled=busy;button.addEventListener('click',()=>guard(()=>select(lesson)));$('contentList').append(button);
    }
  }
  function select(lesson=null){
    currentId=lesson?.id||null;currentPublished=lesson?.published===true;
    fields.kind.value=lesson?.kind||'lesson';fields.kind.disabled=Boolean(currentId);
    fields.title.value=lesson?.title||'';fields.category.value=lesson?.kind==='news'?'':lesson?.category||'';fields.intro.value=lesson?.intro||'';fields.access.value=lesson?.access||'member';
    fields.topic.value=lesson?.kind==='news'?lesson.category:'stocks';
    fields.sources.value=(lesson?.sources||[]).join('\n');fields.attachment.value=lesson?.attachmentUrl||'';fields.tickers.value=(lesson?.tickers||[]).join(', ');
    fields.schedule.value=lesson?.scheduledAt?moscowInput.format(new Date(lesson.scheduledAt)).replace(' ','T'):'';
    editorialFields();
    $('lessonSections').replaceChildren();for(const value of lesson?.sections||[{title:'',text:''}])addSection(value);
    $('lessonState').textContent=currentPublished?'ОПУБЛИКОВАННЫЙ МАТЕРИАЛ':lesson?.scheduledAt?'ЗАПЛАНИРОВАН':currentId?'ЧЕРНОВИК':'НОВЫЙ ЧЕРНОВИК';$('editorHeading').textContent=currentId?'Редактировать материал':'Подготовить материал';
    const dates=[lesson?.createdAt?'Создан '+date(lesson.createdAt):'',lesson?.updatedAt?'Обновлён '+date(lesson.updatedAt):'',lesson?.scheduledAt?'Публикация '+date(lesson.scheduledAt):''].filter(Boolean);$('lessonDates').textContent=dates.join(' · ');
    $('saveDraft').textContent=lesson?.scheduledAt?'Снять с расписания':'Сохранить черновик';
    $('saveDraft').hidden=currentPublished;$('publishLesson').textContent=currentPublished?'Сохранить изменения':'Опубликовать';$('unpublishLesson').hidden=!currentPublished;
    $('readPublication').hidden=!currentPublished||fields.kind.value==='lesson';
    if(!$('readPublication').hidden)$('readPublication').href='/article.html?id='+encodeURIComponent(currentId);
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
  async function save(action){
    if(busy||!form.reportValidity())return false;
    const published=action==='publish';
    const lesson={...readForm(),published};
    if(!lesson.title||!lesson.category||!lesson.intro||lesson.sections.some(section=>!section.title||!section.text)){message('Заполните название, тему, описание и текст каждого раздела.',true);return false;}
    if(fields.kind.value!=='lesson'){
      const localTime=fields.schedule.value;
      if(action==='schedule'&&!localTime){message('Укажите дату и время публикации по Москве.',true);fields.schedule.focus();return false;}
      Object.assign(lesson,{
        kind:fields.kind.value,sources:fields.sources.value.trim().split(/\s+/).filter(Boolean),attachmentUrl:fields.attachment.value.trim()||null,
        tickers:fields.tickers.value.trim().split(/[\s,]+/).filter(Boolean),scheduledAt:action==='schedule'?localTime+':00+03:00':null
      });
    }
    const body=JSON.stringify({revision:db.revision,lesson});if(new TextEncoder().encode(body).length>65536){message('Материал слишком большой. Сократите текст: общий размер запроса — до 64 КиБ.',true);return false;}
    busy=true;syncBusy();message('Сохраняем материал…');
    try{
      const result=await api('/api/admin/content'+(currentId?'/'+encodeURIComponent(currentId):''),{method:currentId?'PUT':'POST',body});
      db.revision=result.revision;const index=db.lessons.findIndex(value=>value.id===result.lesson.id);if(index<0)db.lessons.unshift(result.lesson);else db.lessons[index]=result.lesson;select(result.lesson);message(published?'Материал опубликован.':action==='schedule'?'Публикация запланирована на '+date(result.lesson.scheduledAt)+'.':'Черновик сохранён.');return true;
    }catch(error){
      if(error.status===409){$('contentConflict').hidden=false;message('Сохранение остановлено: список изменился. Ваш текст остаётся в форме.',true);}
      else message(error.message,true);return false;
    }finally{busy=false;syncBusy();updateSectionControls();}
  }
  $('newLesson').addEventListener('click',()=>guard(()=>{select();message('Новый материал. Заполните поля и сохраните черновик.');$('lessonTitle').focus();}));
  $('contentSearch').addEventListener('input',renderList);
  $('refreshContent').addEventListener('click',()=>guard(refresh));$('loadLatest').addEventListener('click',()=>guard(refresh));
  $('addSection').addEventListener('click',()=>{addSection(undefined,true);markDirty();preview();});
  form.addEventListener('input',()=>{markDirty();preview();});form.addEventListener('change',event=>{if(event.target===fields.kind)editorialFields();markDirty();preview();});
  form.addEventListener('submit',event=>{event.preventDefault();void save(currentPublished?'publish':event.submitter?.dataset.action||'draft');});
  $('keepEditing').addEventListener('click',()=>{$('discardDialog').close();});
  $('discardChanges').addEventListener('click',()=>{const action=pendingDiscard;pendingDiscard=null;$('discardDialog').close();action?.();});
  $('discardDialog').addEventListener('close',()=>{pendingDiscard=null;});
  $('unpublishLesson').addEventListener('click',()=>{if(!form.reportValidity())return;$('unpublishDialog').showModal();});
  $('cancelUnpublish').addEventListener('click',()=>$('unpublishDialog').close());$('confirmUnpublish').addEventListener('click',()=>{$('unpublishDialog').close();void save('draft');});
  window.addEventListener('beforeunload',event=>{if(dirty){event.preventDefault();event.returnValue='';}});
  try{const user=await A.requireAdmin();if(!user)return;privateSession=window.OrbitaAdminSession.watch(user,{workspace:'contentMain',clear(){db={revision:0,lessons:[]};currentId=null;dirty=false;pendingDiscard=null;for(const id of ['contentList','lessonPreview','lessonSections','lessonDates'])$(id).replaceChildren();}});$('contentAuth').hidden=true;$('contentMain').hidden=false;select();await refresh();}
  catch(error){$('contentAuth').replaceChildren(node('h1','','Не удалось открыть редакцию'),node('p','',error.message));}
})();
