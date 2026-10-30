import test from 'node:test';
import assert from 'node:assert/strict';
import {createHook} from 'node:async_hooks';
import {serviceFixture} from './service-fixture.mjs';
import {json,readJson} from '../lib/http.mjs';
import {totp} from '../lib/account-security.mjs';

const password='test-password-long-2026';
async function fixture(options={}){
  return serviceFixture(async({accounts})=>({webhookPaths:[],async handle(req,res,url){
    if(url.pathname!=='/test-sensitive')return false;
    const credentials=await readJson(req),user=await accounts.authorizeSensitive(req,credentials);
    json(res,200,{user});return true;
  }}),options);
}
async function owner(f,email='sensitive-owner@example.test'){
  const registered=await f.register(email);assert.equal(registered.status,200);await f.accounts.promote(email);return registered;
}
const sensitive=(f,account,body={password},headers={})=>f.request('/test-sensitive',{method:'POST',cookie:account?.cookie,body,headers});
async function enroll(f,account){
  const setup=await f.request('/api/security/mfa/setup',{method:'POST',cookie:account.cookie,body:{password}});assert.equal(setup.status,200);
  const usedCode=totp(setup.data.secret),confirmed=await f.request('/api/security/mfa/confirm',{method:'POST',cookie:account.cookie,body:{code:usedCode}});assert.equal(confirmed.status,200);
  return {secret:setup.data.secret,codes:confirmed.data.recoveryCodes,usedCode};
}

test('sensitive actions require current admin session, same-origin POST and current password without persisting credentials',async()=>{
  const f=await fixture();
  try{
    const admin=await owner(f),member=await f.register('sensitive-member@example.test');assert.equal(member.status,200);
    assert.equal((await sensitive(f,null)).status,401);assert.equal((await sensitive(f,member)).status,403);
    assert.equal((await sensitive(f,admin,{password},{Origin:'https://outside.example'})).status,403);
    assert.equal((await sensitive(f,admin,{password:'wrong-sensitive-password'})).status,401);
    assert.equal((await sensitive(f,admin,{})).status,401);
    const before=await f.accounts.readDatabase(),approved=await sensitive(f,admin);assert.equal(approved.status,200);assert.equal(approved.data.user.role,'admin');
    assert.deepEqual(await f.accounts.readDatabase(),before,'password-only approval changes no account data');
    const serialized=JSON.stringify(approved.data)+JSON.stringify(await f.accounts.readDatabase());assert.ok(!serialized.includes(password));assert.ok(!serialized.includes('wrong-sensitive-password'));
    const cookie=admin.cookie,headers={host:new URL(f.base).host,origin:f.base,cookie},req={method:'GET',headers,socket:{remoteAddress:'127.0.0.1'}};
    await assert.rejects(f.accounts.authorizeSensitive(req,{password}),cause=>cause.status===405);
  }finally{await f.close();}
});

test('an admin requiring MFA enrollment or a session without its completed second factor cannot authorize publication',async()=>{
  const f=await fixture({requireAdminMfa:true});
  try{
    const admin=await owner(f);assert.equal((await sensitive(f,admin)).status,403);
    const {codes}=await enroll(f,admin);
    await f.accounts.transact(db=>{db.sessions.find(session=>session.userId===admin.data.user.id).mfa=false;});
    assert.equal((await sensitive(f,admin,{password,code:codes[0]})).status,403,'fresh code does not bypass an incomplete session');
    const login=await f.request('/api/login',{method:'POST',body:{email:admin.data.user.email,password}});assert.equal(login.data.mfaRequired,true);assert.equal(login.cookie,undefined);
    assert.equal((await sensitive(f,login,{password,code:codes[0]})).status,401,'password challenge is not an authorized session');
  }finally{await f.close();}
});

test('MFA approval consumes a fresh recovery code exactly once, including concurrent requests',async()=>{
  const f=await fixture({requireAdminMfa:true});
  try{
    const admin=await owner(f),{secret,codes,usedCode}=await enroll(f,admin);
    assert.equal((await sensitive(f,admin,{password})).status,401);
    assert.equal((await sensitive(f,admin,{password,code:usedCode})).status,401,'setup TOTP already used');
    const duplicate=await Promise.all([sensitive(f,admin,{password,code:codes[0]}),sensitive(f,admin,{password,code:codes[0]})]);
    assert.deepEqual(duplicate.map(result=>result.status).sort(),[200,401]);
    assert.equal((await sensitive(f,admin,{password,code:codes[1]})).status,200);
    const db=await f.accounts.readDatabase();assert.equal(db.users.find(user=>user.id===admin.data.user.id).mfa.recoveryHashes.length,8);
    for(const value of [password,secret,...codes])assert.ok(!JSON.stringify(db).includes(value));
  }finally{await f.close();}
});

test('sensitive action attempts are bounded separately from ordinary login',async()=>{
  const f=await fixture();
  try{
    const admin=await owner(f);
    for(let attempt=0;attempt<5;attempt++)assert.equal((await sensitive(f,admin,{password:'wrong-sensitive-password'})).status,401);
    assert.equal((await sensitive(f,admin)).status,429);
    const login=await f.request('/api/login',{method:'POST',body:{email:admin.data.user.email,password}});assert.equal(login.status,200,'sensitive action budget does not block normal login');
  }finally{await f.close();}
});

test('session revocation or password change during password derivation invalidates sensitive authorization',async()=>{
  for(const mutation of ['session','password']){
    const f=await fixture();let scheduled,hook;
    try{
      const admin=await owner(f);
      hook=createHook({init(_id,type){if(type==='SCRYPTREQUEST'&&!scheduled){scheduled=f.accounts.transact(db=>{if(mutation==='session')db.sessions=db.sessions.filter(session=>session.userId!==admin.data.user.id);else db.users.find(user=>user.id===admin.data.user.id).hash='0'.repeat(128);});}}});
      hook.enable();const result=await sensitive(f,admin);hook.disable();await scheduled;assert.ok(scheduled);assert.equal(result.status,401,mutation);
    }finally{hook?.disable();await f.close();}
  }
});
