import assert from 'node:assert/strict';
import path from 'node:path';
import {readFile} from 'node:fs/promises';
import {runBacktest,example} from '../lib/backtest.mjs';
export async function runAnalyticsFlows({session,browser,record,outputDir}){
 const contexts=[],screenshots=[],errors=[];let admin,client,page;
 async function context(role){const ctx=await browser.newContext({viewport:{width:1440,height:1000},locale:'ru-RU'});contexts.push(ctx);await ctx.route('https://fonts.googleapis.com/**',r=>r.abort());await ctx.route('https://fonts.gstatic.com/**',r=>r.abort());if(role){const account=session.accounts.find(a=>a.role===role),response=await ctx.request.post(session.base+'/api/login',{headers:{Origin:session.base},data:{email:account.email,password:account.password}});assert.equal(response.status(),200);}return ctx;}
 try{
  await record('OHLC-проверка и движок доступны только редактору',async()=>{
   admin=await context('admin');client=await context('pro');const guest=await context();
   for(const ctx of [client,guest]){assert.equal((await ctx.request.get(session.base+'/backtest-admin.html',{maxRedirects:0})).status(),303);for(const asset of ['backtest-admin.js','backtest-engine.js'])assert.equal((await ctx.request.get(session.base+'/assets/'+asset)).status(),ctx===guest?401:403);}
   page=await admin.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(session.base+'/backtest-admin.html');await page.waitForSelector('#backtestWorkspace:not([hidden])');assert.equal(await page.locator('#backtestResult').isVisible(),false);assert.match(await page.locator('#backtestStatus').innerText(),/Без исходных данных/);
  });
  await record('Учебный OHLC-пример, независимый Node-результат и выгрузка отчёта совпадают',async()=>{
   await page.locator('#backtestExample').click();await page.waitForSelector('#backtestResult:not([hidden])');assert.match(await page.locator('#backtestMode').innerText(),/УЧЕБНЫЕ ДАННЫЕ/);assert.equal(await page.locator('#backtestTrades tr').count(),1);
   const download=page.waitForEvent('download');await page.locator('#backtestExport').click();const artifact=await download,value=JSON.parse(await readFile(await artifact.path(),'utf8')),expected=runBacktest(example());assert.deepEqual(value.metrics,expected.metrics);assert.deepEqual(value.trades,expected.trades);assert.deepEqual(value.provenance,expected.provenance);assert.ok(value.warnings.length>0);
  });
  await record('Некорректная и непокрытая история не сохраняет старые показатели',async()=>{
   await page.locator('#backtestFile').setInputFiles({name:'invalid.json',mimeType:'application/json',buffer:Buffer.from('{broken')});await page.waitForFunction(()=>document.getElementById('backtestStatus').textContent.includes('прочитать JSON'));assert.equal(await page.locator('#backtestResult').isVisible(),false);assert.equal(await page.locator('#backtestExport').isDisabled(),true);
   const missing=example();missing.candles=[];await page.locator('#backtestFile').setInputFiles({name:'missing.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(missing))});await page.waitForFunction(()=>document.getElementById('backtestStatus').textContent.includes('Недостаточно данных'));assert.ok(!(await page.locator('#backtestMetrics').innerText()).includes('100\u00a0000'));assert.match(await page.locator('#backtestWarnings').innerText(),/Недостаточно/);
  });
  await record('Импортированный текст безопасен; редакция истории помещается на мобильном экране',async()=>{
   const input=example();input.instrument.ticker='<svg onload=alert(1)>';await page.locator('#backtestFile').setInputFiles({name:'safe-text.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(input))});await page.waitForSelector('#backtestResult:not([hidden])');await page.waitForFunction(()=>!document.getElementById('backtestExport').disabled);assert.equal(await page.locator('#backtestResult svg,#backtestResult img,#backtestResult script').count(),0);
   for(const width of [390,1440]){await page.setViewportSize({width,height:1000});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));const name='backtest-admin-'+width+'.png';await page.screenshot({path:path.join(outputDir,name),fullPage:true});screenshots.push(name);}
  });
  await record('Калькулятор разделяет учебные идеи, показывает издержки и статистику',async()=>{
   const calc=await client.newPage();calc.on('pageerror',e=>errors.push(e.message));await calc.goto(session.base+'/calculator.html');await calc.waitForFunction(()=>document.getElementById('tradeCount').textContent!=='—');assert.equal(await calc.locator('#dataMode').inputValue(),'published');assert.equal(await calc.locator('#tradeCount').innerText(),'0');assert.match(await calc.locator('#resultMessage').innerText(),/демонстрационных идей исключено/);
   await calc.selectOption('#dataMode','demo');if(await calc.locator('#showHistory').isVisible())await calc.locator('#showHistory').click();await calc.waitForFunction(()=>Number(document.getElementById('tradeCount').textContent)>0);assert.match(await calc.locator('#resultMessage').innerText(),/демонстрационные сделки/);assert.notEqual(await calc.locator('#winRate').innerText(),'—');const before=await calc.locator('#profit').innerText();await calc.fill('#slippage','1');await calc.locator('#calcForm button[type=submit]').click();await calc.waitForFunction(value=>document.getElementById('profit').textContent!==value,before);
   await calc.setViewportSize({width:390,height:1000});assert.ok(await calc.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));const name='calculator-metrics-390.png';await calc.screenshot({path:path.join(outputDir,name),fullPage:true});screenshots.push(name);assert.deepEqual(errors,[]);
  });
 }finally{for(const ctx of contexts)await ctx.close();}
 return {screenshots};
}
