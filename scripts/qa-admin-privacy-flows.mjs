import assert from 'node:assert/strict';

export async function runAdminPrivacyFlows({session,browser,record}){
 const context=await browser.newContext({viewport:{width:1440,height:1000},locale:'ru-RU',timezoneId:'Europe/Moscow'}),check=record||(async(_title,work)=>work());
 try{
  await context.route('https://fonts.googleapis.com/**',route=>route.abort());await context.route('https://fonts.gstatic.com/**',route=>route.abort());
  const owner=session.accounts.find(account=>account.role==='admin'),other=session.accounts.find(account=>account.role==='free'),login=async account=>{const response=await context.request.post(session.base+'/api/login',{headers:{Origin:session.base},data:{email:account.email,password:account.password}});assert.equal(response.status(),200);};
  await login(owner);const page=await context.newPage(),errors=[];page.on('pageerror',cause=>errors.push(cause.name));
  const visibleCheck=()=>page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
  await check('Редакция: смена аккаунта очищает клиентов и частный черновик; сбой проверки сохраняет поля скрытыми',async()=>{
   await page.goto(session.base+'/admin.html');await page.waitForFunction(()=>document.querySelectorAll('#usersOverview .user-row').length>0&&!document.getElementById('refreshIdeas').disabled);assert.match(await page.locator('#usersOverview').innerText(),new RegExp(other.email.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
   await page.evaluate(()=>window.addEventListener('beforeunload',()=>sessionStorage.setItem('qa.admin.cleared',JSON.stringify({hidden:document.getElementById('adminMain').hidden,users:document.getElementById('usersOverview').textContent.length,options:document.getElementById('subscriptionUser').options.length,identity:document.getElementById('adminIdentity').textContent.length})),{once:true}));
   await login(other);await visibleCheck();await page.waitForURL(/subscriptions\.html/);assert.deepEqual(await page.evaluate(()=>JSON.parse(sessionStorage.getItem('qa.admin.cleared'))),{hidden:true,users:0,options:0,identity:0});
   await login(owner);await page.goto(session.base+'/legal-admin.html');await page.waitForSelector('#legalWorkspace:not([hidden])');await page.waitForFunction(()=>document.getElementById('legalWorkspace').style.visibility!=='hidden');await page.locator('[name=ownerName]').fill('Частный несохранённый черновик QA');await page.locator('[name=ownerName]').evaluate(node=>{node.focus();node.setSelectionRange(3,10);});
   await page.route('**/api/me',route=>route.abort(),{times:1});await visibleCheck();await page.waitForFunction(()=>document.getElementById('legalWorkspace').style.visibility==='hidden'&&document.body.textContent.includes('Не удалось проверить доступ.'));assert.equal(await page.locator('[name=ownerName]').inputValue(),'Частный несохранённый черновик QA');
   await visibleCheck();await page.waitForFunction(()=>document.getElementById('legalWorkspace').style.visibility!=='hidden');assert.equal(await page.locator('[name=ownerName]').inputValue(),'Частный несохранённый черновик QA');assert.deepEqual(await page.locator('[name=ownerName]').evaluate(node=>[document.activeElement===node,node.selectionStart,node.selectionEnd]),[true,3,10]);
   await page.evaluate(()=>window.addEventListener('beforeunload',()=>sessionStorage.setItem('qa.legal.cleared',JSON.stringify({hidden:document.getElementById('legalWorkspace').hidden,nameLength:document.querySelector('[name=ownerName]').value.length,versions:document.getElementById('legalVersions').textContent.length})),{once:true}));
   await login(other);await visibleCheck();await page.waitForURL(/subscriptions\.html/);assert.deepEqual(await page.evaluate(()=>JSON.parse(sessionStorage.getItem('qa.legal.cleared'))),{hidden:true,nameLength:0,versions:0});
   assert.deepEqual(errors,[]);
  });
 }finally{await context.close();}
}
