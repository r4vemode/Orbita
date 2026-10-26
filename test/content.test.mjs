import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,stat} from 'node:fs/promises';
import path from 'node:path';
import {createContent,validateContentDatabase} from '../lib/content.mjs';
import {serviceFixture} from './service-fixture.mjs';

const material=(extra={})=>({title:'Новый разбор',category:'Практика',intro:'Краткое описание материала.',sections:[{title:'Контекст',text:'Текст с пояснением условий.'}],access:'member',published:false,...extra});
async function fixture(){
  const f=await serviceFixture(({directory})=>createContent(directory));
  f.admin=await f.register('content-admin@example.test');await f.accounts.promote(f.admin.data.user.email);
  f.pro=await f.register('content-pro@example.test');f.exclusive=await f.register('content-exclusive@example.test');f.unpaid=await f.register('content-unpaid@example.test');
  for(const [account,plan]of[[f.pro,'pro'],[f.exclusive,'exclusive']]){
    const response=await f.request('/api/admin/subscriptions',{method:'POST',cookie:f.admin.cookie,body:{userId:account.data.user.id,plan,expiresAt:new Date(Date.now()+86400000).toISOString(),reason:'Content access test'}});assert.equal(response.status,200);
  }
  f.list=()=>f.request('/api/admin/content',{cookie:f.admin.cookie});
  f.create=(lesson,revision)=>f.request('/api/admin/content',{method:'POST',cookie:f.admin.cookie,body:{revision,lesson}});
  f.update=(id,lesson,revision)=>f.request('/api/admin/content/'+id,{method:'PUT',cookie:f.admin.cookie,body:{revision,lesson}});
  return f;
}

test('content API protects drafts and explicit Exclusive access independently of lesson IDs',async()=>{
  const f=await fixture();try{
    for(const route of ['/api/lessons','/api/admin/content'])assert.equal((await f.request(route)).status,401);
    assert.equal((await f.request('/api/lessons',{cookie:f.unpaid.cookie})).status,403);
    for(const account of [f.pro,f.exclusive,f.unpaid]){
      assert.equal((await f.request('/api/admin/content',{cookie:account.cookie})).status,403);
      assert.equal((await f.request('/api/admin/content',{method:'POST',cookie:account.cookie,body:{revision:0,lesson:material()}})).status,403);
    }
    const initial=(await f.list()).data;assert.equal(initial.revision,0);assert.ok(initial.lessons.some(lesson=>lesson.id==='orbita-first-steps'));assert.ok(initial.lessons.find(lesson=>lesson.id==='exclusive-trend').access==='exclusive');
    const draft=await f.create(material({title:'PRIVATE_DRAFT'}),0);assert.equal(draft.status,201);
    const exclusive=await f.create(material({title:'EXCLUSIVE_ARTICLE',access:'exclusive',published:true}),1);assert.equal(exclusive.status,201);assert.ok(!exclusive.data.lesson.id.startsWith('exclusive-'));
    const base=await f.create(material({title:'BASIC_ARTICLE',published:true}),2);assert.equal(base.status,201);
    for(const account of [f.pro,f.exclusive]){
      const response=await f.request('/api/lessons',{cookie:account.cookie});assert.equal(response.status,200);assert.ok(!JSON.stringify(response.data).includes('PRIVATE_DRAFT'));assert.ok(response.data.lessons.some(lesson=>lesson.title==='BASIC_ARTICLE'));assert.ok(response.data.lessons.every(lesson=>!Object.hasOwn(lesson,'createdBy')));
      assert.equal(response.data.lessons.some(lesson=>lesson.title==='EXCLUSIVE_ARTICLE'),account===f.exclusive);
    }
    const adminPublished=await f.request('/api/lessons',{cookie:f.admin.cookie});assert.ok(adminPublished.data.lessons.some(lesson=>lesson.title==='EXCLUSIVE_ARTICLE'));assert.ok(!JSON.stringify(adminPublished.data).includes('PRIVATE_DRAFT'));
    assert.ok((await f.list()).data.lessons.some(lesson=>lesson.title==='PRIVATE_DRAFT'));
  }finally{await f.close();}
});

test('content edits survive recreation, retain immutable metadata and can be unpublished',async()=>{
  const f=await fixture();try{
    const created=(await f.create(material({published:true}),0)).data;
    const saved=await f.update(created.lesson.id,material({title:'<b>Это обычный текст</b>',published:true}),created.revision);assert.equal(saved.status,200);
    assert.equal(saved.data.lesson.createdAt,created.lesson.createdAt);assert.equal(saved.data.lesson.createdBy,created.lesson.createdBy);assert.equal(saved.data.lesson.id,created.lesson.id);
    const restarted=await createContent(f.directory),admin=await f.accounts.getUser(f.admin.data.user.id),rows=await restarted.readAdmin(admin);
    assert.equal(rows.revision,2);assert.equal(rows.lessons.find(lesson=>lesson.id===created.lesson.id).title,'<b>Это обычный текст</b>');
    const hidden=await f.update(created.lesson.id,material({published:false}),2);assert.equal(hidden.status,200);
    const member=await f.request('/api/lessons',{cookie:f.pro.cookie});assert.ok(!member.data.lessons.some(lesson=>lesson.id===created.lesson.id));
    assert.ok((await f.list()).data.lessons.some(lesson=>lesson.id===created.lesson.id));
    const bytes=await readFile(path.join(f.directory,'content.json'),'utf8');assert.equal(validateContentDatabase(JSON.parse(bytes)),true);
    if(process.platform!=='win32')assert.equal((await stat(path.join(f.directory,'content.json'))).mode&0o077,0);
  }finally{await f.close();}
});

test('stale revisions and concurrent instances cannot overwrite another content edit',async()=>{
  const f=await fixture();try{
    const other=await createContent(f.directory),admin=await f.accounts.getUser(f.admin.data.user.id);
    const outcomes=await Promise.allSettled([f.service.save(admin,{revision:0,lesson:material({title:'Первый'})}),other.save(admin,{revision:0,lesson:material({title:'Второй'})})]);
    assert.equal(outcomes.filter(value=>value.status==='fulfilled').length,1);assert.equal(outcomes.find(value=>value.status==='rejected').reason.status,409);
    const rows=(await f.list()).data;assert.equal(rows.revision,1);assert.equal(rows.lessons.filter(lesson=>['Первый','Второй'].includes(lesson.title)).length,1);
    const stale=await f.create(material(),0);assert.equal(stale.status,409);assert.equal((await f.list()).data.revision,1);
  }finally{await f.close();}
});

test('malformed material and forged metadata never mutate stored content',async()=>{
  const f=await fixture();try{
    const invalid=[material({title:''}),material({category:'x'.repeat(61)}),material({access:'pro'}),material({published:'true'}),material({sections:[]}),material({sections:Array.from({length:21},()=>({title:'A',text:'B'}))}),material({sections:[{title:'A',text:'B',html:'<script>'}]}),material({id:'forged'}),material({createdBy:'forged'}),material({intro:'a\u0000b'})];
    for(const lesson of invalid)assert.equal((await f.create(lesson,0)).status,400);
    assert.equal((await f.create(material(),undefined)).status,400);
    assert.equal((await f.update('missing-lesson',material(),0)).status,404);
    const huge=material({sections:[{title:'A',text:'я'.repeat(40000)}]});assert.equal((await f.create(huge,0)).status,413);
    assert.equal((await f.list()).data.revision,0);
    await assert.rejects(readFile(path.join(f.directory,'content.json')),cause=>cause.code==='ENOENT');
  }finally{await f.close();}
});
