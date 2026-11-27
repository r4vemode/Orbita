import assert from 'node:assert/strict';
import test from 'node:test';
import {createTelegramClientMenu, isTelegramClientAction} from '../lib/telegram-client/menu.mjs';
import {canReadTier, PLANS} from '../lib/access.mjs';

const AT=Date.parse('2026-11-27T09:00:00Z');
const FUTURE='2026-12-27T09:00:00Z';
const PAST='2026-11-26T09:00:00Z';
const origin='https://orbita.example.test';
const user=(plan=null,expiresAt=FUTURE)=>({id:plan||'free',role:'member',subscriptions:plan?[{plan,expiresAt}]:[]});
function idea(id,ticker,patch={}){
  const {d={},meta={},...record}=patch;
  return {id,published:true,...record,d:{ticker,strategy:'Momentum RU',market:'stocks',dir:'ЛОНГ',state:'active',status:'Активна',entry:100,stop:90,target:120,...d},
    meta:{publishedAt:PAST,updatedAt:PAST,...meta}};
}
const wire=screen=>JSON.stringify(screen);
const buttons=screen=>screen.keyboard.flat();

function sample({entries=[],events=[],lessons=[]}={}){
  const calls={lists:0,detail:0,radarQuery:null,updates:[]};
  let now=AT;
  const menu=createTelegramClientMenu({
    ideas:{
      list:async()=>{calls.lists++;return {records:entries};},
      get:async id=>{calls.detail++;return entries.find(record=>record.id===id);}
    },
    radar:{
      canAccess:actor=>actor?.id==='free'||canReadTier(actor,'pro',now),
      canRealtime:actor=>canReadTier(actor,'pro',now),
      overview:async (_actor,query)=>{calls.radarQuery=query;return {events};},
      detail:async (_actor,id)=>({event:events.find(event=>event.id===id)})
    },
    content:{readArticles:async()=>({lessons})},
    publicOrigin:origin,now:()=>now
  });
  return {render:menu.render,calls,setNow:value=>{now=value;}};
}

test('client start, help and subscription show account actions without a checkout link',async()=>{
  const {render}=sample();
  const start=await render();
  for(const title of ['Сигналы','Radar','Статьи','История идей','Моя подписка','Уведомления','Помощь']){
    assert.ok(buttons(start).some(button=>button.text===title));
  }
  assert.match(start.text,/подключите Telegram/);
  assert.ok(buttons(start).every(button=>!button.url||button.url.startsWith(origin+'/')));
  const sub=await render({action:'tc:sub',user:user('exclusive')});
  assert.match(sub.text,/Текущий доступ EXCLUSIVE/);
  assert.match(sub.text,/Включает доступ PRO/);
  const price=new Intl.NumberFormat('ru-RU').format(PLANS.pro.price);
  assert.ok(sub.text.includes(price+' ₽'));
  assert.equal(buttons(sub).some(button=>button.url),false);
  const expired=await render({action:'tc:sub',user:user('pro',PAST)});
  assert.match(expired.text,/Активной подписки нет/);
  const help=await render({action:'tc:help',user:user()});
  assert.ok(buttons(help).some(button=>button.url===origin+'/#faq'));
});

test('signal lists, detailed callbacks, and history never expose inaccessible or unpublished ideas',async()=>{
  const entries=[
    idea('ordinary','SBER'),idea('secret','SECRET-TICKER',{d:{strategy:'Orbita Exclusive',entry:12345}}),
    idea('draft','HIDDEN-DRAFT',{published:false}),
    idea('archive','HIDDEN-ARCHIVE',{archived:true}),idea('demo-test','HIDDEN-DEMO',{demo:true}),
    idea('partial','GAZP',{meta:{closures:[{percent:25,price:110,resultPct:10,contributionPct:2.5,occurredAt:PAST,
      reason:'Часть зафиксирована',priceOrigin:'admin'}],remainingPct:75,realizedPct:2.5}}),
    idea('wrong','BROKEN',{erroneous:true,meta:{errorReason:'Ошибочный тикер'}})
  ];
  const {render,calls,setNow}=sample({entries});
  for(const actor of [null,user(),user('pro',PAST)]){
    for(const action of ['tc:s:a:a:a:a:0','tc:i:ordinary','tc:h:0']){
      const denied=await render({action,user:actor});
      assert.match(denied.text,/недоступен/);
    }
  }
  assert.equal(calls.lists,0);
  assert.equal(calls.detail,0);
  const visible=await render({action:'tc:s:a:a:a:a:0',user:user('pro')});
  assert.match(visible.text,/SBER/);
  assert.doesNotMatch(wire(visible),/SECRET|HIDDEN|BROKEN|tc:i:secret|12345/);
  const direct=await render({action:'tc:i:secret',user:user('pro')});
  assert.match(direct.text,/недоступен/);
  assert.doesNotMatch(wire(direct),/SECRET|12345/);
  const both=await render({action:'tc:s:a:a:a:a:0',user:user('exclusive')});
  assert.match(both.text,/SECRET-TICKER/);
  assert.match(both.text,/SBER/);
  assert.doesNotMatch(wire(both),/HIDDEN/);
  const history=await render({action:'tc:h:0',user:user('pro')});
  assert.match(history.text,/частичный выход/);
  assert.match(history.text,/Ошибочная публикация/);
  const partial=await render({action:'tc:j:partial',user:user('pro')});
  assert.match(partial.text,/25% по 110/);
  assert.match(partial.text,/Остаток 75%/);
  assert.match(partial.text,/Часть зафиксирована/);
  assert.match(partial.text,/Расчёт по уровням идеи/);
  setNow(Date.parse('2027-01-01T00:00:00Z'));
  assert.match((await render({action:'tc:i:secret',user:user('exclusive')})).text,/недоступен/);
});

test('signal filters and paginated buttons stay within Bot API callback limits',async()=>{
  const entries=Array.from({length:7},(_,i)=>idea('idea-'+i,'FUT'+i,{d:{strategy:'Импульс',market:'futures',dir:'ШОРТ'}}));
  entries.push(idea('stock','SBER'));
  const {render}=sample({entries});
  const filter=await render({action:'tc:f:p:f:o:s:0',user:user('pro')});
  assert.ok(buttons(filter).some(button=>button.text==='✓ Фьючерсы'));
  assert.ok(buttons(filter).some(button=>button.text==='✓ SHORT'));
  assert.ok(!buttons(filter).some(button=>button.text.includes('EXCLUSIVE')));
  const first=await render({action:'tc:s:p:f:o:s:0',user:user('pro')});
  assert.match(first.text,/Страница 1\/2/);
  assert.doesNotMatch(first.text,/SBER/);
  const next=buttons(first).find(button=>button.text==='Дальше →');
  assert.ok(next);
  const second=await render({action:next.callback_data,user:user('pro')});
  assert.match(second.text,/Страница 2\/2/);
  assert.match(second.text,/FUT6/);
  for(const screen of [filter,first,second]){
    assert.ok(buttons(screen).filter(button=>button.callback_data).every(button=>isTelegramClientAction(button.callback_data)));
  }
  for(const action of ['tc:p:constructor:1','tc:s:a:a:wrong:a:0','tc:i:bad/id','tc:i:'+('a'.repeat(61)),'ta:home']){
    assert.equal(isTelegramClientAction(action),false,action);
  }
});

test('Radar uses entitled service access and only trusted source URLs',async()=>{
  const {render,calls}=sample({events:[
    {id:'radar-paid',ticker:'SBER',headline:'Официальное событие',summary:'Сводка',publishedAt:PAST,importanceScore:8,following:true,sources:[
      {url:'http://untrusted.example.org'}, {url:'https://www.moex.com/n12345'}
    ]},
    {id:'radar-another',ticker:'MOEX',headline:'Другое событие',following:false},
    {id:'radar-demo',ticker:'DEMO',headline:'Демонстрационное',following:true,isDemo:true}
  ]});
  assert.match((await render({action:'tc:e:radar-paid',user:user()})).text,/недоступен/);
  const list=await render({action:'tc:r:f',user:user('pro')});
  assert.equal(calls.radarQuery.get('watchlist'),'1');
  assert.match(list.text,/Официальное событие/);
  assert.doesNotMatch(wire(list),/Другое событие|radar-another|radar-demo/);
  const detail=await render({action:'tc:e:radar-paid',user:user('pro')});
  assert.ok(buttons(detail).some(button=>button.url==='https://www.moex.com/n12345'));
  assert.doesNotMatch(wire(detail),/untrusted/);
});

test('articles distinguish public, member, exclusive, future and draft content',async()=>{
  const article=(id,title,access,patch={})=>({id,title,access,kind:'article',published:true,intro:title+' summary',...patch});
  const {render}=sample({lessons:[
    article('a-public','Public article','public'),article('a-pro','Pro article','member'),
    article('a-secret','Hidden Exclusive','exclusive'),article('a-draft','Hidden Draft','public',{published:false}),
    article('a-future','Hidden Future','public',{publication:{publishedAt:FUTURE}})
  ]});
  const guest=await render({action:'tc:a:0'});
  assert.match(guest.text,/Public article/);
  assert.doesNotMatch(wire(guest),/Hidden|Pro article/);
  const member=await render({action:'tc:a:0',user:user('pro')});
  assert.match(member.text,/Pro article/);
  assert.doesNotMatch(wire(member),/Hidden|a-secret/);
  assert.match((await render({action:'tc:d:a-secret',user:user('pro')})).text,/недоступен/);
  const allowed=await render({action:'tc:d:a-secret',user:user('exclusive')});
  assert.match(allowed.text,/Hidden Exclusive summary/);
  assert.ok(buttons(allowed).some(button=>button.url===origin+'/article.html?id=a-secret'));
  assert.match((await render({action:'tc:d:a-future'})).text,/недоступен/);
});

test('preferences use explicit replay-safe values and enforce the subscriber tier',async()=>{
  const {render,calls}=sample();
  const updatePreferences=async patch=>{calls.updates.push(patch);return patch;};
  const pro=user('pro');
  assert.match((await render({action:'tc:p:exclusiveSignals:1',user:pro,updatePreferences})).text,/недоступен/);
  assert.match((await render({action:'tc:p:proSignals:1',user:user(),updatePreferences})).text,/недоступен/);
  assert.match((await render({action:'tc:p:articles:1',updatePreferences})).text,/недоступен/);
  assert.deepEqual(calls.updates,[]);
  for(let i=0;i<2;i++){
    const next=await render({action:'tc:p:proSignals:1',user:pro,updatePreferences});
    assert.ok(buttons(next).some(button=>button.callback_data==='tc:p:proSignals:0'));
  }
  await render({action:'tc:p:proSignals:0',user:pro,updatePreferences});
  await render({action:'tc:p:articles:1',user:user(),updatePreferences});
  assert.deepEqual(calls.updates,[{proSignals:true},{proSignals:true},{proSignals:false},{articles:true}]);
});
