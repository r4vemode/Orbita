import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createIdeas} from '../lib/ideas.mjs';
import {buildShowcase} from '../lib/showcase.mjs';
import {canReadTier,canReadStrategy,effectiveTier,tierOf,accessFor} from '../lib/access.mjs';
import {createAccounts,SESSION_IDLE_MS,SESSION_MAX_MS} from '../lib/accounts.mjs';

const admin={id:'editor',role:'admin',subscriptions:[]};
const plan=(name,expiresAt='2099-01-01T00:00:00.000Z')=>({id:name,role:'user',subscriptions:[{plan:name,expiresAt}]});
const pro=plan('pro'),exclusive=plan('exclusive'),free={id:'free',role:'user',subscriptions:[]},expired=plan('exclusive','2001-01-01T00:00:00.000Z');
const full=(d={})=>({mode:'full',d:{ticker:'SBER',dir:'ЛОНГ',entry:310,stop:300,target:340,entryRule:'Вход выше уровня.',cancelRule:'Выход по стопу.',...d}});
async function fixture(t){const directory=await mkdtemp(join(tmpdir(),'orbita-tiers-'));t.after(()=>rm(directory,{recursive:true,force:true}));return {directory,ideas:await createIdeas(directory)};}
const rejected=(promise,status)=>assert.rejects(promise,error=>error.status===status);

test('access matrix: none / PRO / EXCLUSIVE / admin; expiry removes access; unknown strategies are paid',()=>{
 const matrix=[[free,false,false],[pro,true,false],[exclusive,true,true],[admin,true,true],[expired,false,false]];
 for(const [user,proAccess,exclusiveAccess]of matrix){assert.equal(canReadTier(user,'pro'),proAccess,user.id);assert.equal(canReadTier(user,'exclusive'),exclusiveAccess,user.id);}
 assert.equal(effectiveTier(exclusive),'exclusive');assert.equal(effectiveTier(free),null);
 assert.equal(tierOf('Legacy strategy'),'pro','legacy ideas never become public');assert.equal(canReadStrategy(free,'Legacy strategy'),false);
 assert.deepEqual(accessFor(pro).tiers,['pro']);assert.deepEqual(accessFor(exclusive).tiers,['pro','exclusive']);
});

test('moving an idea between strategies changes access immediately and is journaled',async t=>{
 const {ideas}=await fixture(t),record=(await ideas.create(admin,full())).record;
 assert.equal((await ideas.get(record.id,pro)).id,record.id);
 const moved=(await ideas.update(admin,record.id,{action:'strategy-change',d:{strategy:'Orbita Exclusive'},note:'Перенос в премиальную ленту'})).record;
 assert.equal(moved.d.strategy,'Orbita Exclusive');assert.equal(moved.meta.events.at(-1)[3].type,'strategy-change');assert.match(moved.meta.events.at(-1)[2],/PRO\) → Orbita Exclusive \(EXCLUSIVE\)/);
 await rejected(ideas.get(record.id,pro),404);assert.equal((await ideas.list(pro)).records.length,0);assert.equal((await ideas.get(record.id,exclusive)).id,record.id);
 await rejected(ideas.update(admin,record.id,{action:'strategy-change',d:{strategy:'Crypto Trend'},note:'x'}),400);
 await rejected(ideas.update(pro,record.id,{action:'strategy-change',d:{strategy:'Momentum RU'},note:'x'}),403);
});

test('EXCLUSIVE ideas can be published for futures; PRO strategies keep their market',async t=>{
 const {ideas}=await fixture(t);
 const futures=(await ideas.create(admin,full({ticker:'SiZ6',market:'futures',strategy:'Orbita Exclusive',entry:82000,stop:81500,target:83000}))).record;
 assert.equal(futures.d.market,'futures');await rejected(ideas.create(admin,full({market:'futures',strategy:'Momentum RU'})),400);
});

test('several targets follow the trade direction and are validated server-side',async t=>{
 const {ideas}=await fixture(t);
 const long=(await ideas.create(admin,full({targets:[350,365]}))).record;assert.deepEqual(long.d.targets,[350,365]);
 await rejected(ideas.create(admin,full({targets:[335]})),400);
 await rejected(ideas.create(admin,full({targets:[350,345]})),400);
 await rejected(ideas.create(admin,full({targets:[1,2,3,4,5].map(n=>340+n)})),400);
 const short=(await ideas.create(admin,full({ticker:'GAZP',dir:'ШОРТ',entry:120,stop:125,target:115,targets:[110]}))).record;assert.deepEqual(short.d.targets,[110]);
 const changed=(await ideas.update(admin,long.id,{action:'terms-change',d:{targets:[355]},note:'Уточнение целей'})).record;assert.deepEqual(changed.d.targets,[355]);
});

test('archive hides an idea from clients but keeps it for admins; drafts can be deleted, published ideas cannot',async t=>{
 const {ideas}=await fixture(t),record=(await ideas.create(admin,full())).record;
 await ideas.update(admin,record.id,{action:'archive'});
 assert.equal((await ideas.list(pro)).records.length,0);await rejected(ideas.get(record.id,pro),404);assert.equal((await ideas.list(admin)).records[0].archived,true);
 await rejected(ideas.update(admin,record.id,{action:'archive'}),400);await ideas.update(admin,record.id,{action:'unarchive'});assert.equal((await ideas.list(pro)).records.length,1);
 await rejected(ideas.remove(admin,record.id),409);
 const draft=(await ideas.create(admin,{mode:'draft',d:{ticker:'DRAFT'}})).record;assert.equal((await ideas.remove(admin,draft.id)).ok,true);
});

test('landing showcase: one open PRO idea, no levels or comments leak, closed ideas leave the block',async t=>{
 const {ideas}=await fixture(t);
 const record=(await ideas.create(admin,full({ticker:'SiZ6',market:'futures',strategy:'Импульс',entry:82000,stop:81500,target:83000,thesis:'Секретный разбор автора'}))).record;
 const premium=(await ideas.create(admin,full({strategy:'Orbita Exclusive'}))).record;
 await rejected(ideas.update(admin,premium.id,{action:'showcase'}),400);
 assert.equal(await buildShowcase({ideas}),null,'neutral state when nothing is selected');
 await ideas.update(admin,record.id,{action:'showcase'});
 const waiting=await buildShowcase({ideas,markets:{priceFor:async()=>({price:82410,providerTime:'2026-11-08T11:34:00.000Z',source:'MOEX ISS',delayMinutes:15})}});
 assert.equal(waiting.ticker,'SiZ6');assert.equal(waiting.result,null,'no result before entry');
 const text=JSON.stringify(waiting);for(const secret of ['82000','81500','83000','Секретный','Вход выше','Выход по стопу','editor'])assert.ok(!text.includes(secret),secret);
 await ideas.update(admin,record.id,{action:'activate',note:'Вход подтверждён'});
 const active=await buildShowcase({ideas,markets:{priceFor:async()=>({price:82410,providerTime:'2026-11-08T11:34:00.000Z',source:'MOEX ISS',delayMinutes:15})}});
 assert.equal(active.result.pct,0.5);assert.equal(active.result.source,'MOEX ISS');assert.ok(!JSON.stringify(active).includes('82000'));
 assert.equal((await buildShowcase({ideas,markets:{priceFor:async()=>null}})).result,null,'no verified price — no percentage');
 await ideas.update(admin,record.id,{action:'target',note:'Цель'});
 assert.equal(await buildShowcase({ideas}),null,'closed idea is removed automatically');
 assert.equal((await ideas.list(admin)).records.find(r=>r.id===record.id).showcase,false);
});

test('sessions slide on activity up to an absolute limit and never shorten',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'orbita-session-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const accounts=await createAccounts(directory,{publicOrigin:'',requireAdminMfa:false,mailer:{configured:false}});
 const call=async(route,{method='GET',cookie,body}={})=>{
  let status,headers={},payload='';const res={headersSent:false,writeHead(code,h={}){status=code;headers=h;return this;},end(data){payload=data||'';}};
  const {Readable}=await import('node:stream');const req=Object.assign(Readable.from(body?[Buffer.from(JSON.stringify(body))]:[]),{method,url:route,headers:{host:'127.0.0.1:3000',origin:'http://127.0.0.1:3000','content-type':'application/json',...(cookie?{cookie}:{})},socket:{remoteAddress:'127.0.0.1'}});
  await accounts.handle(req,res,new URL('http://127.0.0.1:3000'+route));return {status,headers,data:payload?JSON.parse(payload):null};
 };
 const legalVersion=await accounts.currentLegalVersion();
 const registered=await call('/api/register',{method:'POST',body:{email:'slide@example.test',password:'Very-long-pass-1',acceptTerms:true,acceptPrivacy:true,legalVersion}});
 assert.equal(registered.status,200);const cookie=registered.headers['Set-Cookie'].split(';')[0];
 const fresh=await call('/api/me',{cookie});assert.equal(fresh.data.user.email,'slide@example.test');assert.equal(fresh.headers['Set-Cookie'],undefined,'a fresh session is not rewritten on every request');
 // Age the session: 2 days of idle window left, created 10 days ago.
 await accounts.transact(db=>{const s=db.sessions[0];s.createdAt=Date.now()-10*86400000;s.expires=Date.now()+2*86400000;});
 const renewed=await call('/api/me',{cookie});assert.match(renewed.headers['Set-Cookie'],/Max-Age=60\d{4}/);
 const after=(await accounts.readDatabase()).sessions[0];assert.ok(after.expires>Date.now()+SESSION_IDLE_MS-60000);
 await accounts.transact(db=>{const s=db.sessions[0];s.createdAt=Date.now()-SESSION_MAX_MS+3600000;s.expires=Date.now()+1800000;});
 await call('/api/me',{cookie});const capped=(await accounts.readDatabase()).sessions[0];assert.ok(capped.expires<=capped.createdAt+SESSION_MAX_MS,'absolute lifetime is respected');
 await accounts.transact(db=>{db.sessions[0].expires=Date.now()-1;});
 assert.equal((await call('/api/me',{cookie})).data.user,null,'an expired session is not revived');
});

test('public stats aggregate closed real ideas only and reveal no tickers or levels',async t=>{
 const {ideas}=await fixture(t);
 const win=(await ideas.create(admin,full())).record,loss=(await ideas.create(admin,full({ticker:'GAZP',dir:'ШОРТ',entry:120,stop:125,target:110}))).record;
 await ideas.create(admin,full({ticker:'OPEN'}));
 for(const [r,action] of [[win,'target'],[loss,'stop']]){await ideas.update(admin,r.id,{action:'activate',note:'Вход'});await ideas.update(admin,r.id,{action,note:'Итог'});}
 const stats=await ideas.stats();assert.equal(stats.pro.closed,2);assert.equal(stats.pro.winRate,50);assert.equal(stats.exclusive.closed,0);
 assert.ok(Math.abs(stats.pro.avgR-((340-310)/10+(-1))/2)<1e-9,'average outcome in risk units');
 assert.ok(!JSON.stringify(stats).includes('SBER')&&!JSON.stringify(stats).includes('310'));
 assert.deepEqual((await ideas.activeTickers('stocks')).sort(),['OPEN']);
});

test('owner CLI creates a verified administrator or resets the password, never via argv',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'orbita-admin-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const accounts=await createAccounts(directory,{publicOrigin:'',requireAdminMfa:false,mailer:{configured:false}});
 const created=await accounts.createAdmin(' Owner@Example.test ','Strong-pass-123');assert.equal(created.created,true);assert.equal(created.role,'admin');
 const again=await accounts.createAdmin('owner@example.test','Another-pass-456');assert.equal(again.created,false);
 const db=await accounts.readDatabase();assert.equal(db.users.length,1);assert.equal(db.users[0].emailVerified,true);assert.ok(!JSON.stringify(db).includes('Another-pass-456'));
 await assert.rejects(accounts.createAdmin('owner@example.test','short'));
 const script=await readFile(new URL('../scripts/manage-access.mjs',import.meta.url),'utf8');assert.match(script,/ORBITA_ADMIN_PASSWORD/);assert.doesNotMatch(script,/argv\.slice\(2\)\[2\]/);
});

test('public results list every finished real idea with initial levels; open ideas are only counted',async t=>{
 const {ideas}=await fixture(t);
 const win=(await ideas.create(admin,full())).record,moved=(await ideas.create(admin,full({ticker:'GAZP',dir:'ШОРТ',entry:120,stop:125,target:110}))).record,cancelled=(await ideas.create(admin,full({ticker:'LKOH'}))).record;
 await ideas.create(admin,full({ticker:'OPENSECRET',entry:777,stop:700,target:900}));
 await ideas.update(admin,win.id,{action:'activate',note:'Вход'});await ideas.update(admin,win.id,{action:'target',note:'Цель'});
 await ideas.update(admin,moved.id,{action:'activate',note:'Вход'});await ideas.update(admin,moved.id,{action:'stop-change',price:122,note:'Перенос стопа'});await ideas.update(admin,moved.id,{action:'stop',note:'Стоп'});
 await ideas.update(admin,cancelled.id,{action:'cancel',note:'Не дошла'});
 const out=await ideas.results();assert.equal(out.open,1);assert.equal(out.results.length,3);
 assert.ok(!JSON.stringify(out).includes('OPENSECRET')&&!JSON.stringify(out).includes('777'),'open idea levels stay private');
 const loss=out.results.find(r=>r.ticker==='GAZP');assert.equal(loss.initial.stop,125);assert.equal(loss.final.stop,122);assert.equal(loss.changes,1);
 assert.ok(Math.abs(loss.r-(-0.4))<1e-9,'R is measured against the stop as first published');
 assert.equal(out.results.find(r=>r.ticker==='LKOH').pct,null);assert.ok(out.results.find(r=>r.ticker==='SBER').pct>0);
});
