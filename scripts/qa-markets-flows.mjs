import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {normalizeOpenPositions,positionMetrics} from '../lib/markets/model.mjs';

// Current Markets screen replaces participants.html. Exchange payloads are
// recorded test fixtures; browser interceptions never modify a live store.
export async function runMarketsFlows({session,browser,record}){
 const contexts=[],errors=[],base=session.base;let admin,pro,exclusive,free,guest,page,fixture;
 const check=record||(async(_n,f)=>f());
 async function ctx(role){const c=await browser.newContext({viewport:{width:1440,height:1000}});contexts.push(c);if(role){const a=session.accounts.find(x=>x.role===role);assert.equal((await c.request.post(base+'/api/login',{headers:{Origin:base},data:{email:a.email,password:a.password}})).status(),200);}return c;}
 async function get(c,p,status=200){const r=await c.request.get(base+p,{maxRedirects:0});assert.equal(r.status(),status,p);return r;}
 async function refresh(){await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));}
 try{
  await check('Рынки: API и страница закрыты гостю и бесплатному аккаунту, доступны PRO и EXCLUSIVE',async()=>{
   admin=await ctx('admin');pro=await ctx('pro');exclusive=await ctx('exclusive');free=await ctx('free');guest=await ctx();
   for(const c of [guest,free]){await get(c,'/markets.html',303);await get(c,'/api/markets',c===guest?401:403);await get(c,'/assets/markets.js',c===guest?401:403);}
   for(const c of [pro,exclusive]){await get(c,'/markets.html');await get(c,'/api/markets');await get(c,'/api/admin/markets',403);}
   for(const old of ['/participants.html','/market-demo.html']){const r=await get(guest,old,301);assert.equal(r.headers().location,'/markets.html');}
   // Legacy endpoints remain protected, even though the old screen was replaced.
   for(const p of ['/api/participants','/api/participants/demo','/api/participants/watchlist']){await get(guest,p,401);await get(free,p,403);await get(pro,p);}
  });
  await check('Рынки: отключённый источник не выдаёт вымышленные цены',async()=>{
   const result=await(await get(pro,'/api/markets')).json();assert.equal(result.mode,'off');assert.ok(result.instruments.every(i=>!i.quote&&!i.positions));
   page=await pro.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(base+'/markets.html');await page.locator('#marketsSkeleton').waitFor({state:'hidden'});assert.match(await page.locator('#marketsSource').innerText(),/выключен/);assert.equal(await page.locator('#marketsError').isVisible(),false);
  });
  await check('Рынки: поиск, фильтр и карточка показывают доли контрактов и дату источника',async()=>{
   const raw=JSON.parse(await readFile(new URL('../fixtures/moex/op_si.json',import.meta.url),'utf8'));
   const positions={...positionMetrics(normalizeOpenPositions(raw,'Si')),freshness:{state:'stale'}};
   fixture={mode:'moex',source:'MOEX · запись для автоматической проверки',delayMinutes:15,sources:{quotes:{status:'ok',lastSuccess:'2026-11-06T12:00:00Z'},positions:{status:'ok',lastSuccess:'2026-11-06T12:00:00Z'}},instruments:[{asset:'Si',name:'Учебный USD/RUB',group:'fx',contract:{secid:'SiZ6',shortName:'Si-12.26',expiry:'2026-12-17'},quote:{last:81000,changePct:1,volume:100,openInterest:positions.openInterest,providerTime:'2026-11-06T12:00:00Z',freshness:{state:'stale'}},positions,history:[],sessions:[],ideas:[]}]};
   await page.route('**/api/markets',r=>r.fulfill({json:fixture}));await page.reload();await page.locator('#marketsRows tr[data-asset=Si]').waitFor();await page.locator('#marketsSearch').fill('нет-такого');assert.equal(await page.locator('#marketsRows tr').count(),0);await page.locator('#marketsSearch').fill('Si');assert.equal(await page.locator('#marketsRows tr').count(),1);await page.locator('#marketsGroup').selectOption('stocks');assert.equal(await page.locator('#marketsRows tr').count(),0);await page.locator('#marketsGroup').selectOption('all');
   await page.locator('#marketsRows tr').focus();await page.keyboard.press('Enter');await page.locator('#marketsDetail').waitFor();const text=await page.locator('#marketsDetail').innerText();assert.match(text,/Физлица/);assert.match(text,/Юрлица/);assert.match(text,/06.11.2026/);assert.match(text,/Доли — от общего числа открытых контрактов/);assert.match(text,/устарело/);assert.match(text,/недостаточно истории/);assert.ok(positions.fiz.longShare>0&&positions.yur.shortShare>0);
  });
  await check('Рынки: ошибка источника видна, текст безопасен, интерфейс помещается в обеих темах',async()=>{
   fixture.instruments[0].name='<img src=x onerror=window.marketInjected=true>';await refresh();await page.waitForFunction(()=>document.getElementById('marketsRows').textContent.includes('<img'));assert.equal(await page.locator('#marketsRows img').count(),0);assert.equal(await page.evaluate(()=>window.marketInjected===true),false);
   await page.route('**/api/markets',r=>r.fulfill({status:503,json:{error:'Учебный отказ источника'}}),{times:1});await refresh();await page.locator('#marketsError').waitFor();assert.match(await page.locator('#marketsError').innerText(),/Учебный отказ/);assert.equal(await page.locator('#marketsRows tr').count(),1);
   for(const theme of ['dark','light']){await page.evaluate(t=>window.OrbitaTheme.apply(t),theme);for(const width of [320,390,768,1440]){await page.setViewportSize({width,height:1000});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),theme+' '+width);}}
  });
  await check('Рынки: отзыв доступа блокирует открытую страницу и прямой API',async()=>{
   await page.unroute('**/api/markets');const user=(await(await get(pro,'/api/me')).json()).user;
   const result=await admin.request.post(base+'/api/admin/subscriptions',{headers:{Origin:base},data:{userId:user.id,plan:'pro',expiresAt:null,reason:'Проверка отзыва доступа к рынкам'}});assert.equal(result.status(),200);await refresh();await page.locator('#marketsLocked').waitFor();assert.equal(await page.locator('#marketsWorkspace').isVisible(),false);await get(pro,'/api/markets',403);assert.deepEqual(errors,[]);
  });
 }finally{await Promise.all(contexts.map(c=>c.close()));}
}
