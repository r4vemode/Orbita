import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const context={};context.window=context;vm.createContext(context);
for(const file of ['calculator-engine.js'])vm.runInContext(await readFile(new URL('../public/assets/'+file,import.meta.url),'utf8'),context);
const E=context.OrbitaCalculator,records=JSON.parse(await readFile(new URL('../fixtures/demo-ideas.json',import.meta.url),'utf8'));
const options={capital:100000,allocation:10,fee:0,start:'2026-01-01',end:'2026-12-31',strategy:'Orbita Exclusive'};
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
 const result=E.calculate(rows,{...options,capital:1000,allocation:100,strategy:'all'});
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
