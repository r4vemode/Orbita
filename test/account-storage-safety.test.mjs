import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,symlink,stat,truncate} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {createAccounts,MAX_ACCOUNT_BYTES,validateAccountsDatabase} from '../lib/accounts.mjs';
import {createSecretVault} from '../lib/account-security.mjs';
import {serviceFixture} from './service-fixture.mjs';

test('account storage rejects corrupt and symlinked files at startup and after initialization without resetting contents',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'orbita-account-safe-')),file=join(directory,'accounts.json');
 try{
  for(const bytes of ['{"version":','{"version":1,"users":[null],"sessions":[]}']){
   await writeFile(file,bytes);await assert.rejects(createAccounts(directory),cause=>cause.code==='DATA_INVALID');assert.equal(await readFile(file,'utf8'),bytes);await assert.rejects(stat(join(directory,'.security-key')),cause=>cause.code==='ENOENT');
  }
  await rm(file);const accounts=await createAccounts(directory);await accounts.transact(db=>{db.accessAudit=[];});const original=await readFile(file,'utf8'),outside=join(directory,'external.json');await writeFile(outside,original);await rm(file);await symlink(outside,file);
  await assert.rejects(createAccounts(directory),cause=>cause.code==='DATA_UNSAFE');await assert.rejects(accounts.readDatabase(),cause=>cause.code==='DATA_UNSAFE');await assert.rejects(accounts.transact(db=>{db.users=[];}),cause=>cause.code==='DATA_UNSAFE');assert.equal(await readFile(outside,'utf8'),original);
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('account capacity rejects oversized files and updates without overwriting the last valid database',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'orbita-account-capacity-')),file=join(directory,'accounts.json');
 try{
  await writeFile(file,'');await truncate(file,MAX_ACCOUNT_BYTES+1);await assert.rejects(createAccounts(directory),cause=>cause.code==='DATA_UNSAFE');assert.equal((await stat(file)).size,MAX_ACCOUNT_BYTES+1);
  await rm(file);const accounts=await createAccounts(directory);await accounts.transact(db=>{db.accessAudit=[];});const before=await readFile(file,'utf8');
  await assert.rejects(accounts.transact(db=>{db.oversized='x'.repeat(MAX_ACCOUNT_BYTES);}),cause=>cause.status===409&&cause.code==='ACCOUNT_STORAGE_LIMIT');assert.equal(await readFile(file,'utf8'),before);assert.equal(validateAccountsDatabase(JSON.parse(before)),true);await assert.rejects(stat(file+'.lock'),cause=>cause.code==='ENOENT');
  await accounts.transact(db=>{db.accessAudit.push({action:'after-rejected-write'});});assert.equal((await accounts.readDatabase()).accessAudit.length,1);
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('security vault refuses symlinked or malformed keys without following or changing their targets',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'orbita-vault-safe-')),file=join(directory,'.security-key'),target=join(directory,'external-key');
 try{
  const bytes=randomBytes(32);await writeFile(target,bytes,{mode:0o640});const mode=(await stat(target)).mode;await symlink(target,file);
  await assert.rejects(createSecretVault(directory),cause=>cause.code==='DATA_UNSAFE');assert.deepEqual(await readFile(target),bytes);assert.equal((await stat(target)).mode,mode);
  await rm(file);await writeFile(file,randomBytes(33));await assert.rejects(createSecretVault(directory),cause=>cause.code==='DATA_UNSAFE');assert.equal((await stat(file)).size,33);
  await rm(file);const vaults=await Promise.all(Array.from({length:6},()=>createSecretVault(directory))),cipher=vaults[0].encrypt('Synthetic vault fixture');for(const vault of vaults)assert.equal(vault.decrypt(cipher),'Synthetic vault fixture');
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('registration reports an unavailable storage reference for corruption and recovers after the valid file is restored',async t=>{
 const f=await serviceFixture(async()=>({handle:async()=>false,webhookPaths:[]})),logs=[];t.mock.method(console,'error',(...values)=>logs.push(values.join(' ')));
 try{
  const first=await f.register('integrity-existing@example.test');assert.equal(first.status,200);const file=join(f.directory,'accounts.json'),original=await readFile(file,'utf8');await writeFile(file,'{"version":');
  const result=await f.register('integrity-new@example.test');assert.equal(result.status,503);assert.equal(result.data.code,'ACCOUNT_STORAGE_UNAVAILABLE');assert.match(result.data.errorId,/^[a-f0-9-]{36}$/);assert.ok(logs.some(value=>value.includes('DATA_INVALID')));assert.equal(await readFile(file,'utf8'),'{"version":');assert.ok(!JSON.stringify(result.data).includes(f.directory));
  await writeFile(file,original);assert.equal((await f.register('integrity-new@example.test')).status,200);assert.equal((await f.request('/api/me',{cookie:first.cookie})).data.user.id,first.data.user.id);
 }finally{await f.close();}
});
