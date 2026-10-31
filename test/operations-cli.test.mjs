import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink,stat,readdir,cp,truncate} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {importNews} from '../scripts/import-news.mjs';
import {createReadiness} from '../lib/operations.mjs';

const project=fileURLToPath(new URL('../',import.meta.url));
async function fixture(t){const root=await mkdtemp(path.join(tmpdir(),'orbita-cli-audit-')),directory=path.join(root,'data'),publicDir=path.join(root,'public'),source=path.join(root,'feed.json');await mkdir(directory,{mode:0o700});await mkdir(publicDir,{mode:0o700});await writeFile(source,JSON.stringify({items:[{id:'approved-test',title:'Approved isolated item',source:'Fixture',publishedAt:new Date().toISOString(),url:'https://example.test/item',topics:['stocks']}]}));t.after(()=>rm(root,{recursive:true,force:true}));return {root,directory,publicDir,source};}

test('news import uses a private atomic file and failed input never replaces the previous feed',async t=>{
 const f=await fixture(t);assert.deepEqual(await importNews(f.source,f),{imported:1});const target=path.join(f.directory,'news.json'),before=await readFile(target);assert.equal((await stat(target)).mode&0o777,0o600);
 await writeFile(f.source,'{"items":"invalid"}');await assert.rejects(importNews(f.source,f));assert.deepEqual(await readFile(target),before);
 await writeFile(f.source,'{}');await truncate(f.source,1048577);await assert.rejects(importNews(f.source,f),/1 МиБ/);assert.deepEqual(await readFile(target),before);
 assert.deepEqual(await readdir(f.directory),['news.json']);
});

test('news import rejects public directories and symlink substitutions without changing their targets',async t=>{
 const f=await fixture(t);await assert.rejects(importNews(f.source,{...f,directory:path.join(f.publicDir,'feed')}),/вне public/);
 const alias=path.join(f.root,'alias');await symlink(f.directory,alias);await assert.rejects(importNews(f.source,{...f,directory:alias}),/приватный/);
 const target=path.join(f.directory,'news.json'),outside=path.join(f.root,'outside.json');await writeFile(outside,'preserve this file');await symlink(outside,target);await assert.rejects(importNews(f.source,f),/обычным приватным файлом/);assert.equal(await readFile(outside,'utf8'),'preserve this file');
});

test('readiness cannot report ready after shutdown begins while a probe is still running',async t=>{
 const f=await fixture(t),readiness=createReadiness({...f,env:{}}),probe=readiness.status();readiness.setDraining();const result=await probe;assert.equal(result.ready,false);assert.equal(result.draining,true);assert.equal((await readiness.status()).ready,false);
});

test('local operator commands reject public data locations and production demo import before writing records',async t=>{
 const f=await fixture(t),copy=path.join(f.root,'project');await mkdir(path.join(copy,'scripts'),{recursive:true});
 await cp(path.join(project,'lib'),path.join(copy,'lib'),{recursive:true});await cp(path.join(project,'public'),path.join(copy,'public'),{recursive:true});await cp(path.join(project,'fixtures'),path.join(copy,'fixtures'),{recursive:true});await cp(path.join(project,'package.json'),path.join(copy,'package.json'));
 for(const name of ['manage-access.mjs','seed-demo.mjs'])await cp(path.join(project,'scripts',name),path.join(copy,'scripts',name));
 const run=(script,args,env)=>new Promise((resolve,reject)=>{let stderr='';const child=spawn(process.execPath,[path.join(copy,'scripts',script),...args],{cwd:copy,env:{PATH:process.env.PATH,...env},stdio:['ignore','ignore','pipe']});child.stderr.on('data',chunk=>stderr+=chunk);child.once('error',reject);child.once('exit',code=>resolve({code,stderr}));});
 for(const script of ['manage-access.mjs','seed-demo.mjs']){const directory=path.join(copy,'public','private-data'),result=await run(script,script==='manage-access.mjs'?['admin','operator@example.test']:[],{ORBITA_DATA_DIR:directory});assert.equal(result.code,1);assert.match(result.stderr,/приватный|вне public/);await assert.rejects(readFile(path.join(directory,script==='manage-access.mjs'?'accounts.json':'ideas.json')),cause=>cause.code==='ENOENT');}
 const production=path.join(f.root,'production-data'),blocked=await run('seed-demo.mjs',[],{NODE_ENV:'production',ORBITA_DATA_DIR:production});assert.equal(blocked.code,1);assert.match(blocked.stderr,/локальной/);await assert.rejects(stat(production),cause=>cause.code==='ENOENT');
});
