import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {validatePosition} from '../lib/positions.mjs';
const context={window:{}};vm.runInNewContext(await readFile(new URL('../public/assets/personal-engine.js',import.meta.url),'utf8'),context);
const {result}=context.window.OrbitaPersonalEngine;
const position={ideaId:'sber',entry:100,quantity:10,pointValue:1,enteredAt:'2026-10-01T10:00:00Z',exit:null,closedAt:null};
test('personal result differs from author entry and uses long and short direction',()=>{
 assert.equal(result(position,{entry:95,current:110,dir:'ЛОНГ',state:'active'},{}).pnl,100);
 assert.equal(result(position,{current:90,dir:'ШОРТ',state:'active'},{}).percent,10);
 assert.equal(result(position,{current:110,dir:'ШОРТ',state:'active'},{}).pnl,-100);
});
test('own exit takes precedence over strategy exit and futures use point value',()=>{
 const r=result({...position,exit:106,pointValue:2},{current:120,dir:'ЛОНГ',state:'closed'},{exit:104.2});
 assert.equal(r.source,'manual');assert.equal(r.pnl,120);assert.equal(r.percent,6);
 const estimate=result(position,{current:120,dir:'ЛОНГ',state:'closed'},{exit:104.2});
 assert.equal(estimate.source,'strategy');assert.ok(Math.abs(estimate.percent-4.2)<1e-9);
});
test('position validation rejects non-finite, negative and inconsistent exits',()=>{
 assert.equal(validatePosition(position).entry,100);
 for(const patch of [{entry:Infinity},{quantity:0},{pointValue:-1},{exit:110},{exit:110,closedAt:'bad'},{exit:110,closedAt:'2026-09-01T00:00:00Z'},{ideaId:'<script>'},{entry:1e12,quantity:1e12}])assert.throws(()=>validatePosition({...position,...patch}));
});
test('a strategy exit before the personal entry cannot become a personal result',()=>{
 const closed={exit:104.2,events:[['09.10.2026 · 10:00','Закрыто вручную','',{type:'manual',at:'2026-10-09T07:00:00.000Z'}]]};
 const later={...position,enteredAt:'2026-10-19T10:00:00Z'};
 assert.equal(result(later,{state:'closed',dir:'ЛОНГ'},closed),null);
 assert.equal(result({...later,exit:106},{state:'closed',dir:'ЛОНГ'},closed).source,'manual');
});
