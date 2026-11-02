import test from 'node:test';
import assert from 'node:assert/strict';
import {parseSignal,parsePrice,validateSignal,signalMetrics,TelegramSignalParser} from '../lib/telegram-admin/parser.mjs';
import {INSTRUMENTS,findInstruments} from '../lib/instruments.mjs';

test('Telegram parser normalizes fast input, decimal commas and optional commands/direction',()=>{
 const expected={ticker:'SBER',direction:'LONG',entry:312.5,stop:307,take:325,missing:[]};
 for(const input of ['SBER 312.5 307 325','sber 312,5 307 325','SBER LONG 312.5 307 325','/s SBER 312.5 307 325','/signal SBER 312.5 307 325','/s@Orbita_AdminBot sber long 312,5 307 325'])assert.deepEqual(parseSignal(input),expected);
 assert.equal(new TelegramSignalParser().parse('SBER 312 307 325').direction,'LONG');
 assert.equal(parseSignal('SBER 312.5 318 300').direction,'SHORT');
 assert.equal(parseSignal('Si-12.26 SHORT 80000 81000 79000').ticker,'SI-12.26');
});

test('Telegram parser preserves partial drafts so missing levels can be supplied without retyping',()=>{
 const draft=parseSignal('SBER 312 307');assert.deepEqual(draft.missing,['take']);assert.equal(draft.direction,null);
 assert.deepEqual(validateSignal({...draft,take:325}),{ticker:'SBER',entry:312,stop:307,take:325,direction:'LONG',missing:[]});
 assert.deepEqual(parseSignal('/signal SBER LONG').missing,['entry','stop','take']);
 assert.deepEqual(parseSignal('SBER 312').missing,['stop','take']);
 assert.throws(()=>signalMetrics(draft),{code:'TELEGRAM_SIGNAL_INCOMPLETE'});
});

test('Telegram parser rejects malformed prices, extra targets, junk and conflicting levels',()=>{
 for(const value of ['1e3','NaN','Infinity','1 000','1,000.50','0x10','+10','-10','10руб','10.','0','1000000000001','9'.repeat(65),[],{},true,Infinity,NaN,0,-1])assert.throws(()=>parsePrice(value),{code:'TELEGRAM_PRICE_INVALID'});
 for(const input of ['SBER 312 320 325','SBER LONG 312 318 300','SBER SHORT 312 307 325','SBER 312 312 325','SBER 312 307 312','SBER 312 307 320 325','/publish SBER 312 307 325','<script> 312 307 325','SBER 312 307 x','SBER\u0000 312 307 325'])assert.throws(()=>parseSignal(input));
 assert.equal(parsePrice('1000000000000'),1e12);assert.equal(parsePrice('.5'),0.5);assert.equal(parsePrice('0,05'),0.05);
});

test('Telegram metrics calculate risk, potential and reward for both directions without rounding input levels',()=>{
 const long=signalMetrics(parseSignal('SBER 312.5 307 325'));
 assert.ok(Math.abs(long.riskPercent-1.76)<1e-12);assert.ok(Math.abs(long.potentialPercent-4)<1e-12);assert.ok(Math.abs(long.riskReward-2.272727272727273)<1e-12);
 const short=signalMetrics(parseSignal('SBER 312.5 318 300'));assert.deepEqual(short,long);
 const partial={ticker:'SBER',entry:100,stop:99.99999999,take:100.00000001};assert.ok(signalMetrics(partial).riskPercent>0);
});

test('Shared instrument directory prioritizes exact instruments and suggests ambiguous matches',()=>{
 assert.ok(Object.isFrozen(INSTRUMENTS));
 assert.deepEqual(findInstruments('sber').map(item=>item.ticker),['SBER']);
 assert.deepEqual(findInstruments('SBE').map(item=>item.ticker),['SBER','SBERP']);
 assert.equal(findInstruments('Si')[0].market,'futures');assert.equal(findInstruments('BTCUSDT')[0].market,'crypto');assert.equal(findInstruments('BTC/USDT')[0].ticker,'BTCUSDT');
 assert.equal(findInstruments('TEST').length,0);assert.equal(findInstruments('__proto__').length,0);assert.equal(findInstruments('Сбер')[0].name,'Сбербанк');
});

test('Only trusted published non-demo compatible ideas extend the shared instrument directory',()=>{
 const record={id:'idea-real',published:true,d:{ticker:'SIZ6',name:'Доллар / рубль, декабрь 2026',market:'futures',strategy:'Импульс'}};
 assert.equal(findInstruments('SIZ6',{records:[record]})[0].strategy,'Импульс');
 for(const altered of [{...record,demo:true},{...record,erroneous:true},{...record,published:false},{...record,id:'demo-real'},{...record,d:{...record.d,strategy:'Momentum RU'}},{...record,d:{...record.d,ticker:'<script>'}},{...record,d:{...record.d,name:'\u0000bad'}}])assert.equal(findInstruments('SIZ6',{records:[altered]}).length,0);
 const ambiguity=[record,{...record,id:'idea-other',d:{...record.d,market:'stocks',strategy:'Trend RU'}}];assert.equal(findInstruments('SIZ6',{records:ambiguity}).length,2);
 const original=structuredClone(record);findInstruments('SIZ6',{records:[record]});assert.deepEqual(record,original);
});
