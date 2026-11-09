import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Readable} from 'node:stream';
import {selectFrontContracts,normalizeQuote,normalizeHistory,normalizeOpenPositions,positionMetrics,freshness,openInterestFromIss,issTable,moscowDate} from '../lib/markets/model.mjs';
import {createMarkets,marketsConfiguration,validateMarketsDatabase} from '../lib/markets/service.mjs';
import {showcaseResult} from '../lib/showcase.mjs';

const fixture=async name=>JSON.parse(await readFile(new URL('../fixtures/moex/'+name,import.meta.url),'utf8'));
// Captured from MOEX ISS on Sunday 2026-11-08 (weekend session of the 09.11 clearing day).
const SUNDAY=Date.parse('2026-11-08T12:00:00+03:00');

test('front contract is the live contract with the largest open interest; ISS OPENPOSITION counts both sides',async()=>{
 const forts=await fixture('forts.json'),contracts=selectFrontContracts(forts,['Si','BR','IMOEX'],{today:'2026-11-08'});
 assert.equal(contracts.Si.secid,'SiZ6');assert.equal(contracts.Si.expiry,'2026-12-17');assert.equal(contracts.IMOEX.secid,'IMOEXF');
 const quote=normalizeQuote(contracts.Si,{receivedAt:new Date(SUNDAY).toISOString(),delayMinutes:15});
 assert.equal(quote.tradeDate,'2026-11-08');assert.equal(quote.sessionDate,'2026-11-09');assert.equal(quote.delayMinutes,15);
 assert.ok(quote.quoteTime<=quote.providerTime,'trade time precedes the ISS publication time');
 assert.equal(openInterestFromIss(9913346),4956673);assert.equal(openInterestFromIss(3),null);
 assert.equal(Object.keys(selectFrontContracts(forts,['Si'],{today:'2029-01-01'})).length,0,'expired contracts are never selected');
});

test('completed sessions come from exchange history: the 04.11 holiday and the weekend are absent, T−1 on Sunday is Friday',async()=>{
 const rows=normalizeHistory(await fixture('hist.json'),'SiZ6');
 assert.ok(!rows.some(row=>row.date==='2026-11-04'));assert.equal(rows.at(-1).date,'2026-11-06');
 const state=freshness({kind:'daily',providerDate:rows.at(-1).date,lastSuccess:new Date(SUNDAY).toISOString(),now:SUNDAY});
 assert.equal(state.state,'previous-session','Friday data on Sunday is the last session, not "today" and not stale');
 assert.equal(freshness({kind:'daily',providerDate:'2026-10-20',lastSuccess:new Date(SUNDAY).toISOString(),now:SUNDAY}).state,'stale');
 assert.equal(freshness({kind:'daily',providerDate:'2026-11-06',lastSuccess:'2026-11-01T00:00:00Z',now:SUNDAY}).state,'stale','a broken sync marks old data stale');
 assert.equal(freshness({kind:'quote',providerTime:new Date(SUNDAY-20*60000).toISOString(),now:SUNDAY}).state,'delayed');
 assert.equal(freshness({kind:'quote',providerTime:new Date(SUNDAY-5*3600000).toISOString(),now:SUNDAY}).state,'stale');
 assert.equal(moscowDate(Date.parse('2026-11-08T22:30:00Z')),'2026-11-09','dates are computed in Moscow time');
});

test('open positions by participant group are balanced and shares are shares of contracts',async()=>{
 const snapshot=normalizeOpenPositions(await fixture('op_si.json'),'Si');
 assert.equal(snapshot.date,'2026-11-06');assert.equal(snapshot.openInterest,4956673);assert.equal(snapshot.balanced,true);
 assert.equal(snapshot.fiz.personsLong,11775);assert.equal(snapshot.yur.short,4831982);
 const previous={...snapshot,date:'2026-11-05',openInterest:4989695,fiz:{...snapshot.fiz,long:1412524,short:158915},yur:{...snapshot.yur,long:3577143,short:4830752}};
 const metrics=positionMetrics(snapshot,previous);
 assert.equal(metrics.fiz.net,1393873-124691);assert.equal(metrics.fiz.net,-metrics.yur.net,'net positions of the two groups offset each other');
 assert.ok(Math.abs(metrics.fiz.longShare+metrics.yur.longShare-100)<1e-9);assert.equal(metrics.change.openInterest,4956673-4989695);
 assert.equal(normalizeOpenPositions({open_positions:{columns:['tradedate','asset','is_fiz'],data:[]}},'Si'),null,'non-trading dates return no snapshot');
 assert.throws(()=>issTable({futoi:{columns:['ERROR_MESSAGE'],data:[["Free users can't receive data for the last 14 days"]]}},'futoi'),{code:'ISS_PROVIDER_ERROR'});
});

function fakeIss({fail=new Set(),calls=[]}={}){
 return async url=>{
  calls.push(url);const u=new URL(url);
  for(const pattern of fail)if(u.pathname.includes(pattern))throw Object.assign(Error('down'),{code:'RADAR_PROVIDER_NETWORK'});
  if(u.pathname.endsWith('/forts/securities.json'))return {body:await readFile(new URL('../fixtures/moex/forts.json',import.meta.url),'utf8')};
  if(u.pathname.includes('/history/'))return {body:await readFile(new URL('../fixtures/moex/hist.json',import.meta.url),'utf8')};
  if(u.pathname.includes('/openpositions/')){const date=u.searchParams.get('date')||'2026-11-06',base=await fixture('op_si.json');base.open_positions.data=base.open_positions.data.map(row=>[date,...row.slice(1)]);return {body:JSON.stringify(base)};}
  throw Object.assign(Error('unexpected '+url),{code:'UNEXPECTED'});
 };
}
const accounts={checkRequest(){},identify:async()=>null};
const env={MARKETS_ASSETS:'Si',MARKETS_REQUEST_SPACING_MS:'0',MARKETS_MANUAL_COOLDOWN_SECONDS:'0'};

test('refresh pipeline stores quotes, sessions and backfilled positions without duplicates',async t=>{
 const directory=await mkdtemp(path.join(tmpdir(),'orbita-markets-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const calls=[],markets=await createMarkets(directory,{accounts,env,now:()=>SUNDAY,requestImpl:fakeIss({calls}),sleep:async()=>{}});
 for(const kind of ['quotes','daily','positions'])assert.equal((await markets.run(kind)).ok,true);
 const first=await markets.read();assert.equal(validateMarketsDatabase(first),true);
 const si=first.instruments.Si;assert.equal(si.daily.at(-1).date,'2026-11-06');assert.ok(si.positions.length>=10);
 assert.equal(new Set(si.positions.map(row=>row.date)).size,si.positions.length);
 const before=calls.length;await markets.run('positions');const second=(await markets.read()).instruments.Si;
 assert.equal(second.positions.length,si.positions.length,'re-running adds no duplicate snapshots');
 assert.equal(calls.length-before,1,'backfill is not repeated: only the latest snapshot is requested');
 assert.ok(calls.every(url=>url.startsWith('https://iss.moex.com/iss/')),'only the fixed official host is called');
 const price=await markets.priceFor('futures','SiZ6');assert.equal(price.source,'MOEX ISS');assert.equal(price.delayMinutes,15);
 assert.equal(await markets.priceFor('stocks','SBER'),null,'no verified stock price — no result');
 await markets.close();
});

test('transient errors are retried, persistent failures keep the last valid data and are logged for admins',async t=>{
 const directory=await mkdtemp(path.join(tmpdir(),'orbita-markets-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 let attempts=0;const flaky=fakeIss();
 const markets=await createMarkets(directory,{accounts,env,now:()=>SUNDAY,sleep:async()=>{},requestImpl:async url=>{if(++attempts<3)throw Object.assign(Error('reset'),{code:'RADAR_PROVIDER_NETWORK'});return flaky(url);}});
 assert.equal((await markets.run('quotes')).ok,true);assert.equal(attempts,3);await markets.close();
 const broken=await createMarkets(directory,{accounts,env,now:()=>SUNDAY+3600000,sleep:async()=>{},requestImpl:fakeIss({fail:new Set(['/forts/securities.json'])})});
 const result=await broken.run('quotes');assert.equal(result.ok,false);
 const db=await broken.read();assert.equal(db.instruments.Si.quote.last>0,true,'last valid value is kept');
 assert.match(db.sources.quotes.lastError,/RADAR_PROVIDER_NETWORK/);assert.equal(db.runs[0].ok,false);
 await broken.close();
});

test('markets API: members only, admin diagnostics, manual refresh is guarded; production stays off until licensing is confirmed',async t=>{
 const directory=await mkdtemp(path.join(tmpdir(),'orbita-markets-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const markets=await createMarkets(directory,{accounts:{checkRequest(){},identify:async()=>admin},env,now:()=>SUNDAY,sleep:async()=>{},requestImpl:fakeIss()});
 const admin={id:'admin-1',role:'admin'},pro={id:'u1',role:'member',subscriptions:[{plan:'pro',expiresAt:'2030-01-01T00:00:00Z'}]},free={id:'u2',role:'member',subscriptions:[]};
 async function call(pathname,user,method='GET',body){
  let status,payload;const res={headersSent:false,writeHead(code){status=code;return this;},end(data){payload=data?JSON.parse(data):null;}};
  const req=Object.assign(Readable.from(body?[Buffer.from(JSON.stringify(body))]:[]),{method,headers:{'content-type':'application/json'},url:pathname});
  await markets.handle(req,res,new URL('http://localhost'+pathname),user);return {status,payload};
 }
 assert.equal((await call('/api/markets',null)).status,401);assert.equal((await call('/api/markets',free)).status,403);
 assert.equal((await call('/api/admin/markets',pro)).status,403);
 const feed=await call('/api/markets',pro);assert.equal(feed.status,200);assert.equal(feed.payload.source,'MOEX ISS');assert.equal(feed.payload.delayMinutes,15);
 const diag=await call('/api/admin/markets',admin);assert.equal(diag.status,200);assert.equal(diag.payload.sources.quotes.status,'waiting');
 assert.equal((await call('/api/admin/markets/refresh',admin,'POST',{kind:'bogus'})).status,400);
 await markets.close();
 const config=marketsConfiguration({ORBITA_PUBLIC_ORIGIN:'https://orbita.example'});assert.equal(config.mode,'off');assert.equal(config.blockedByLicense,true);
 assert.equal(marketsConfiguration({ORBITA_PUBLIC_ORIGIN:'https://orbita.example',MARKETS_LICENSE_CONFIRMED:'true'}).mode,'moex');
 assert.throws(()=>marketsConfiguration({MARKETS_ASSETS:'Si,../x'}));
});

test('public showcase result uses the documented direction-aware formula',()=>{
 assert.equal(showcaseResult({dir:'ЛОНГ',entry:100,price:105}),5);assert.equal(showcaseResult({dir:'ШОРТ',entry:100,price:105}),-5);
 assert.equal(showcaseResult({dir:'ЛОНГ',entry:null,price:105}),null);
});

test('crowd extreme: z-score of individuals’ net position against the previous 20 sessions',async()=>{
 const {sentiment,normalizeStockQuotes}=await import('../lib/markets/model.mjs');
 const rows=Array.from({length:21},(_,i)=>({date:'2026-10-'+String(i+1).padStart(2,'0'),fizNet:i===20?1000:1000+(i%2?50:-50)}));
 assert.equal(sentiment(rows).level,'normal');
 rows[20].fizNet=1400;const extreme=sentiment(rows);assert.equal(extreme.level,'extreme');assert.equal(extreme.direction,'long');assert.ok(extreme.z>=2);
 assert.equal(sentiment(rows.slice(0,5)),null,'too little history — no claim');
 const quotes=normalizeStockQuotes(await fixture('tqbr.json'),{receivedAt:'2026-11-08T12:17:00Z',delayMinutes:15});
 assert.equal(quotes.SBER.last,294.35);assert.equal(quotes.SBER.quoteTime,'2026-11-08T12:28:22.000Z');assert.equal(quotes.GAZP.lotSize,10);assert.equal(quotes.SBER.lotSize,1);assert.equal(quotes.SBER.board,'TQBR');
});
