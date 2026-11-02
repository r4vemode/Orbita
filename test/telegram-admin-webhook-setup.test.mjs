import test from 'node:test';
import assert from 'node:assert/strict';
import {configureTelegramAdminWebhook} from '../scripts/setup-telegram-admin.mjs';

const env={TELEGRAM_ADMIN_BOT_ENABLED:'true',TELEGRAM_ADMIN_BOT_TOKEN:'123456:fixture_admin_token_not_a_real_secret',TELEGRAM_ADMIN_BOT_USERNAME:'OrbitaFixtureBot',TELEGRAM_ADMIN_WEBHOOK_SECRET:'fixture_webhook_secret_at_least_32_chars',ORBITA_PUBLIC_ORIGIN:'https://orbita.example.test'};
function harness(responses){const calls=[],lines=[];return {calls,lines,options:{env,log:value=>lines.push(value),errorLog:value=>lines.push(value),fetchImpl:async(url,options)=>{const method=url.split('/').at(-1);calls.push({method,body:JSON.parse(options.body),redirect:options.redirect});return new Response(JSON.stringify({ok:true,result:responses[method]}));}}};}

test('webhook setup is explicitly invoked and disabled/help/bad arguments never contact Telegram',async()=>{
 const context=harness({});assert.equal((await configureTelegramAdminWebhook(['--help'],context.options)).exitCode,0);assert.equal((await configureTelegramAdminWebhook(['--token=secret'],context.options)).exitCode,2);
 assert.equal((await configureTelegramAdminWebhook([],{...context.options,env:{}})).exitCode,0);assert.equal((await configureTelegramAdminWebhook(['--set'],{...context.options,env:{}})).code,'BOT_DISABLED');assert.equal(context.calls.length,0);
});

test('webhook setup verifies the selected bot, retains pending updates and uses a secret header',async()=>{
 const context=harness({getMe:{is_bot:true,username:env.TELEGRAM_ADMIN_BOT_USERNAME},setWebhook:true,getWebhookInfo:{url:env.ORBITA_PUBLIC_ORIGIN+'/api/telegram/webhook',pending_update_count:3}});
 const result=await configureTelegramAdminWebhook(['--set'],context.options);assert.equal(result.exitCode,0);assert.equal(result.matches,true);assert.equal(result.pendingUpdates,3);
 assert.deepEqual(context.calls.map(item=>item.method),['getMe','setWebhook','getWebhookInfo']);const setup=context.calls[1];assert.equal(setup.redirect,'error');assert.equal(setup.body.secret_token,env.TELEGRAM_ADMIN_WEBHOOK_SECRET);assert.equal(setup.body.drop_pending_updates,false);assert.deepEqual(setup.body.allowed_updates,['message','callback_query']);assert.equal(setup.body.max_connections,2);
 assert.ok(!context.lines.join('\n').includes(env.TELEGRAM_ADMIN_BOT_TOKEN));assert.ok(!context.lines.join('\n').includes(env.TELEGRAM_ADMIN_WEBHOOK_SECRET));
});

test('a wrong bot cannot be reconfigured and raw transport errors cannot disclose the token',async()=>{
 const context=harness({getMe:{is_bot:true,username:'WrongFixtureBot'}});assert.equal((await configureTelegramAdminWebhook(['--set'],context.options)).code,'BOT_USERNAME_MISMATCH');assert.deepEqual(context.calls.map(item=>item.method),['getMe']);
 const lines=[];const result=await configureTelegramAdminWebhook(['--status'],{env,log:value=>lines.push(value),errorLog:value=>lines.push(value),fetchImpl:async()=>{throw Error('https://api.telegram.org/bot'+env.TELEGRAM_ADMIN_BOT_TOKEN);}});assert.equal(result.exitCode,1);assert.ok(!JSON.stringify({result,lines}).includes(env.TELEGRAM_ADMIN_BOT_TOKEN));
});

test('read-only webhook status reports a mismatch without echoing another endpoint or provider errors',async()=>{
 const context=harness({getWebhookInfo:{url:'https://elsewhere.example/private-path?token=private',pending_update_count:2,last_error_date:1,last_error_message:'private diagnostic'}});const result=await configureTelegramAdminWebhook([],context.options);
 assert.equal(result.matches,false);assert.equal(result.hasDeliveryError,true);assert.deepEqual(context.calls.map(item=>item.method),['getWebhookInfo']);assert.ok(!JSON.stringify({result,lines:context.lines}).includes('private'));
});
