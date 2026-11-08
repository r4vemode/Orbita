import assert from 'node:assert/strict';
import path from 'node:path';

// Caller starts an isolated beta with {payments:true}. No merchant credentials,
// outgoing provider requests, production accounts or real transfers are used.
export async function runBillingReferralFlows({session,browser,record,outputDir}){
 const check=record||(async(_title,work)=>work()),base=session.base,contexts=[],screenshots=[],errors=[];
 const accounts=Object.fromEntries(session.accounts.map(item=>[item.role,item]));
 let admin,client,partner,adminPage,clientPage,partnerPage,ref,customer,order,agreement;
 async function context(role){const ctx=await browser.newContext({viewport:{width:1440,height:1000},locale:'ru-RU',timezoneId:'Europe/Moscow',reducedMotion:'reduce'});contexts.push(ctx);if(role)await login(ctx,accounts[role]);return ctx;}
 async function login(ctx,account){await request(ctx,'/api/login',{method:'POST',data:{email:account.email,password:account.password}});}
 async function request(ctx,route,{method='GET',data,status=200}={}){const result=await ctx.request.fetch(base+route,{method,maxRedirects:0,headers:{Origin:base},...(data===undefined?{}:{data})});assert.equal(result.status(),status,route);return result.headers()['content-type']?.includes('application/json')?result.json():null;}
 async function page(ctx){const view=await ctx.newPage();view.on('pageerror',cause=>errors.push(cause.name));view.on('dialog',dialog=>dialog.accept());return view;}
 async function partners(){return (await request(admin,'/api/admin/referrals')).partners;}
 async function payments(){return request(admin,'/api/admin/payments/orders');}
 try{
  await check('Платежи и партнёры: новые страницы и API защищены от гостя и клиента',async()=>{
   admin=await context('admin');const guest=await context(),member=await context('pro');
   for(const route of ['/payments-admin.html','/partners-admin.html','/%70artners-admin.html']){await request(guest,route,{status:303});await request(member,route,{status:303});await request(admin,route);}
   for(const route of ['/api/admin/payments/orders','/api/admin/referrals','/assets/payments-admin.js']){await request(guest,route,{status:401});await request(member,route,{status:403});}
   await request(guest,'/partner.html',{status:303});await request(guest,'/api/referrals/me',{status:401});await request(guest,'/api/payments/history',{status:401});
   for(const route of ['/api/payments/history','/api/payments/subscriptions'])await request(member,route);
  });
  await check('Партнёр: администратор создаёт ссылку и условия через интерфейс',async()=>{
   adminPage=await page(admin);await adminPage.goto(base+'/partners-admin.html');await adminPage.locator('#partnerUser option').first().waitFor({state:'attached'});
   const target=(await request(admin,'/api/admin/users')).users.find(item=>item.email===accounts.pro.email);
   await adminPage.selectOption('#partnerUser',target.id);await adminPage.fill('#partnerName','Учебный партнёр');await adminPage.fill('#partnerHold','0');
   await adminPage.getByRole('button',{name:'Добавить партнёра',exact:true}).click();await adminPage.getByRole('heading',{name:'Учебный партнёр',exact:true}).waitFor();
   ref=(await partners())[0];assert.equal(ref.terms.firstBps,1500);assert.equal(ref.terms.repeatBps,1000);
  });
  await check('Партнёрская ссылка: регистрация привязывается один раз, платный доступ не выдаётся',async()=>{
   client=await context();clientPage=await page(client);await clientPage.goto(base+ref.link);await clientPage.goto(base+ref.link);
   const legalVersion=(await request(client,'/api/public-config')).legalVersion;
   customer=(await request(client,'/api/register',{method:'POST',data:{email:'billing-ui-client@example.test',password:'temporary-billing-ui-2026',acceptTerms:true,acceptPrivacy:true,legalVersion}})).user;
   assert.equal(customer.access.hasSubscription,false);assert.equal((await partners())[0].visits,1);assert.equal((await partners())[0].registrations,1);
   await request(client,'/api/ideas',{status:403});
  });
  await check('Подписки: согласие на продление выключено по умолчанию, тестовый заказ явно обозначен',async()=>{
   await clientPage.goto(base+'/subscriptions.html?plan=pro');await clientPage.locator('#createCheckout:not([disabled])').waitFor();
   assert.equal(await clientPage.locator('#recurringConsent').isChecked(),false);assert.match(await clientPage.locator('#createCheckout').innerText(),/тестовый/);
   await clientPage.check('#recurringConsent');await clientPage.locator('#createCheckout').click();await clientPage.waitForFunction(()=>document.getElementById('paymentOrderTitle').textContent==='Тестовый заказ создан');
   assert.equal(await clientPage.locator('#continuePayment').isHidden(),true);order=(await payments()).orders.find(item=>item.userId===customer.id);assert.equal(order.simulation,true);
   await request(client,'/api/admin/payments/simulate',{method:'POST',data:{action:'pay',orderId:order.id,requestId:'forbidden-ui-test'},status:403});
  });
  await check('Симулятор: подтверждённая оплата даёт только купленный тариф и первую комиссию',async()=>{
   await adminPage.goto(base+'/payments-admin.html');await adminPage.getByRole('button',{name:'Успешная оплата',exact:true}).click();await adminPage.getByRole('button',{name:'Повторное списание',exact:true}).waitFor();
   const state=await payments();order=state.orders.find(item=>item.id===order.id);agreement=state.subscriptions.find(item=>item.id===order.agreementId);
   assert.equal(order.status,'paid');assert.equal(agreement.status,'active');assert.deepEqual((await request(client,'/api/me')).user.access.activePlans,['pro']);assert.equal((await partners())[0].balance.totalMinor,44985);
   await clientPage.reload();await clientPage.locator('#billingAgreements button').waitFor();assert.match(await clientPage.locator('#billingOrders').innerText(),/симуляция/);
  });
  await check('Повторная оплата и отключение: комиссия меняется, оплаченный срок сохраняется',async()=>{
   await adminPage.getByRole('button',{name:'Повторное списание',exact:true}).click();await adminPage.waitForFunction(()=>document.querySelectorAll('#paymentAdminOrders .billing-row').length===2);
   assert.equal((await partners())[0].balance.totalMinor,74975);const before=(await request(client,'/api/me')).user.subscriptions.find(item=>item.plan==='pro').expiresAt;
   await clientPage.locator('#refreshBilling').click();await clientPage.locator('#billingAgreements button').click();await clientPage.waitForFunction(()=>document.getElementById('billingAgreements').textContent.includes('Будущие списания отключены'));
   assert.equal((await request(client,'/api/me')).user.subscriptions.find(item=>item.plan==='pro').expiresAt,before);assert.equal((await payments()).subscriptions[0].status,'cancelled');
  });
  await check('Партнёрский кабинет: только своя статистика без email привлечённых клиентов',async()=>{
   partner=await context('pro');partnerPage=await page(partner);await partnerPage.goto(base+'/partner.html');await partnerPage.locator('.referral-card').waitFor();
   const own=await request(partner,'/api/referrals/me');assert.equal(own.partners[0].balance.totalMinor,74975);assert.ok(!JSON.stringify(own).includes(customer.email));assert.ok(!(await partnerPage.content()).includes(customer.email));
   assert.equal((await request(client,'/api/referrals/me')).partners.length,0);
  });
  await check('Партнёрские выплаты: резерв и отмена работают в интерфейсе без перевода денег',async()=>{
   await adminPage.goto(base+'/partners-admin.html');await adminPage.getByRole('button',{name:'Зарезервировать выплату',exact:true}).click();await adminPage.waitForFunction(()=>document.getElementById('referralList').textContent.includes('Отменить резерв'));
   assert.equal((await partners())[0].balance.reservedMinor,74975);await adminPage.getByText('История выплат',{exact:true}).click();await adminPage.getByRole('button',{name:'Отменить резерв',exact:true}).click();
   await adminPage.waitForFunction(()=>document.getElementById('referralList').textContent.includes('Резерв отменён'));assert.equal((await partners())[0].balance.reservedMinor,0);
  });
  await check('Новые кабинеты: адаптивность 320/390/768/1440 и отсутствие ошибок JavaScript',async()=>{
   for(const [view,name,route,selector]of [[adminPage,'partners-admin','/partners-admin.html','.referral-card'],[adminPage,'payments-admin','/payments-admin.html','#paymentAdminOrders .billing-row'],[clientPage,'subscriptions','/subscriptions.html?plan=pro','#billingOrders .billing-row'],[partnerPage,'partner','/partner.html','.referral-card']]){
    await view.goto(base+route);await view.locator(selector).first().waitFor();for(const width of [320,390,768,1440]){await view.setViewportSize({width,height:1000});assert.ok(await view.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),name+' overflow '+width);if(outputDir&&[390,1440].includes(width)){const filename=name+'-'+width+'.png';await view.screenshot({path:path.join(outputDir,filename),fullPage:true});screenshots.push(filename);}}
   }assert.deepEqual(errors,[]);
  });
  await check('Возврат в редакции: явное подтверждение, очистка пароля и тот же запрос после обрыва связи',async()=>{
   const fixture={id:'order-browser-fixture',userId:customer.id,plan:'pro',amount:2999,currency:'RUB',status:'paid',testMode:true,remainingRefundMinor:299900};
   const attempts=[];await adminPage.route('**/api/admin/payments/orders',route=>route.fulfill({status:200,json:{simulation:false,testMode:true,orders:[fixture],subscriptions:[],refundRequests:[]}}));
   await adminPage.route('**/api/admin/payments/refunds',route=>{attempts.push(route.request().postDataJSON());return attempts.length===1?route.abort():route.fulfill({status:202,json:{refund:{id:'refund-browser-fixture',status:'unknown'}}});});
   await adminPage.goto(base+'/payments-admin.html');
   async function submitRefund(){await adminPage.getByText('Оформить возврат',{exact:true}).click();await adminPage.getByLabel('Сумма возврата, ₽',{exact:true}).fill('999.33');await adminPage.getByLabel('Основание возврата',{exact:true}).fill('Учебное обращение о возврате');await adminPage.getByLabel('Ваш пароль',{exact:true}).fill(accounts.admin.password);await adminPage.getByRole('button',{name:'Отправить запрос возврата',exact:true}).click();}
   await submitRefund();await adminPage.waitForFunction(()=>document.getElementById('paymentAdminMessage').textContent.includes('Нет связи'));await adminPage.getByText('Оформить возврат',{exact:true}).waitFor();
   await submitRefund();await adminPage.waitForFunction(()=>document.getElementById('paymentAdminMessage').textContent.includes('Запрос сохранён'));
   assert.equal(attempts.length,2);assert.equal(attempts[0].amountMinor,99933);assert.equal(attempts[0].requestId,attempts[1].requestId);
   assert.equal(await adminPage.locator('input[type=password]').inputValue(),'');assert.equal(await adminPage.evaluate(value=>JSON.stringify(localStorage).includes(value)||JSON.stringify(sessionStorage).includes(value),accounts.admin.password),false);
  });
  await check('Партнёрский кабинет: поздний ответ не раскрывает статистику после смены аккаунта',async()=>{
   let release,started;const held=new Promise(resolve=>{release=resolve;}),seen=new Promise(resolve=>{started=resolve;});const original=await request(partner,'/api/referrals/me');
   await partnerPage.route('**/api/referrals/me',async route=>{started();await held;await route.fulfill({status:200,json:original}).catch(()=>{});},{times:1});
   await partnerPage.locator('#referralRefresh').click();await seen;await login(partner,accounts.free);release();await partnerPage.waitForFunction(()=>document.getElementById('referralList')?.textContent.includes('пока не подключена'));
   assert.ok(!(await partnerPage.content()).includes('Учебный партнёр'));assert.deepEqual(errors,[]);
  });
  return {screenshots};
 }finally{await Promise.allSettled(contexts.map(ctx=>ctx.close()));}
}
