import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../public/assets/editor-store.js',import.meta.url),'utf8');
const record={id:'paid-idea',published:true,d:{ticker:'TEST'}};
function fixture(fetch){const window=new EventTarget();vm.runInNewContext(source,{window,fetch,AbortController,CustomEvent});return window.OrbitaStore;}
test('late authorized feed response cannot restore records after account invalidation',async()=>{
 let complete,signal;const store=fixture((_url,options)=>{signal=options.signal;return new Promise(resolve=>{complete=resolve;});});
 const loading=store.refresh();store.clear();assert.equal(signal.aborted,true);complete({ok:true,json:async()=>({revision:1,records:[record]})});
 await assert.rejects(loading,/Аккаунт изменился/);assert.equal(store.read().records.length,0);
});
test('after invalidation a new authorized refresh can populate the empty feed normally',async()=>{
 let revision=1;const store=fixture(async()=>({ok:true,json:async()=>({revision:revision++,records:[record]})}));
 await store.refresh();assert.equal(store.read().records.length,1);store.clear();assert.equal(store.read().records.length,0);await store.refresh();assert.equal(store.read().records.length,1);assert.equal(store.read().revision,2);
});
