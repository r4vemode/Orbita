import assert from 'node:assert/strict';

// Browser-only acceptance against an isolated startLocalBeta() session. This
// helper never starts a server, loads real provider keys or prints credentials.
export async function runClientFlows({session,browser,record}){
  const contexts=[],pages={},errors=[],base=session.base;
  const fixtureAccounts=Object.fromEntries(session.accounts.map(account=>[account.role,account]));
  const check=record||(async(_name,work)=>work());
  async function context(role){
    const value=await browser.newContext({viewport:{width:1440,height:1000},locale:'ru-RU',timezoneId:'Europe/Moscow',reducedMotion:'reduce'});contexts.push(value);
    await value.route('https://fonts.googleapis.com/**',route=>route.abort());
    await value.route('https://fonts.gstatic.com/**',route=>route.abort());
    const page=await value.newPage();page.on('pageerror',error=>errors.push({role,message:error.message}));pages[role]=page;return value;
  }
  async function login(page,role){
    const account=fixtureAccounts[role];await page.goto(base+'/account.html?mode=login');
    await page.locator('[name=email]').fill(account.email);await page.locator('[name=password]').fill(account.password);await page.locator('#submit').click();
    await page.waitForURL(url=>url.pathname==='/security.html');await page.waitForSelector('#securitySettings:not([hidden])');
    assert.match(await page.locator('#accountEmail').innerText(),new RegExp(account.email.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
    assert.match(await page.locator('#mailConfiguration').innerText(),/не настроен|не подключ|пока не/i);
  }
  async function get(ctx,path){const response=await ctx.request.get(base+path,{maxRedirects:0});return {status:response.status(),response};}
  async function post(ctx,path,data){const response=await ctx.request.post(base+path,{headers:{Origin:base},data});assert.ok(response.ok(),`Fixture ${path}: HTTP ${response.status()}`);return response.json();}
  const noOverflow=async(page,label)=>assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),label+' overflows viewport');
  let editor,pro,exclusive,free,regular,special;
  try{
    await check('Вход четырёх ролей и честный статус неподключённой почты',async()=>{
      editor=await context('admin');pro=await context('pro');exclusive=await context('exclusive');free=await context('free');
      for(const role of ['admin','pro','exclusive','free'])await login(pages[role],role);
      const users=await Promise.all([pro,exclusive,free].map(async ctx=>(await(await ctx.request.get(base+'/api/me')).json()).user));
      assert.deepEqual(users[0].access.activePlans,['pro']);assert.deepEqual(users[1].access.activePlans,['exclusive']);assert.equal(users[2].access.hasSubscription,false);
      assert.ok(users.every(user=>user.emailVerified===false));
    });
    await check('Раздельный доступ Pro и Exclusive к идеям и API',async()=>{
      const full=(ticker,strategy)=>({mode:'full',d:{ticker,strategy,dir:'ЛОНГ',entry:100,stop:95,target:110,entryRule:'Учебная проверка: вход после подтверждения.',cancelRule:'Учебная проверка: выход по стопу.',title:'Учебный сценарий браузерной приёмки',summary:'Тестовые цены, без реального рынка.'}});
      regular=(await post(editor,'/api/admin/ideas',full('QACLIENT','Momentum RU'))).record;
      special=(await post(editor,'/api/admin/ideas',full('QAEXCLUSIVE','Orbita Exclusive'))).record;
      for(const [role,ctx,own,other]of [['pro',pro,regular,special],['exclusive',exclusive,special,regular]]){
        const page=pages[role],rows=(await(await ctx.request.get(base+'/api/ideas')).json()).records;
        assert.ok(rows.some(row=>row.id===own.id));assert.ok(!rows.some(row=>row.id===other.id));
        assert.ok(rows.every(row=>role==='exclusive'?row.d.strategy==='Orbita Exclusive':row.d.strategy!=='Orbita Exclusive'));
        assert.equal((await get(ctx,'/api/ideas/'+other.id)).status,404);
        await page.goto(base+'/app.html');await page.waitForSelector('#cards [data-idea]');
        assert.equal(await page.locator('#cards [data-idea]').count(),rows.length);assert.equal(await page.locator('#cards [data-idea="'+other.id+'"]').count(),0);
      }
    });
    await check('Публичная стратегия скрывает идеи и сохраняет выбор Exclusive',async()=>{
      const page=pages.free;await page.goto(base+'/subscriptions.html?plan=pro');await page.waitForFunction(()=>document.getElementById('checkoutTitle')?.textContent==='Orbita Pro');
      await page.goto(base+'/strategy.html?strategy=orbita-exclusive');await page.waitForSelector('.detail-hero .primary-link');
      assert.equal(await page.locator('.strategy-idea').count(),0);assert.equal(await page.locator('.strategy-history tbody tr').count(),0);
      assert.match(await page.locator('#strategyDetail').innerText(),/По подписке|по подписке/);
      assert.equal(new URL(await page.locator('.detail-hero .primary-link').getAttribute('href'),base).searchParams.get('plan'),'exclusive');
      for(const link of await page.locator('.strategy-lesson a').all())assert.equal(new URL(await link.getAttribute('href'),base).searchParams.get('plan'),'exclusive');
      await page.locator('.detail-hero .primary-link').click();await page.waitForFunction(()=>document.getElementById('checkoutTitle')?.textContent==='Orbita Exclusive');
      assert.equal(await page.locator('#createCheckout').isDisabled(),true);
      assert.match(await page.locator('#checkoutMessage').innerText(),/подтвердите email|не подключён/i);
    });
    await check('Бесплатный аккаунт не открывает платные страницы и данные напрямую',async()=>{
      for(const path of ['/app.html','/calculator.html','/learn.html','/admin.html','/content-admin.html','/settings-admin.html']){
        const result=await get(free,path);assert.equal(result.status,303,path);assert.match(result.response.headers().location,/subscriptions/);
      }
      for(const path of ['/api/ideas','/api/lessons','/api/watchlist','/api/positions','/assets/app.js','/assets/learning-data.js'])assert.equal((await get(free,path)).status,403,path);
      await pages.free.goto(base+'/app.html?idea='+regular.id);await pages.free.waitForURL(url=>url.pathname==='/subscriptions.html');
    });
    await check('Калькулятор сохраняет стратегию и закрывает чужой тариф',async()=>{
      for(const [role,slug,name,other]of [['pro','momentum-ru','Momentum RU','Orbita Exclusive'],['exclusive','orbita-exclusive','Orbita Exclusive','Momentum RU']]){
        const page=pages[role];await page.goto(base+'/strategy.html?strategy='+slug);await page.waitForSelector('.detail-hero .primary-link');
        await page.locator('.detail-hero .primary-link').click();await page.waitForURL(url=>url.pathname==='/calculator.html');await page.waitForFunction(expected=>document.getElementById('strategy')?.value===expected,name);
        assert.ok(!(await page.locator('#strategy option').allTextContents()).includes(other));
        await page.locator('#capital').fill('500000');await page.locator('#calcForm [type=submit]').click();assert.equal(await page.locator('#formError').innerText(),'');assert.ok((await page.locator('#finalCapital').innerText()).includes('₽'));
        await page.goto(base+'/calculator.html?strategy='+encodeURIComponent(other));await page.waitForFunction(()=>document.getElementById('resultMessage')?.textContent.includes('отдельной подписке'));
        assert.equal(await page.locator('#calcForm [type=submit]').isDisabled(),true);
      }
    });
    await check('Отслеживание и личный вход сохраняются только в своём аккаунте',async()=>{
      const page=pages.pro;await page.goto(base+'/app.html?idea='+regular.id);await page.waitForSelector('.personal-form');await page.locator('#follow').click();await page.waitForFunction(()=>document.getElementById('savedCount').textContent==='1');
      const form=page.locator('.personal-form');await form.locator('[name=entry]').fill('102');await form.locator('[name=quantity]').fill('10');await form.locator('[type=submit]').click();await page.waitForFunction(()=>document.querySelector('.personal-trade h3')?.textContent==='Моя точка входа');
      await page.reload();await page.waitForSelector('.personal-form');assert.equal(await page.locator('.personal-form [name=entry]').inputValue(),'102');assert.equal(await page.locator('.personal-form [name=quantity]').inputValue(),'10');assert.equal(await page.locator('#follow').getAttribute('aria-pressed'),'true');
      assert.deepEqual((await(await exclusive.request.get(base+'/api/positions')).json()).positions,[]);assert.deepEqual((await(await exclusive.request.get(base+'/api/watchlist')).json()).ids,[]);
    });
    await check('Авторский и личный результаты различаются; исходные условия сохранены',async()=>{
      await post(editor,'/api/admin/ideas/'+regular.id+'/events',{action:'activate',note:'Учебная проверка подтверждения входа.'});
      await post(editor,'/api/admin/ideas/'+regular.id+'/events',{action:'stop-change',price:101,note:'Учебная проверка переноса стопа.'});
      await post(editor,'/api/admin/ideas/'+regular.id+'/events',{action:'target',note:'Учебная проверка закрытия по цели.'});
      const page=pages.pro;await page.goto(base+'/app.html?idea='+regular.id);await page.waitForSelector('.scenario-result');assert.match(await page.locator('.scenario-result').innerText(),/\+10,00%/);assert.match(await page.locator('.original-conditions').innerText(),/стоп 95/);assert.match(await page.locator('.paid-history').innerText(),/стоп изменён с 95 до 101/);
      const form=page.locator('.personal-form');await form.locator('details').evaluate(node=>node.open=true);await form.locator('[name=exit]').fill('108');const entered=await form.locator('[name=enteredAt]').inputValue();await form.locator('[name=closedAt]').fill(entered);await form.locator('[type=submit]').click();await page.waitForFunction(()=>document.querySelector('.personal-comparison')?.textContent.includes('+5,88%'));
      assert.match(await page.locator('.personal-comparison').innerText(),/\+10%/);assert.match(await page.locator('.personal-comparison').innerText(),/\+5,88%/);assert.match(await page.locator('.personal-trade').innerText(),/Ваш результат по введённой цене выхода/);
      await page.reload();await page.waitForSelector('.personal-form');assert.equal(await page.locator('.personal-form [name=exit]').inputValue(),'108');
    });
    await check('Удаление личной отметки: отмена, сбой, повтор и сохранность истории',async()=>{
      const page=pages.pro,before=(await(await pro.request.get(base+'/api/ideas/'+regular.id)).json()).record;
      page.once('dialog',dialog=>dialog.dismiss());await page.locator('[data-remove-position]').click();assert.equal((await(await pro.request.get(base+'/api/positions')).json()).positions.length,1);
      for(const width of [320,390]){await page.setViewportSize({width,height:844});await noOverflow(page,'Saved personal position at '+width);}await page.setViewportSize({width:1440,height:1000});
      await page.route(base+'/api/positions',route=>route.fulfill({status:503,json:{error:'Учебный сбой удаления: повторите попытку.'}}),{times:1});page.once('dialog',dialog=>dialog.accept());await page.locator('[data-remove-position]').click();await page.waitForFunction(()=>document.querySelector('.personal-form [role=status]')?.textContent.includes('Учебный сбой удаления'));
      assert.equal((await(await pro.request.get(base+'/api/positions')).json()).positions.length,1);assert.equal(await page.locator('[data-remove-position]').isDisabled(),false);
      let release,arrived;const held=new Promise(resolve=>release=resolve),started=new Promise(resolve=>arrived=resolve);await page.route(base+'/api/positions',async route=>{arrived();await held;await route.continue();},{times:1});page.once('dialog',dialog=>dialog.accept());await page.locator('[data-remove-position]').click();await started;
      assert.equal(await page.locator('.personal-form [type=submit]').isDisabled(),true);assert.equal(await page.locator('[data-remove-position]').isDisabled(),true);await page.locator('#refreshIdeas').click();await page.waitForFunction(()=>document.querySelector('.personal-form [data-remove-position]')?.disabled===true);release();await page.waitForFunction(()=>document.querySelector('.personal-trade h3')?.textContent==='Я вошёл');
      assert.deepEqual((await(await pro.request.get(base+'/api/positions')).json()).positions,[]);assert.deepEqual((await(await pro.request.get(base+'/api/watchlist')).json()).ids,[regular.id]);assert.deepEqual((await(await exclusive.request.get(base+'/api/positions')).json()).positions,[]);
      assert.deepEqual((await(await pro.request.get(base+'/api/ideas/'+regular.id)).json()).record,before);await page.reload();await page.waitForSelector('.personal-form');assert.equal(await page.locator('[data-remove-position]').count(),0);assert.equal(await page.locator('#follow').getAttribute('aria-pressed'),'true');
    });
    await check('Обучение: тарифы, поиск, прогресс и закрытые ссылки на статьи',async()=>{
      for(const [role,ctx]of [['pro',pro],['exclusive',exclusive]]){
        const rows=(await(await ctx.request.get(base+'/api/lessons')).json()).lessons;assert.ok(rows.length>0);if(role==='pro')assert.ok(rows.every(lesson=>lesson.access!=='exclusive'));else assert.ok(rows.some(lesson=>lesson.access==='exclusive'));
        const page=pages[role];await page.goto(base+'/learn.html');await page.waitForSelector('.lesson-card');await page.locator('#search').fill('несуществующий-запрос-приёмки');assert.equal(await page.locator('.lesson-card').count(),0);assert.equal(await page.locator('#empty').isVisible(),true);await page.locator('#search').fill('');
        const first=page.locator('.lesson-card').first(),id=await first.getAttribute('data-lesson');await first.click();await page.waitForSelector('#article[open]');await page.locator('#markRead').click();await page.locator('#closeArticle').click();await page.reload();await page.waitForSelector('.lesson-card');assert.match(await page.locator('[data-lesson="'+id+'"]').innerText(),/Прочитано/);
      }
      const page=pages.pro;await page.goto(base+'/learn.html?lesson=exclusive-trend');await page.waitForFunction(()=>document.getElementById('resultCount')?.textContent.includes('недоступен'));assert.equal(await page.locator('#article[open]').count(),0);
    });
    await check('Тренажёр: лонг, плечо, стоп шорта и повтор сделки',async()=>{
      const page=pages.pro;await page.goto(base+'/learn.html');await page.waitForSelector('#trainingPriceSlider');
      const moveSlider=value=>page.locator('#trainingPriceSlider').evaluate((node,value)=>{node.value=String(value);node.dispatchEvent(new Event('input',{bubbles:true}));},value);
      await page.locator('#trainingLeverage').selectOption('5');await page.locator('#trainingApply').click();await moveSlider(110);assert.match(await page.locator('#trainingPnl').innerText(),/\+100/);assert.match(await page.locator('#trainingMarginReturn').innerText(),/\+50%/);
      await page.locator('#trainingSide').selectOption('short');await page.locator('#trainingApply').click();await moveSlider(110);assert.match(await page.locator('#trainingStatus').innerText(),/Стоп сработал/);assert.equal(await page.locator('#trainingPriceSlider').isDisabled(),true);assert.match(await page.locator('#trainingPnl').innerText(),/-50|−50/);
      await page.locator('#trainingReset').click();assert.equal(await page.locator('#trainingPriceSlider').isDisabled(),false);
    });
    await check('Кабинет, история, обучение и калькулятор на ширинах 320 и 390',async()=>{
      const page=pages.pro;for(const width of [320,390]){
        await page.setViewportSize({width,height:844});
        for(const path of ['/app.html?idea='+regular.id,'/learn.html','/calculator.html?strategy=Momentum%20RU']){
          await page.goto(base+path);await page.waitForSelector(path.startsWith('/app')?'.personal-form':path.startsWith('/learn')?'.lesson-card':'#strategy option[value="Momentum RU"]',{state:path.startsWith('/calculator')?'attached':'visible'});await noOverflow(page,path+' at '+width);
        }
        await page.goto(base+'/app.html');await page.waitForSelector('#cards [data-idea]');await page.locator('[data-view=history]').click();await noOverflow(page,'History at '+width);
      }
    });
    await check('Выход, возврат назад и смена аккаунта не раскрывают прежние данные',async()=>{
      const page=pages.pro;await page.goto(base+'/app.html?idea='+regular.id);await page.waitForSelector('.personal-form');await page.goto(base+'/subscriptions.html');await page.waitForSelector('#subscriptionLogout');await page.locator('#subscriptionLogout').click();await page.waitForURL(url=>url.pathname==='/account.html');
      await page.goBack();await page.waitForURL(url=>url.pathname==='/account.html');assert.equal(await page.locator('.personal-form').count(),0);assert.equal((await get(pro,'/api/positions')).status,401);assert.equal((await get(pro,'/app.html')).status,303);
      await login(page,'exclusive');await page.goto(base+'/learn.html');await page.waitForSelector('.lesson-card');assert.match(await page.locator('#progress').innerText(),/^0 из/);
      assert.deepEqual((await(await pro.request.get(base+'/api/positions')).json()).positions,[]);await page.goto(base+'/app.html');await page.waitForSelector('#cards [data-idea]');assert.equal(await page.locator('#cards [data-idea="'+regular.id+'"]').count(),0);
    });
    await check('Отзыв подписки закрывает действующую сессию при обновлении',async()=>{
      const page=pages.pro;await post(editor,'/api/admin/subscriptions',{userId:(await(await pro.request.get(base+'/api/me')).json()).user.id,plan:'exclusive',expiresAt:null,reason:'Учебная проверка отзыва в действующей сессии.'});
      await page.locator('#refreshIdeas').click();await page.waitForURL(url=>url.pathname==='/subscriptions.html');assert.equal((await get(pro,'/api/ideas')).status,403);assert.equal((await get(exclusive,'/api/ideas')).status,403);assert.equal((await get(pro,'/app.html')).status,303);
    });
    await check('Клиентские сценарии проходят без ошибок JavaScript',async()=>assert.deepEqual(errors,[]));
    return {checks:14,findings:[],errors};
  }finally{await Promise.all(contexts.map(value=>value.close()));}
}
