import test from 'node:test';
import assert from 'node:assert/strict';
import {createNotifications} from '../lib/notifications.mjs';
import {createTelegramClientMenu,isTelegramClientAction} from '../lib/telegram-client/menu.mjs';
import {serviceFixture} from './service-fixture.mjs';

const publicOrigin='https://orbita.example.test';
const config={botToken:'123456:fixture_client_token_for_tests',botUsername:'OrbitaClientFixtureBot',
  webhookSecret:'fixture_client_webhook_secret',publicOrigin};
const route='/api/notifications/telegram/webhook';
const editor={id:'fixture-admin',role:'admin'};

test('client webhook starts the menu, applies live subscriptions, and delivers closure results once',async t=>{
  const replies=[];
  let offset=0;
  const now=()=>Date.now()+offset;
  const f=await serviceFixture(({directory,accounts,ideas})=>{
    const clientMenu={...createTelegramClientMenu({ideas,publicOrigin,now}),isAction:isTelegramClientAction};
    return createNotifications(directory,{accounts,ideas,clientMenu,config,now,fetchImpl:async(url,request)=>{
      replies.push({method:url.split('/').at(-1),...JSON.parse(request.body)});
      return {ok:true,json:async()=>({ok:true,result:{message_id:replies.length}})};
    }});
  });
  t.after(()=>f.close());

  let sequence=0;
  const message=(id,text)=>({update_id:++sequence,message:{message_id:sequence,chat:{id,type:'private'},from:{id,is_bot:false},text}});
  const callback=(id,data,from=id)=>({update_id:++sequence,callback_query:{
    id:'click-'+sequence,data,from:{id:from,is_bot:false},message:{message_id:sequence,chat:{id,type:'private'}}}});
  const send=body=>f.request(route,{method:'POST',body,headers:{Origin:'','X-Telegram-Bot-Api-Secret-Token':config.webhookSecret}});
  const card=()=>replies.findLast(reply=>['sendMessage','editMessageText'].includes(reply.method));
  const options=(cookie,values)=>f.request('/api/notifications/preferences',{method:'PUT',cookie,body:values});
  const grant=(id,plan)=>f.accounts.transact(db=>{
    db.users.find(user=>user.id===id).subscriptions=[{plan,expiresAt:new Date(now()+600000).toISOString()}];
  });
  const start=message(11001,'/start');
  await send(start);
  assert.match(card().text,/подключите Telegram/);
  assert.ok(card().reply_markup.inline_keyboard.flat().some(button=>button.text==='Моя подписка'));
  await send(start);
  assert.equal(replies.length,1);

  const users={};
  for(const [i,plan] of ['pro','exclusive','free'].entries()){
    const chat=11001+i,account=await f.register(plan+'@orbita.example.test');
    users[plan]={chat,account};
    if(plan!=='free')await grant(account.data.user.id,plan);
    const {data:{deepLink}}=await f.request('/api/notifications/telegram/link',{method:'POST',cookie:account.cookie,body:{}});
    const token=new URL(deepLink).searchParams.get('start');
    assert.equal((await send(message(chat,'/start '+token))).data.linked,true);
    assert.equal((await options(account.cookie,{proSignals:true,exclusiveSignals:true,ideaClosures:true})).status,200);
  }
  const {chat,account}=users.pro;
  const toggle=callback(chat,'tc:p:levelChanges:1');
  const beforeCallback=replies.length;
  await send(callback(chat,'tc:p:levelChanges:1',123456));
  assert.equal(replies.length,beforeCallback);
  await send(toggle);
  await send(toggle);
  assert.equal(replies.length,beforeCallback+2);
  assert.equal((await f.request('/api/notifications/preferences',{cookie:account.cookie})).data.preferences.levelChanges,true);
  await f.service.tick();

  function idea(ticker,strategy){
    return f.ideas.create(editor,{mode:'full',d:{ticker,dir:'ЛОНГ',strategy,entry:100,stop:90,target:130,
      entryRule:'Вход подтверждён.',cancelRule:'Выход по стопу.'}});
  }
  const {record:pro}=await idea('SBER','Momentum RU');
  const {record:exclusive}=await idea('GAZP','Orbita Exclusive');
  const firstDelivery=replies.length;
  await f.service.tick();
  assert.deepEqual(replies.slice(firstDelivery).map(message=>[Number(message.chat_id),message.text.includes('GAZP')]).sort(),
    [[users.pro.chat,false],[users.exclusive.chat,false],[users.exclusive.chat,true]]);
  await f.service.tick();
  assert.equal(replies.length,firstDelivery+3);

  await send(callback(chat,'tc:i:'+exclusive.id));
  assert.match(card().text,/Материал недоступен/);
  assert.doesNotMatch(card().text,/GAZP|130/);
  await send(callback(users.exclusive.chat,'tc:i:'+exclusive.id));
  assert.match(card().text,/GAZP.*EXCLUSIVE|EXCLUSIVE.*GAZP/);
  await send(callback(users.free.chat,'tc:i:'+pro.id));
  assert.doesNotMatch(card().text,/SBER|130/);

  await f.ideas.update(editor,pro.id,{action:'activate',note:'Вход.'});
  await f.ideas.update(editor,pro.id,{action:'partial-close',price:110,percent:25,
    occurredAt:new Date().toISOString(),reason:'Зафиксировать четверть'});
  await f.ideas.update(editor,pro.id,{action:'early-close',price:90,occurredAt:new Date().toISOString(),
    reason:'Сценарий перестал работать'});
  await f.service.tick();
  assert.ok(replies.some(message=>Number(message.chat_id)===chat&&/Осталось 75%/.test(message.text)));
  assert.ok(replies.some(message=>Number(message.chat_id)===chat&&/Сценарий перестал работать[\s\S]+−5%/.test(message.text)));

  offset+=601000;
  await send(callback(users.exclusive.chat,'tc:i:'+exclusive.id));
  assert.match(card().text,/Материал недоступен/);
  assert.doesNotMatch(card().text,/GAZP|130/);
});
