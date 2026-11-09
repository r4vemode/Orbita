import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
async function calc(){const c={window:{}};vm.createContext(c);vm.runInContext(await readFile(new URL('../public/assets/position-calc.js',import.meta.url),'utf8'),c);return c.window.OrbitaPositionCalc.calc;}

test('stocks: lots from capital and risk with the MOEX lot size',async()=>{
 const f=await calc(),r=f({market:'stocks',entry:120,stop:115,capital:100000,riskPct:1,spec:{kind:'stock',lotSize:10}});
 assert.equal(r.count,20);assert.equal(r.shares,200);assert.equal(r.actualRisk,1000);assert.equal(r.value,24000);assert.deepEqual([...r.warnings],[]);
 const big=f({market:'stocks',entry:300,stop:299,capital:100000,riskPct:2,spec:{kind:'stock',lotSize:1}});assert.equal(big.count,2000);assert.match(big.warnings.join(' '),/плечо/);
 const tiny=f({market:'stocks',entry:5000,stop:4000,capital:10000,riskPct:1,spec:{kind:'stock',lotSize:1}});assert.equal(tiny.count,0);assert.match(tiny.warnings.join(' '),/больше выбранного/);
 assert.match(f({market:'stocks',entry:120,stop:115,capital:100000,riskPct:1}).warnings.join(' '),/Размер лота не получен/);
});
test('futures: contracts from point value; margin is checked; no specs — no guess',async()=>{
 const f=await calc(),si={kind:'future',stepPrice:1,minStep:1,margin:12916.8};
 const r=f({market:'futures',entry:82000,stop:81500,capital:200000,riskPct:2,spec:si});assert.equal(r.count,8);assert.equal(r.actualRisk,4000);assert.ok(Math.abs(r.margin-8*12916.8)<1e-6);
 const br=f({market:'futures',entry:98.5,stop:97.5,capital:100000,riskPct:1,spec:{kind:'future',stepPrice:8.21386,minStep:.01,margin:17209.89}});assert.equal(br.count,1);
 assert.equal(f({market:'futures',entry:82000,stop:81500,capital:200000,riskPct:2}).ok,false);
 assert.equal(f({market:'futures',entry:82000,stop:81500,capital:0,riskPct:2,spec:si}).ok,false);
});
