import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {createContent} from '../lib/content.mjs';
import {createProductSettings,defaultProductSettings} from '../lib/product-settings.mjs';
import {createLegal} from '../lib/legal.mjs';
import {serviceFixture} from './service-fixture.mjs';

const material={title:'Учебный разбор',category:'Практика',intro:'Контекст.',sections:[{title:'Раздел',text:'Учебный текст.'}],access:'member',published:false};
async function pausedUpload(f,account,route,method,payload){
 const original=f.accounts.identify;let reached,seen=false;
 const captured=new Promise(resolve=>{reached=resolve;});
 f.accounts.identify=async req=>{const actor=await original(req);if(req.url===route&&!seen){seen=true;reached();}return actor;};
 const bytes=Buffer.from(JSON.stringify(payload));let request;
 const result=new Promise((resolve,reject)=>{
  request=http.request(new URL(route,f.base),{method,headers:{Origin:f.base,Cookie:account.cookie,'Content-Type':'application/json','Content-Length':bytes.length}},response=>{const chunks=[];response.on('data',chunk=>chunks.push(chunk));response.on('end',()=>{try{resolve({status:response.statusCode,data:JSON.parse(Buffer.concat(chunks).toString('utf8'))});}catch(cause){reject(cause);}});});request.once('error',reject);request.write(bytes.subarray(0,1));
 });
 // The server has authenticated the headers, but is still waiting for the body.
 let timer;try{await Promise.race([captured,new Promise((_resolve,reject)=>{timer=setTimeout(()=>reject(Error('The paused request was not authenticated')),3000);})]);}catch(cause){request.destroy();await result.catch(()=>{});throw cause;}finally{clearTimeout(timer);}
 return {async finish(){request.end(bytes.subarray(1));try{return await result;}finally{f.accounts.identify=original;}},abort(){request.destroy();f.accounts.identify=original;}};
}

test('editor mutations recheck administrator authority after a paused HTTP upload before changing content, settings or legal data',async()=>{
 const routes=['content-create','content-update','settings','legal-draft','legal-publish'];
 for(const mutation of ['role','session'])for(const kind of routes){
  let publicationChecks=0;
  const f=await serviceFixture(async({directory,accounts})=>{
   const content=await createContent(directory,{accounts}),settings=await createProductSettings(directory,{accounts}),legal=await createLegal(directory,{accounts,authorizePublish:async req=>{publicationChecks++;return accounts.identify(req);}});
   return {webhookPaths:[],content,settings,legal,async handle(req,res,url,user){return await content.handle(req,res,url,user)||await settings.handle(req,res,url,user)||await legal.handle(req,res,url,user);},async close(){await content.close();await legal.close();}};
  });
  let upload;
  try{
   const owner=await f.register('editor-race@example.test');await f.accounts.promote(owner.data.user.email);const admin=await f.accounts.getUser(owner.data.user.id),created=await f.service.content.save(admin,{revision:0,lesson:material});
   const contentBefore=await readFile(path.join(f.directory,'content.json'),'utf8');
   const [route,method,payload]=kind==='content-create'?['/api/admin/content','POST',{revision:1,lesson:{...material,title:'Не создавать'}}]:kind==='content-update'?['/api/admin/content/'+created.lesson.id,'PUT',{revision:1,lesson:{...material,title:'Не заменять'}}]:kind==='settings'?['/api/admin/settings','PUT',{revision:0,settings:{...defaultProductSettings(),authorName:'Не сохранять'}}]:kind==='legal-draft'?['/api/admin/legal','PUT',{revision:0,profile:{ownerName:'Не сохранять'}}]:['/api/admin/legal/publish','POST',{revision:0,password:'isolated-publication-password'}];
   upload=await pausedUpload(f,owner,route,method,payload);
   await f.accounts.transact(db=>{if(mutation==='role')db.users.find(user=>user.id===owner.data.user.id).role='member';else db.sessions=db.sessions.filter(session=>session.userId!==owner.data.user.id);});
   const response=await upload.finish();assert.equal(response.status,mutation==='role'?403:401,kind+' / '+mutation);assert.equal(publicationChecks,0);
   assert.equal(await readFile(path.join(f.directory,'content.json'),'utf8'),contentBefore);
   for(const file of ['product-settings.json','legal.json'])await assert.rejects(readFile(path.join(f.directory,file)),cause=>cause.code==='ENOENT');
  }finally{upload?.abort();await f.close();}
 }
});
