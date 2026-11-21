import assert from 'node:assert/strict';
import test from 'node:test';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {serviceFixture} from './service-fixture.mjs';
import {createTelegramLoginSender,telegramLoginConfiguration,validTelegramLoginId} from '../lib/telegram-admin/login.mjs';

const fixtureToken='123456:fixture-token-used-only-with-mocked-requests';
const senderEnv={TELEGRAM_ADMIN_LOGIN_ENABLED:'true',TELEGRAM_ADMIN_BOT_TOKEN:fixtureToken};
const email='telegram-owner@example.test', telegramId='987654321';
const emptyService=()=>({webhookPaths:[],handle:async()=>false});
const login=(f,password='test-password-long-2026')=>f.request('/api/login',{method:'POST',body:{email,password}});
const confirm=(f,challenge,code)=>f.request('/api/security/mfa/login',{method:'POST',body:{challenge,code}});

test('Telegram codes use only the configured admin bot and are delivered to the exact private chat',async()=>{
 assert.equal(telegramLoginConfiguration({}).enabled,false);
 assert.throws(()=>telegramLoginConfiguration({TELEGRAM_ADMIN_LOGIN_ENABLED:'true'}));
 assert.throws(()=>telegramLoginConfiguration({...senderEnv,TELEGRAM_BOT_TOKEN:fixtureToken}));
 for(const id of ['-1','0','0123','4503599627370496','@example'])assert.equal(validTelegramLoginId(id),false,id);
 let chatType='private',calls=0;
 const sender=createTelegramLoginSender({env:senderEnv,fetchImpl:async(url,options)=>{
  calls++;
  assert.equal(url,'https://api.telegram.org/bot'+fixtureToken+'/sendMessage');
  const body=JSON.parse(options.body);
  assert.equal(body.chat_id,Number(telegramId));
  assert.equal(body.protect_content,true);
  assert.match(body.text,/012345/);
  return Response.json({ok:true,result:{chat:{id:Number(telegramId),type:chatType}}});
 }});
 await sender(telegramId,'012345');
 await assert.rejects(()=>sender('-123','012345'));
 chatType='group';
 await assert.rejects(()=>sender(telegramId,'012345'));
 assert.equal(calls,2);
});

test('CLI Telegram assignment revokes the prior session and password plus one code opens the editor',async t=>{
 const sent=[], fixture=await serviceFixture(emptyService,{telegramLogin:async(id,code)=>sent.push({id,code})});
 t.after(()=>fixture.close());
 const prior=await fixture.register(email);
 const owner=prior.data.user;
 const second=await fixture.register('telegram-other@example.test');
 assert.equal(await login(fixture,'incorrect-password').then(a=>a.status),401);
 assert.equal(sent.length,0);
 const project=fileURLToPath(new URL('../',import.meta.url)), run=promisify(execFile);
 const cli=(...args)=>run(process.execPath,['scripts/manage-access.mjs',...args],{cwd:project,env:{PATH:process.env.PATH,ORBITA_DATA_DIR:fixture.directory,...senderEnv}});
 await cli('admin-telegram',email,telegramId);
 assert.equal((await fixture.request('/api/me',{cookie:prior.cookie})).data.user,null);
 await assert.rejects(()=>fixture.accounts.promote(second.data.user.email,{telegramId}),/другому аккаунту/);
 const passwordStep=await login(fixture);
 assert.equal(passwordStep.status,200);
 assert.equal(passwordStep.cookie,undefined);
 assert.deepEqual(Object.keys(passwordStep.data).sort(),['challenge','mfaMethod','mfaRequired']);
 assert.equal(passwordStep.data.mfaMethod,'telegram');
 assert.equal(sent.length,1);
 assert.equal(sent[0].id,telegramId);
 const db=await fixture.accounts.readDatabase(),pending=db.authChallenges[0];
 assert.equal(pending.userId,owner.id);
 assert.equal(typeof pending.secret.data,'string');
 assert.equal(Object.hasOwn(pending,'code'),false);
 assert.equal((await login(fixture)).status,429);
 assert.equal(sent.length,1);
 const {code}=sent[0],{challenge}=passwordStep.data;
 assert.equal((await confirm(fixture,challenge,code==='000000'?'000001':'000000')).status,401);
 const loggedIn=await confirm(fixture,challenge,code);
 assert.equal(loggedIn.status,200);
 assert.equal(loggedIn.data.user.access.isAdmin,true);
 assert.equal(loggedIn.data.user.security.telegramLoginEnabled,true);
 assert.equal(JSON.stringify(loggedIn.data).includes(telegramId),false);
 assert.equal((await fixture.request('/api/admin/users',{cookie:loggedIn.cookie})).status,200);
 assert.equal((await confirm(fixture,challenge,code)).status,401);
 await cli('admin-telegram-off',email);
 assert.equal((await fixture.request('/api/me',{cookie:loggedIn.cookie})).data.user,null);
 assert.ok((await login(fixture)).cookie);
});

test('delivery failure, expired codes and a relink during delivery do not create a session',async t=>{
 let failure=true, relink=false, code, fixture;
 fixture=await serviceFixture(emptyService,{telegramLogin:async(_id,nextCode)=>{
  if(failure)throw Error('private provider detail');
  code=nextCode;
  if(relink)await fixture.accounts.promote(email,{telegramId:'987654322'});
 }});
 t.after(()=>fixture.close());
 await fixture.register(email);
 await fixture.accounts.promote(email,{telegramId});
 const failed=await login(fixture);
 assert.equal(failed.status,503);
 assert.equal(failed.cookie,undefined);
 assert.doesNotMatch(JSON.stringify(failed.data),/private provider detail/);
 assert.deepEqual((await fixture.accounts.readDatabase()).authChallenges,[]);
 failure=false;
 const issued=await login(fixture);
 await fixture.accounts.transact(db=>{db.authChallenges[0].expires=Date.now()-1;});
 assert.equal((await confirm(fixture,issued.data.challenge,code)).status,401);
 relink=true;
 const changed=await login(fixture);
 assert.equal(changed.status,401);
 assert.equal(changed.cookie,undefined);
 assert.deepEqual((await fixture.accounts.readDatabase()).authChallenges,[]);
});

test('a bound administrator cannot continue with just a password when Telegram is disabled or attempts run out',async t=>{
 const offline=await serviceFixture(emptyService);
 t.after(()=>offline.close());
 await offline.register(email);
 await offline.accounts.promote(email,{telegramId});
 const denied=await login(offline);
 assert.equal(denied.status,503);
 assert.equal(denied.cookie,undefined);

 let code;
 const online=await serviceFixture(emptyService,{telegramLogin:async(_id,value)=>{code=value;}});
 t.after(()=>online.close());
 await online.register(email);
 await online.accounts.promote(email,{telegramId});
 const {data:{challenge}}=await login(online);
 for(let i=0;i<5;i++)assert.equal((await confirm(online,challenge,code==='111111'?'111112':'111111')).status,401);
 assert.equal((await confirm(online,challenge,code)).status,401);
});
