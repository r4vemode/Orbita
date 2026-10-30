import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createRadar} from '../lib/radar/service.mjs';
import {createBackup,verifyBackup,restoreBackup} from '../lib/backups.mjs';
import {checkStorage,inspectConfiguration} from '../lib/operations.mjs';

test('preflight rejects malformed Radar configuration without exposing endpoints or credentials',()=>{
  for(const values of [{RADAR_ENABLED:'yes'},{RADAR_ALLOWED_PLANS:'administrator'},{RADAR_PROVIDER_MODE:'live',RADAR_NSD_ENABLED:'true',RADAR_NSD_ENDPOINT:'http://127.0.0.1/private?token=hidden'}]){
    const result=inspectConfiguration(values),check=result.checks.find(item=>item.name==='RADAR_CONFIGURATION');assert.equal(check.status,'fail');assert.ok(!JSON.stringify(result).includes('hidden'));assert.ok(!JSON.stringify(result).includes('127.0.0.1'));
  }
});

test('Radar history is validated by readiness and survives an encrypted backup without creating public files',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'orbita-radar-storage-')),directory=path.join(root,'data'),restored=path.join(root,'restored');let radar;
  const accounts={identify:async()=>null,checkRequest:()=>{}};
  try{
    radar=await createRadar(directory,{accounts,env:{}});assert.equal((await radar.readDatabase()).events.length,0);await radar.seedDemo();await radar.close();radar=null;
    const original=await readFile(path.join(directory,'radar.json'),'utf8');
    const valid=await checkStorage({directory,write:false});assert.equal(valid.ok,true);assert.ok(valid.stores.includes('radar.json'));
    const passphrase='isolated radar backup test phrase',backup=await createBackup({dataDir:directory,backupDir:path.join(root,'backups'),passphrase});
    const verified=await verifyBackup({file:backup.file,passphrase});assert.ok(verified.files.some(file=>file.path==='radar.json'));
    await restoreBackup({file:backup.file,destination:restored,passphrase});assert.equal(await readFile(path.join(restored,'radar.json'),'utf8'),original);
    radar=await createRadar(restored,{accounts,env:{}});assert.ok((await radar.readDatabase()).events.length>=15);await radar.close();radar=null;
    await writeFile(path.join(restored,'radar.json'),'{"version":1,"events":[]}');const invalid=await checkStorage({directory:restored,write:false});assert.equal(invalid.ok,false);assert.equal(invalid.store,'radar.json');assert.equal(invalid.code,'DATA_INVALID');
  }finally{await radar?.close();await rm(root,{recursive:true,force:true});}
});
