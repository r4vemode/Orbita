import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink,lstat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {writeDurable,readPrivateJson} from '../lib/durable-file.mjs';
import {reclaimAbandonedLock} from '../lib/storage-lock.mjs';

test('durable JSON replacement preserves private permissions and refuses symbolic storage targets',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'orbita-durable-'));try{
  const file=path.join(root,'store.json');await writeDurable(file,'{"version":1}');await writeDurable(file,'{"version":2}');assert.deepEqual(await readPrivateJson(file,db=>db.version===2),{version:2});
  if(process.platform!=='win32')assert.equal((await lstat(file)).mode&0o777,0o600);
  const alias=path.join(root,'alias.json');await symlink(file,alias);await assert.rejects(writeDurable(alias,'{}'),cause=>cause.code==='DATA_UNSAFE');await assert.rejects(readPrivateJson(alias,()=>true),cause=>cause.code==='DATA_UNSAFE');assert.equal(await readFile(file,'utf8'),'{"version":2}');
  await assert.rejects(readPrivateJson(file,()=>true,{maxBytes:1}),cause=>cause.code==='DATA_UNSAFE');await writeFile(file,'broken');await assert.rejects(readPrivateJson(file,()=>true),cause=>cause.code==='DATA_INVALID');assert.equal(await readFile(file,'utf8'),'broken');
 }finally{await rm(root,{recursive:true,force:true});}
});

test('parallel stale-lock reclaimers do not remove a live successor and abandoned recovery stays fail-closed',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'orbita-reclaim-')),lock=path.join(root,'accounts.json.lock');try{
  await mkdir(lock);await writeFile(path.join(lock,'owner.json'),JSON.stringify({pid:2147483647}));const outcomes=await Promise.all(Array.from({length:8},()=>reclaimAbandonedLock(lock)));assert.equal(outcomes.filter(Boolean).length,1);
  await mkdir(lock);await writeFile(path.join(lock,'owner.json'),JSON.stringify({pid:process.pid}));assert.ok((await Promise.all(Array.from({length:8},()=>reclaimAbandonedLock(lock)))).every(value=>!value));assert.equal(JSON.parse(await readFile(path.join(lock,'owner.json'))).pid,process.pid);
  await writeFile(lock+'.reclaim',JSON.stringify({pid:2147483647}));await writeFile(path.join(lock,'owner.json'),JSON.stringify({pid:2147483647}));assert.equal(await reclaimAbandonedLock(lock),false);assert.ok((await lstat(lock)).isDirectory());
 }finally{await rm(root,{recursive:true,force:true});}
});
