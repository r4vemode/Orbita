import test from 'node:test';
import assert from 'node:assert/strict';
import {createContent} from '../lib/content.mjs';
import {serviceFixture} from './service-fixture.mjs';

const body={
  kind:'article',title:'Разбор редакции',category:'Практика',intro:'Краткое описание',
  sections:[{title:'Контекст',text:'Проверяемый текст.'}],
  sources:['https://example.test/source'],attachmentUrl:'https://example.test/report.pdf',
  tickers:['SBER'],access:'exclusive',published:false
};

test('website editorial links respect current audience and retain shared material after restart',async t=>{
  const fixture=await serviceFixture(({directory,accounts})=>createContent(directory,{accounts}));
  t.after(()=>fixture.close());
  const owner=await fixture.register('editorial-owner@example.test');
  const pro=await fixture.register('editorial-pro@example.test');
  const exclusive=await fixture.register('editorial-exclusive@example.test');
  await fixture.accounts.promote(owner.data.user.email);
  for(const [account,plan] of [[pro,'pro'],[exclusive,'exclusive']]){
    const granted=await fixture.request('/api/admin/subscriptions',{
      method:'POST',cookie:owner.cookie,body:{userId:account.data.user.id,plan,reason:'Editorial fixture',expiresAt:new Date(Date.now()+3600000).toISOString()}
    });
    assert.equal(granted.status,200);
  }
  const create=(lesson,revision)=>fixture.request('/api/admin/content',{
    method:'POST',cookie:owner.cookie,body:{revision,lesson}
  });
  const edit=(id,lesson,revision)=>fixture.request('/api/admin/content/'+id,{
    method:'PUT',cookie:owner.cookie,body:{revision,lesson}
  });
  const list=options=>fixture.request('/api/articles',options);
  const invalid=await create({...body,attachmentUrl:'javascript:alert(1)'},0);
  assert.equal(invalid.status,400);
  const draft=await create(body,0);
  assert.equal(draft.status,201);
  const {id}=draft.data.lesson;
  const read=account=>fixture.request('/api/articles/'+id,{cookie:account?.cookie});
  assert.equal((await read(exclusive)).status,404);

  const published=await edit(id,{...body,published:true},draft.data.revision);
  assert.equal(published.status,200);
  assert.equal((await read()).status,404);
  assert.equal((await read(pro)).status,404);
  assert.deepEqual((await list({cookie:pro.cookie})).data.lessons,[]);
  const reader=await read(exclusive);
  assert.equal(reader.status,200);
  assert.equal(reader.data.lesson.attachmentUrl,body.attachmentUrl);
  assert.deepEqual(reader.data.lesson.sources,body.sources);
  assert.ok(!Object.hasOwn(reader.data.lesson,'createdBy'));

  const disk=await createContent(fixture.directory);
  const user=await fixture.accounts.getUser(exclusive.data.user.id);
  const restored=await disk.readArticle(user,id);
  assert.deepEqual(restored,reader.data);
  const opened=await edit(id,{...body,access:'public',published:true},published.data.revision);
  assert.equal(opened.status,200);
  assert.equal((await read()).status,200);
  assert.deepEqual((await list()).data.lessons.map(lesson=>lesson.id),[id]);
  const withdrawn=await edit(id,{...body,access:'public'},opened.data.revision);
  assert.equal(withdrawn.status,200);
  assert.equal((await read(exclusive)).status,404);
  assert.deepEqual((await list()).data.lessons,[]);
});
