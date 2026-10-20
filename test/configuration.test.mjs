import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
async function rejected(directory){const child=spawn(process.execPath,['server.mjs'],{cwd:root,env:{...process.env,PORT:'0',ORBITA_DATA_DIR:directory},stdio:['ignore','pipe','pipe']});let output='';child.stderr.on('data',b=>output+=b);const code=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{child.kill();reject(Error('Unsafe data directory was not rejected.'));},10000);child.on('error',reject);child.on('exit',c=>{clearTimeout(timer);resolve(c);});});assert.notEqual(code,0);assert.match(output,/вне публичной папки public/);}
test('server refuses account storage in the public tree, including symlink aliases',async()=>{const temporary=await mkdtemp(join(tmpdir(),'orbita-config-'));try{const publicDirectory=join(root,'public');await rejected(publicDirectory);const alias=join(temporary,'alias');await symlink(publicDirectory,alias,'dir');await rejected(alias);}finally{await rm(temporary,{recursive:true,force:true});}});
