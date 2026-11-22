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
   const calc=await client.newPage();calc.on('pageerror',e=>errors.push(e.message));await calc.goto(session.base+'/calculator.html');await calc.waitForFunction(()=>document.getElementById('tradeCount').textContent!=='—');assert.equal(await calc.locator('#dataMode').inputValue(),'published');assert.equal(await calc.locator('#tradeCount').innerText(),'0');assert.match(await calc.locator('#resultMessage').innerText(),/Нет исполненных сделок/);
   await calc.selectOption('#dataMode','demo');if(await calc.locator('#showHistory').isVisible())await calc.locator('#showHistory').click();await calc.waitForFunction(()=>Number(document.getElementById('tradeCount').textContent)>0);assert.match(await calc.locator('#resultMessage').innerText(),/условными входами и выходами/);assert.notEqual(await calc.locator('#winRate').innerText(),'—');const before=await calc.locator('#profit').innerText();await calc.fill('#slippage','1');await calc.locator('#calcForm button[type=submit]').click();await calc.waitForFunction(value=>document.getElementById('profit').textContent!==value,before);
   await calc.setViewportSize({width:390,height:1000});assert.ok(await calc.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));const name='calculator-metrics-390.png';await calc.screenshot({path:path.join(outputDir,name),fullPage:true});screenshots.push(name);assert.deepEqual(errors,[]);
  });
  await record('С главной без входа открываются 170 исторических сценариев и отдельный журнал публикаций',async()=>{
   const guest=await context(),journal=await guest.newPage();
   journal.on('pageerror',error=>errors.push(error.message));
   await journal.goto(session.base+'/');
   await journal.getByRole('link',{name:'Результаты',exact:true}).click();
   await journal.waitForSelector('#resultsRows tr');
   assert.equal(await journal.locator('#resultsRows tr').count(),170);
   assert.equal(await journal.locator('#resultsRows .results-source').count(),170);
   assert.match(await journal.locator('#resultsSubtitle').innerText(),/отобраны задним числом/i);
   await journal.locator('[data-tier=pro]').click();
   assert.equal(await journal.locator('#resultsRows tr').count(),150);
   await journal.locator('[data-tier=exclusive]').click();
   assert.equal(await journal.locator('#resultsRows tr').count(),20);
   const download=journal.waitForEvent('download');
   await journal.locator('#resultsCsv').click();
   const csv=await readFile(await (await download).path(),'utf8');
   assert.equal(csv.trim().split('\n').length,21);
   assert.match(csv,/NLMK/);
   await journal.locator('#resultsFrom').fill('2026-11-22');
   assert.equal(await journal.locator('#resultsEmpty').isVisible(),true);
   await journal.locator('#resultsClearDate').click();
   assert.equal(await journal.locator('#resultsRows tr').count(),20);
   await journal.locator('[data-results-type=actual]').click();
   await journal.waitForSelector('#resultsEmpty:not([hidden])');
   assert.equal(await journal.locator('#resultsRows tr').count(),0);
   await journal.locator('[data-results-type=scenarios]').click();
   await journal.waitForSelector('#resultsRows tr');
   assert.equal(await journal.locator('#resultsRows tr').count(),20);
   await journal.setViewportSize({width:390,height:844});
   assert.ok(await journal.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
   const result=await journal.locator('#resultsRows tr').first().locator('td').nth(8).boundingBox();
   assert.ok(result.x>=0&&result.x+result.width<=391);
   const name='public-history-390.png';
   await journal.screenshot({path:path.join(outputDir,name)});screenshots.push(name);
   assert.deepEqual(errors,[]);
  });
  await record('У EXCLUSIVE открываются свечи, уровни, помесячная статистика и расчёт +15%',async()=>{
   const participant=await context('exclusive'),history=await participant.newPage();
   history.on('pageerror',error=>errors.push(error.message));
   await history.goto(session.base+'/strategies.html?view=history&type=demo&tab=exclusive');
   const idea=history.locator('.irow[data-provenance=demo]').filter({hasText:'NLMK'});
   await idea.locator('.irow-main').click();
   assert.equal(await history.locator('.irow[data-provenance=demo]').count(),20);
   assert.ok(await idea.locator('.ic-candle').count()>25);
   assert.equal(await idea.locator('.ic-level').count(),4);
   assert.match(await idea.locator('.irow-main').innerText(),/15,51%/);
   await history.waitForSelector('.history-capital .capital-line');
   assert.equal(await history.locator('.history-months tbody tr').count(),9);
   await history.locator('.history-calculator').click();
   await history.waitForURL('**/calculator.html?*');
   await history.waitForFunction(()=>document.getElementById('tradeCount')?.textContent==='20');
   assert.equal(await history.locator('#returnPct').innerText(),'+15,00%');
   assert.deepEqual(errors,[]);
  });
  await record('Журнал идей фильтрует закрытия по дате МСК и тарифу в таблице и CSV',async()=>{
   const guest=await context(),journal=await guest.newPage();
   journal.on('pageerror',e=>errors.push(e.message));
   const levels={entry:100,stop:95,target:110};
   const row=(ticker,closedAt,tier,pct)=>({ticker,tier,closedAt,publishedAt:'2026-07-30T09:00:00Z',dir:'ЛОНГ',strategy:'Импульс',state:'closed',outcome:pct>0?'Закрыто по цели':'Закрыто по стопу',pct,r:pct/5,initial:levels,final:levels,exit:100+pct});
   const results=[
    row('EXONLY','2026-08-04T13:00:00Z','exclusive',3),
    row('LOSING','2026-08-03T12:00:00Z','pro',-5),
    row('MIDNIGHT','2026-07-31T21:00:00Z','pro',10),
    row('JULY','2026-07-31T20:59:59Z','pro',6)
   ];
   await journal.route('**/api/public/results',route=>route.fulfill({json:{open:0,results}}));
   await journal.goto(session.base+'/results.html?type=actual&from=2026-08-01&tier=pro');
   await journal.waitForSelector('#resultsTable:not([hidden])');
   assert.deepEqual(await journal.locator('#resultsRows b').allTextContents(),['LOSING','MIDNIGHT']);
   assert.equal(await journal.locator('[data-tier=pro]').getAttribute('aria-selected'),'true');
   const downloaded=journal.waitForEvent('download');await journal.locator('#resultsCsv').click();
   const csv=await readFile(await (await downloaded).path(),'utf8');
   assert.match(csv,/LOSING/);assert.match(csv,/MIDNIGHT/);assert.doesNotMatch(csv,/EXONLY|JULY/);
   await journal.locator('#resultsFrom').fill('2026-08-05');
   assert.equal(await journal.locator('#resultsEmpty').isVisible(),true);
   assert.equal(await journal.locator('#resultsCsv').isDisabled(),true);
   assert.match(journal.url(),/from=2026-08-05/);
   await journal.setViewportSize({width:320,height:800});
   assert.ok(await journal.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
   assert.deepEqual(errors,[]);
  });
 }finally{for(const ctx of contexts)await ctx.close();}
 return {screenshots};
}
