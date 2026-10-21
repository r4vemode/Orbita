import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createNotifications} from '../lib/notifications.mjs';
import {serviceFixture} from './service-fixture.mjs';

const admin={id:'editor',role:'admin'},DAY=86400000;
const config={botToken:'123456:abcdefghijklmnopqrstuvwxyzABCDEF',botUsername:'orbita_test_bot',webhookSecret:'local-test-webhook-secret-123',publicOrigin:'https://orbita.example.test'};
async function fixture(options={},accountOptions={}){
 const sent=[];let offset=0;
 const f=await serviceFixture(({directory,accounts,ideas})=>createNotifications(directory,{accounts,ideas,config,now:()=>Date.now()+offset,...options,fetchImpl:options.fetchImpl|| (async(url,init)=>{sent.push({url,...JSON.parse(init.body)});return {ok:true,json:async()=>({ok:true,result:{message_id:sent.length}})};})}),accountOptions);
 f.sent=sent;f.advance=ms=>{offset+=ms;};
 f.grant=(u,plan='pro',expiresAt=new Date(Date.now()+DAY*30).toISOString())=>f.accounts.transact(db=>{db.users.find(x=>x.id===u.data.user.id).subscriptions=[{plan,expiresAt}];});
 f.preferences=(u,values)=>f.request('/api/notifications/preferences',{method:'PUT',cookie:u.cookie,body:values});
 f.start=(token,chatId=12345,extra={})=>f.request('/api/notifications/telegram/webhook',{method:'POST',body:{message:{chat:{id:chatId,type:'private'},from:{id:chatId,is_bot:false},text:'/start '+token,...extra}},headers:{Origin:'','X-Telegram-Bot-Api-Secret-Token':config.webhookSecret}});
 f.bind=async(u,chatId=12345)=>{const link=await f.request('/api/notifications/telegram/link',{method:'POST',cookie:u.cookie,body:{}});assert.equal(link.status,200);const token=new URL(link.data.deepLink).searchParams.get('start');assert.equal((await f.start(token,chatId)).data.linked,true);return token;};
 return f;
}
const full=(ticker='SBER',strategy='Momentum RU')=>({mode:'full',d:{ticker,dir:'ЛОНГ',strategy,entry:310,stop:306,target:340,entryRule:'Подтверждение входа.',cancelRule:'Выход по стопу.'}});

test('Telegram connection requires authenticated owner, provider secret, private chat and one-use expiring link',async()=>{const f=await fixture();try{
 assert.equal((await f.request('/api/notifications/preferences')).status,401);
 const u=await f.register('telegram@example.test');
 assert.equal((await f.request('/api/notifications/telegram/link',{method:'POST',cookie:u.cookie,body:{chatId:999}})).status,400);
 const link=await f.request('/api/notifications/telegram/link',{method:'POST',cookie:u.cookie,body:{}}),token=new URL(link.data.deepLink).searchParams.get('start');
 assert.ok(!JSON.stringify(await readFile(join(f.directory,'notifications.json'),'utf8')).includes(token));
 assert.equal((await f.request('/api/notifications/telegram/webhook',{method:'POST',body:{},headers:{Origin:''}})).status,403);
 assert.equal((await f.start(token,12345,{chat:{id:12345,type:'group'}})).data.linked,false);
 assert.equal((await f.start(token,12345,{from:{id:666,is_bot:false}})).data.linked,false);
 assert.equal((await f.start(token)).data.linked,true);assert.equal((await f.start(token,54321)).data.linked,false);
 const p=(await f.request('/api/notifications/preferences',{cookie:u.cookie})).data;assert.equal(p.telegram.linked,true);assert.ok(!JSON.stringify(p).includes('chatId'));
 const other=await f.register('telegram-other@example.test'),otherLink=await f.request('/api/notifications/telegram/link',{method:'POST',cookie:other.cookie,body:{}});f.advance(11*60000);assert.equal((await f.start(new URL(otherLink.data.deepLink).searchParams.get('start'),54321)).data.linked,false);
}finally{await f.close();}});

test('notifications include exact stop changes, filter strategy access, and never replay old events',async()=>{const f=await fixture();try{
 const u=await f.register('watcher@example.test');await f.grant(u);const old=(await f.ideas.create(admin,full())).record;
 await f.accounts.transact(db=>{db.users.find(x=>x.id===u.data.user.id).watchlist=[old.id];});
 await f.preferences(u,{ideaUpdates:true,newSignals:true});await f.bind(u);await f.service.tick();assert.equal(f.sent.length,0);
 await f.ideas.update(admin,old.id,{action:'activate',note:'Вход подтверждён.'});await f.ideas.update(admin,old.id,{action:'stop-change',price:312,note:'Защита позиции.'});
 await f.ideas.create(admin,full('GAZP'));await f.ideas.create(admin,full('EXCLUSIVE','Orbita Exclusive'));
 await f.service.tick();assert.equal(f.sent.length,3);assert.ok(f.sent.some(m=>m.text.includes('SBER: стоп изменён с 306 до 312 ₽')));assert.ok(f.sent.some(m=>m.text.includes('GAZP: новый сигнал')));assert.ok(f.sent.every(m=>!m.text.includes('EXCLUSIVE')));
 await f.service.tick();assert.equal(f.sent.length,3);
 const prefs=await f.preferences(u,{ideaUpdates:false,newSignals:false});assert.equal(prefs.status,200);await f.ideas.update(admin,old.id,{action:'note',note:'Скрытый комментарий.'});await f.service.tick();assert.equal(f.sent.length,3);
}finally{await f.close();}});

test('queued delivery rechecks revoked access before retry and retains no unpaid signal delivery',async()=>{let attempts=0;const f=await fixture({fetchImpl:async()=>{attempts++;return {ok:false,status:503,json:async()=>({ok:false,error_code:503})};}});try{
 const u=await f.register('revoke@example.test');await f.grant(u);await f.preferences(u,{newSignals:true});await f.bind(u);await f.ideas.create(admin,full());await f.service.tick();assert.equal(attempts,1);
 await f.accounts.transact(db=>{db.users.find(x=>x.id===u.data.user.id).subscriptions=[];});f.advance(60000);await f.service.tick();assert.equal(attempts,1);
 const db=JSON.parse(await readFile(join(f.directory,'notifications.json'),'utf8'));assert.ok(db.outbox.every(item=>item.status==='discarded'));
}finally{await f.close();}});

test('Telegram retry-after is respected and disabled bindings stop pending messages',async()=>{let attempts=0;const f=await fixture({fetchImpl:async()=>{attempts++;return {ok:false,status:429,json:async()=>({ok:false,error_code:429,parameters:{retry_after:120}})};}});try{
 const u=await f.register('retry@example.test');await f.grant(u);await f.preferences(u,{newSignals:true});await f.bind(u);await f.ideas.create(admin,full());await f.service.tick();assert.equal(attempts,1);f.advance(60000);await f.service.tick();assert.equal(attempts,1);
 assert.equal((await f.request('/api/notifications/telegram/link',{method:'DELETE',cookie:u.cookie})).status,200);f.advance(120000);await f.service.tick();assert.equal(attempts,1);
}finally{await f.close();}});

test('subscription reminders continue after expiry without idea content and /stop opts out',async()=>{const f=await fixture();try{
 const u=await f.register('reminder@example.test');await f.grant(u,'exclusive',new Date(Date.now()+DAY/2).toISOString());await f.preferences(u,{expiryReminders:true});await f.bind(u);
 await f.service.tick();assert.equal(f.sent.length,1);assert.match(f.sent[0].text,/меньше суток/);assert.match(f.sent[0].text,/Exclusive/);assert.ok(!f.sent[0].text.includes('SBER'));
 await f.service.tick();assert.equal(f.sent.length,1);f.advance(DAY);await f.service.tick();assert.equal(f.sent.length,2);assert.match(f.sent[1].text,/Подписка завершилась/);
 assert.equal((await f.start('unused',12345,{text:'/stop'})).data.linked,false);const p=(await f.request('/api/notifications/preferences',{cookie:u.cookie})).data;assert.equal(p.telegram.linked,false);assert.equal(p.preferences.expiryReminders,false);
}finally{await f.close();}});

test('unconfigured transport and unenrolled administrator cannot disclose paid ideas',async()=>{
 const f=await fixture({}, {requireAdminMfa:true});try{const u=await f.register('unenrolled@example.test');await f.accounts.promote(u.data.user.email);await f.preferences(u,{newSignals:true});await f.bind(u);await f.ideas.create(admin,full());await f.service.tick();assert.equal(f.sent.length,0);}finally{await f.close();}
 const absent=await fixture({config:{botToken:'',botUsername:'',webhookSecret:'',publicOrigin:''}});try{const u=await absent.register('unconfigured@example.test');assert.equal((await absent.preferences(u,{newSignals:true})).data.configured,false);assert.equal((await absent.request('/api/notifications/telegram/link',{method:'POST',cookie:u.cookie,body:{}})).status,503);assert.equal((await absent.service.tick()).sent,0);}finally{await absent.close();}
});
