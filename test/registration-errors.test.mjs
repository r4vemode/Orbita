import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {rename,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {serviceFixture} from './service-fixture.mjs';

test('unavailable account storage reports a safe support reference and recovers without losing existing accounts',async t=>{
 const f=await serviceFixture(async()=>({handle:async()=>false,webhookPaths:[]})),logs=[];
 t.mock.method(console,'error',(...values)=>logs.push(values.join(' ')));
 const saved=f.directory+'-saved';let moved=false,blocked=false;
 try{
  const existing=await f.register('existing@example.test');assert.equal(existing.status,200);
  const before=await readFile(join(f.directory,'accounts.json'),'utf8');
  await rename(f.directory,saved);moved=true;await writeFile(f.directory,'Temporary filesystem fault');blocked=true;
  const failure=await f.register('new@example.test');
  assert.equal(failure.status,503);assert.equal(failure.data.code,'ACCOUNT_STORAGE_UNAVAILABLE');assert.match(failure.data.errorId,/^[a-f0-9-]{36}$/);assert.equal(failure.cookie,undefined);
  assert.equal(await readFile(join(saved,'accounts.json'),'utf8'),before);
  assert.ok(logs.some(line=>line.includes(failure.data.errorId)&&line.includes('code=ENOTDIR')));
  for(const secret of ['existing@example.test','new@example.test','test-password-long-2026',existing.cookie,f.directory]){
   assert.ok(!JSON.stringify(failure.data).includes(secret));assert.ok(!logs.join('\n').includes(secret));
  }
  await rm(f.directory);blocked=false;await rename(saved,f.directory);moved=false;
  const retried=await f.register('new@example.test');assert.equal(retried.status,200);
  const current=await f.request('/api/me',{cookie:existing.cookie});assert.equal(current.data.user.id,existing.data.user.id);
  assert.equal((await f.accounts.readDatabase()).users.length,2);
 }finally{
  if(blocked)await rm(f.directory,{force:true});if(moved)await rename(saved,f.directory);
  await f.close();
 }
});

test('account forms show the support reference but reject untrusted reference text',async()=>{
 const code=await readFile(new URL('../public/assets/access.js',import.meta.url),'utf8');
 for(const errorId of ['11111111-1111-4111-8111-111111111111','unsafe\nprivate-path']){
  const window={addEventListener(){}},context=vm.createContext({window,fetch:async()=>({ok:false,status:503,headers:{get:()=> 'application/json'},json:async()=>({error:'Сохранение временно недоступно.',code:'ACCOUNT_STORAGE_UNAVAILABLE',errorId})})});
  vm.runInContext(code,context);
  await assert.rejects(window.OrbitaAccess.request('/api/register'),error=>error.status===503&&error.code==='ACCOUNT_STORAGE_UNAVAILABLE'&&(errorId.startsWith('1111')?error.message.includes(errorId):!error.message.includes(errorId)));
 }
});
