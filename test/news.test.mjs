import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFile,readFile,rm,symlink,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {createNews} from '../lib/news.mjs';
import {serviceFixture} from './service-fixture.mjs';

const item=(id,publishedAt)=>({id,title:'Событие '+id,source:'Учебный источник',publishedAt,url:'https://www.moex.com/news/'+id,topics:['stocks'],tickers:['SBER']});

test('news feed distinguishes missing, valid and invalid data and excludes future publications',async()=>{
 const f=await serviceFixture(({directory})=>({handle:createNews(directory),webhookPaths:[]}));
 try{
  const file=join(f.directory,'news.json');let response=await f.request('/api/news');assert.equal(response.status,200);assert.equal(response.data.configured,false);assert.deepEqual(response.data.items,[]);
  const at=Date.now(),syncedAt=new Date(at).toISOString();await writeFile(file,JSON.stringify({items:[item('past',new Date(at-1000).toISOString()),item('future',new Date(at+3600000).toISOString())],syncedAt}));
  response=await f.request('/api/news');assert.equal(response.status,200);assert.equal(response.data.configured,true);assert.deepEqual(response.data.items.map(row=>row.id),['past']);assert.equal(response.data.syncedAt,syncedAt);
  assert.equal((await f.request('/api/news',{method:'POST',body:{}})).status,405);
  await writeFile(file,'{invalid');response=await f.request('/api/news');assert.equal(response.status,503);assert.ok(!Object.hasOwn(response.data,'items'));
 }finally{await f.close();}
});

test('news rejects a symlink, non-file or oversized source without returning data from its target',async()=>{
 const f=await serviceFixture(({directory})=>({handle:createNews(directory),webhookPaths:[]}));
 try{
  const file=join(f.directory,'news.json'),target=join(f.directory,'private-target.json'),privateFeed=JSON.stringify({items:[item('private',new Date().toISOString())]});
  await writeFile(target,privateFeed);await symlink(target,file);let response=await f.request('/api/news');assert.equal(response.status,503);assert.ok(!JSON.stringify(response.data).includes('private'));assert.equal(await readFile(target,'utf8'),privateFeed);
  await rm(file);await mkdir(file);assert.equal((await f.request('/api/news')).status,503);await rm(file,{recursive:true});
  await writeFile(file,JSON.stringify({items:[],padding:'x'.repeat(1048576)}));response=await f.request('/api/news');assert.equal(response.status,503);assert.ok(!Object.hasOwn(response.data,'items'));
 }finally{await f.close();}
});
