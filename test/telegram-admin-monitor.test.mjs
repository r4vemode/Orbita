import test from 'node:test';
import assert from 'node:assert/strict';
import {createTelegramAdmin} from '../lib/telegram-admin/service.mjs';
import {serviceFixture} from './service-fixture.mjs';

test('system alarms go to verified bindings and respect the durable cooldown after restart',async t=>{
  const env={ORBITA_PUBLIC_ORIGIN:'https://orbita.example.test',TELEGRAM_ADMIN_BOT_ENABLED:'true',
    TELEGRAM_ADMIN_BOT_TOKEN:'123456:fixture_admin_token_for_tests',TELEGRAM_ADMIN_BOT_USERNAME:'OrbitaAdminFixtureBot',
    TELEGRAM_ADMIN_WEBHOOK_SECRET:'fixture_admin_monitor_webhook_secret'};
  let oldestPendingSeconds=0,offset=0,dependencies;
  const sent=[],now=()=>Date.now()+offset;
  const f=await serviceFixture(({accounts,ideas})=>{
    dependencies={accounts,ideas,env,now,notifications:{configured:true,statistics:async()=>({oldestPendingSeconds,pending:7,recentFailures:0})},
      send:async(method,payload)=>{sent.push({method,...payload});return {message_id:sent.length};}};
    return createTelegramAdmin(dependencies);
  });
  t.after(()=>f.close());
  const admin=await f.register('monitor-fixture@example.test');
  await f.accounts.promote(admin.data.user.email);
  await f.accounts.transact(db=>{
    db.users.find(user=>user.id===admin.data.user.id).mfa={enabled:true,secret:'fixture-encrypted-envelope'};
    db.sessions.find(session=>session.userId===admin.data.user.id).mfa=true;
  });
  const {data:{code}}=await f.request('/api/admin/telegram/link',{method:'POST',body:{},cookie:admin.cookie});
  await f.service.store.connect(12001,12001,code);
  await f.service.pump();
  assert.equal(sent.length,0);

  oldestPendingSeconds=660;
  offset+=61000;
  await f.service.pump();
  assert.equal(sent.length,1);
  assert.match(sent[0].text,/Системный сбой[\s\S]+7 задач[\s\S]+11 мин/);
  assert.equal(Number(sent[0].chat_id),12001);
  const restarted=createTelegramAdmin(dependencies);
  t.after(()=>restarted.close());
  await restarted.pump();
  assert.equal(sent.length,1);
  offset+=3601000;
  await restarted.pump();
  assert.equal(sent.length,2);

  await f.accounts.transact(db=>{db.users.find(user=>user.id===admin.data.user.id).role='member';});
  offset+=3601000;
  await restarted.pump();
  assert.equal(sent.length,2);
});
