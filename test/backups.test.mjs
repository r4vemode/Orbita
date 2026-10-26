import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,lstat,readdir,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomBytes,scrypt as scryptCallback,createDecipheriv,createCipheriv,createHash} from 'node:crypto';
import {gzip as gzipCallback,gunzip as gunzipCallback} from 'node:zlib';
import {promisify} from 'node:util';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createBackup,listBackups,verifyBackup,restoreBackup,pruneBackups} from '../lib/backups.mjs';

const passphrase='roundtrip backup passphrase 2026',scrypt=promisify(scryptCallback),gzip=promisify(gzipCallback),gunzip=promisify(gunzipCallback);
async function fixture(){
  const root=await mkdtemp(path.join(tmpdir(),'orbita-backups-')),dataDir=path.join(root,'data'),backupDir=path.join(root,'backups'),publicDir=path.join(root,'public');
  await mkdir(dataDir,{mode:0o700});await mkdir(publicDir,{mode:0o700});
  const files={
    'accounts.json':JSON.stringify({version:1,users:[{email:'backup-user@example.test',mfa:{secret:'encrypted-mfa-secret'}}],sessions:[]}),
    'ideas.json':JSON.stringify({version:1,revision:1,records:[]}),
    'billing.json':JSON.stringify({version:1,payments:[{id:'pending-payment',state:'crediting'}]}),
    'notifications.json':JSON.stringify({version:1,outbox:[{id:'outbox-test',status:'pending'}]}),
    'news.json':JSON.stringify({items:[]}),
    'nested/state.json':JSON.stringify({marker:'nested-state'}),
    '.security-key':randomBytes(32)
  };
  await mkdir(path.join(dataDir,'nested'),{mode:0o700});
  for(const [name,content]of Object.entries(files))await writeFile(path.join(dataDir,name),content,{mode:0o600});
  return {root,dataDir,backupDir,publicDir,files,cleanup:()=>rm(root,{recursive:true,force:true})};
}
async function alterAuthenticatedArchive(original,destination,mutate){
  const bytes=await readFile(original),offset=Buffer.byteLength('ORBITA-BACKUP\0')+4,headerLength=bytes.readUInt32BE(offset-4),header=JSON.parse(bytes.subarray(offset,offset+headerLength)),aad=bytes.subarray(0,offset+headerLength);
  const key=await scrypt(passphrase,Buffer.from(header.kdf.salt,'base64'),32,{N:header.kdf.N,r:header.kdf.r,p:header.kdf.p,maxmem:64*1024*1024});
  try{
    const decipher=createDecipheriv('aes-256-gcm',key,Buffer.from(header.cipher.iv,'base64'));decipher.setAAD(aad);decipher.setAuthTag(bytes.subarray(-16));
    const payload=JSON.parse((await gunzip(Buffer.concat([decipher.update(bytes.subarray(aad.length,-16)),decipher.final()]))).toString());mutate(payload);
    const cipher=createCipheriv('aes-256-gcm',key,Buffer.from(header.cipher.iv,'base64'));cipher.setAAD(aad);
    const encrypted=Buffer.concat([cipher.update(await gzip(Buffer.from(JSON.stringify(payload)))),cipher.final()]);
    await writeFile(destination,Buffer.concat([aad,encrypted,cipher.getAuthTag()]),{mode:0o600});
  }finally{key.fill(0);}
}

test('encrypted backup restores all file stores and security key with private permissions',async()=>{
  const f=await fixture();try{
    await writeFile(path.join(f.dataDir,'telegram.session'),'excluded-session');await writeFile(path.join(f.dataDir,'ideas.json.tmp-old'),'incomplete write');await writeFile(path.join(f.dataDir,'.orbita-readiness-probe.ok'),'orbita-readiness');
    const result=await createBackup({...f,passphrase});assert.equal(result.files.length,Object.keys(f.files).length);assert.ok(result.skipped.includes('telegram.session'));assert.ok(result.skipped.includes('.orbita-readiness-probe.ok'));
    assert.equal((await lstat(result.file)).mode&0o777,0o600);assert.equal((await lstat(f.backupDir)).mode&0o777,0o700);
    const encrypted=await readFile(result.file);assert.ok(!encrypted.includes(Buffer.from('backup-user@example.test')));assert.ok(!encrypted.includes(f.files['.security-key']));
    const verified=await verifyBackup({file:result.file,passphrase});assert.equal(verified.files.length,7);assert.ok(verified.files.every(file=>/^[a-f0-9]{64}$/.test(file.sha256)));
    assert.deepEqual((await listBackups(f)).map(item=>item.file),[result.file]);
    const destination=path.join(f.root,'restored');await restoreBackup({file:result.file,destination,passphrase,publicDir:f.publicDir});
    assert.equal((await lstat(destination)).mode&0o777,0o700);
    for(const [name,content]of Object.entries(f.files)){assert.deepEqual(await readFile(path.join(destination,name)),Buffer.from(content));assert.equal((await lstat(path.join(destination,name))).mode&0o777,0o600);}
    assert.equal((await readdir(destination)).some(name=>name.endsWith('.lock')),false);
  }finally{await f.cleanup();}
});

test('wrong passwords, modified ciphertext, checksums and unsafe archive paths are rejected before restore writes',async()=>{
  const f=await fixture();try{
    const result=await createBackup({...f,passphrase}),destination=path.join(f.root,'must-not-exist');
    await assert.rejects(restoreBackup({file:result.file,destination,passphrase:'incorrect backup passphrase',publicDir:f.publicDir}),/парольная фраза|повреждён/);
    const corrupted=path.join(f.root,'corrupted.orbita-backup'),bytes=await readFile(result.file);bytes[bytes.length-20]^=1;await writeFile(corrupted,bytes);
    await assert.rejects(verifyBackup({file:corrupted,passphrase}),/парольная фраза|повреждён/);
    for(const unsafe of ['../escape.json','/absolute.json','nested/../../escape.json','nested\\escape.json','a//b.json','a/./b.json']){
      const malicious=path.join(f.root,'malicious.orbita-backup');await alterAuthenticatedArchive(result.file,malicious,payload=>{payload.files[0].path=unsafe;});
      await assert.rejects(restoreBackup({file:malicious,destination,passphrase,publicDir:f.publicDir}),/путь|размер/);
    }
    const checksum=path.join(f.root,'checksum.orbita-backup');await alterAuthenticatedArchive(result.file,checksum,payload=>{payload.files[0].sha256='0'.repeat(64);});
    await assert.rejects(verifyBackup({file:checksum,passphrase}),/Контрольная сумма/);
    const duplicate=path.join(f.root,'duplicate.orbita-backup');await alterAuthenticatedArchive(result.file,duplicate,payload=>{payload.files.push(payload.files[0]);});
    await assert.rejects(verifyBackup({file:duplicate,passphrase}),/Повторяющиеся/);
    await assert.rejects(lstat(destination),{code:'ENOENT'});await assert.rejects(lstat(path.join(f.root,'escape.json')),{code:'ENOENT'});
  }finally{await f.cleanup();}
});

test('backup locations, symlinks and nonempty restore destinations cannot expose or overwrite data',async()=>{
  const f=await fixture();try{
    await assert.rejects(createBackup({...f,backupDir:path.join(f.publicDir,'backups'),passphrase}),/вне public/);
    await assert.rejects(createBackup({...f,backupDir:path.join(f.dataDir,'backups'),passphrase}),/вне public/);
    await assert.rejects(createBackup({...f,passphrase:'short'}),/16/);
    const result=await createBackup({...f,passphrase}),destination=path.join(f.root,'existing');await mkdir(destination,{mode:0o700});await writeFile(path.join(destination,'keep.txt'),'preserve me');
    await assert.rejects(restoreBackup({file:result.file,destination,passphrase,publicDir:f.publicDir}),/должен быть пустым/);assert.equal(await readFile(path.join(destination,'keep.txt'),'utf8'),'preserve me');
    await assert.rejects(restoreBackup({file:result.file,destination:path.join(f.publicDir,'restore'),passphrase,publicDir:f.publicDir}),/public/);
    const alias=path.join(f.root,'alias');await symlink(destination,alias);
    await assert.rejects(restoreBackup({file:result.file,destination:alias,passphrase,publicDir:f.publicDir}),/Символические ссылки/);
    await symlink(path.join(f.root,'outside-secret'),path.join(f.dataDir,'symlink-secret'));
    await assert.rejects(createBackup({...f,passphrase}),/Символические ссылки/);
    assert.ok((await readdir(f.dataDir)).every(name=>!name.endsWith('.lock')));
    assert.ok((await readdir(f.root)).every(name=>!name.startsWith('.orbita-restore-')));
  }finally{await f.cleanup();}
});

test('snapshot waits for cooperating store locks and releases partial locks on timeout',async()=>{
  const f=await fixture();try{
    const lock=path.join(f.dataDir,'ideas.json.lock');await mkdir(lock,{mode:0o700});await writeFile(path.join(lock,'owner.json'),JSON.stringify({pid:process.pid}));
    await assert.rejects(createBackup({...f,passphrase,lockTimeoutMs:75}),/согласованный снимок/);
    assert.ok((await lstat(lock)).isDirectory());await assert.rejects(lstat(path.join(f.dataDir,'accounts.json.lock')),{code:'ENOENT'});
    let finished=false;const pending=createBackup({...f,passphrase,lockTimeoutMs:2000}).then(result=>{finished=true;return result;});
    await new Promise(resolve=>setTimeout(resolve,50));assert.equal(finished,false);
    await writeFile(path.join(f.dataDir,'accounts.json'),JSON.stringify({version:1,revision:2,users:[],sessions:[]}));
    await writeFile(path.join(f.dataDir,'ideas.json'),JSON.stringify({version:1,revision:2,records:[]}));
    await rm(lock,{recursive:true});const result=await pending,destination=path.join(f.root,'consistent');await restoreBackup({file:result.file,destination,passphrase,publicDir:f.publicDir});
    assert.equal(JSON.parse(await readFile(path.join(destination,'accounts.json'))).revision,2);assert.equal(JSON.parse(await readFile(path.join(destination,'ideas.json'))).revision,2);
    assert.ok((await readdir(f.dataDir)).every(name=>!name.endsWith('.lock')));
  }finally{await f.cleanup();}
});

test('snapshot recovers a lock left by a process that exited',async()=>{
  const f=await fixture();try{
    const child=spawn(process.execPath,['-e','']);await new Promise(resolve=>child.once('exit',resolve));
    const lock=path.join(f.dataDir,'billing.json.lock');await mkdir(lock,{mode:0o700});await writeFile(path.join(lock,'owner.json'),JSON.stringify({pid:child.pid}));
    const result=await createBackup({...f,passphrase,lockTimeoutMs:1000});assert.ok(result.file);await assert.rejects(lstat(lock),{code:'ENOENT'});
  }finally{await f.cleanup();}
});

test('explicit retention removes only older authenticated owned backups',async()=>{
  const f=await fixture();try{
    const first=await createBackup({...f,passphrase}),second=await createBackup({...f,passphrase});
    await writeFile(path.join(f.backupDir,'notes.txt'),'never prune');
    const fake='orbita-20000101T000000000Z-11111111-1111-1111-1111-111111111111.orbita-backup';await writeFile(path.join(f.backupDir,fake),'not an authenticated backup');
    const retention=await pruneBackups({...f,passphrase,keep:1});assert.deepEqual(retention.removed,[path.basename(first.file)]);assert.deepEqual(retention.skipped,[fake]);
    assert.ok((await lstat(second.file)).isFile());assert.equal(await readFile(path.join(f.backupDir,'notes.txt'),'utf8'),'never prune');
    await assert.rejects(pruneBackups({...f,passphrase,keep:0}),/--keep/);
  }finally{await f.cleanup();}
});

test('backup CLI requires environment passphrase and explicit restore target without logging it',async()=>{
  const f=await fixture();try{
    const script=fileURLToPath(new URL('../scripts/backup.mjs',import.meta.url));
    const run=(args,phrase)=>new Promise((resolve,reject)=>{let stdout='',stderr='';const child=spawn(process.execPath,[script,...args],{env:{...process.env,ORBITA_BACKUP_PASSPHRASE:phrase||''},stdio:['ignore','pipe','pipe']});child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);child.on('error',reject);child.on('exit',code=>resolve({code,stdout,stderr}));});
    const missing=await run(['list','--directory',f.backupDir]);assert.equal(missing.code,1);assert.match(missing.stderr,/ORBITA_BACKUP_PASSPHRASE/);
    const created=await run(['create','--data-dir',f.dataDir,'--directory',f.backupDir],passphrase);assert.equal(created.code,0,created.stderr);assert.ok(!created.stdout.includes(passphrase));
    const result=JSON.parse(created.stdout),noDestination=await run(['restore','--file',result.file],passphrase);assert.equal(noDestination.code,1);assert.match(noDestination.stderr,/--restore/);
    const verified=await run(['verify','--file',result.file],passphrase);assert.equal(verified.code,0,verified.stderr);assert.equal(JSON.parse(verified.stdout).files.length,7);
  }finally{await f.cleanup();}
});
