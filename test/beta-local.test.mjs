import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,readFile,readdir,rm,writeFile,lstat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:net';
import {localBetaEnvironment,startLocalBeta} from '../scripts/beta-local.mjs';
import {createIdeas} from '../lib/ideas.mjs';
import {createAccounts} from '../lib/accounts.mjs';
import {importDemoHistory,loadDemoHistoryFixture,rollbackDemoHistory} from '../lib/demo-history.mjs';

const project=fileURLToPath(new URL('../',import.meta.url));
const script=path.join(project,'scripts/beta-local.mjs');
const marketFixturePath=path.join(project,'fixtures','local-market-history.json');
async function login(session,role){
  const account=session.accounts.find(value=>value.role===role),response=await fetch(session.base+'/api/login',{method:'POST',headers:{Origin:session.base,'Content-Type':'application/json'},body:JSON.stringify({email:account.email,password:account.password})});
  assert.equal(response.status,200);return {user:(await response.json()).user,cookie:response.headers.get('set-cookie')?.split(';')[0]};
}
async function get(session,route,cookie){const response=await fetch(session.base+route,{redirect:'manual',headers:cookie?{Cookie:cookie}:{}});return {status:response.status,data:response.headers.get('content-type')?.includes('application/json')?await response.json():null};}

test('local beta isolates provider settings, owns temporary data and exposes four genuine roles',async()=>{
  const guard=await mkdtemp(path.join(tmpdir(),'orbita-beta-guard-')),operatorData=path.join(guard,'operator-data'),operatorBackups=path.join(guard,'operator-backups');
  await mkdir(operatorData);await mkdir(operatorBackups);await writeFile(path.join(operatorData,'accounts.json'),'OPERATOR DATA MUST REMAIN UNTOUCHED');await writeFile(path.join(operatorBackups,'keep.txt'),'PRESERVE');
  let session;
  try{
    const source={...process.env,HOST:'0.0.0.0',PORT:'3000',ORBITA_DATA_DIR:operatorData,ORBITA_PUBLIC_ORIGIN:'https://external.example',ORBITA_REQUIRE_ADMIN_MFA:'true',CLOUDPAYMENTS_PUBLIC_ID:'operator-merchant',CLOUDPAYMENTS_API_SECRET:'operator-secret',RESEND_API_KEY:'operator-mail-key',ORBITA_MAIL_FROM:'operator@example.test',TELEGRAM_BOT_TOKEN:'operator-bot',ORBITA_BACKUP_DIR:operatorBackups,ORBITA_BACKUP_PASSPHRASE:'operator-passphrase',NODE_OPTIONS:'--not-a-real-option'};
    const environment=localBetaEnvironment('/private/test-only',source);assert.equal(environment.HOST,'127.0.0.1');assert.equal(environment.PORT,'0');assert.equal(environment.ORBITA_DATA_DIR,'/private/test-only');assert.equal(environment.CLOUDPAYMENTS_API_SECRET,'');assert.equal(environment.RESEND_API_KEY,'');assert.equal(environment.ORBITA_BACKUP_DIR,'');assert.equal(environment.NODE_OPTIONS,undefined);assert.equal(environment.MARKETS_MODE,'off');assert.equal(environment.ORBITA_PUSH_ENABLED,'false');
    session=await startLocalBeta({environment:source});assert.match(session.base,/^http:\/\/127\.0\.0\.1:\d+$/);assert.notEqual(session.directory,operatorData);assert.equal(session.accounts.length,4);
    if(process.platform!=='win32')assert.equal((await lstat(session.root)).mode&0o077,0);
    assert.ok(session.accounts.every(account=>account.password.length>=20));assert.equal(new Set(session.accounts.map(account=>account.email)).size,4);
    const admin=await login(session,'admin'),pro=await login(session,'pro'),exclusive=await login(session,'exclusive'),free=await login(session,'free');
    assert.equal(admin.user.role,'admin');assert.deepEqual(pro.user.access.activePlans,['pro']);assert.deepEqual(exclusive.user.access.activePlans,['exclusive']);assert.equal(free.user.access.hasSubscription,false);
    assert.equal((await get(session,'/api/admin/ideas',admin.cookie)).status,200);assert.equal((await get(session,'/api/admin/ideas',pro.cookie)).status,403);assert.equal((await get(session,'/api/ideas',free.cookie)).status,403);assert.equal((await get(session,'/api/ideas')).status,401);
    const proFeed=(await get(session,'/api/ideas',pro.cookie)).data,proIdeas=proFeed.records,exclusiveIdeas=(await get(session,'/api/ideas',exclusive.cookie)).data.records;
    assert.equal(proFeed.localMarketHistory,false);
    assert.ok(proIdeas.length>0&&proIdeas.every(record=>record.demo===true&&record.d.strategy!=='Orbita Exclusive'));assert.ok(exclusiveIdeas.length>proIdeas.length&&exclusiveIdeas.every(record=>record.demo===true)&&exclusiveIdeas.some(record=>record.d.strategy==='Orbita Exclusive'),'EXCLUSIVE includes PRO');
    const config=(await get(session,'/api/public-config')).data;assert.equal(config.paymentsAvailable,false);assert.equal(config.mailEnabled,false);assert.equal(config.telegramEnabled,false);
    const radar=(await get(session,'/api/radar?importance=0&limit=50',pro.cookie)).data;assert.ok(radar.events.length>=15);assert.ok(radar.events.every(event=>event.isDemo&&!Object.hasOwn(event,'rawText')));assert.equal((await get(session,'/api/radar',free.cookie)).status,403);assert.equal((await get(session,'/api/radar',exclusive.cookie)).status,200,'EXCLUSIVE includes PRO Radar');
    const settings=(await get(session,'/api/product-settings')).data;assert.equal(settings.supportEmail,'');assert.ok(settings.partnerOffers.every(offer=>offer.url===''));
    assert.equal(await readFile(path.join(operatorData,'accounts.json'),'utf8'),'OPERATOR DATA MUST REMAIN UNTOUCHED');assert.equal(await readFile(path.join(operatorBackups,'keep.txt'),'utf8'),'PRESERVE');
    const firstRoot=session.root,firstPassword=session.accounts[0].password;await session.close();await assert.rejects(lstat(firstRoot),{code:'ENOENT'});
    session=await startLocalBeta({environment:source});assert.notEqual(session.root,firstRoot);assert.notEqual(session.accounts[0].password,firstPassword);
  }finally{await session?.close();await rm(guard,{recursive:true,force:true});}
});

test('local beta rejects an already cancelled startup without making a temporary fixture',async()=>{
  const controller=new AbortController();controller.abort();await assert.rejects(startLocalBeta({signal:controller.signal}),error=>error.name==='AbortError');
});

test('cancelling preparation waits for its child and removes the incomplete fixture',async()=>{
  const prefix=`orbita-local-beta-${process.pid}-`,before=new Set((await readdir(tmpdir())).filter(name=>name.startsWith(prefix))),controller=new AbortController();
  const pending=startLocalBeta({signal:controller.signal}),timer=setTimeout(()=>controller.abort(),20);
  try{await assert.rejects(pending);}finally{clearTimeout(timer);}
  const remaining=(await readdir(tmpdir())).filter(name=>name.startsWith(prefix)&&!before.has(name));assert.deepEqual(remaining,[]);
});

test('CLI interruption stops its child and removes only its owned fixture',async()=>{
  const child=spawn(process.execPath,[script],{cwd:project,env:{PATH:process.env.PATH},stdio:['ignore','pipe','pipe']});let output='';const done=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
  try{
    await new Promise((resolve,reject)=>{let settled=false;const timer=setTimeout(()=>{if(!settled){settled=true;reject(Error('Local beta CLI did not become ready.'));}},15000);child.stdout.on('data',chunk=>{output=(output+chunk).slice(-16000);if(!settled&&output.includes('Ctrl+C остановит')){settled=true;clearTimeout(timer);resolve();}});child.stderr.on('data',()=>{});child.once('exit',()=>{if(!settled){settled=true;clearTimeout(timer);reject(Error('Local beta CLI exited before readiness.'));}});});
    assert.ok(output.includes('ЛОКАЛЬНАЯ УЧЕБНАЯ БЕТА'));const names=(await readdir(tmpdir())).filter(name=>name.startsWith(`orbita-local-beta-${child.pid}-`));assert.equal(names.length,1);const root=path.join(tmpdir(),names[0]);
    const address=new URL(output.match(/^Адрес: (\S+)$/m)[1]);
    assert.equal(address.searchParams.get('next'),'/strategies.html?view=history&type=demo');
    const [,email,password]=output.match(/^Клиент Exclusive: (\S+) \| (\S+)$/m);
    const session={base:address.origin,accounts:[{role:'exclusive',email,password}]};
    const {cookie}=await login(session,'exclusive');
    const feed=(await get(session,'/api/ideas',cookie)).data;
    assert.equal(feed.demoHistory,true);
    assert.equal(feed.records.filter(record=>record.demoHistory&&record.tier==='pro').length,150);
    assert.equal(feed.records.filter(record=>record.demoHistory&&record.tier==='exclusive').length,20);
    child.kill('SIGTERM');let timer;const result=await Promise.race([done,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Local beta CLI did not shut down.')),15000);})]).finally(()=>clearTimeout(timer));assert.equal(result.code,0);await assert.rejects(lstat(root),{code:'ENOENT'});
  }finally{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await done;}}
});

test('CLI accepts help and never accepts a supplied data path',async()=>{
  const run=args=>new Promise((resolve,reject)=>{const child=spawn(process.execPath,[script,...args],{cwd:project,env:{PATH:process.env.PATH},stdio:['ignore','pipe','pipe']});let stdout='';child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',()=>{});child.once('error',reject);child.once('exit',code=>resolve({code,stdout}));});
  const help=await run(['--help']);assert.equal(help.code,0);assert.match(help.stdout,/Usage: npm run beta:local/);
  const invalid=await run(['--data-dir','/must-not-be-used']);assert.equal(invalid.code,2);assert.equal(invalid.stdout,'');
});

test('local fixed-port startup rejects invalid ports and leaves an occupied listener untouched',async()=>{
 for(const port of [-1,65536,1.5,'3000'])await assert.rejects(startLocalBeta({port}),/Порт/);
 const listener=createServer();await new Promise((resolve,reject)=>{listener.once('error',reject);listener.listen(0,'127.0.0.1',resolve);});
 try{const port=listener.address().port;await assert.rejects(startLocalBeta({port}),cause=>cause.code==='LOCAL_PORT_IN_USE'&&cause.message.includes(String(port)));assert.equal(listener.listening,true);}
 finally{await new Promise(resolve=>listener.close(resolve));}
});

test('interactive local fixture can bypass nonexistent test email delivery without enabling real providers',async()=>{
 const session=await startLocalBeta({verifyFixtureEmails:true});try{
  for(const role of ['admin','pro','exclusive','free'])assert.equal((await login(session,role)).user.emailVerified,true);
  const config=(await get(session,'/api/public-config')).data;assert.equal(config.paymentsAvailable,false);assert.equal(config.mailEnabled,false);assert.equal(config.telegramEnabled,false);
 }finally{await session.close();}
});

test('local MOEX history preserves source prices and remains separate from public results',async()=>{
 const session=await startLocalBeta({marketHistory:true});
 try{
  const fixture=JSON.parse(await readFile(marketFixturePath,'utf8'));
  const local=await get(session,'/api/local/market-history');
  assert.equal(local.status,200);
  const rows=local.data.results;
  assert.equal(rows.length,fixture.trades.length);
  assert.ok(rows.length>=500);
  assert.equal(local.data.requestedFrom,'2026-03-01');
  assert.equal(local.data.asOfDate,'2026-11-21');
  assert.deepEqual(local.data.latestQuotes,fixture.latestQuotes);
  assert.ok(fixture.latestQuotes.length>=4);
  for(const quote of fixture.latestQuotes){
   assert.ok(Number.isFinite(quote.price)&&quote.price>0);
   assert.ok(quote.at.startsWith(fixture.asOfDate+'T'));
   const source=new URL(quote.sourceUrl);
   assert.equal(source.origin,'https://iss.moex.com');
   assert.ok(source.pathname.endsWith('/'+quote.ticker+'/candles.json'));
   assert.equal(source.searchParams.get('from'),fixture.asOfDate);
   assert.equal(source.searchParams.get('till'),fixture.asOfDate);
  }
  assert.ok(rows.some(row=>row.pct>0)&&rows.some(row=>row.pct<0));
  assert.ok(rows.some(row=>row.market==='stocks')&&rows.some(row=>row.market==='futures'));
  const byId=new Map(rows.map(row=>[row.id,row]));
  const days=new Map();
  for(const trade of fixture.trades){
   const first=trade.bars[0], last=trade.bars.at(-1), date=first[0].slice(0,10);
   const row=byId.get('demo-moex-'+date.replaceAll('-','')+'-'+trade.ticker);
   assert.equal(row.state,'closed');
   assert.equal(row.tier,'pro');
   assert.equal(row.initial.entry,first[2]);
   assert.equal(row.exit,last[3]);
   assert.equal(row.enteredAt,new Date(first[0]).toISOString());
   assert.equal(row.closedAt,new Date(last[1]).toISOString());
   assert.ok(Math.abs(row.pct)>=1&&Math.abs(row.pct)<=5);
   const source=new URL(row.sourceUrl);
   assert.equal(source.origin,'https://iss.moex.com');
   assert.equal(source.searchParams.get('from'),date);
   assert.equal(source.searchParams.get('till'),date);
   days.set(date,(days.get(date)||0)+1);
  }
  const dates=[...days.keys()].sort();
  assert.ok(dates[0].startsWith('2026-03'));
  assert.equal(local.data.fromDate,dates[0]);
  assert.equal(local.data.throughDate,dates.at(-1));
  const average=rows.length/days.size;
  assert.ok(average>=2&&average<=3);
  assert.ok([...days.values()].every(n=>[1,2,3,7,10].includes(n)));
  assert.ok([...days.values()].includes(7)&&[...days.values()].includes(10));
  assert.deepEqual((await get(session,'/api/public/results')).data.results,[]);
  assert.equal((await get(session,'/api/public/stats')).data.stats.pro.closed,0);
  const {cookie}=await login(session,'pro');
  const pro=await get(session,'/api/ideas',cookie);
  assert.equal(pro.data.localMarketHistory,true);
  assert.equal(pro.data.demoHistory,true);
  assert.equal(pro.data.records.length,150);
  assert.ok(pro.data.records.every(record=>record.demoHistory&&record.demo&&record.tier==='pro'&&record.d.state==='closed'));
  const exclusive=await login(session,'exclusive');
  const exclusiveFeed=(await get(session,'/api/ideas',exclusive.cookie)).data;
  assert.equal(exclusiveFeed.records.length,170);
  const exclusiveRows=exclusiveFeed.records.filter(record=>record.tier==='exclusive');
  assert.equal(exclusiveRows.length,20);
  assert.equal(pro.data.records.filter(record=>record.d.market==='stocks').length,108);
  assert.equal(exclusiveRows.filter(record=>record.d.market==='stocks').length,18);
  assert.ok(pro.data.records.filter(record=>record.d.market==='stocks'&&record.d.dir==='ШОРТ').length>=40);
  assert.ok(exclusiveRows.every(record=>{
   const pct=(record.meta.exit/record.d.entry-1)*(record.d.dir==='ШОРТ'?-100:100);
   return pct>=12&&pct<=16||pct>=-7&&pct<0;
  }));
  assert.ok(exclusiveRows.every(record=>record.d.candles.length>1&&Object.keys(record.d.analysis).length===6));
  assert.equal((await get(session,'/api/ideas/'+exclusiveRows[0].id,cookie)).status,404);
  assert.equal((await get(session,'/api/ideas/'+exclusiveRows[0].id,exclusive.cookie)).status,200);
  assert.equal((await get(session,'/api/history/statistics?tier=exclusive&type=demo',cookie)).status,403);
  assert.equal((await get(session,'/api/history/statistics?tier=pro&type=demo')).status,401);
  for(const [tier,reader,closed,wins,losses] of [['pro',cookie,150,105,45],['exclusive',exclusive.cookie,20,14,6]]){
   const stats=(await get(session,'/api/history/statistics?tier='+tier+'&type=demo',reader)).data;
   assert.deepEqual([stats.closedTrades,stats.wins,stats.losses,stats.winRate],[closed,wins,losses,70]);
   assert.equal(stats.totalReturnPercent.toFixed(2),tier==='exclusive'?'15.00':'11.00');
   assert.ok(stats.totalReturnPercent>0&&stats.profitFactor>1&&stats.maxDrawdownPercent>0);
   assert.ok(stats.averageWinPercent>0&&stats.averageLossPercent<0);
   assert.equal(stats.capital.length,closed+1);
   assert.equal(stats.monthly.length,9);
   assert.equal(stats.monthly.reduce((n,month)=>n+month.closedTrades,0),closed);
   assert.ok(Math.abs(stats.monthly.reduce((sum,month)=>sum+month.returnPercent,0)-stats.totalReturnPercent)<1e-8);
   assert.equal((await get(session,'/api/history/statistics?tier='+tier+'&type=actual',reader)).data.closedTrades,0);
  }
  for(const market of ['stocks','futures','crypto']){
   const count=pro.data.records.filter(record=>record.d.market===market).length;
   assert.ok(count>0);
   assert.equal((await get(session,'/api/history/statistics?tier=pro&type=demo&market='+market,cookie)).data.closedTrades,count);
  }
  const id=rows[0].id;
  assert.equal((await get(session,'/api/ideas/'+id,cookie)).data.record.id,id);
  const admin=await login(session,'admin');
  assert.deepEqual((await get(session,'/api/admin/ideas',admin.cookie)).data.records,[]);
  await assert.rejects(lstat(path.join(session.directory,'ideas.json')),{code:'ENOENT'});
  const normal=await createIdeas(session.directory);
  assert.deepEqual((await normal.list(admin.user)).records,[]);
  await assert.rejects(normal.get(id,admin.user),{status:404});
 }finally{await session.close();}
});

test('ordinary npm start and production serve the bundled archive to an existing administrator without importing it',async t=>{
 const directory=await mkdtemp(path.join(tmpdir(),'orbita-start-history-'));
 t.after(()=>rm(directory,{recursive:true,force:true}));
 const account={role:'admin',email:'owner@example.test',password:'Local-owner-password-2026'};
 const accounts=await createAccounts(directory);
 const owner=await accounts.createAdmin(account.email,account.password);
 const ideas=await createIdeas(directory);
 const draft=(await ideas.create({id:owner.id,role:'admin'},{mode:'draft',d:{ticker:'KEEP'}})).record;
 const store=path.join(directory,'ideas.json'),before=await readFile(store,'utf8');
 const {scripts}=JSON.parse(await readFile(path.join(project,'package.json'),'utf8'));
 const fixture=await loadDemoHistoryFixture();
 const args=scripts.start.split(' ').slice(1);
 for(const production of [false,true]){
  const env={...localBetaEnvironment(directory),...(production?{NODE_ENV:'production'}:{})};
  const child=spawn(process.execPath,production?['server.mjs']:args,{cwd:project,env,stdio:['ignore','pipe','ignore']});
  const done=new Promise(resolve=>child.once('exit',resolve));
  try{
   const base=await new Promise((resolve,reject)=>{
    let output='';
    const timer=setTimeout(()=>reject(Error('npm start did not become ready.')),12000);
    child.stdout.on('data',chunk=>{
     output+=chunk;
     const match=output.match(/ORBITA: (http:\/\/127\.0\.0\.1:\d+)/);
     if(match){clearTimeout(timer);resolve(match[1]);}
    });
    child.once('exit',code=>{clearTimeout(timer);reject(Error('npm start exited with code '+code));});
   });
   const session={base,accounts:[account]},loginResult=await login(session,'admin'),cookie=loginResult.cookie;
   assert.equal(loginResult.user.id,owner.id);
   const feed=(await get(session,'/api/ideas',cookie)).data;
   assert.equal(feed.localMarketHistory,!production);
   assert.equal(feed.records.filter(record=>record.demoHistory).length,fixture.trades.length);
   assert.equal(feed.records.filter(record=>record.demoHistory&&record.tier==='pro').length,150);
   assert.equal((await get(session,'/api/history/statistics?tier=pro&type=demo',cookie)).data.closedTrades,150);
   const historical=feed.records.find(record=>record.demoHistory);
   assert.equal((await get(session,'/api/ideas/'+historical.id,cookie)).data.record.id,historical.id);
   await assert.rejects(lstat(path.join(directory,'demo-history.json')),{code:'ENOENT'});
   assert.deepEqual((await get(session,'/api/admin/ideas',cookie)).data.records.map(record=>record.id),[draft.id]);
   assert.equal((await get(session,'/api/local/market-history')).status,production?404:200);
   assert.deepEqual((await get(session,'/api/public/results')).data.results,[]);
   const archive=await get(session,'/api/public/history-scenarios');
   assert.equal(archive.status,200);
   assert.equal(archive.data.type,'scenarios');
   assert.equal(archive.data.open,0);
   assert.equal(archive.data.results.length,170);
   assert.match(archive.data.fromDate,/^2026-03-/);
   assert.match(archive.data.throughDate,/^2026-11-/);
   const sourceById=new Map(fixture.trades.map(trade=>[trade.id,trade]));
   for(const [index,row] of archive.data.results.entries()){
    const source=sourceById.get(row.id);
    assert.equal(row.state,'closed');
    assert.equal(row.publishedAt,null);
    assert.equal(row.enteredAt,source.openedAt);
    assert.equal(row.closedAt,source.closedAt);
    assert.equal(row.sourceUrl,source.sourceUrl);
    assert.equal(row.exit,source.exit);
    assert.deepEqual(row.initial,{entry:source.entry,stop:source.stop,target:source.target});
    assert.ok(Math.abs(row.pct-(source.exit/source.entry-1)*(source.direction==='SHORT'?-100:100))<1e-10);
    assert.ok(!index||archive.data.results[index-1].closedAt>=row.closedAt);
    for(const field of ['analysis','candles','comment','meta','closeReason'])assert.ok(!Object.hasOwn(row,field));
   }
   const forwarded=await fetch(base+'/api/ideas',{headers:{Cookie:cookie,'X-Forwarded-Host':'public.example.test'}});
   const proxied=await forwarded.json();
   assert.equal(proxied.localMarketHistory,false);
   assert.equal(proxied.demoHistory,true);
   if(production){
    const privateTrade={...fixture.trades[0],name:'Private instrument label'};
    await importDemoHistory(directory,{version:1,trades:[privateTrade,...fixture.trades.slice(1)]});
    const seeded=(await get(session,'/api/ideas',cookie)).data;
    assert.equal(seeded.records.filter(record=>record.demoHistory).length,170);
    assert.equal(seeded.records.find(record=>record.id===privateTrade.id).d.name,privateTrade.name);
    assert.deepEqual((await get(session,'/api/public/history-scenarios')).data.results,archive.data.results);
    assert.equal((await get(session,'/api/public/results')).data.results.length,0);
    await rollbackDemoHistory(directory);
    assert.equal((await get(session,'/api/ideas',cookie)).data.demoHistory,false);
   }
   assert.equal(await readFile(store,'utf8'),before);
  }finally{
   if(child.exitCode===null)child.kill('SIGTERM');
   await done;
  }
 }
});
