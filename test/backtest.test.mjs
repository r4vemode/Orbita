import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {runBacktest,example} from '../lib/backtest.mjs';

const close=(a,b)=>assert.ok(Math.abs(a-b)<1e-7,`${a} != ${b}`);
function input(direction='LONG'){
 const value=example();value.options={initialCapital:1000,allocationPercent:100,feeBps:0,slippageBps:0,maxPendingBars:5};value.instrument.lotSize=1;
 value.signals=[{id:'synthetic-test',publishedAt:'2026-01-05T08:59:00Z',direction,entryOrder:'limit',entry:100,stop:direction==='LONG'?95:105,target:direction==='LONG'?110:90}];
 value.candles=[{time:'2026-01-05T09:00:00Z',open:100,high:101,low:99,close:100},{time:'2026-01-05T10:00:00Z',open:100,high:direction==='LONG'?111:101,low:direction==='LONG'?99:89,close:direction==='LONG'?110:90}];return value;
}
test('synthetic long and short trades use signed units, finite metrics and explicit hypothetical provenance',()=>{
 for(const direction of ['LONG','SHORT']){const report=runBacktest(input(direction)),trade=report.trades[0];assert.equal(trade.status,'closed');close(trade.netPnl,100);close(report.metrics.finalEquity,1100);assert.equal(report.metrics.winRate,100);assert.equal(report.metrics.profitFactor,null);assert.equal(report.metrics.profitFactorStatus,'no-losses');assert.equal(report.sourceKind,'synthetic');assert.equal(report.kind,'hypothetical-backtest');assert.match(report.warnings.join(' '),/СИНТЕТИЧЕСКИЙ/);}
});
test('commissions cover both sides and stop-order slippage is adverse and tick-rounded',()=>{
 const value=input();value.options.feeBps=10;value.options.slippageBps=10;value.signals[0].entryOrder='stop';value.candles[1]={time:'2026-01-05T10:00:00Z',open:100,high:101,low:94,close:95};
 const report=runBacktest(value),trade=report.trades[0];close(trade.entryFill,100.1);close(trade.exitFill,94.9);assert.equal(trade.units,9);close(trade.entryFee,.9009);close(trade.exitFee,.8541);close(trade.netPnl,-48.555);close(report.metrics.finalEquity,951.445);assert.ok(report.metrics.maxDrawdownPercent>0);
});
test('gaps fill stops at the worse open and ambiguous intrabar stop/target chooses the stop',()=>{
 const value=input();value.candles[1]={time:'2026-01-05T10:00:00Z',open:90,high:93,low:89,close:92};let report=runBacktest(value);assert.equal(report.trades[0].exitReason,'stop-gap');close(report.trades[0].exitFill,90);close(report.metrics.realizedPnl,-100);
 const ambiguous=input();ambiguous.candles[0]={time:'2026-01-05T09:00:00Z',open:100,high:111,low:94,close:105};report=runBacktest(ambiguous);close(report.trades[0].exitFill,95);assert.equal(report.coverage.ambiguousBars,1);assert.ok(report.trades[0].flags.includes('intrabar-order-unknown-stop-first'));
});
test('publication and amendments cannot use an already open candle or rewrite an earlier stop execution',()=>{
 const value=input();value.signals[0].publishedAt='2026-01-05T09:30:00Z';value.candles[0].high=120;value.candles[1]={time:'2026-01-05T10:00:00Z',open:100,high:102,low:99,close:101};let report=runBacktest(value);assert.equal(report.trades[0].enteredAt,'2026-01-05T10:00:00.000Z');assert.equal(report.metrics.closedTrades,0);assert.equal(report.status,'partial');
 const update=input();update.candles[0].low=94;update.signals[0].updates=[{knownAt:'2026-01-05T09:30:00Z',stop:108}];report=runBacktest(update);assert.equal(report.trades[0].exitFill,95);assert.equal(report.trades[0].currentStop,95);
});
test('missing historical coverage produces no invented metrics and open trades stay open',()=>{
 const missing=input();missing.candles=[];const report=runBacktest(missing);assert.equal(report.status,'insufficient-data');assert.equal(report.metrics,null);assert.equal(report.coverage.uncoveredSignals,1);assert.deepEqual(report.equity,[]);
 const opened=input();opened.candles.length=1;const partial=runBacktest(opened);assert.equal(partial.metrics.closedTrades,0);assert.equal(partial.metrics.openTrades,1);assert.equal(partial.trades[0].exitFill,undefined);
});
test('capital released within a candle cannot finance a second same-candle entry',()=>{
 const value=input();value.signals.push({...value.signals[0],id:'synthetic-test-2'});value.candles[0].high=111;const result=runBacktest(value);assert.equal(result.trades[0].status,'closed');assert.equal(result.trades[1].status,'skipped-capital');assert.equal(result.metrics.closedTrades,1);
});
test('malformed, overlapping, unfinished and future-known inputs are rejected',()=>{
 for(const change of [v=>{v.candles[0].low=102;},v=>{v.candles[1].time=v.candles[0].time;},v=>{v.metadata.asOf='2026-01-05T10:30:00Z';},v=>{v.candles[0].time='2026-02-30T09:00:00Z';},v=>{v.signals[0].validFrom='2026-01-05T08:00:00Z';},v=>{v.signals[0].updates=[{knownAt:'2026-01-05T13:00:00Z',stop:96}];},v=>{v.signals[0].entry=100.001;},v=>{v.options.leverage=100;}]){const value=input();change(value);assert.throws(()=>runBacktest(value));}
});
test('report fingerprints exact file bytes and never certifies operator-provided market provenance',()=>{
 const value=input();value.metadata.sourceKind='real';value.metadata.source='Operator supplied';const raw=JSON.stringify(value,null,2)+'\n',result=runBacktest(raw);assert.equal(result.provenance.inputSha256,createHash('sha256').update(raw).digest('hex'));assert.equal(result.provenance.scope,'exact-input-utf8');assert.equal(result.provenance.verification,'operator-supplied-unverified');assert.match(result.warnings[0],/не удостоверяет/);
});
