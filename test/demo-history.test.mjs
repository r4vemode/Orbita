import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdtemp,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {getDemoHistoryStatus,importDemoHistory,readDemoHistory,rollbackDemoHistory,validateDemoHistoryFixture} from '../lib/demo-history.mjs';

const run=promisify(execFile);
const cli=fileURLToPath(new URL('../scripts/manage-demo-history.mjs',import.meta.url));

function trade(){
  return {
    id:'demo-history-pro-sber-1',tier:'pro',strategy:'Momentum RU',ticker:'SBER',name:'Сбербанк',market:'stocks',direction:'LONG',
    openedAt:'2026-03-14T10:00:00+03:00',closedAt:'2026-03-14T10:19:59+03:00',
    entry:100,exit:105.5,stop:98,target:105,comment:'Демонстрационный вход после пробоя.',
    sourceUrl:'https://iss.moex.com/iss/engines/stock/markets/shares/boards/TQBR/securities/SBER/candles.json?from=2026-03-14&till=2026-03-14&interval=10',
    candles:[
      {at:'2026-03-14T10:00:00+03:00',end:'2026-03-14T10:09:59+03:00',open:100,high:102,low:99,close:101},
      {at:'2026-03-14T10:10:00+03:00',end:'2026-03-14T10:19:59+03:00',open:101,high:106,low:100,close:105.5}
    ]
  };
}
const fixture=(...trades)=>({version:1,trades});

async function scratch(t){
  const directory=await mkdtemp(path.join(tmpdir(),'orbita-demo-history-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  return directory;
}

test('validates candle execution order, trusted data sources and duplicate executions',()=>{
  assert.equal(validateDemoHistoryFixture(fixture(trade())),true);
  const invalid=[
    item=>{item.entry=101;},
    item=>{item.candles[0].low=97;},
    item=>{item.candles[1].low=97;},
    item=>{item.candles[1].close=104;item.exit=104;},
    item=>{item.candles[1].end='2026-03-14T10:20:00+03:00';},
    item=>{item.sourceUrl='https://iss.moex.com.example.org/candles.json';},
    item=>{item.sourceUrl=item.sourceUrl.replace('/SBER/','/GAZP/');},
    item=>{item.id='public-idea-1';},
    item=>{item.closeReason='time';},
    item=>{item.strategy='Orbita Exclusive';item.tier='exclusive';}
  ];
  for(const change of invalid){const item=trade();change(item);assert.equal(validateDemoHistoryFixture(fixture(item)),false);}
  assert.equal(validateDemoHistoryFixture(fixture(trade(),{...trade(),id:'demo-history-alias-id'})),false);
});

test('imports and rolls back isolated durable snapshots without duplicates or other store writes',async t=>{
  const directory=await scratch(t),accounts=path.join(directory,'accounts.json'),store=path.join(directory,'demo-history.json');
  await writeFile(accounts,'previous accounts stay untouched');
  assert.deepEqual(await readDemoHistory(directory,{useBundled:false}),[]);

  const imported=await importDemoHistory(directory,fixture(trade()));
  assert.deepEqual(imported,{persisted:true,changed:true,revision:1,previousRevision:0,total:1,pro:1,exclusive:0});
  const [record]=await readDemoHistory(directory);
  assert.equal(record.closeReason,'target');
  assert.equal(record.openedAt,'2026-03-14T07:00:00.000Z');
  assert.equal((await importDemoHistory(directory,fixture(record))).changed,false);
  const before=await readFile(store,'utf8');
  await assert.rejects(importDemoHistory(directory,fixture(trade(),trade())),{code:'DEMO_HISTORY_DUPLICATE'});
  assert.equal(await readFile(store,'utf8'),before);

  const modified={...trade(),comment:'Обновлённый комментарий.'};
  assert.equal((await importDemoHistory(directory,fixture(modified))).revision,2);
  await assert.rejects(rollbackDemoHistory(directory,1),{code:'DEMO_HISTORY_REVISION_CONFLICT'});
  assert.equal((await rollbackDemoHistory(directory,2)).revision,3);
  assert.deepEqual(await readDemoHistory(directory),[record]);
  assert.equal((await rollbackDemoHistory(directory,3)).revision,4);
  assert.deepEqual(await readDemoHistory(directory),[],'explicit rollback to empty must override the bundled fixture');
  assert.equal((await getDemoHistoryStatus(directory)).persisted,true);
  assert.equal((await rollbackDemoHistory(directory,4)).changed,false);
  assert.equal(await readFile(accounts,'utf8'),'previous accounts stay untouched');
  const files=await readdir(directory);
  assert.ok(files.includes('demo-history.json.backup-0'));
  assert.ok(files.includes('demo-history.json.backup-2'));
  assert.ok(files.every(name=>!name.endsWith('.lock')&&!name.includes('.tmp-')));
});

test('serializes concurrent imports, leaving exactly one seed and a usable rollback',async t=>{
  const directory=await scratch(t),input=fixture(trade());
  const imports=await Promise.all(Array.from({length:5},()=>importDemoHistory(directory,input)));
  assert.equal(imports.filter(item=>item.changed).length,1);
  assert.ok(imports.every(item=>item.revision===1));
  assert.equal((await readDemoHistory(directory)).length,1);
  assert.equal((await rollbackDemoHistory(directory,1)).total,0);
});

test('management script imports an explicit fixture and rolls it back by revision',async t=>{
  const directory=await scratch(t),input=path.join(directory,'source.json');
  await writeFile(input,JSON.stringify(fixture(trade())));
  const execute=async (...args)=>JSON.parse((await run(process.execPath,[cli,...args],{env:{...process.env,ORBITA_DATA_DIR:directory}})).stdout);
  assert.equal((await execute('import',input)).pro,1);
  assert.equal((await execute('status')).revision,1);
  assert.equal((await execute('rollback','1')).total,0);
});
