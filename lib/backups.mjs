import {constants} from 'node:fs';
import {open,mkdir,mkdtemp,lstat,readdir,readFile,writeFile,rename,rm,rmdir,realpath} from 'node:fs/promises';
import {randomBytes,randomUUID,scrypt as scryptCallback,createCipheriv,createDecipheriv,createHash} from 'node:crypto';
import {promisify} from 'node:util';
import {gzip as gzipCallback,gunzip as gunzipCallback} from 'node:zlib';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const scrypt=promisify(scryptCallback),gzip=promisify(gzipCallback),gunzip=promisify(gunzipCallback);
const MAGIC=Buffer.from('ORBITA-BACKUP\0'),VERSION=1,TAG_BYTES=16;
const KDF={name:'scrypt',N:32768,r:8,p:1},KDF_MEMORY=64*1024*1024;
const MAX_FILE=32*1024*1024,MAX_DATA=64*1024*1024,MAX_PAYLOAD=96*1024*1024,MAX_ARCHIVE=100*1024*1024,MAX_FILES=1000;
const DEFAULT_PUBLIC=fileURLToPath(new URL('../public/',import.meta.url));
const STORES=['accounts.json','ideas.json','billing.json','notifications.json','payments.json','content.json','product-settings.json','legal.json','radar.json','participants.json','support.json'];
const BACKUP_NAME=/^orbita-\d{8}T\d{9}Z-[a-f0-9-]{36}\.orbita-backup$/;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const inside=(parent,child)=>child===parent||child.startsWith(parent+path.sep);
const fail=message=>{throw Error(message);};
function password(value){if(typeof value!=='string'||value.length<16||value.length>4096)fail('Задайте ORBITA_BACKUP_PASSPHRASE: от 16 до 4096 символов.');return value;}
function validName(name){return typeof name==='string'&&name.length<=1024&&!name.includes('\\')&&!name.includes('\0')&&!path.posix.isAbsolute(name)&&name.split('/').every(part=>/^[A-Za-z0-9._-]{1,200}$/.test(part)&&part!=='.'&&part!=='..')&&path.posix.normalize(name)===name;}
function ignored(name){return name.startsWith('.orbita-readiness-')||name.endsWith('.lock')||name.includes('.tmp')||/\.(?:session|sqlite|sqlite3|db)(?:-(?:wal|shm|journal))?$/.test(name)||name.endsWith('.orbita-backup');}

// Resolve existing ancestors without following symlinks, including when a target does not exist yet.
async function physical(location){
  const absolute=path.resolve(location),parsed=path.parse(absolute);let cursor=parsed.root;
  for(const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)){
    cursor=path.join(cursor,part);
    try{if((await lstat(cursor)).isSymbolicLink())fail('Символические ссылки не поддерживаются в путях резервной копии.');}
    catch(error){if(error.code==='ENOENT')continue;throw error;}
  }
  return absolute;
}
async function privateDirectory(location){
  const target=await physical(location);await mkdir(target,{recursive:true,mode:0o700});
  const info=await lstat(target);if(!info.isDirectory()||info.isSymbolicLink())fail('Ожидается обычный каталог.');return await realpath(target);
}
async function backupDirectory(location,{dataDir,publicDir=DEFAULT_PUBLIC,create=false}={}){
  if(!location)fail('Укажите отдельный каталог резервных копий.');
  const target=await physical(location),publicRoot=await physical(publicDir);
  if(inside(publicRoot,target)||(dataDir&&inside(await physical(dataDir),target)))fail('Каталог резервных копий должен находиться вне public и каталога данных.');
  if(create)await privateDirectory(target);
  const info=await lstat(target);if(!info.isDirectory()||info.isSymbolicLink())fail('Ожидается обычный каталог резервных копий.');
  if(info.mode&0o077)fail('Каталог резервных копий должен быть приватным (права 0700).');return await realpath(target);
}
async function regularFile(filename,maxSize){
  const source=await lstat(filename);if(!source.isFile()||source.isSymbolicLink()||source.size>maxSize)fail('Файл резервной копии слишком большой или имеет неподдерживаемый тип.');
  const handle=await open(filename,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{const info=await handle.stat();if(!info.isFile()||info.size>maxSize)fail('Файл резервной копии слишком большой или имеет неподдерживаемый тип.');return await handle.readFile();}
  finally{await handle.close();}
}

async function acquireSnapshotLocks(directory,{lockTimeoutMs=5000}={}){
  if(!Number.isFinite(lockTimeoutMs)||lockTimeoutMs<1||lockTimeoutMs>60000)fail('Некорректное время ожидания блокировок.');
  const names=new Set(STORES);
  for(const entry of await readdir(directory,{withFileTypes:true})){
    if(entry.isFile()&&entry.name.endsWith('.json'))names.add(entry.name);
    if(entry.isDirectory()&&entry.name.endsWith('.json.lock'))names.add(entry.name.slice(0,-5));
  }
  const locks=[...names].sort().map(name=>path.join(directory,name+'.lock')),deadline=Date.now()+lockTimeoutMs;
  while(true){
    const held=[];let busy=false;
    try{
      // Never wait while holding a partial set: writers may legitimately nest store locks.
      for(const lock of locks){
        try{await mkdir(lock,{mode:0o700});held.push(lock);await writeFile(path.join(lock,'owner.json'),JSON.stringify({pid:process.pid,at:Date.now(),purpose:'backup'}),{mode:0o600});}
        catch(error){if(error.code==='EEXIST'){
          // A killed snapshot process can leave locks for otherwise idle stores.
          // Reclaim only locks with an identifiable process that no longer exists.
          try{const owner=JSON.parse(await readFile(path.join(lock,'owner.json'),'utf8'));if(Number.isInteger(owner.pid)&&owner.pid>0){try{process.kill(owner.pid,0);}catch(gone){if(gone.code==='ESRCH')await rm(lock,{recursive:true,force:true});}}}catch{}
          busy=true;break;
        }throw error;}
      }
      if(!busy)return async()=>{for(const lock of held.reverse())await rm(lock,{recursive:true,force:true});};
    }catch(error){for(const lock of held.reverse())await rm(lock,{recursive:true,force:true});throw error;}
    for(const lock of held.reverse())await rm(lock,{recursive:true,force:true});
    if(Date.now()>=deadline)fail('Не удалось получить согласованный снимок: база занята. Повторите резервное копирование.');
    await new Promise(resolve=>setTimeout(resolve,25));
  }
}

async function snapshot(directory){
  const files=[],skipped=[];let total=0;
  async function visit(relative=''){
    const entries=await readdir(path.join(directory,relative),{withFileTypes:true});
    for(const entry of entries.sort((a,b)=>a.name.localeCompare(b.name))){
      const name=relative?relative+'/'+entry.name:entry.name;
      if(!validName(name))fail('Неподдерживаемое имя файла в каталоге данных.');
      if(ignored(entry.name)){skipped.push(name);continue;}
      const target=path.join(directory,...name.split('/')),info=await lstat(target);
      if(info.isSymbolicLink())fail('Символические ссылки в каталоге данных не включаются в резервную копию.');
      if(info.isDirectory()){await visit(name);continue;}
      if(!info.isFile())fail('Неподдерживаемый тип файла в каталоге данных.');
      const content=await regularFile(target,MAX_FILE);total+=content.length;
      if(total>MAX_DATA||files.length>=MAX_FILES)fail('Превышен размер резервной копии: 64 МиБ данных или 1000 файлов.');
      if(name==='.security-key'&&content.length!==32)fail('Файл .security-key должен содержать 32 байта.');
      if(name.endsWith('.json')){try{JSON.parse(content.toString('utf8'));}catch{fail('Обнаружен некорректный JSON. Проверьте базу перед резервным копированием.');}}
      files.push({path:name,size:content.length,sha256:hash(content),content:content.toString('base64')});
    }
  }
  await visit();return {files,skipped};
}

function decodeBase64(value,size,label){
  if(typeof value!=='string'||value.length>MAX_PAYLOAD*2||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))fail('Некорректный '+label+'.');
  const bytes=Buffer.from(value,'base64');if(bytes.toString('base64')!==value||(size!==undefined&&bytes.length!==size))fail('Некорректный '+label+'.');return bytes;
}
async function encrypt(payload,passphrase){
  const salt=randomBytes(16),iv=randomBytes(12),header={format:'orbita-encrypted-backup',version:VERSION,createdAt:payload.createdAt,compression:'gzip',kdf:{...KDF,salt:salt.toString('base64')},cipher:{name:'aes-256-gcm',iv:iv.toString('base64')}};
  const headerBytes=Buffer.from(JSON.stringify(header)),length=Buffer.alloc(4);length.writeUInt32BE(headerBytes.length);
  const aad=Buffer.concat([MAGIC,length,headerBytes]),key=await scrypt(password(passphrase),salt,32,{N:KDF.N,r:KDF.r,p:KDF.p,maxmem:KDF_MEMORY});
  try{const compressed=await gzip(Buffer.from(JSON.stringify(payload)),{level:6}),cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(aad);return Buffer.concat([aad,cipher.update(compressed),cipher.final(),cipher.getAuthTag()]);}
  finally{key.fill(0);}
}
async function decrypt(filename,passphrase){
  password(passphrase);const bytes=await regularFile(await physical(filename),MAX_ARCHIVE),offset=MAGIC.length+4;
  if(bytes.length<offset+TAG_BYTES||!bytes.subarray(0,MAGIC.length).equals(MAGIC))fail('Неизвестный формат резервной копии.');
  const length=bytes.readUInt32BE(MAGIC.length);if(length<2||length>4096||offset+length+TAG_BYTES>=bytes.length)fail('Некорректный заголовок резервной копии.');
  let header;try{header=JSON.parse(bytes.subarray(offset,offset+length).toString('utf8'));}catch{fail('Некорректный заголовок резервной копии.');}
  if(header.format!=='orbita-encrypted-backup'||header.version!==VERSION||header.compression!=='gzip'||header.kdf?.name!==KDF.name||header.kdf?.N!==KDF.N||header.kdf?.r!==KDF.r||header.kdf?.p!==KDF.p||header.cipher?.name!=='aes-256-gcm'||!Number.isFinite(Date.parse(header.createdAt)))fail('Неподдерживаемый формат или параметры резервной копии.');
  const salt=decodeBase64(header.kdf.salt,16,'salt'),iv=decodeBase64(header.cipher.iv,12,'nonce'),key=await scrypt(passphrase,salt,32,{N:KDF.N,r:KDF.r,p:KDF.p,maxmem:KDF_MEMORY});
  let compressed;
  try{const decipher=createDecipheriv('aes-256-gcm',key,iv);decipher.setAAD(bytes.subarray(0,offset+length));decipher.setAuthTag(bytes.subarray(-TAG_BYTES));compressed=Buffer.concat([decipher.update(bytes.subarray(offset+length,-TAG_BYTES)),decipher.final()]);}
  catch{fail('Не удалось проверить резервную копию: неверная парольная фраза или файл повреждён.');}
  finally{key.fill(0);}
  let payload;try{payload=JSON.parse((await gunzip(compressed,{maxOutputLength:MAX_PAYLOAD})).toString('utf8'));}catch{fail('Некорректное или слишком большое содержимое резервной копии.');}
  if(payload?.format!=='orbita-data-snapshot'||payload.version!==VERSION||payload.createdAt!==header.createdAt||!Array.isArray(payload.files)||payload.files.length>MAX_FILES)fail('Некорректный манифест резервной копии.');
  const seen=new Set();let total=0;
  const files=payload.files.map(file=>{
    if(!file||!validName(file.path)||ignored(path.posix.basename(file.path))||!Number.isSafeInteger(file.size)||file.size<0||file.size>MAX_FILE||typeof file.sha256!=='string'||!/^([a-f0-9]{64})$/.test(file.sha256))fail('Некорректный путь или размер файла в резервной копии.');
    const name=file.path.toLowerCase();if(seen.has(name)||[...seen].some(previous=>name.startsWith(previous+'/')||previous.startsWith(name+'/')))fail('Повторяющиеся или пересекающиеся пути в резервной копии.');seen.add(name);
    const content=decodeBase64(file.content,file.size,'содержимое файла');total+=content.length;
    if(total>MAX_DATA||hash(content)!==file.sha256)fail('Контрольная сумма или размер файла не совпадает.');
    if(file.path==='.security-key'&&content.length!==32)fail('Некорректный файл .security-key в резервной копии.');
    if(file.path.endsWith('.json')){try{JSON.parse(content.toString('utf8'));}catch{fail('Некорректный JSON в резервной копии.');}}
    return {path:file.path,size:file.size,sha256:file.sha256,content};
  });
  return {createdAt:payload.createdAt,files,bytes:bytes.length,totalBytes:total};
}
const summary=archive=>({createdAt:archive.createdAt,files:archive.files.map(({path,size,sha256})=>({path,size,sha256})),bytes:archive.bytes,totalBytes:archive.totalBytes});

export async function createBackup({dataDir,backupDir,passphrase,publicDir=DEFAULT_PUBLIC,lockTimeoutMs=5000,keep}={}){
  password(passphrase);if(!dataDir)fail('Укажите каталог данных.');
  if(keep!==undefined&&(!Number.isInteger(keep)||keep<1||keep>10000))fail('--keep должен быть целым числом от 1 до 10000.');
  const directory=await physical(dataDir),info=await lstat(directory);if(!info.isDirectory())fail('Каталог данных не найден.');
  if(inside(await physical(publicDir),directory))fail('Каталог данных не должен находиться внутри public.');
  const destination=await backupDirectory(backupDir,{dataDir:directory,publicDir,create:true}),release=await acquireSnapshotLocks(directory,{lockTimeoutMs});
  let data;try{data=await snapshot(directory);}finally{await release();}
  const createdAt=new Date().toISOString(),bytes=await encrypt({format:'orbita-data-snapshot',version:VERSION,createdAt,files:data.files},passphrase);
  const name='orbita-'+createdAt.replace(/[-:.]/g,'')+'-'+randomUUID()+'.orbita-backup',filename=path.join(destination,name),temporary=filename+'.tmp';
  try{const handle=await open(temporary,'wx',0o600);try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}await rename(temporary,filename);}
  finally{await rm(temporary,{force:true});}
  const result={file:filename,createdAt,files:data.files.map(({path,size,sha256})=>({path,size,sha256})),bytes:bytes.length,totalBytes:data.files.reduce((total,file)=>total+file.size,0),skipped:data.skipped};
  if(keep!==undefined)result.retention=await pruneBackups({backupDir:destination,dataDir:directory,publicDir,passphrase,keep});
  return result;
}

export async function listBackups({backupDir,dataDir,publicDir=DEFAULT_PUBLIC}={}){
  const directory=await backupDirectory(backupDir,{dataDir,publicDir}),files=[];
  for(const entry of await readdir(directory,{withFileTypes:true}))if(entry.isFile()&&BACKUP_NAME.test(entry.name)){const info=await lstat(path.join(directory,entry.name));if(info.isFile()&&!info.isSymbolicLink())files.push({file:path.join(directory,entry.name),name:entry.name,bytes:info.size});}
  return files.sort((a,b)=>b.name.localeCompare(a.name));
}

export async function verifyBackup({file,passphrase}={}){if(!file)fail('Укажите файл резервной копии.');return summary(await decrypt(file,passphrase));}

export async function restoreBackup({file,destination,passphrase,publicDir=DEFAULT_PUBLIC}={}){
  if(!destination)fail('Восстановление требует явного пустого каталога --restore.');
  const archive=await decrypt(file,passphrase),target=await physical(destination),publicRoot=await physical(publicDir);
  if(target===path.parse(target).root||inside(publicRoot,target))fail('Восстановление в public или корень файловой системы запрещено.');
  let existed=false;
  try{const info=await lstat(target);if(!info.isDirectory()||info.isSymbolicLink()||(await readdir(target)).length)fail('Каталог восстановления должен быть пустым. Существующие данные не перезаписываются.');existed=true;}
  catch(error){if(error.code!=='ENOENT')throw error;}
  const parent=await privateDirectory(path.dirname(target)),stage=await mkdtemp(path.join(parent,'.orbita-restore-'));let committed=false,removedEmpty=false;
  try{
    for(const item of archive.files){
      const filename=path.join(stage,...item.path.split('/'));await mkdir(path.dirname(filename),{recursive:true,mode:0o700});
      const handle=await open(filename,'wx',0o600);try{await handle.writeFile(item.content);await handle.sync();}finally{await handle.close();}
    }
    // rmdir refuses a directory that acquired files after the initial check.
    if(existed){await rmdir(target);removedEmpty=true;}
    else {try{await lstat(target);fail('Каталог восстановления появился во время операции. Повторите с другим пустым каталогом.');}catch(error){if(error.code!=='ENOENT')throw error;}}
    await rename(stage,target);committed=true;return {destination:target,...summary(archive)};
  }finally{
    if(!committed){await rm(stage,{recursive:true,force:true});if(removedEmpty)await mkdir(target,{mode:0o700}).catch(error=>{if(error.code!=='EEXIST')throw error;});}
  }
}

export async function pruneBackups({backupDir,dataDir,publicDir=DEFAULT_PUBLIC,passphrase,keep}={}){
  password(passphrase);if(!Number.isInteger(keep)||keep<1||keep>10000)fail('--keep должен быть целым числом от 1 до 10000.');
  const files=await listBackups({backupDir,dataDir,publicDir}),removed=[],skipped=[];
  for(const item of files.slice(keep)){
    try{await decrypt(item.file,passphrase);}catch{skipped.push(item.name);continue;}
    await rm(item.file);removed.push(item.name);
  }
  return {removed,skipped};
}
