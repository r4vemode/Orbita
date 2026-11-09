import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

async function library(){const context={window:{}};vm.createContext(context);vm.runInContext(await readFile(new URL('../public/assets/chart-formations.js',import.meta.url),'utf8'),context);return context.window.OrbitaFormations;}
const y=(svg,cls)=>Number(svg.match(new RegExp(`class="fx-level ${cls}"[^>]*y1="([\\d.]+)"`))[1]);

test('illustrations: 8 bullish, 8 bearish, 5 neutral paths; choice follows direction/state and is stable per idea',async()=>{
 const F=await library();
 assert.equal(F.FORMATIONS.long.length,8);assert.equal(F.FORMATIONS.short.length,8);assert.equal(F.FORMATIONS.neutral.length,5);
 const seen={long:new Set(),short:new Set()};
 for(let i=0;i<200;i++){
  const long={id:'idea-'+i,d:{dir:'ЛОНГ',state:'active'}},short={id:'idea-'+i,d:{dir:'ШОРТ',state:'waiting'}};
  assert.equal(F.pick(long).kind,'long');assert.equal(F.pick(short).kind,'short');seen.long.add(F.pick(long).key);seen.short.add(F.pick(short).key);
  assert.equal(F.pick(long).key,F.pick({id:'idea-'+i,d:{dir:'ЛОНГ',state:'active'}}).key,'same idea → same formation');
 }
 assert.equal(seen.long.size,8,'all bullish paths are used');assert.equal(seen.short.size,8);
 assert.equal(F.pick({id:'x',d:{dir:'ЛОНГ',state:'cancelled'}}).kind,'neutral');assert.equal(F.pick({id:'x',erroneous:true,d:{dir:'ШОРТ',state:'active'}}).kind,'neutral');
});

test('levels are drawn on the correct side and every picture is labelled as an illustration',async()=>{
 const F=await library();
 const long=F.svg({id:'idea-1',d:{ticker:'SBER',dir:'ЛОНГ',state:'active',entry:312.4,stop:306.2,target:329,targets:[338]}});
 assert.ok(y(long,'target')<y(long,'entry')&&y(long,'entry')<y(long,'stop'),'LONG: target above entry above stop');
 assert.match(long,/не история цены/);assert.match(long,/Цель 2/);assert.equal(long,F.svg({id:'idea-1',d:{ticker:'SBER',dir:'ЛОНГ',state:'active',entry:312.4,stop:306.2,target:329,targets:[338]}}),'byte-identical on reload');
 const short=F.svg({id:'idea-2',d:{ticker:'GAZP',dir:'ШОРТ',state:'waiting',entry:120,stop:124,target:110}});
 assert.ok(y(short,'stop')<y(short,'entry')&&y(short,'entry')<y(short,'target'),'SHORT: stop above entry above target');
 const pending=F.svg({id:'idea-3',d:{ticker:'SBER',dir:'ЛОНГ',state:'announced'}});assert.match(pending,/уровни ещё не опубликованы/);assert.doesNotMatch(pending,/fx-level/);
 const values=[...long.matchAll(/y1="([\d.-]+)"/g)].map(m=>Number(m[1]));assert.ok(values.every(v=>v>=0&&v<=460),'everything stays inside the viewBox');
});
