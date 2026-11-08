import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const context={};context.window=context;vm.createContext(context);
for(const file of ['calculator-engine.js'])vm.runInContext(await readFile(new URL('../public/assets/'+file,import.meta.url),'utf8'),context);
const E=context.OrbitaCalculator,records=JSON.parse(await readFile(new URL('../fixtures/demo-ideas.json',import.meta.url),'utf8'));
const options={capital:100000,allocation:10,fee:0,start:'2026-01-01',end:'2026-12-31',strategy:'Orbita Exclusive',dataMode:'demo'};
test('Exclusive history includes profit and loss, while open ideas stay outside realised results',()=>{
 const r=E.calculate(records,options);assert.equal(r.executed,2);assert.equal(r.open,1);assert.equal(r.wins,1);assert.ok(r.rows.every(row=>row.demo));assert.ok(r.rows.some(row=>row.net<0));assert.ok(r.rows.some(row=>row.net>0));
});
test('erroneous published trades remain archived but leave performance calculations',()=>{
 const copy=structuredClone(records),closed=copy.find(r=>r.id==='exclusive-gmkn');closed.erroneous=true;
 const r=E.calculate(copy,options);assert.equal(r.executed,1);assert.equal(E.normalize(closed),null);assert.ok(copy.includes(closed));
});
test('short result respects direction rather than treating a price decline as a loss',()=>{
 const record=structuredClone(records.find(r=>r.id==='exclusive-gmkn'));record.d.dir='ШОРТ';record.meta.exit=record.d.entry*.95;
 assert.ok(Math.abs(E.normalize(record).change-.05)<1e-10);
});
test('precise event times preserve sequential capital reuse inside the same displayed minute',()=>{
 const make=(id,entrySecond,exitSecond,exit)=>({id,published:true,d:{ticker:id,strategy:'Precision',market:'stocks',dir:'ЛОНГ',entry:100,state:'closed'},meta:{published:'20.10.2026 · 13:00',publishedAt:'2026-10-20T10:00:00.000Z',exit,events:[['20.10.2026 · 13:00','Вход подтверждён','',{at:`2026-10-20T10:00:${entrySecond}.000Z`}],['20.10.2026 · 13:00','Закрыто вручную','',{at:`2026-10-20T10:00:${exitSecond}.000Z`}]]}});
 const rows=[make('A','10','20',110),make('B','30','40',120)];
 const result=E.calculate(rows,{...options,capital:1000,allocation:100,strategy:'all',dataMode:'published'});
 assert.equal(result.executed,2);assert.equal(result.skipped,0);assert.ok(Math.abs(result.final-1320)<1e-8);assert.equal(E.normalize(rows[0]).entered,Date.parse('2026-10-20T10:00:10.000Z'));
});
test('invalid authoritative event timestamps are excluded instead of guessed from display text',()=>{
 const record=structuredClone(records.find(row=>row.id==='exclusive-gmkn'));record.meta.enteredAt='invalid-iso-time';
 assert.equal(E.normalize(record).valid,false);
});
test('unrepresentable historical changes and portfolio arithmetic cannot produce infinite output',()=>{
 const record=structuredClone(records.find(row=>row.id==='exclusive-gmkn'));record.d.entry=1e-308;record.meta.exit=1e12;
 assert.equal(E.normalize(record).valid,false);
 record.d.entry=1e-296;
 assert.equal(E.normalize(record).valid,true);
 assert.throws(()=>E.calculate([record],{...options,allocation:100}),/Числовой диапазон/);
});
const dated=(id,{entry=100,exit=110,dir='ЛОНГ',entered='2026-10-20T10:00:10Z',exited='2026-10-20T11:00:00Z',published='2026-10-20T10:00:00Z'}={})=>({id,published:true,d:{ticker:id,strategy:'Verified',market:'stocks',dir,entry,state:'closed'},meta:{publishedAt:published,enteredAt:entered,closedAt:exited,exit,events:[['20.10.2026 · 13:00','Вход подтверждён','',{at:entered,after:{entry}}],['20.10.2026 · 14:00','Закрыто вручную','',{at:exited,after:{exit}}]]}});
const realOptions={...options,strategy:'all',dataMode:'published'};
test('published and demonstration history never share one performance series',()=>{
 const live=dated('live'),demo={...dated('demo-synthetic'),demo:true};
 const published=E.calculate([...records,live,demo],{...realOptions});assert.equal(published.executed,1);assert.ok(published.excludedDemo>0);assert.ok(published.rows.every(row=>!row.demo));
 const synthetic=E.calculate([live,demo],{...realOptions,dataMode:'demo'});assert.equal(synthetic.executed,1);assert.ok(synthetic.rows.every(row=>row.demo));
 assert.equal(E.calculate(records,{...options,dataMode:undefined}).executed,0);
});
test('publication and level availability must precede entry; recorded prices cannot change retroactively',()=>{
 assert.equal(E.normalize(dated('before',{entered:'2026-10-20T09:59:59Z'})).valid,false);
 const noPublication=dated('unknown');noPublication.meta.publishedAt='not-a-date';assert.equal(E.normalize(noPublication).valid,false);
 const lateLevels=dated('late-levels');lateLevels.meta.levelsPublishedAt='2026-10-20T10:00:11Z';assert.equal(E.normalize(lateLevels).valid,false);
 const rewritten=dated('rewritten');rewritten.d.entry=90;assert.equal(E.normalize(rewritten).valid,false);
 const rewrittenExit=dated('rewritten-exit');rewrittenExit.meta.exit=120;assert.equal(E.normalize(rewrittenExit).valid,false);
 assert.equal(E.normalize(dated('coherent')).valid,true);
});
test('fees and adverse slippage are charged on both sides of long and short positions',()=>{
 for(const dir of ['ЛОНГ','ШОРТ']){
  const trade=dated('costs',{dir,exit:dir==='ЛОНГ'?110:90}),result=E.calculate([trade],{...realOptions,capital:1000,allocation:100,fee:1,slippage:1}),row=result.rows[0],sign=dir==='ЛОНГ'?1:-1;
  const amount=1000/1.01,entry=100*(1+sign*.01),exit=trade.meta.exit*(1-sign*.01),exitFee=amount*exit/entry*.01,net=amount*(exit/entry-1)*sign-amount*.01-exitFee;
  assert.ok(Math.abs(row.net-net)<1e-9);assert.ok(Math.abs(result.final-(1000+net))<1e-9);assert.ok(row.net<E.calculate([trade],{...realOptions,capital:1000,allocation:100,fee:1}).rows[0].net);
 }
});
test('statistics use net outcomes and a realized equity drawdown; no-trade and no-loss PF are explicit',()=>{
 const trades=[dated('gain',{exit:110}),dated('loss',{exit:80,entered:'2026-10-21T10:00:10Z',exited:'2026-10-21T11:00:00Z'}),dated('flat',{exit:100,entered:'2026-10-22T10:00:10Z',exited:'2026-10-22T11:00:00Z'})];
 const result=E.calculate(trades,{...realOptions,capital:1000,allocation:100,compound:false});
 assert.equal(result.executed,2); // loss leaves less than the fixed 100% budget for the third trade
 assert.equal(result.skipped,1);assert.equal(result.wins,1);assert.equal(result.losses,1);assert.equal(result.winRate,50);assert.ok(Math.abs(result.profitFactor-.5)<1e-9);assert.ok(Math.abs(result.maxDrawdownPercent-200/1100*100)<1e-9);assert.ok(Math.abs(result.averageReturnPercent+5)<1e-9);
 const winner=E.calculate(trades.slice(0,1),realOptions);assert.equal(winner.profitFactor,null);assert.equal(winner.profitFactorStatus,'no-losses');
 const empty=E.calculate([],realOptions);assert.equal(empty.winRate,null);assert.equal(empty.profitFactorStatus,'no-trades');assert.equal(empty.averageReturnPercent,null);
});
test('overlapping trades reserve capital, duplicate IDs are rejected and exact simultaneous close frees cash',()=>{
 const a=dated('a'),b=dated('b',{entered:'2026-10-20T10:00:11Z'}),c=dated('c',{entered:'2026-10-20T11:00:00Z',exited:'2026-10-20T12:00:00Z'});
 const result=E.calculate([a,b,c],{...realOptions,capital:1000,allocation:100});assert.equal(result.executed,2);assert.equal(result.skipped,1);assert.ok(Math.abs(result.final-1210)<1e-8);
 assert.throws(()=>E.calculate([a,a],realOptions),/идентификатор/);
});
