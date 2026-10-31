import assert from 'node:assert/strict';

export async function runSecurityRaceFlows({session,browser,record}){
 const context=await browser.newContext({viewport:{width:1440,height:1000},locale:'ru-RU',timezoneId:'Europe/Moscow'}),check=record||(async(_title,work)=>work());
 try{
  await context.route('https://fonts.googleapis.com/**',route=>route.abort());await context.route('https://fonts.gstatic.com/**',route=>route.abort());const owner=session.accounts.find(account=>account.role==='admin'),other=session.accounts.find(account=>account.role==='free');
  const login=async account=>{const response=await context.request.post(session.base+'/api/login',{headers:{Origin:session.base},data:{email:account.email,password:account.password}});assert.equal(response.status(),200);};
  await login(owner);const page=await context.newPage(),errors=[];page.on('pageerror',cause=>errors.push(cause.name));
  await check('Безопасность: поздний ключ настройки MFA не раскрывается после смены аккаунта',async()=>{
   await page.goto(session.base+'/security.html');await page.waitForSelector('#securitySettings:not([hidden])');await page.locator('#mfaSetupForm [name=password]').fill(owner.password);
   let release,entered;const gate=new Promise(resolve=>{release=resolve;}),intercepted=new Promise(resolve=>{entered=resolve;});
   await page.route('**/api/security/mfa/setup',async route=>{const response=await route.fetch();assert.equal(response.status(),200);entered();await gate;await route.fulfill({response});},{times:1});
   await page.locator('#mfaSetupForm [type=submit]').click();await intercepted;
   try{await context.request.post(session.base+'/api/logout',{headers:{Origin:session.base},data:{}});await login(other);}finally{release();}
   await page.waitForFunction(email=>document.getElementById('accountEmail').textContent===email,other.email);assert.equal(await page.locator('#setupSecret').inputValue(),'');assert.equal(await page.locator('#setupUri').innerText(),'');assert.equal(await page.locator('#mfaSetupPanel').isVisible(),false);assert.equal(await page.locator('#recoveryCodes li').count(),0);assert.deepEqual(errors,[]);
  });
 }finally{await context.close();}
}
