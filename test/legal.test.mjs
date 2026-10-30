import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm,copyFile,lstat,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createLegal,defaultLegalProfile,legalReadiness,validateLegalDatabase} from '../lib/legal.mjs';
import {LEGAL_VERSION} from '../lib/access.mjs';
import {error} from '../lib/http.mjs';
import {serviceFixture} from './service-fixture.mjs';

const admin={id:'legal-editor',role:'admin'},member={id:'member',role:'member',subscriptions:[]};
const checkDigit=(prefix,weights)=>String(weights.reduce((sum,weight,index)=>sum+weight*Number(prefix[index]),0)%11%10);
const inn10=prefix=>prefix+checkDigit(prefix,[2,4,10,3,5,9,4,6,8]);
const inn12=prefix=>{const first=prefix+checkDigit(prefix,[7,2,4,10,3,5,9,4,6,8]);return first+checkDigit(first,[3,7,2,4,10,3,5,9,4,6,8]);};
const ogrn=(prefix,divisor)=>prefix+String(BigInt(prefix)%BigInt(divisor)%10n);
const fixtureProfile=(extra={})=>({...defaultLegalProfile(),ownerKind:'self-employed',ownerName:'Учебный исполнитель',inn:inn12('9900000000'),address:'Учебный адрес для изолированной проверки',supportEmail:'support@example.test',privacyEmail:'privacy@example.test',hostingDetails:'Учебный поставщик, учебная страна и адрес; не настоящее размещение.',processorsDetails:'Учебная проверка: внешние обработчики не подключены, сообщения не отправляются.',...extra});
const rejected=(promise,status)=>assert.rejects(promise,cause=>cause.status===status);
const baseline=JSON.parse(await readFile(new URL('../fixtures/legal-baseline.json',import.meta.url),'utf8'));
async function fixture(t){const directory=await mkdtemp(path.join(tmpdir(),'orbita-legal-'));t.after(()=>rm(directory,{recursive:true,force:true}));return {directory,legal:await createLegal(directory)};}

test('legal public defaults and the exact original consent document never disclose a private draft',async t=>{
  const {directory,legal}=await fixture(t);
  assert.deepEqual(await legal.readPublic(),{version:LEGAL_VERSION,published:false,publishedAt:null,profile:defaultLegalProfile()});
  await assert.rejects(lstat(path.join(directory,'legal.json')),{code:'ENOENT'});
  const draft=await legal.saveDraft(admin,{revision:0,profile:{ownerName:'PRIVATE DRAFT OWNER',inn:'99'}});
  assert.equal(draft.revision,1);assert.equal(draft.currentVersion,null);assert.equal(draft.readiness.ready,false);assert.equal(draft.draft.ownerName,'PRIVATE DRAFT OWNER');
  assert.deepEqual((await legal.readPublic()).profile,defaultLegalProfile());
  for(const document of ['offer','privacy','refunds']){
    assert.equal(await legal.renderPage(document),baseline.pages[document]);assert.equal(await legal.renderPage(document,{version:LEGAL_VERSION}),baseline.pages[document]);
    assert.ok(!(await legal.renderPage(document)).includes('PRIVATE DRAFT OWNER'));
  }
  await rejected(legal.readAdmin(null),401);await rejected(legal.readAdmin(member),403);await rejected(legal.saveDraft(member,{revision:1,profile:{}}),403);await rejected(legal.previewPage(member,'offer'),403);
});

test('legal publication checks identifiers, contact formats and declared hosting before publishing',async t=>{
  const {legal}=await fixture(t),valid=fixtureProfile();assert.equal(legalReadiness(valid).ready,true);
  for(const profile of [fixtureProfile({ownerKind:'company',inn:inn10('990000000'),ogrn:ogrn('120000000000',11)}),fixtureProfile({ownerKind:'ip',ogrn:ogrn('32000000000000',13)})])assert.equal(legalReadiness(profile).ready,true);
  let revision=0;
  for(const invalid of [fixtureProfile({inn:valid.inn.slice(0,-1)+String((Number(valid.inn.at(-1))+1)%10)}),fixtureProfile({ogrn:ogrn('32000000000000',13)}),fixtureProfile({hostingDetails:''}),fixtureProfile({processorsDetails:''}),fixtureProfile({privacyEmail:'not-an-email'}),fixtureProfile({supportEmail:'support@..example'}),fixtureProfile({ownerKind:'company',inn:valid.inn,ogrn:ogrn('120000000000',11)}),fixtureProfile({ownerKind:'ip',ogrn:'320000000000009'})]){
    const draft=await legal.saveDraft(admin,{revision,profile:invalid});revision=draft.revision;assert.equal(draft.readiness.ready,false);await rejected(legal.publish(admin,{revision}),400);assert.equal((await legal.readAdmin(admin)).revision,revision);
  }
  assert.equal((await legal.readPublic()).published,false);
});

test('legal drafts reject secret injection, malformed fields and stale revisions without writes',async t=>{
  const {directory,legal}=await fixture(t),saved=await legal.saveDraft(admin,{revision:0,profile:fixtureProfile()}),before=await readFile(path.join(directory,'legal.json'),'utf8');
  for(const profile of [fixtureProfile({apiSecret:'do-not-store'}),fixtureProfile({ownerName:123}),fixtureProfile({inn:null}),fixtureProfile({ownerName:'a'.repeat(301)}),fixtureProfile({address:'unsafe\u0000address'}),fixtureProfile({inn:'99a'}),fixtureProfile({ownerKind:'admin'}),fixtureProfile({hostingDetails:'a'.repeat(1501)}),fixtureProfile({processorsDetails:'a'.repeat(4001)})])await rejected(legal.saveDraft(admin,{revision:saved.revision,profile}),400);
  await rejected(legal.saveDraft(admin,{revision:0,profile:fixtureProfile({ownerName:'stale'})}),409);await rejected(legal.publish(admin,{revision:0}),409);
  assert.equal(await readFile(path.join(directory,'legal.json'),'utf8'),before);assert.equal(validateLegalDatabase(JSON.parse(before)),true);
  if(process.platform!=='win32')assert.equal((await lstat(path.join(directory,'legal.json'))).mode&0o077,0);
});

test('published documents escape profile text and preserve every old version and original baseline',async t=>{
  const {directory,legal}=await fixture(t),profile=fixtureProfile({ownerName:'Учебный <script>window.bad=1</script> $&',address:'Адрес <img src=x onerror=window.bad=1>',processorsDetails:'Обработчики: <b>учебный текст</b>\nНикаких реальных передач.'});
  const draft=await legal.saveDraft(admin,{revision:0,profile}),first=await legal.publish(admin,{revision:draft.revision});
  assert.match(first.currentVersion,/^ORBITA-\d{4}-\d{2}-\d{2}-1$/);assert.equal(first.versions.length,1);
  const publicView=await legal.readPublic();assert.equal(publicView.version,first.currentVersion);assert.equal(publicView.profile.ownerName,profile.ownerName);assert.equal(publicView.published,true);assert.equal(publicView.profile.ogrn,'');
  const snapshots={};
  for(const document of ['offer','privacy','refunds']){
    const html=await legal.renderPage(document);snapshots[document]=html;
    assert.ok(html.includes('&lt;script&gt;window.bad=1&lt;/script&gt; $&amp;'));assert.ok(!html.includes('<script>window.bad'));assert.ok(!html.includes('class="legal-placeholder"'));assert.ok(!html.includes('data-legal-draft aria-label'));assert.ok(!html.includes(' · проект'));
    assert.ok(html.includes('Не применяется'));assert.ok(html.includes('?version='+first.currentVersion));assert.equal(await legal.renderPage(document,{version:LEGAL_VERSION}),baseline.pages[document]);
  }
  const nextDraft=await legal.saveDraft(admin,{revision:first.revision,profile:fixtureProfile({ownerName:'SECOND PRIVATE NAME'})});
  assert.equal((await legal.readPublic()).version,first.currentVersion);assert.equal(await legal.renderPage('offer'),snapshots.offer);
  const second=await legal.publish(admin,{revision:nextDraft.revision});assert.notEqual(second.currentVersion,first.currentVersion);assert.equal(second.versions.length,2);
  const recreated=await createLegal(directory);
  for(const document of ['offer','privacy','refunds']){assert.equal(await recreated.renderPage(document,{version:first.currentVersion}),snapshots[document]);assert.equal(await recreated.renderPage(document,{version:LEGAL_VERSION}),baseline.pages[document]);}
  await rejected(recreated.renderPage('../accounts'),404);await rejected(recreated.renderPage('offer',{version:'../../accounts.json'}),404);await rejected(recreated.readPublic({version:'ORBITA-2099-01-01-1'}),404);
});

test('legal snapshots survive future template edits and concurrent editors cannot overwrite a winning draft',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'orbita-legal-template-'));t.after(()=>rm(root,{recursive:true,force:true}));const directory=path.join(root,'data'),templateDir=path.join(root,'templates');await mkdir(templateDir);
  for(const name of ['offer','privacy','refunds'])await copyFile(new URL('../public/'+name+'.html',import.meta.url),path.join(templateDir,name+'.html'));
  const legal=await createLegal(directory,{templateDir}),draft=await legal.saveDraft(admin,{revision:0,profile:fixtureProfile()}),published=await legal.publish(admin,{revision:draft.revision}),old=await legal.renderPage('offer');
  const template=path.join(templateDir,'offer.html');await writeFile(template,(await readFile(template,'utf8')).replace('Публичная оферта','НОВЫЙ ШАБЛОН'));
  const restarted=await createLegal(directory,{templateDir});assert.equal(await restarted.renderPage('offer'),old);assert.equal(await restarted.renderPage('offer',{version:LEGAL_VERSION}),baseline.pages.offer);
  const outcomes=await Promise.allSettled([legal.saveDraft(admin,{revision:published.revision,profile:fixtureProfile({ownerName:'First writer'})}),restarted.saveDraft(admin,{revision:published.revision,profile:fixtureProfile({ownerName:'Second writer'})})]);
  assert.equal(outcomes.filter(result=>result.status==='fulfilled').length,1);assert.equal(outcomes.find(result=>result.status==='rejected').reason.status,409);assert.equal((await restarted.readAdmin(admin)).revision,published.revision+1);
});

test('corrupt, modified and symlinked legal stores fail closed',async t=>{
  const {directory,legal}=await fixture(t),draft=await legal.saveDraft(admin,{revision:0,profile:fixtureProfile()});await legal.publish(admin,{revision:draft.revision});
  const file=path.join(directory,'legal.json'),db=JSON.parse(await readFile(file,'utf8'));db.versions[0].pages.offer+='tampered';assert.equal(validateLegalDatabase(db),false);await writeFile(file,JSON.stringify(db));await assert.rejects(createLegal(directory),cause=>cause.code==='DATA_INVALID');
  await rm(file);await symlink(path.join(directory,'outside.json'),file);await writeFile(path.join(directory,'outside.json'),'{}');await assert.rejects(createLegal(directory),cause=>cause.code==='DATA_INVALID');
});

test('publication capacity stops at 50 without deleting or rewriting any accepted version',async t=>{
  const {directory,legal}=await fixture(t);let state=await legal.saveDraft(admin,{revision:0,profile:fixtureProfile()}),firstVersion,firstPage;
  for(let index=0;index<50;index++){
    state=await legal.publish(admin,{revision:state.revision});
    if(index===0){firstVersion=state.currentVersion;firstPage=await legal.renderPage('offer');}
  }
  assert.equal(state.versions.length,50);const before=await readFile(path.join(directory,'legal.json'));
  await rejected(legal.publish(admin,{revision:state.revision}),409);
  assert.equal((await readFile(path.join(directory,'legal.json'))).equals(before),true);assert.equal(await legal.renderPage('offer',{version:firstVersion}),firstPage);assert.equal((await legal.readAdmin(admin)).versions.length,50);
});

test('legal HTTP routes hide drafts, protect preview and demand fresh publication authorization',async()=>{
  const credentials=[];
  const f=await serviceFixture(async({directory,accounts})=>createLegal(directory,{authorizePublish:async(req,payload)=>{credentials.push(payload);if(payload.password!=='publication-test-password')throw error(401,'Повторите подтверждение паролем.');return accounts.identify(req);}}));
  try{
    const owner=await f.register('legal-owner@example.test');await f.accounts.promote(owner.data.user.email);const free=await f.register('legal-free@example.test');
    assert.equal((await f.request('/api/admin/legal')).status,401);assert.equal((await f.request('/api/admin/legal',{cookie:free.cookie})).status,403);
    const preview=await fetch(f.base+'/api/admin/legal/preview?document=offer',{headers:{Cookie:free.cookie}});assert.equal(preview.status,403);
    const profile=fixtureProfile({ownerName:'Private HTTP Draft <img src=x onerror=alert(1)>'});
    const saved=await f.request('/api/admin/legal',{method:'PUT',cookie:owner.cookie,body:{revision:0,profile}});assert.equal(saved.status,200);assert.equal(saved.data.readiness.ready,true);
    const publicDefault=await f.request('/api/legal');assert.equal(publicDefault.status,200);assert.deepEqual(publicDefault.data.profile,defaultLegalProfile());assert.ok(!JSON.stringify(publicDefault.data).includes('Private HTTP'));
    const htmlResponse=await fetch(f.base+'/api/admin/legal/preview?document=offer',{headers:{Cookie:owner.cookie}}),html=await htmlResponse.text();assert.equal(htmlResponse.status,200);assert.equal(htmlResponse.headers.get('cache-control'),'no-store');assert.ok(html.includes('Private HTTP Draft &lt;img'));assert.ok(!html.includes('<img src=x'));assert.ok(html.includes('/api/admin/legal/preview?document=privacy'));assert.ok(html.includes('href="/assets/legal.css"'));assert.ok(html.includes(' · проект'));
    const invalid=await f.request('/api/admin/legal/publish',{method:'POST',cookie:owner.cookie,body:{revision:1,password:'wrong'}});assert.equal(invalid.status,401);assert.equal((await f.service.readAdmin(admin)).revision,1);
    const unknown=await f.request('/api/admin/legal/publish',{method:'POST',cookie:owner.cookie,body:{revision:1,password:'publication-test-password',apiSecret:'bad'}});assert.equal(unknown.status,400);assert.equal(credentials.length,1);
    const published=await f.request('/api/admin/legal/publish',{method:'POST',cookie:owner.cookie,body:{revision:1,password:'publication-test-password',code:'123456'}});assert.equal(published.status,200);assert.equal(credentials.length,2);assert.equal(published.data.revision,2);
    const publicData=(await f.request('/api/legal')).data;assert.equal(publicData.published,true);assert.equal(publicData.profile.ownerName,profile.ownerName);assert.ok(!JSON.stringify(publicData).includes('publishedBy'));
    const persisted=await readFile(path.join(f.directory,'legal.json'),'utf8');assert.ok(!persisted.includes('publication-test-password'));assert.ok(!persisted.includes('123456'));assert.ok(!JSON.stringify(published.data).includes('publication-test-password'));
    assert.equal((await f.request('/api/legal?version=unknown')).status,404);assert.equal((await f.request('/api/legal?version='+LEGAL_VERSION)).data.published,false);
  }finally{await f.close();}
});

test('HTTP publication fails closed when no fresh-authorization callback is configured',async()=>{
  const f=await serviceFixture(async({directory})=>createLegal(directory));
  try{const owner=await f.register('legal-no-reauth@example.test');await f.accounts.promote(owner.data.user.email);const saved=await f.request('/api/admin/legal',{method:'PUT',cookie:owner.cookie,body:{revision:0,profile:fixtureProfile()}});assert.equal(saved.status,200);const publish=await f.request('/api/admin/legal/publish',{method:'POST',cookie:owner.cookie,body:{revision:1,password:'no-bypass-password'}});assert.equal(publish.status,503);assert.equal((await f.request('/api/legal')).data.published,false);}finally{await f.close();}
});
