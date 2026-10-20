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
