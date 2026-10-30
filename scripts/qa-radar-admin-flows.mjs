import assert from 'node:assert/strict';

// The caller owns the isolated local-beta database, browser and cleanup. All
// events below are synthetic; no external source is fetched or credential logged.
export async function runRadarAdminFlows({session,browser,record}){
  const context=await browser.newContext({viewport:{width:1440,height:1000},locale:'ru-RU',timezoneId:'Europe/Moscow',reducedMotion:'reduce'}),audiences=[];
  const errors=[],owner=session.accounts.find(account=>account.role==='admin');
  let page,company,manual,demo,initialAnalysis,initialIdeas;
  const api=async(route,{method='GET',data,expected=200,target=context}={})=>{
    const response=await target.request.fetch(session.base+route,{method,headers:{Origin:session.base},...(data===undefined?{}:{data})});assert.equal(response.status(),expected,route);return response;
  };
  const json=async(route,options)=>await(await api(route,options)).json();
  const latest=async id=>(await json('/api/admin/radar?limit=50')).events.find(event=>event.id===id);
  const waitEditor=()=>page.waitForFunction(()=>!document.getElementById('radarEventFields').disabled);
  const save=async(button,method='PATCH',expected=200)=>{
    const response=page.waitForResponse(value=>value.request().method()===method&&new URL(value.url()).pathname.startsWith('/api/admin/radar'));
    await page.locator('#'+button).click();const result=await response;assert.equal(result.status(),expected);await waitEditor();return result;
  };
  const refresh=async()=>{
    const response=page.waitForResponse(value=>value.request().method()==='GET'&&new URL(value.url()).pathname==='/api/admin/radar');await page.locator('#refreshRadarAdmin').click();await response;await waitEditor();
  };
  const select=async id=>{await page.locator(`[data-radar-event="${id}"]`).click();await page.waitForFunction(id=>document.getElementById('viewRadarEvent').getAttribute('href').endsWith(encodeURIComponent(id)),id);};
  const make=async(headline,source)=>{
    return(await json('/api/admin/radar',{method:'POST',expected:201,data:{companyId:company.id,eventType:'DIVIDEND',headline,summary:'Вымышленное событие для проверки объединения; не рыночная публикация.',whyImportant:'Учебная приёмка сохранения источников.',impact:'NEUTRAL',importanceScore:7,source,publishedAt:new Date().toISOString(),status:'published'}})).event;
  };
  try{
    for(const target of [context]){await target.route('https://fonts.googleapis.com/**',route=>route.abort());await target.route('https://fonts.gstatic.com/**',route=>route.abort());}
    await record('Radar редакция: гостевые и клиентские обращения не открывают страницу, скрипт и API администратора',async()=>{
      const guest=await browser.newContext();audiences.push(guest);
      const guestPage=await guest.request.get(session.base+'/radar-admin.html',{maxRedirects:0});assert.equal(guestPage.status(),303);assert.match(guestPage.headers().location,/account\.html/);
      assert.equal((await guest.request.get(session.base+'/assets/radar-admin.js')).status(),401);await api('/api/admin/radar',{target:guest,expected:401});
      for(const role of ['free','pro','exclusive']){
        const target=await browser.newContext();audiences.push(target);const account=session.accounts.find(account=>account.role===role);
        await api('/api/login',{target,method:'POST',data:{email:account.email,password:account.password}});
        assert.equal((await target.request.get(session.base+'/radar-admin.html',{maxRedirects:0})).status(),303);assert.equal((await target.request.get(session.base+'/assets/radar-admin.js')).status(),403);
        await api('/api/admin/radar',{target,expected:403});await api('/api/admin/radar',{target,method:'POST',expected:403,data:{}});
      }
      await api('/api/login',{method:'POST',data:{email:owner.email,password:owner.password}});
      page=await context.newPage();page.on('pageerror',cause=>errors.push(cause.name));await page.goto(session.base+'/radar-admin.html');await page.waitForSelector('#radarAdminMain:not([hidden])');await page.waitForSelector('[data-radar-event]');await waitEditor();
      const state=await json('/api/admin/radar?limit=50');assert.ok(state.events.length>=15);company=state.companies.find(value=>value.ticker==='SBER'&&value.active);assert.ok(company);demo=state.events.find(event=>event.isDemo&&event.originalAnalysis);assert.ok(demo);initialAnalysis=structuredClone(demo.originalAnalysis);initialIdeas=(await json('/api/admin/ideas')).records.length;
    });

    await record('Radar редакция: отключённые источники показываются честно, повтор запроса сохраняет сообщение об отказе',async()=>{
      const state=await json('/api/admin/radar?limit=50');assert.ok(state.providers.length>0);assert.ok(state.providers.every(provider=>provider.status==='disabled'));assert.equal(await page.locator('.radar-provider-status.online').count(),0);assert.ok((await page.locator('#radarProviders').innerText()).includes('ОТКЛЮЧЁН'));
      const response=page.waitForResponse(value=>value.request().method()==='POST'&&new URL(value.url()).pathname==='/api/admin/radar/sync');await page.locator('#syncRadarProviders').click();assert.equal((await response).status(),409);await page.waitForFunction(()=>!document.getElementById('syncRadarProviders').disabled);assert.match(await page.locator('#radarAdminMessage').innerText(),/отключены/i);
      for(const width of [320,390]){await page.setViewportSize({width,height:1000});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));}
      await page.setViewportSize({width:1440,height:1000});
    });

    await record('Radar редакция: ручной черновик, публикация и безопасный исходный текст не создают торговый сигнал',async()=>{
      await page.locator('#newRadarEvent').click();await page.locator('#radarEventCompany').selectOption(company.id);await page.locator('#radarEventType').selectOption('DIVIDEND');await page.locator('#radarEventHeadline').fill('Учебное ручное событие <img src=x onerror=alert(1)>');await page.locator('#radarEventSummary').fill('Демонстрационный текст <script>window.radarUnsafeExecuted=true</script>');await page.locator('#radarEventWhy').fill('Проверка интерфейса, не рыночное сообщение.');await page.locator('#radarEventImportance').fill('8.2');await page.locator('#radarEventSource').fill('https://www.sberbank.com/ru/investor');
      manual=(await(await save('saveRadarDraft','POST',201)).json()).event;assert.equal(manual.status,'draft');assert.equal(manual.analysisMethod,'manual');assert.equal(manual.marketReaction,null);
      const pro=audiences[2];await api('/api/radar/'+manual.id,{target:pro,expected:404});assert.equal(await page.locator('#radarEventRaw script').count(),0);assert.equal(await page.locator('#radarAdminList img').count(),0);assert.equal(await page.evaluate(()=>window.radarUnsafeExecuted),undefined);
      manual=(await(await save('publishRadarEvent')).json()).event;assert.equal(manual.status,'published');await api('/api/radar/'+manual.id,{target:pro});assert.equal((await json('/api/admin/ideas')).records.length,initialIdeas);assert.ok((await page.locator('#radarEventSources a').first().getAttribute('rel')).includes('noopener'));
    });

    await record('Radar редакция: конфликт версии сохраняет набранное, исправление анализа сохраняет первоначальную оценку',async()=>{
      const initial=manual.summary;await json('/api/admin/radar/'+manual.id,{method:'PATCH',data:{revision:manual.revision,summary:'Сохранено во второй учебной вкладке'}});
      await page.locator('#radarEventSummary').fill('Мой несохранённый текст');await save('saveRadarDraft','PATCH',409);assert.equal(await page.locator('#radarEventSummary').inputValue(),'Мой несохранённый текст');assert.equal(await page.locator('#radarConflict').isVisible(),true);assert.notEqual((await latest(manual.id)).summary,initial);
      page.once('dialog',dialog=>dialog.accept());await page.locator('#loadLatestRadar').click();await page.waitForFunction(()=>document.getElementById('radarEventSummary').value==='Сохранено во второй учебной вкладке');await waitEditor();
      await select(demo.id);await page.locator('#radarEventSummary').fill('Учебное исправление автоматического разбора');await page.locator('#radarEventImpact').selectOption('MIXED');await page.locator('#radarEventImportance').fill('7.1');await page.locator('#radarAnalysisIncorrect').check();await save('saveRadarDraft');const saved=await latest(demo.id);assert.equal(saved.aiIncorrect,true);assert.equal(saved.impact,'MIXED');assert.equal(saved.importanceScore,7.1);assert.deepEqual(saved.originalAnalysis,initialAnalysis);assert.ok(saved.audit.some(entry=>entry.action==='edited'));
    });

    await record('Radar редакция: скрытие и отметка дубля закрывают клиентскую карточку, сохраняя запись и историю',async()=>{
      await select(manual.id);page.once('dialog',dialog=>dialog.accept());await save('hideRadarEvent');const hidden=await latest(manual.id);assert.equal(hidden.status,'hidden');await api('/api/radar/'+manual.id,{target:audiences[2],expected:404});assert.equal(hidden.sources.length,1);assert.ok(hidden.audit.length>=3);
      page.once('dialog',dialog=>dialog.accept());const response=page.waitForResponse(value=>value.request().method()==='DELETE'&&new URL(value.url()).pathname==='/api/admin/radar/'+manual.id);await page.locator('#duplicateRadarEvent').click();assert.equal((await response).status(),200);await page.waitForFunction(()=>document.getElementById('radarAdminMessage').textContent==='Редакция Radar обновлена.');await waitEditor();const duplicate=await latest(manual.id);assert.equal(duplicate.status,'duplicate');assert.ok(duplicate.audit.some(entry=>entry.action==='marked-duplicate'));assert.equal(duplicate.rawText,manual.rawText);assert.equal(await page.locator('#saveRadarDraft').isDisabled(),true);
    });

    await record('Radar редакция: объединение дополняет источники и сохраняет обе исходные записи с историей',async()=>{
      const target=await make('Учебное основное событие для объединения','https://www.sberbank.com/ru/investor'),source=await make('Учебный повтор события для объединения','https://www.sberbank.com/ru/investor/financial-statements');await refresh();await select(source.id);await page.locator('#openRadarMerge').click();await page.locator('#radarMergeTarget').selectOption(target.id);page.once('dialog',dialog=>dialog.accept());const response=page.waitForResponse(value=>value.request().method()==='POST'&&new URL(value.url()).pathname==='/api/admin/radar/'+source.id+'/merge');await page.locator('#confirmRadarMerge').click();assert.equal((await response).status(),200);await page.waitForFunction(()=>!document.getElementById('radarMergeDialog').open);await waitEditor();
      const savedTarget=await latest(target.id),savedSource=await latest(source.id);assert.equal(savedTarget.sources.length,2);assert.equal(savedSource.status,'duplicate');assert.equal(savedSource.mergedInto,target.id);assert.ok(savedTarget.audit.some(entry=>entry.action==='merged-from'&&entry.sourceId===source.id));assert.ok(savedSource.audit.some(entry=>entry.action==='merged-into'&&entry.targetId===target.id));assert.equal(savedSource.sources.length,1);assert.equal(new Set(savedTarget.sources.map(value=>value.id)).size,2);assert.deepEqual(errors,[]);
      for(const width of [320,390]){await page.setViewportSize({width,height:1000});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));}
    });
  }finally{await context.close();for(const audience of audiences)await audience.close();}
}
