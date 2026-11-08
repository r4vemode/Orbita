import {open,rename,rm,lstat} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {constants} from 'node:fs';

export async function readPrivateJson(file,validate,{maxBytes=32*1024*1024}={}){
  let handle;
  try{
    const info=await lstat(file);if(!info.isFile()||info.isSymbolicLink()||info.size>maxBytes)throw Object.assign(Error('Unsafe storage file'),{code:'DATA_UNSAFE'});
    handle=await open(file,constants.O_RDONLY|(constants.O_NOFOLLOW||0));const actual=await handle.stat();if(!actual.isFile()||actual.size>maxBytes)throw Object.assign(Error('Unsafe storage file'),{code:'DATA_UNSAFE'});
    const bytes=await handle.readFile();if(bytes.length>maxBytes)throw Object.assign(Error('Oversized storage file'),{code:'DATA_UNSAFE'});
    const data=JSON.parse(bytes.toString('utf8'));if(!validate(data))throw Object.assign(Error('Invalid storage data'),{code:'DATA_INVALID'});return data;
  }catch(cause){if(cause instanceof SyntaxError)throw Object.assign(Error('Invalid storage JSON'),{code:'DATA_INVALID'});throw cause;}
  finally{await handle?.close();}
}

// Callers own the transaction lock. A successful return means the file and
// directory entry were flushed, not merely replaced in the OS page cache.
export async function syncDirectory(directory){
  let handle;
  try{handle=await open(directory,'r');await handle.sync();}
  catch(cause){
    // Windows does not expose directory fsync through Node. Do not conceal
    // durability errors on the Linux production deployment.
    if(process.platform!=='win32'||!['EPERM','EISDIR','EINVAL','ENOTSUP'].includes(cause.code))throw cause;
  }finally{await handle?.close();}
}
export async function writeDurable(file,bytes){
  try{const info=await lstat(file);if(!info.isFile()||info.isSymbolicLink())throw Object.assign(Error('Unsafe storage target'),{code:'DATA_UNSAFE'});}
  catch(cause){if(cause.code!=='ENOENT')throw cause;}
  const temporary=file+'.tmp-'+randomUUID();let handle;
  try{
    handle=await open(temporary,'wx',0o600);await handle.writeFile(bytes);await handle.sync();await handle.close();handle=null;
    await rename(temporary,file);await syncDirectory(path.dirname(file));
  }finally{await handle?.close();await rm(temporary,{force:true});}
}
