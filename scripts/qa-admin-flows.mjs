import assert from 'node:assert/strict';

// Browser acceptance helpers. The caller owns its isolated local-beta session,
// browser process, report and teardown; no working data or provider is used.
export async function runAdminFlows({session,browser,record}){
  const context=await browser.newContext({viewport:{width:1440,height:1000},locale:'ru-RU',timezoneId:'Europe/Moscow',reducedMotion:'reduce'}),audiences=[];
  const errors=[];let page,idea,other,initial,lessonId;
  await context.route('https://fonts.googleapis.com/**',route=>route.abort());
  await context.route('https://fonts.gstatic.com/**',route=>route.abort());
  const api=async(path,{method='GET',data,expected=200}={})=>{
    const response=await context.request.fetch(session.base+path,{method,headers:{Origin:session.base},...(data===undefined?{}:{data})});
    assert.equal(response.status(),expected,path);return response.json();
  };
  const submitEvent=async(action,note,price)=>{
    await page.locator('#eventAction').selectOption(action);await page.locator('#eventNote').fill(note);
    if(price!==undefined)await page.locator('#exitPrice').fill(String(price));
    const response=page.waitForResponse(response=>response.request().method()==='POST'&&response.url().includes('/events'));
    await page.locator('#saveEvent').click();assert.equal((await response).status(),200);
    await page.waitForFunction(()=>!document.getElementById('saveEvent').disabled&&document.getElementById('eventNote').value==='');
  };
  const quick=async(ticker,dir='ЛОНГ')=>{
    await page.locator('#quickTicker').fill(ticker);await page.locator('#quickDirection').selectOption(dir);
    const response=page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname==='/api/admin/ideas');
    await page.locator('#quickForm [type=submit]').click();const result=await response;assert.equal(result.status(),201);
    const record=(await result.json()).record;await page.waitForFunction(()=>!document.getElementById('quickTicker').disabled&&document.getElementById('quickTicker').value==='');return record;
  };
  const audience=async role=>{
    const target=await browser.newContext({locale:'ru-RU',timezoneId:'Europe/Moscow'});audiences.push(target);const account=session.accounts.find(account=>account.role===role);
    const login=await target.request.post(session.base+'/api/login',{headers:{Origin:session.base},data:{email:account.email,password:account.password}});assert.equal(login.status(),200);
    return target;
  };
  try{
    await record('Редакция: вход через форму и быстрый сигнал из тикера/направления',async()=>{
      page=await context.newPage();page.on('pageerror',cause=>errors.push(cause.message));
      const owner=session.accounts.find(account=>account.role==='admin');await page.goto(session.base+'/account.html');
      await page.locator('[name=email]').fill(owner.email);
      try{await page.locator('[name=password]').fill(owner.password);}catch{throw Error('Не удалось ввести учебный пароль редакции.');}
      await page.locator('#submit').click();await page.waitForURL('**/security.html?verify=1');
      await page.goto(session.base+'/admin.html');await page.waitForSelector('#adminMain:not([hidden])');await page.waitForFunction(()=>document.querySelectorAll('#ideaList [data-id]').length>0);
      idea=await quick('QAEDITOR');initial=structuredClone(idea.meta.initial);
      assert.equal(idea.d.state,'announced');assert.equal(idea.d.entry,null);assert.equal(await page.locator('#deleteIdea').isVisible(),false);assert.match(await page.locator('#selectedIdea').innerText(),/Уровни ещё не заданы/);
      other=await quick('QADRAFT','ШОРТ');
    });

    await record('Редакция: уровни сохраняются при переключении, обновлении и конфликте версий',async()=>{
      await page.locator(`[data-id="${idea.id}"]`).click();await page.locator('#eventAction').selectOption('levels');
      const fields={levelEntry:'100',levelStop:'95',levelTarget:'110',levelHorizon:'1–5 дней',levelEntryRule:'Закрепление выше 100',levelCancelRule:'Выход при достижении стопа',eventNote:'Учебные уровни QA'};
      for(const [id,value]of Object.entries(fields))await page.locator('#'+id).fill(value);
      await page.locator(`[data-id="${other.id}"]`).click();await page.locator('#eventNote').fill('Черновик второго сигнала');await page.locator(`[data-id="${idea.id}"]`).click();
      for(const [id,value]of Object.entries(fields))assert.equal(await page.locator('#'+id).inputValue(),value);
      const stale=(await api('/api/admin/ideas')).revision;
      await api('/api/admin/ideas/'+other.id+'/events',{method:'POST',data:{revision:stale,action:'note',note:'Сохранено из другой вкладки'}});
      const conflict=page.waitForResponse(response=>response.request().method()==='POST'&&response.url().includes('/events'));
      await page.locator('#saveEvent').click();assert.equal((await conflict).status(),409);await page.waitForFunction(()=>document.getElementById('message').textContent.includes('другой вкладке'));
      for(const [id,value]of Object.entries(fields))assert.equal(await page.locator('#'+id).inputValue(),value);
      const refreshed=page.waitForResponse(response=>response.request().method()==='GET'&&new URL(response.url()).pathname==='/api/admin/ideas');await page.locator('#refreshIdeas').click();await refreshed;await page.waitForFunction(()=>document.getElementById('message').textContent==='Список идей обновлён.');
      for(const [id,value]of Object.entries(fields))assert.equal(await page.locator('#'+id).inputValue(),value);
      await submitEvent('levels',fields.eventNote);const stored=(await api('/api/ideas/'+idea.id)).record;assert.equal(stored.d.state,'waiting');assert.deepEqual(stored.meta.initial,initial);
      await page.locator(`[data-id="${other.id}"]`).click();assert.equal(await page.locator('#eventNote').inputValue(),'Черновик второго сигнала');page.once('dialog',dialog=>dialog.accept());await page.locator('#discardEvent').click();assert.equal(await page.locator('#eventNote').inputValue(),'');
      await page.locator(`[data-id="${idea.id}"]`).click();
    });

    await record('Редакция: подтверждение входа, перенос стопа, закрытие и неизменяемая история',async()=>{
      await submitEvent('activate','Учебный вход подтверждён');await submitEvent('stop-change','Учебная защита прибыли',102);await submitEvent('manual','Учебная позиция закрыта',106);
      const closed=(await api('/api/ideas/'+idea.id)).record;assert.equal(closed.d.state,'closed');assert.equal(closed.meta.exit,106);assert.equal(closed.d.stop,102);assert.equal(closed.meta.initialLevels.stop,95);assert.deepEqual(closed.meta.initial,initial);
      assert.deepEqual(closed.meta.events.map(event=>event[3].type),['published','levels','activate','stop-change','manual']);assert.equal(new Set(closed.meta.events.map(event=>event[3].id)).size,5);
      assert.match(await page.locator('#eventHistory').innerText(),/стоп изменён с 95 до 102/);assert.equal(await page.locator('#deleteIdea').isVisible(),false);
      await submitEvent('error','Учебная проверка маркировки ошибки');const erroneous=(await api('/api/ideas/'+idea.id)).record;assert.equal(erroneous.erroneous,true);assert.equal(erroneous.meta.exit,106);assert.deepEqual(erroneous.meta.events.slice(0,5),closed.meta.events);assert.match(await page.locator('#selectedIdea').innerText(),/Ошибочная публикация/);
    });

    await record('Редакция: совместимые стратегии и действия на ширинах 320 и 390',async()=>{
      await page.locator('.quick-options').evaluate(node=>node.open=true);await page.locator('#quickMarket').selectOption('crypto');assert.deepEqual(await page.locator('#quickStrategy option').allTextContents(),['Crypto Momentum','Crypto Trend']);await page.locator('#quickMarket').selectOption('stocks');
      await page.locator('#fullComposer').evaluate(node=>node.open=true);await page.locator('#ideaForm [name=market]').selectOption('futures');assert.deepEqual(await page.locator('#fullStrategy option').allTextContents(),['Импульс']);
      for(const width of [320,390]){await page.setViewportSize({width,height:900});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));assert.equal(await page.locator('#quickTicker').isVisible(),true);assert.equal(await page.locator('#eventAction').isVisible(),true);}
      // Clear the explicitly changed full composer before navigating away.
      page.once('dialog',dialog=>dialog.accept());await page.locator('#clearFullForm').click();await page.setViewportSize({width:1440,height:1000});
    });

    const pro=await audience('pro'),exclusive=await audience('exclusive');
    const visible=async target=>{const response=await target.request.get(session.base+'/api/lessons');assert.equal(response.status(),200);return (await response.json()).lessons;};
    await record('Редакция материалов: черновик, безопасный предпросмотр и публикация Exclusive',async()=>{
      await page.goto(session.base+'/content-admin.html');await page.waitForSelector('#contentMain:not([hidden])');await page.waitForFunction(()=>document.getElementById('contentMessage').textContent==='Материалы обновлены.');
      const title='QA статья <img src=x onerror=alert(1)>';
      await page.locator('#lessonTitle').fill(title);await page.locator('#lessonCategory').fill('Приёмка редакции');await page.locator('#lessonIntro').fill('Учебный материал для проверки доступа');await page.locator('#lessonAccess').selectOption('exclusive');await page.locator('[data-section-title]').fill('Первый раздел');await page.locator('[data-section-text]').fill('Учебный безопасный текст <script>alert(1)</script>');assert.equal(await page.locator('#lessonPreview img,#lessonPreview script').count(),0);
      let response=page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname==='/api/admin/content');await page.locator('#saveDraft').click();const created=await response;assert.equal(created.status(),201);lessonId=(await created.json()).lesson.id;await page.waitForFunction(()=>document.getElementById('contentMessage').textContent.startsWith('Черновик сохранён.'));
      for(const target of [pro,exclusive])assert.ok(!(await visible(target)).some(lesson=>lesson.id===lessonId));
      response=page.waitForResponse(response=>response.request().method()==='PUT'&&response.url().endsWith('/'+lessonId));await page.locator('#publishLesson').click();assert.equal((await response).status(),200);await page.waitForFunction(()=>document.getElementById('contentMessage').textContent.startsWith('Материал опубликован.'));
      assert.ok((await visible(exclusive)).some(lesson=>lesson.id===lessonId));assert.ok(!(await visible(pro)).some(lesson=>lesson.id===lessonId));
    });

    await record('Редакция материалов: конфликт не стирает текст; снятие скрывает статью у клиента',async()=>{
      await page.locator('#lessonIntro').fill('Несохранённый текст редактора');await page.locator('#newLesson').click();await page.waitForSelector('#discardDialog[open]');await page.locator('#keepEditing').click();assert.equal(await page.locator('#lessonIntro').inputValue(),'Несохранённый текст редактора');
      const remote=await api('/api/admin/content'),lesson=remote.lessons.find(lesson=>lesson.id===lessonId);await api('/api/admin/content/'+lessonId,{method:'PUT',data:{revision:remote.revision,lesson:{title:lesson.title,category:lesson.category,intro:'Версия из другой вкладки',sections:lesson.sections,access:lesson.access,published:true}}});
      const conflict=page.waitForResponse(response=>response.request().method()==='PUT'&&response.url().endsWith('/'+lessonId));await page.locator('#publishLesson').click();assert.equal((await conflict).status(),409);await page.waitForSelector('#contentConflict:not([hidden])');assert.equal(await page.locator('#lessonIntro').inputValue(),'Несохранённый текст редактора');
      await page.locator('#loadLatest').click();await page.waitForSelector('#discardDialog[open]');await page.locator('#discardChanges').click();await page.waitForFunction(()=>document.getElementById('lessonIntro').value==='Версия из другой вкладки');
      await page.locator('#unpublishLesson').click();await page.waitForSelector('#unpublishDialog[open]');await page.locator('#confirmUnpublish').click();await page.waitForFunction(()=>document.getElementById('contentMessage').textContent.startsWith('Черновик сохранён.'));assert.ok(!(await visible(exclusive)).some(lesson=>lesson.id===lessonId));
      for(const width of [320,390]){await page.setViewportSize({width,height:900});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));}await page.setViewportSize({width:1440,height:1000});
    });

    await record('Настройки: общая публикация, конфликт версий и пустые партнёрские ссылки',async()=>{
      await page.goto(session.base+'/settings-admin.html');await page.waitForSelector('#settingsWorkspace:not([hidden])');await page.locator('[name=authorName]').fill('Учебная редакция QA');await page.locator('[name=editorialNote]').fill('Учебный обзор для приёмки интерфейса');await page.locator('#saveSettings').click();await page.waitForFunction(()=>document.getElementById('settingsMessage').textContent==='Настройки сохранены для всего проекта.');
      const remote=await api('/api/admin/settings');assert.ok(remote.settings.partnerOffers.every(offer=>offer.url===''));await api('/api/admin/settings',{method:'PUT',data:{revision:remote.revision,settings:{...remote.settings,authorName:'Вторая вкладка QA'}}});await page.locator('[name=authorName]').fill('Мой несохранённый автор');await page.locator('#saveSettings').click();await page.waitForFunction(()=>document.getElementById('settingsMessage').textContent.includes('другой вкладке'));assert.equal(await page.locator('[name=authorName]').inputValue(),'Мой несохранённый автор');
      page.once('dialog',dialog=>dialog.accept());await page.locator('#reloadSettings').click();await page.waitForFunction(()=>document.querySelector('[name=authorName]').value==='Вторая вкладка QA');
      const publicSettings=await api('/api/product-settings');assert.equal(publicSettings.authorName,'Вторая вкладка QA');
      for(const width of [320,390]){await page.setViewportSize({width,height:900});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));}
      assert.deepEqual(errors,[]);
    });
  }finally{await context.close();await Promise.all(audiences.map(context=>context.close()));}
}
