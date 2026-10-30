import assert from 'node:assert/strict';
import path from 'node:path';

// The caller owns an isolated local beta fixture. No real account or provider
// is read, and credentials remain in memory instead of reports/screenshots.
export async function runIdeaAlertFlows({session,browser,record,outputDir}){
  const context=await browser.newContext({viewport:{width:1440,height:1000},locale:'ru-RU',timezoneId:'Europe/Moscow',reducedMotion:'reduce'}),screenshots=[],errors=[],check=record||(async(_name,work)=>work());
  try{
    await context.route('https://fonts.googleapis.com/**',route=>route.abort());await context.route('https://fonts.gstatic.com/**',route=>route.abort());
    const owner=session.accounts.find(account=>account.role==='admin'),login=await context.request.post(session.base+'/api/login',{headers:{Origin:session.base},data:{email:owner.email,password:owner.password}});assert.equal(login.status(),200);
    const page=await context.newPage();page.on('pageerror',cause=>errors.push(cause.name));
    async function open(route){await page.goto(session.base+'/'+route,{waitUntil:'networkidle'});await page.waitForSelector('.alerts-trigger:not([hidden])');await page.locator('.alerts-trigger').click();await page.waitForSelector('#ideaAlertsDialog[open]');await page.locator('.alerts-settings').evaluate(node=>{node.open=true;});await page.waitForSelector('#strategySubscriptions input');}
    async function fit(){const dimensions=await page.evaluate(()=>{const dialog=document.getElementById('ideaAlertsDialog'),rect=dialog.getBoundingClientRect();return {viewport:innerWidth,document:document.documentElement.scrollWidth,left:rect.left,right:rect.right,height:rect.height,viewportHeight:innerHeight,dialogWidth:dialog.clientWidth,dialogScrollWidth:dialog.scrollWidth};});assert.ok(dimensions.document<=dimensions.viewport+1);assert.ok(dimensions.left>=0&&dimensions.right<=dimensions.viewport+1);assert.ok(dimensions.height<=dimensions.viewportHeight-20);assert.ok(dimensions.dialogScrollWidth<=dimensions.dialogWidth+1);}
    async function checkboxLayout(){const rows=await page.locator('.alerts-settings label').evaluateAll(labels=>labels.map(label=>{const input=label.querySelector('input'),span=label.querySelector('span'),a=input.getBoundingClientRect(),b=span.getBoundingClientRect();return {width:a.width,height:a.height,gap:b.left-a.right,topDifference:Math.abs(b.top-a.top),text:span.textContent};}));assert.ok(rows.length>=2);for(const row of rows){assert.ok(row.width>=17&&row.width<=19,row.text);assert.ok(row.height>=17&&row.height<=19,row.text);assert.ok(row.gap>=8&&row.gap<=14,row.text);assert.ok(row.topDifference<=3,row.text);}}
    await check('Уведомления идей: единое оформление на стратегиях, идее, калькуляторе и странице стратегии',async()=>{
      for(const route of ['strategies.html','strategy.html?strategy=momentum-ru','app.html','calculator.html']){
        await open(route);assert.equal(await page.locator('#orbitaIdeaAlertsStyles').count(),1);
        const style=await page.locator('#ideaAlertsDialog').evaluate(dialog=>{const value=getComputedStyle(dialog);return {radius:parseFloat(value.borderTopLeftRadius),background:value.backgroundImage,border:value.borderTopColor};});assert.ok(style.radius>=18);assert.match(style.background,/linear-gradient/);assert.notEqual(style.border,'rgb(255, 255, 255)');
        await fit();await checkboxLayout();await page.locator('.alerts-close').click();
      }
    });
    await check('Уведомления идей: checkbox рядом с текстом и окно помещается на 320, 390, 768 и 1440 px',async()=>{
      await open('strategies.html');
      for(const width of [320,390,768,1440]){await page.setViewportSize({width,height:1000});await fit();await checkboxLayout();if(outputDir&&[390,1440].includes(width)){const name='idea-alerts-'+width+'.png';await page.screenshot({path:path.join(outputDir,name),fullPage:true});screenshots.push(name);}}
      await page.locator('.alerts-close').click();
    });
    await check('Уведомления идей: предпочтения сохраняются и новые сообщения отмечаются прочитанными',async()=>{
      await open('strategies.html');await page.locator('#ideaPopups').uncheck();await page.locator('#strategySubscriptions input[value="Momentum RU"]').check();await page.reload({waitUntil:'networkidle'});await page.waitForSelector('.alerts-trigger:not([hidden])');await page.locator('.alerts-trigger').click();await page.waitForSelector('#ideaAlertsDialog[open]');await page.locator('.alerts-settings').evaluate(node=>{node.open=true;});assert.equal(await page.locator('#ideaPopups').isChecked(),false);assert.equal(await page.locator('#strategySubscriptions input[value="Momentum RU"]').isChecked(),true);
      const published=await context.request.post(session.base+'/api/admin/ideas',{headers:{Origin:session.base},data:{mode:'quick',d:{ticker:'QAALERT',dir:'ЛОНГ',strategy:'Momentum RU'}}});assert.equal(published.status(),201);
      await page.evaluate(()=>window.OrbitaStore.refresh());await page.waitForSelector('#ideaAlertsFeed .alert-item.unread');assert.ok(Number(await page.locator('.alerts-trigger b').innerText())>0);await page.locator('#alertsRead').click();assert.equal(await page.locator('.alerts-trigger b').innerText(),'0');assert.equal(await page.locator('.alert-item.unread').count(),0);await page.locator('.alerts-close').click();
    });
    await check('Уведомления идей: Escape и закрытие возвращают фокус к кнопке, ошибок JavaScript нет',async()=>{
      await page.locator('.alerts-trigger').click();await page.waitForSelector('#ideaAlertsDialog[open]');assert.equal(await page.locator('.alerts-trigger').getAttribute('aria-expanded'),'true');await page.keyboard.press('Escape');await page.waitForFunction(()=>!document.getElementById('ideaAlertsDialog').open&&document.querySelector('.alerts-trigger').getAttribute('aria-expanded')==='false');assert.equal(await page.locator('.alerts-trigger').getAttribute('aria-expanded'),'false');assert.equal(await page.locator('.alerts-trigger').evaluate(node=>node===document.activeElement),true);
      await page.locator('.alerts-trigger').click();await page.waitForSelector('#ideaAlertsDialog[open]');await page.locator('.alerts-close').click();assert.equal(await page.locator('.alerts-trigger').evaluate(node=>node===document.activeElement),true);assert.deepEqual(errors,[]);
    });
    return {screenshots,checks:4};
  }finally{await context.close();}
}
