import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {createNotifications} from '../lib/notifications.mjs';
import {activePlans} from '../lib/access.mjs';
import {serviceFixture} from './service-fixture.mjs';

const config={botToken:'123456:abcdefghijklmnopqrstuvwxyzABCDEF',botUsername:'orbita_test_bot',webhookSecret:'radar-test-webhook-secret-123',publicOrigin:'https://orbita.example.test'};
async function fixture({fail=false}={}){
  let at=Date.now(),enabled=true;const events=[],following=new Set(),sent=[],marked=[];
  const eligible=(user,event)=>enabled&&activePlans(user,at).includes('pro')&&following.has(user.id)&&event?.status==='published'&&event.importanceScore>=6;
  const radar={canRealtime:user=>enabled&&activePlans(user,at).includes('pro'),notificationsFor:async(user,{since})=>events.filter(event=>eligible(user,event)&&Date.parse(event.firstPublishedAt||event.processedAt)>=since),getForNotification:async(user,id)=>events.find(event=>event.id===id&&eligible(user,event))||null,markNotificationSent:async(id,date)=>marked.push({id,date})};
  const f=await serviceFixture(({directory,accounts,ideas})=>createNotifications(directory,{accounts,ideas,radar,config,now:()=>at,fetchImpl:async(_url,options)=>{sent.push(JSON.parse(options.body));return fail?{ok:false,status:503,json:async()=>({ok:false,error_code:503})}:{ok:true,json:async()=>({ok:true})};}}));
  f.sent=sent;f.marked=marked;f.advance=ms=>{at+=ms;};f.disable=()=>{enabled=false;};
  f.event=(id,extra={})=>{const event={id,ticker:'SBER',headline:'Учебное корпоративное событие',summary:'Не торговый сигнал.',importanceScore:9.2,impact:'POSITIVE',processedAt:new Date(at).toISOString(),isDemo:true,status:'published',...extra};events.push(event);return event;};
  f.follow=user=>following.add(user.data.user.id);f.unfollow=user=>following.delete(user.data.user.id);
  f.grant=user=>f.accounts.transact(db=>{db.users.find(value=>value.id===user.data.user.id).subscriptions=[{plan:'pro',expiresAt:new Date(at+86400000).toISOString()}];});
  f.revoke=user=>f.accounts.transact(db=>{db.users.find(value=>value.id===user.data.user.id).subscriptions=[];});
  f.preferences=(user,body)=>f.request('/api/notifications/preferences',{method:'PUT',cookie:user.cookie,body});
  f.webhook=text=>f.request('/api/notifications/telegram/webhook',{method:'POST',headers:{Origin:'','X-Telegram-Bot-Api-Secret-Token':config.webhookSecret},body:{message:{chat:{id:12345,type:'private'},from:{id:12345,is_bot:false},text}}});
  f.bind=async user=>{const link=await f.request('/api/notifications/telegram/link',{method:'POST',cookie:user.cookie,body:{}});assert.equal(link.status,200);assert.equal((await f.webhook('/start '+new URL(link.data.deepLink).searchParams.get('start'))).data.linked,true);};
  return f;
}

test('Radar Telegram requires separate consent and matching subscription, sends only new events once, and records the actual send time',async()=>{
  const f=await fixture();try{
    const user=await f.register('radar-notification@example.test');await f.grant(user);f.follow(user);await f.bind(user);
    f.event('past-event');await f.service.tick();assert.equal(f.sent.length,0);
    f.advance(10);assert.equal((await f.preferences(user,{radarEvents:true})).status,200);await f.service.tick();assert.equal(f.sent.length,0);
    f.advance(10);const fresh=f.event('fresh-event');fresh.firstPublishedAt=fresh.processedAt;fresh.processedAt=new Date(0).toISOString();f.event('low-event',{importanceScore:5});await f.service.tick();assert.equal(f.sent.length,1);assert.match(f.sent[0].text,/Демонстрация/);assert.match(f.sent[0].text,/Корпоративное событие, не торговый сигнал/);assert.match(f.sent[0].text,/radar.html\?event=fresh-event/);assert.deepEqual(f.marked.map(value=>value.id),['fresh-event']);
    await f.service.tick();assert.equal(f.sent.length,1);
    const db=JSON.parse(await readFile(path.join(f.directory,'notifications.json'),'utf8'));assert.equal(db.outbox.find(item=>item.eventId==='fresh-event').type,'RADAR_EVENT');
    await f.preferences(user,{radarEvents:false});f.advance(10);f.event('disabled-event');await f.service.tick();assert.equal(f.sent.length,1);
  }finally{await f.close();}
});

test('Radar retry discards queued alerts after revocation, unfollow, hide, module disable or Telegram /stop',async()=>{
  for(const change of ['revoke','unfollow','hide','disable','stop']){
    const f=await fixture({fail:true});try{
      const user=await f.register('radar-retry@example.test');await f.grant(user);f.follow(user);await f.preferences(user,{radarEvents:true});await f.bind(user);f.advance(10);const event=f.event('queued-event');await f.service.tick();assert.equal(f.sent.length,1,change);assert.equal(f.marked.length,0);
      if(change==='revoke')await f.revoke(user);if(change==='unfollow')f.unfollow(user);if(change==='hide')event.status='hidden';if(change==='disable')f.disable();if(change==='stop')await f.webhook('/stop');
      f.advance(60000);await f.service.tick();assert.equal(f.sent.length,1,change);const db=JSON.parse(await readFile(path.join(f.directory,'notifications.json'),'utf8'));assert.equal(db.outbox[0].status,'discarded',change);
    }finally{await f.close();}
  }
});
