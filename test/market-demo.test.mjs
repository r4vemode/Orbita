import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const context=vm.createContext({});vm.runInContext(await readFile(new URL('../public/assets/market-demo-engine.js',import.meta.url),'utf8'),context);const E=context.OrbitaMarketDemo;
test('synthetic market preserves OHLC, traded volume and buyer/seller accounting in every scenario',()=>{
 for(const scenario of ['normal','volume','pressure'])for(const instrument of E.instruments){const bars=E.series(instrument,scenario);assert.equal(bars.length,60);for(const bar of bars){assert.ok(bar.low<=bar.open&&bar.low<=bar.close);assert.ok(bar.high>=bar.open&&bar.high>=bar.close);assert.equal(bar.buyVolume+bar.sellVolume,bar.volume);assert.ok(bar.low>0&&bar.volume>0);}const snapshot=E.snapshot(instrument,bars.slice(0,20));assert.equal(snapshot.price,bars[19].close);assert.equal(snapshot.volume,bars.slice(0,20).reduce((sum,bar)=>sum+bar.volume,0));assert.ok(snapshot.buyShare>=0&&snapshot.buyShare<=1);assert.ok(Math.abs(snapshot.imbalance)<=1);}
});
test('resampling does not invent future candles and preserves open, close, extrema and volume',()=>{
 const bars=E.series(E.instruments[0]).slice(0,13),aggregated=E.aggregate(bars,5);assert.equal(aggregated.length,3);assert.equal(aggregated[0].open,bars[0].open);assert.equal(aggregated.at(-1).close,bars[12].close);assert.equal(aggregated.at(-1).endMinute,12);assert.equal(aggregated.reduce((sum,b)=>sum+b.volume,0),bars.reduce((sum,b)=>sum+b.volume,0));assert.equal(aggregated[0].high,Math.max(...bars.slice(0,5).map(b=>b.high)));assert.throws(()=>E.aggregate(bars,0));
});
test('screener combines search, sector, volume and favorites with numeric ordering',()=>{
 const rows=E.instruments.map(i=>E.snapshot(i,E.series(i)));assert.equal(E.screen(rows,{search:'сбер'}).length,1);assert.equal(E.screen(rows,{search:'sBeR'})[0].ticker,'SBER');assert.equal(E.screen(rows,{favoritesOnly:true,favorites:[]}).length,0);assert.equal(E.screen(rows,{sector:'energy',favoritesOnly:true,favorites:['SBER']}).length,0);assert.ok(E.screen(rows,{unusual:true}).every(r=>r.relativeVolume>=1.5));const sorted=E.screen(rows,{sort:'change'});assert.ok(sorted.every((r,i)=>!i||r.change<=sorted[i-1].change));
});
test('draft risk uses shares per lot, respects long and short and rejects impossible stops',()=>{
 const data={direction:'long',entry:310,stop:300,target:330,lots:10,lot:10,capital:100000,current:315},long=E.risk(data);assert.equal(long.quantity,100);assert.equal(long.loss,1000);assert.equal(long.reward,2000);assert.equal(long.riskPercent,1);assert.equal(long.ratio,2);assert.equal(long.pnl,500);const short=E.risk({...data,direction:'short',stop:320,target:290,current:305});assert.equal(short.pnl,500);assert.equal(short.ratio,2);for(const patch of [{lots:1.5},{lot:0},{capital:0},{stop:310},{stop:320},{entry:Infinity},{direction:'buy'}])assert.throws(()=>E.risk({...data,...patch}));
});
