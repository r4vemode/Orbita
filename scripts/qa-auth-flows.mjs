import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {totp} from '../lib/account-security.mjs';

async function context(browser,options={}){
  const value=await browser.newContext({viewport:{width:390,height:844},locale:'ru-RU',timezoneId:'Europe/Moscow',reducedMotion:'reduce',...options});
  await value.route('https://fonts.googleapis.com/**',route=>route.abort());
  await value.route('https://fonts.gstatic.com/**',route=>route.abort());
  return value;
}
async function credentials(page,email,password){await page.locator('[name=email]').fill(email);await page.locator('[name=password]').fill(password);}
const queryIsPrivate=page=>{const url=new URL(page.url());assert.equal(url.searchParams.has('password'),false);assert.equal(url.searchParams.has('email'),false);};

export async function runAuthFlows({session,browser,record}){
  await record('Регистрация: медленная загрузка условий не отправляет пароль в URL и ждёт актуальную версию согласия',async()=>{
    const ctx=await context(browser);let release;const held=new Promise(resolve=>release=resolve);
    try{
      await ctx.route(session.base+'/api/public-config',async route=>{await held;await route.continue().catch(()=>{});});
      const page=await ctx.newPage();let registrations=0;page.on('request',req=>{if(new URL(req.url()).pathname==='/api/register')registrations++;});
      await page.goto(session.base+'/account.html?mode=register&plan=exclusive',{waitUntil:'domcontentloaded'});
      await credentials(page,'qa-auth-'+randomUUID()+'@example.test','Qa-auth-'+randomUUID());await page.locator('[name=acceptTerms]').check();await page.locator('[name=acceptPrivacy]').check();
      await page.locator('#submit').click();await page.waitForFunction(()=>document.getElementById('submit').disabled&&document.getElementById('message').textContent.includes('Загружаем условия'));
      assert.equal(registrations,0);queryIsPrivate(page);release();
      await page.waitForURL('**/security.html?verify=1&plan=exclusive');queryIsPrivate(page);assert.equal(registrations,1);
      const me=await(await ctx.request.get(session.base+'/api/me')).json();assert.equal(me.user.emailVerified,false);assert.equal(me.user.access.hasSubscription,false);
    }finally{release();await ctx.close();}
  });

  await record('Вход: задержка настроек не включает нативный GET с паролем и не блокирует обработку ошибки',async()=>{
    const ctx=await context(browser);let release;const held=new Promise(resolve=>release=resolve);
    try{
      await ctx.route(session.base+'/api/public-config',async route=>{await held;await route.continue().catch(()=>{});});
      const page=await ctx.newPage(),methods=[];page.on('request',req=>{if(new URL(req.url()).pathname==='/api/login')methods.push(req.method());});
      await page.goto(session.base+'/account.html',{waitUntil:'domcontentloaded'});await credentials(page,'qa-unknown-'+randomUUID()+'@example.test','Qa-auth-incorrect-password');await page.locator('#submit').click();
      await page.waitForFunction(()=>document.getElementById('message').textContent.includes('Неверный email или пароль'));
      queryIsPrivate(page);assert.deepEqual(methods,['POST']);assert.equal(await page.locator('#submit').isEnabled(),true);
    }finally{release();await ctx.close();}
  });

  await record('Ошибка загрузки условий: регистрация остановлена, введённый email сохранён, повтор доступен без утечки',async()=>{
    const ctx=await context(browser);
    try{
      await ctx.route(session.base+'/api/public-config',route=>route.fulfill({status:503,json:{error:'Не удалось загрузить условия регистрации. Повторите попытку.'}}));
      const page=await ctx.newPage();let registrations=0;page.on('request',req=>{if(new URL(req.url()).pathname==='/api/register')registrations++;});
      await page.goto(session.base+'/account.html?mode=register');const email='qa-config-'+randomUUID()+'@example.test';await credentials(page,email,'Qa-auth-configuration-password');await page.locator('[name=acceptTerms]').check();await page.locator('[name=acceptPrivacy]').check();await page.locator('#submit').click();
      await page.waitForFunction(()=>document.getElementById('message').textContent.includes('Не удалось загрузить условия'));
      assert.equal(registrations,0);queryIsPrivate(page);assert.equal(await page.locator('[name=email]').inputValue(),email);assert.equal(await page.locator('#submit').isEnabled(),true);
    }finally{await ctx.close();}
  });

  await record('Выбор Exclusive проходит через гостевой переход к подписке и вход без потери тарифа',async()=>{
    const ctx=await context(browser);
    try{
      const page=await ctx.newPage(),free=session.accounts.find(account=>account.role==='free');
      await page.goto(session.base+'/subscriptions.html?plan=exclusive');await page.waitForURL('**/account.html?**');await credentials(page,free.email,free.password);await page.locator('#submit').click();
      await page.waitForURL('**/security.html?verify=1&plan=exclusive');await page.waitForSelector('#continueAccount');assert.match(await page.locator('#continueAccount').getAttribute('href'),/plan=exclusive/);queryIsPrivate(page);
    }finally{await ctx.close();}
  });

  await record('Регистрация после временной ошибки условий повторяет загрузку на той же странице и сохраняет Exclusive',async()=>{
    const ctx=await context(browser);let available=false,configurations=0;
    try{
      await ctx.route(session.base+'/api/public-config',route=>{configurations++;return available?route.continue():route.fulfill({status:503,json:{error:'Условия временно недоступны. Повторите попытку.'}});});
      const page=await ctx.newPage();let registrations=0;page.on('request',req=>{if(new URL(req.url()).pathname==='/api/register')registrations++;});
      await page.goto(session.base+'/account.html?mode=register&plan=exclusive');const email='qa-retry-'+randomUUID()+'@example.test';await credentials(page,email,'Qa-retry-'+randomUUID());await page.locator('[name=acceptTerms]').check();await page.locator('[name=acceptPrivacy]').check();await page.locator('#submit').click();
      await page.waitForFunction(()=>document.getElementById('message').textContent.includes('Условия временно недоступны')&&!document.getElementById('submit').disabled);assert.equal(registrations,0);queryIsPrivate(page);assert.equal(await page.locator('[name=email]').inputValue(),email);assert.ok(configurations>=1);
      available=true;await page.locator('#submit').click();await page.waitForURL('**/security.html?verify=1&plan=exclusive');queryIsPrivate(page);assert.equal(registrations,1);assert.ok(configurations>=2);
      const me=await(await ctx.request.get(session.base+'/api/me')).json();assert.equal(me.user.emailVerified,false);assert.equal(me.user.access.hasSubscription,false);
    }finally{await ctx.close();}
  });

  await record('Без JavaScript форма использует POST и не раскрывает email или пароль в адресе страницы',async()=>{
    const ctx=await context(browser,{javaScriptEnabled:false});
    try{
      const page=await ctx.newPage();await page.goto(session.base+'/account.html');assert.equal(await page.locator('#accountForm').getAttribute('method'),'post');assert.equal(await page.locator('#submit').isDisabled(),true);
      await credentials(page,'qa-no-script@example.test','Qa-auth-no-script-password');
      await Promise.all([page.waitForRequest(req=>req.isNavigationRequest()&&req.method()==='POST'),page.evaluate(()=>HTMLFormElement.prototype.submit.call(document.getElementById('accountForm')))]);await page.waitForLoadState('domcontentloaded');queryIsPrivate(page);
    }finally{await ctx.close();}
  });

  await record('Обучение: Escape возвращает фокус к карточке после отметки прочтения, а при пустом фильтре — к поиску',async()=>{
    const ctx=await context(browser);
    try{
      const page=await ctx.newPage(),pro=session.accounts.find(account=>account.role==='pro');
      await page.goto(session.base+'/account.html');await credentials(page,pro.email,pro.password);await page.locator('#submit').click();await page.waitForURL('**/security.html?verify=1');
      await page.goto(session.base+'/learn.html');await page.waitForSelector('.lesson-card');const firstId=await page.locator('.lesson-card').first().getAttribute('data-lesson');
      await page.locator('.lesson-card').first().focus();await page.keyboard.press('Enter');await page.waitForSelector('#article[open]');await page.locator('#markRead').click();await page.keyboard.press('Escape');
      await page.waitForFunction(id=>document.activeElement?.dataset.lesson===id,firstId);assert.equal(new URL(page.url()).searchParams.has('lesson'),false);
      await page.keyboard.press('Enter');await page.waitForSelector('#article[open]');
      await page.evaluate(()=>{const search=document.getElementById('search');search.value='QA-no-material-matches';search.dispatchEvent(new Event('input',{bubbles:true}));});await page.keyboard.press('Escape');
      await page.waitForFunction(()=>document.activeElement?.id==='search');assert.equal(await page.locator('.lesson-card').count(),0);
    }finally{await ctx.close();}
  });

  await record('MFA редакции: подключение, сохранение резервных кодов, вход со вторым фактором и запрет повторного кода',async()=>{
    const ctx=await context(browser),owner=session.accounts.find(account=>account.role==='admin');let secret='',codes=[],stage='вход редактора';
    try{
      const page=await ctx.newPage();
      const login=async()=>{await page.goto(session.base+'/account.html');await credentials(page,owner.email,owner.password);await page.locator('#submit').click();};
      const logout=async()=>{await page.goto(session.base+'/subscriptions.html');await page.locator('#subscriptionLogout').click();await page.waitForURL(/\/account\.html(?:\?|$)/);};
      const assertAnonymous=async()=>{const me=await(await ctx.request.get(session.base+'/api/me')).json();assert.equal(me.user,null);assert.equal((await ctx.request.get(session.base+'/api/admin/users')).status(),401);};
      await login();await page.waitForURL('**/security.html?verify=1');await page.waitForSelector('#mfaSetupForm:not([hidden])');
      stage='настройка второго фактора';await page.locator('#mfaSetupForm [name=password]').fill(owner.password);await page.locator('#mfaSetupForm [type=submit]').click();await page.waitForSelector('#mfaSetupPanel:not([hidden])');secret=await page.locator('#setupSecret').inputValue();assert.ok(/^[A-Z2-7]+$/.test(secret),'Ключ настройки получен через интерфейс');
      await page.locator('#mfaConfirmForm [name=code]').fill(totp(secret));await page.locator('#mfaConfirmForm [type=submit]').click();await page.waitForSelector('#recoveryPanel:not([hidden])');secret='';
      stage='сохранение резервных кодов';codes=await page.locator('#recoveryCodes code').allTextContents();assert.equal(codes.length,10);assert.equal(new Set(codes).size,10);assert.equal(await page.locator('#closeRecovery').isDisabled(),true);await page.locator('#recoverySaved').check();await page.locator('#closeRecovery').click();await page.waitForSelector('#recoveryPanel[hidden]',{state:'attached'});assert.equal(await page.locator('#setupSecret').inputValue(),'');assert.equal(await page.locator('#recoveryCodes code').count(),0);
      stage='пароль без второго фактора';await logout();await assertAnonymous();await login();await page.waitForSelector('#mfaChallenge:not([hidden])');await assertAnonymous();
      stage='первый вход с резервным кодом';await page.locator('#accountForm [name=code]').fill(codes[0]);await page.locator('#submit').click();await page.waitForURL('**/security.html?verify=1');await page.goto(session.base+'/admin.html');await page.waitForSelector('#adminMain:not([hidden])');
      stage='отклонение повторного резервного кода';await logout();await login();await page.waitForSelector('#mfaChallenge:not([hidden])');await page.locator('#accountForm [name=code]').fill(codes[0]);await page.locator('#submit').click();await page.waitForFunction(()=>document.getElementById('message').textContent.includes('Неверный код'));await assertAnonymous();
      stage='вход с другим резервным кодом';await page.locator('#accountForm [name=code]').fill(codes[1]);await page.locator('#submit').click();await page.waitForURL('**/security.html?verify=1');await page.goto(session.base+'/admin.html');await page.waitForSelector('#adminMain:not([hidden])');const me=await(await ctx.request.get(session.base+'/api/me')).json();assert.equal(me.user.role,'admin');assert.equal(me.user.security.mfaEnabled,true);queryIsPrivate(page);
    }catch{
      // Playwright's call log can include filled values. Report the failed stage
      // without writing the fixture password, TOTP secret or recovery codes.
      throw Error('Проверка MFA не пройдена на шаге: '+stage+'. Ключи и резервные коды исключены из отчёта.');
    }finally{secret='';codes.length=0;await ctx.close();}
  });
}
