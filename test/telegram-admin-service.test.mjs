import test from 'node:test';
import assert from 'node:assert/strict';
import {serviceFixture} from './service-fixture.mjs';
import {createTelegramAdmin} from '../lib/telegram-admin/service.mjs';
import {telegramAdminConfiguration} from '../lib/telegram-admin/config.mjs';
import {createTelegramAdminTransport} from '../lib/telegram-admin/transport.mjs';

const environment={TELEGRAM_ADMIN_BOT_ENABLED:'true',TELEGRAM_ADMIN_BOT_TOKEN:'123456:fixture_admin_token_not_a_real_secret',TELEGRAM_ADMIN_BOT_USERNAME:'OrbitaFixtureBot',TELEGRAM_ADMIN_WEBHOOK_SECRET:'fixture_webhook_secret_at_least_32_chars',ORBITA_PUBLIC_ORIGIN:'https://orbita.example.test'};
const tg=123456789;
async function setup(t,enabled=true){
 const deliveries=[];let sentId=100;
 const f=await serviceFixture(({accounts,ideas})=>createTelegramAdmin({accounts,ideas,env:enabled?environment:{},send:async(method,payload)=>{deliveries.push({method,payload:structuredClone(payload)});return {message_id:payload.message_id||++sentId};}}));
 t.after(()=>f.close());
 const admin=await f.register('telegram-owner@example.test'),free=await f.register('telegram-client@example.test');
 await f.accounts.promote(admin.data.user.email);
 // Synthetic verified-MFA session; the actual enrollment flow has its own tests.
 await f.accounts.transact(db=>{const user=db.users.find(item=>item.id===admin.data.user.id);user.mfa={enabled:true,secret:'fixture-encrypted-envelope'};db.sessions.filter(item=>item.userId===user.id).forEach(item=>{item.mfa=true;});});
 let sequence=1;
 const message=text=>({update_id:sequence++,message:{message_id:sequence,from:{id:tg,is_bot:false},chat:{id:tg,type:'private'},text}});
 async function webhook(update,headers={}){const result=await f.request('/api/telegram/webhook',{method:'POST',body:update,headers:{'x-telegram-bot-api-secret-token':environment.TELEGRAM_ADMIN_WEBHOOK_SECRET,...headers}});await f.service.pump();return result;}
 async function link(){const issued=await f.request('/api/admin/telegram/link',{method:'POST',cookie:admin.cookie,body:{}});assert.equal(issued.status,201);assert.equal((await webhook(message('/connect '+issued.data.code))).status,200);return issued.data;}
 function lastCard(){return deliveries.findLast(item=>['sendMessage','editMessageText'].includes(item.method));}
 function callback(label){const card=lastCard(),button=card.payload.reply_markup?.inline_keyboard.flat().find(item=>item.text.includes(label));assert.ok(button,'Missing Telegram button '+label);return {update_id:sequence++,callback_query:{id:'fixture-callback-'+sequence,from:{id:tg,is_bot:false},message:{message_id:card.payload.message_id||sentId,from:{id:99999,is_bot:true},chat:{id:tg,type:'private'}},data:button.callback_data}};}
 return {...f,admin,free,deliveries,message,webhook,link,lastCard,callback};
}

test('admin bot is safely disabled by default and never grants a client administrative access',async t=>{
 const f=await setup(t,false);
 assert.equal(f.service.engine,null);assert.equal((await f.request('/api/admin/telegram')).status,401);
 assert.equal((await f.request('/api/admin/telegram',{cookie:f.free.cookie})).status,403);
 const state=await f.request('/api/admin/telegram',{cookie:f.admin.cookie});assert.equal(state.status,200);assert.equal(state.data.configured,false);assert.equal(state.data.linked,false);
 assert.ok(!JSON.stringify(state.data).includes('fixture_admin_token'));
 assert.equal((await f.request('/api/admin/telegram/link',{method:'POST',cookie:f.admin.cookie,body:{}})).status,503);
 assert.equal((await f.request('/api/admin/telegram/link',{method:'POST',cookie:f.admin.cookie,body:{},headers:{Origin:'https://outside.example'}})).status,403);
 await f.service.pump();assert.equal(f.deliveries.length,0);
});

test('webhook authenticates the secret before reading work and accepts only its own POST route',async t=>{
 const f=await setup(t);
 assert.equal((await f.webhook(f.message('/start'),{'x-telegram-bot-api-secret-token':'incorrect'})).status,403);
 assert.equal((await f.request('/api/telegram/webhook')).status,405);
 assert.equal((await f.request('/api/telegram/webhook',{method:'POST',body:'{',headers:{'x-telegram-bot-api-secret-token':environment.TELEGRAM_ADMIN_WEBHOOK_SECRET}})).status,400);
 assert.equal((await f.webhook(f.message('/start'))).status,200);assert.equal(f.deliveries.length,0);
 assert.equal((await f.service.store.pendingUpdates()).length,0);
});

test('real webhook pipeline publishes once to shared ideas, keeps metadata private and uses the web event history',async t=>{
 const f=await setup(t);const issued=await f.link();
 const state=await f.request('/api/admin/telegram',{cookie:f.admin.cookie});assert.equal(state.data.linked,true);assert.equal(state.data.preferences.instantPublish,false);
 assert.ok(!JSON.stringify(await f.accounts.readDatabase()).includes(issued.code));
 await f.webhook(f.message('sber 312,5 307 325'));
 assert.match(f.lastCard().payload.text,/LONG/);assert.match(f.lastCard().payload.text,/2[.,]27/);
 assert.equal((await f.ideas.list(await f.accounts.identify({headers:{cookie:f.admin.cookie}}))).records.length,0);
 const publish=f.callback('Опубликовать');await f.webhook(publish);await f.webhook(publish);
 const owner=await f.accounts.identify({headers:{cookie:f.admin.cookie}}),published=await f.ideas.list(owner);
 assert.equal(published.records.length,1);const record=published.records[0];assert.equal(record.createdVia,'TELEGRAM');assert.equal(record.d.state,'waiting');assert.equal(record.meta.events.length,1);
 assert.match(f.lastCard().payload.text,/опубликован/i);assert.ok(f.lastCard().payload.reply_markup.inline_keyboard.flat().some(item=>item.url?.includes('/admin.html?idea='+record.id)));
 const member={id:'paid-fixture',role:'member',subscriptions:[{plan:'pro',expiresAt:new Date(Date.now()+86400000).toISOString()}]};
 const projected=await f.ideas.get(record.id,member);assert.equal(projected.telegram,undefined);assert.equal(projected.createdByUserId,undefined);assert.equal(projected.createdVia,'TELEGRAM');
 const edited=await f.ideas.update(owner,record.id,{action:'stop-change',price:309,note:'Уточнение через веб-редакцию'});
 assert.equal(edited.record.meta.initial.stop,307);assert.equal(edited.record.d.stop,309);assert.equal(edited.record.meta.events.at(-1)[3].via,'WEB');
 const metadata=await f.accounts.readDatabase();assert.ok(metadata.telegramAdmin.audit.some(item=>item.action==='signal-created'&&item.ideaId===record.id));
});

test('unlink and role withdrawal prevent pending previews from becoming new signals',async t=>{
 const f=await setup(t);await f.link();await f.webhook(f.message('SBER 312.5 307 325'));const old=f.callback('Опубликовать');
 assert.equal((await f.request('/api/admin/telegram/link',{method:'DELETE',cookie:f.admin.cookie,body:{}})).status,200);
 await f.webhook(old);assert.equal((await f.ideas.list({id:'fixture',role:'admin'})).records.length,0);
 await f.link();await f.webhook(f.message('SBER 312.5 307 325'));const callback=f.callback('Опубликовать');
 await f.accounts.transact(db=>{db.users.find(user=>user.id===f.admin.data.user.id).role='member';});
 await f.webhook(callback);assert.equal((await f.ideas.list({id:'fixture',role:'admin'})).records.length,0);
});

test('admin bot configuration requires a distinct bot, HTTPS and complete credentials only when enabled',()=>{
 assert.equal(telegramAdminConfiguration({}).configured,false);assert.equal(telegramAdminConfiguration(environment).configured,true);
 for(const env of [{...environment,TELEGRAM_ADMIN_BOT_ENABLED:'yes'},{...environment,ORBITA_PUBLIC_ORIGIN:'http://orbita.example'},{...environment,TELEGRAM_ADMIN_WEBHOOK_SECRET:'short'},{...environment,TELEGRAM_BOT_TOKEN:environment.TELEGRAM_ADMIN_BOT_TOKEN},{...environment,TELEGRAM_ADMIN_DRAFT_TTL_MINUTES:'121'}])assert.throws(()=>telegramAdminConfiguration(env),{code:'TELEGRAM_ADMIN_CONFIGURATION'});
});

test('Telegram transport bounds output, suppresses secret errors and accepts real HTTP400 no-op edits',async()=>{
 let seen;
 const noop=createTelegramAdminTransport({botToken:'never-log-this',fetchImpl:async(url,options)=>{seen=options;return new Response(JSON.stringify({ok:false,error_code:400,description:'Bad Request: message is not modified'}),{status:400});}});
 assert.equal(await noop('editMessageText',{chat_id:tg,message_id:1,text:'unchanged'}),true);assert.equal(seen.redirect,'error');
 for(const response of [new Response('not-json',{status:200}),new Response(JSON.stringify({ok:false,description:'never-log-this'}),{status:400}),new Response('x'.repeat(65537),{status:200})]){
  const send=createTelegramAdminTransport({botToken:'never-log-this',fetchImpl:async()=>response});await assert.rejects(send('sendMessage',{text:'fixture'}),cause=>cause.code==='TELEGRAM_ADMIN_DELIVERY'&&!cause.message.includes('never-log-this'));
 }
 const send=createTelegramAdminTransport({botToken:'never-log-this',fetchImpl:async()=>{throw Error('https://api.telegram.org/botnever-log-this');}});await assert.rejects(send('sendMessage',{}),cause=>!cause.message.includes('never-log-this'));await assert.rejects(send('setWebhook',{}));
});
