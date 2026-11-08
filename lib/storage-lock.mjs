import {open,readFile,lstat,rm} from 'node:fs/promises';
import path from 'node:path';

// Serialize *recovery* as well as normal acquisition. Without this guard two
// readers of a dead PID can delete the next writer's newly acquired lock.
// An abandoned recovery guard is deliberately fail-closed: an operator may
// remove it only after stopping every writer (documented in operations).
export async function reclaimAbandonedLock(lock){
 const guard=lock+'.reclaim';let handle;
 try{handle=await open(guard,'wx',0o600);}catch(cause){if(cause.code==='EEXIST')return false;throw cause;}
 try{
  await handle.writeFile(JSON.stringify({pid:process.pid,createdAt:new Date().toISOString()}));
  let abandoned=false;
  try{
   const file=path.join(lock,'owner.json'),info=await lstat(file);if(!info.isFile()||info.isSymbolicLink()||info.size>1024)return false;
   const owner=JSON.parse(await readFile(file,'utf8'));if(!Number.isSafeInteger(owner.pid)||owner.pid<=0)return false;
   try{process.kill(owner.pid,0);}catch(cause){if(cause.code==='ESRCH')abandoned=true;else if(cause.code!=='EPERM')throw cause;}
  }catch(cause){
   if(cause.code!=='ENOENT')return false;
   try{const info=await lstat(lock);abandoned=info.isDirectory()&&!info.isSymbolicLink()&&Date.now()-info.mtimeMs>30000;}catch(missing){if(missing.code==='ENOENT')return false;throw missing;}
  }
  if(!abandoned)return false;await rm(lock,{recursive:true,force:true});return true;
 }finally{await handle?.close();await rm(guard,{force:true});}
}
