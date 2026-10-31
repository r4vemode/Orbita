import assert from 'node:assert/strict';

// Runs against one isolated local-beta fixture, never a working account database.
export async function runMemberSessionFlows({session,browser,record}){
 const base=session.base,accounts=Object.fromEntries(session.accounts.map(account=>[account.role,account])),contexts=[],errors=[],check=record||(async(_name,work)=>work());
 async function context(role){const value=await browser.newContext({viewport:{width:1440,height:1000},locale:'ru-RU',timezoneId:'Europe/Moscow'});contexts.push(value);await value.route('https://fonts.googleapis.com/**',route=>route.abort());await value.route('https://fonts.gstatic.com/**',route=>route.abort());await login(value,role);return value;}
 async function login(ctx,role){const account=accounts[role],response=await ctx.request.post(base+'/api/login',{headers:{Origin:base},data:{email:account.email,password:account.password}});assert.equal(response.status(),200);}
 async function write(ctx,route,data,method='POST'){const response=await ctx.request.fetch(base+route,{method,headers:{Origin:base},data});assert.equal(response.status(),200);return response.json();}
 async function page(ctx,route){const value=await ctx.newPage();value.on('pageerror',cause=>errors.push(cause.name));await value.goto(base+route);return value;}
 const visibility=value=>value.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
 try{
  await check('Открытый кабинет меняет аккаунт без чужой личной сделки и отслеживания',async()=>{
   const ctx=await context('pro'),rows=(await(await ctx.request.get(base+'/api/ideas')).json()).records,idea=rows.find(row=>row.d.entry>0&&!['closed','cancelled'].includes(row.d.state));assert.ok(idea);
   await write(ctx,'/api/positions',{ideaId:idea.id,entry:102,quantity:17,pointValue:1,enteredAt:new Date().toISOString(),exit:null,closedAt:null},'PUT');await write(ctx,'/api/watchlist',{ids:[idea.id]},'PUT');
   const view=await page(ctx,'/app.html?idea='+encodeURIComponent(idea.id));await view.waitForSelector('.personal-form');assert.equal(await view.locator('.personal-form [name=quantity]').inputValue(),'17');assert.equal(await view.locator('#follow').getAttribute('aria-pressed'),'true');
   await login(ctx,'admin');await Promise.all([view.waitForEvent('framenavigated',frame=>frame===view.mainFrame()),visibility(view)]);await view.waitForSelector('.personal-form');await view.waitForFunction(()=>window.OrbitaPersonal.ids().length===0);assert.equal(await view.locator('.personal-form [name=quantity]').inputValue(),'1');assert.equal(await view.locator('#follow').getAttribute('aria-pressed'),'false');
  });
  await check('Открытая статья закрывается после выхода в другой вкладке',async()=>{
   const ctx=await context('pro'),view=await page(ctx,'/learn.html');await view.waitForSelector('[data-lesson]');await view.locator('[data-lesson]').first().click();await view.waitForSelector('#article[open]');
   await write(ctx,'/api/logout',{});await visibility(view);await view.waitForURL(url=>url.pathname==='/account.html');assert.equal(await view.locator('#articleBody').count(),0);assert.equal((await ctx.request.get(base+'/api/lessons')).status(),401);
  });
  await check('Калькулятор убирает открытую историю после отзыва подписки без ручного пересчёта',async()=>{
   const ctx=await context('pro'),editor=await context('admin'),view=await page(ctx,'/calculator.html');await view.waitForFunction(()=>document.getElementById('finalCapital')?.textContent.includes('₽'));
   const member=(await(await ctx.request.get(base+'/api/me')).json()).user;await write(editor,'/api/admin/subscriptions',{userId:member.id,plan:'pro',expiresAt:null,reason:'Учебная проверка открытого калькулятора'});await visibility(view);await view.waitForURL(url=>url.pathname==='/subscriptions.html');assert.equal(await view.locator('#tradeRows').count(),0);
  });
  await check('Новости сохраняют учебную карточку при опросе и синхронизации настроек другой вкладки',async()=>{
   const ctx=await context('admin');let polls=0;await ctx.route(base+'/api/news',route=>{polls++;return route.fulfill({json:{configured:false,items:[],checkedAt:new Date().toISOString()}});});
   const view=await page(ctx,'/app.html');await view.waitForSelector('.news-trigger');await view.waitForFunction(()=>document.querySelector('.news-status')?.textContent.includes('недоступна'));await view.locator('.news-trigger').click();await view.locator('#newsTest').click();await view.locator('.news-toast .news-close').click();await view.locator('.news-trigger').click();assert.equal(await view.locator('.news-item .news-test-tag').count(),1);
   const before=polls;await visibility(view);await view.waitForFunction(()=>document.querySelector('.news-status')?.textContent.includes('недоступна'));await view.waitForTimeout(100);assert.ok(polls>before);assert.equal(await view.locator('.news-item .news-test-tag').count(),1);
   const settings=await ctx.newPage();await settings.goto(base+'/account.html');await settings.evaluate(()=>{const key=Object.keys(localStorage).find(value=>value.startsWith('orbita.news.v1.'));if(!key)throw Error('Missing fixture preference');const value=JSON.parse(localStorage.getItem(key));value.popups=false;localStorage.setItem(key,JSON.stringify(value));});await view.waitForFunction(()=>document.getElementById('newsPopups')?.checked===false);assert.equal(await view.locator('.news-item .news-test-tag').count(),1);assert.deepEqual(errors,[]);
  });
 }finally{await Promise.all(contexts.map(value=>value.close()));}
}
