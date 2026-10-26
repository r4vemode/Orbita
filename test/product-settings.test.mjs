import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createProductSettings,defaultProductSettings,validateProductSettingsDatabase} from '../lib/product-settings.mjs';
import {serviceFixture} from './service-fixture.mjs';

async function fixture(){const f=await serviceFixture(({directory})=>createProductSettings(directory));const admin=await f.register('settings-owner@example.test');await f.accounts.promote(admin.data.user.email);return {...f,admin};}
test('public settings stay empty until an administrator saves shared values',async()=>{
 const f=await fixture();try{
  const initial=await f.request('/api/product-settings');assert.equal(initial.status,200);assert.deepEqual(initial.data,defaultProductSettings());
  assert.equal((await f.request('/api/admin/settings')).status,401);const member=await f.register('settings-member@example.test');assert.equal((await f.request('/api/admin/settings',{cookie:member.cookie})).status,403);
  const settings=defaultProductSettings();settings.supportEmail='support@example.test';settings.authorName='Редакция ORBITA';settings.editorialNote='Обзор по понедельникам; сигналы при появлении условий.';settings.partnerOffers[0]={id:'stocks',markets:['stocks'],name:'Тестовый партнёр',url:'https://broker.example.test/ref?orbita=1'};
  assert.equal((await f.request('/api/admin/settings',{method:'PUT',cookie:member.cookie,body:{revision:0,settings}})).status,403);
  const saved=await f.request('/api/admin/settings',{method:'PUT',cookie:f.admin.cookie,body:{revision:0,settings}});assert.equal(saved.status,200);assert.equal(saved.data.revision,1);
  assert.deepEqual((await f.request('/api/product-settings')).data,settings);const second=await createProductSettings(f.directory);assert.deepEqual(await second.readPublic(),settings);
  assert.deepEqual(Object.keys((await f.request('/api/product-settings')).data).sort(),['authorName','editorialNote','partnerOffers','supportEmail']);
  const db=JSON.parse(await readFile(join(f.directory,'product-settings.json'),'utf8'));assert.equal(validateProductSettingsDatabase(db),true);assert.equal(db.updatedBy,f.admin.data.user.id);
 }finally{await f.close();}
});
test('settings reject secret injection, unsafe referrals, malformed fields and stale revisions without mutation',async()=>{
 const f=await fixture();try{
  const settings=defaultProductSettings(),save=body=>f.request('/api/admin/settings',{method:'PUT',cookie:f.admin.cookie,body});
  for(const patch of [{apiSecret:'secret'},{CLOUDPAYMENTS_API_SECRET:'secret'},{price:1},{supportEmail:'bad email'},{authorName:'x'.repeat(101)},{editorialNote:'x'.repeat(1201)}])assert.equal((await save({revision:0,settings:{...settings,...patch}})).status,400);
  for(const url of ['javascript:alert(1)','http://broker.example.test','https://user:password@broker.example.test']){const next=structuredClone(settings);next.partnerOffers[0]={id:'stocks',markets:['stocks'],name:'Партнёр',url};assert.equal((await save({revision:0,settings:next})).status,400);}
  const next=structuredClone(settings);next.partnerOffers[0].url='https://broker.example.test';assert.equal((await save({revision:0,settings:next})).status,400);
  assert.equal((await save({revision:0,settings,unexpected:true})).status,400);assert.equal((await save({revision:0,settings})).status,200);assert.equal((await save({revision:0,settings:{...settings,authorName:'Stale'}})).status,409);
  assert.deepEqual((await f.request('/api/product-settings')).data,settings);
 }finally{await f.close();}
});
test('separate settings stores serialize writers and reload the winning revision',async()=>{
 const f=await fixture();try{
  const a=await createProductSettings(f.directory),b=await createProductSettings(f.directory),admin={id:f.admin.data.user.id,role:'admin'},settings=defaultProductSettings();
  const results=await Promise.allSettled([a.updateAdmin(admin,{revision:0,settings:{...settings,authorName:'First'}}),b.updateAdmin(admin,{revision:0,settings:{...settings,authorName:'Second'}})]);
  assert.equal(results.filter(result=>result.status==='fulfilled').length,1);assert.equal(results.find(result=>result.status==='rejected').reason.status,409);assert.deepEqual(await a.readPublic(),await b.readPublic());
 }finally{await f.close();}
});
