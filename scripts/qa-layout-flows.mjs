import assert from 'node:assert/strict';
import path from 'node:path';

export async function runLayoutFlows({session,browser,record,outputDir}){
  const context=await browser.newContext({viewport:{width:1440,height:1000},locale:'ru-RU',timezoneId:'Europe/Moscow',reducedMotion:'reduce'}),screenshots=[];
  try{
    await context.route('https://fonts.googleapis.com/**',route=>route.abort());await context.route('https://fonts.gstatic.com/**',route=>route.abort());
    const owner=session.accounts.find(account=>account.role==='admin');
    const login=await context.request.post(session.base+'/api/login',{headers:{Origin:session.base},data:{email:owner.email,password:owner.password}});assert.equal(login.status(),200);
    const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.name));
    const widths=[320,390,768,1440],pages=['index.html','account.html?mode=register','subscriptions.html','security.html','notifications.html','strategies.html','strategy.html?strategy=orbita-exclusive','calculator.html','learn.html','app.html','admin.html','content-admin.html','settings-admin.html','launch-admin.html','guide.html','brokers.html','offer.html','privacy.html','refunds.html'];
    async function inspect(label){
      for(const width of widths)await record(`Адаптивность: ${label}, ${width}px`,async()=>{
        await page.setViewportSize({width,height:1000});await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
        const dimensions=await page.evaluate(()=>({viewport:innerWidth,document:document.documentElement.scrollWidth}));assert.ok(dimensions.document<=dimensions.viewport+1,`Horizontal overflow ${dimensions.document}/${dimensions.viewport}`);assert.deepEqual(errors,[]);
      });
    }
    async function screenshot(name,width){if(!outputDir)return;await page.setViewportSize({width,height:1000});await page.screenshot({path:path.join(outputDir,name),fullPage:true});screenshots.push(name);}
    for(const route of pages){
      const response=await page.goto(session.base+'/'+route,{waitUntil:'networkidle'});assert.equal(response.status(),200);
      await inspect(route);
      if(route==='index.html')await screenshot('landing-390.png',390);
      if(route==='subscriptions.html')await screenshot('subscriptions-390.png',390);
      if(route==='app.html'){
        await page.waitForSelector('#cards [data-idea]');await screenshot('ideas-1440.png',1440);await screenshot('ideas-390.png',390);
        await page.locator('#cards [data-idea]').first().click();await page.waitForSelector('#signalStage.detail-mode');await inspect('app.html — открытая идея');await screenshot('idea-detail-390.png',390);
      }
      if(route==='admin.html'){
        await page.locator('#fullComposer').evaluate(node=>{node.open=true;});await inspect('admin.html — полный сценарий');await screenshot('admin-320.png',320);
      }
      if(route==='learn.html'){
        await page.locator('.lesson-card').first().click();await page.waitForSelector('#article[open]');await inspect('learn.html — статья');await screenshot('article-390.png',390);await page.locator('#closeArticle').click();
      }
    }
    return {screenshots,widths,pages:pages.length};
  }finally{await context.close();}
}
