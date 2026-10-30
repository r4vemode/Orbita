import test from 'node:test';
import assert from 'node:assert/strict';
import {createHook} from 'node:async_hooks';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {serviceFixture} from './service-fixture.mjs';

const versionOne='ORBITA-2026-10-27-1',versionTwo='ORBITA-2026-10-27-2';
const registration=(email,legalVersion)=>({email,password:'legal-consent-fixture-password',acceptTerms:true,acceptPrivacy:true,legalVersion});
const service=options=>serviceFixture(async()=>({webhookPaths:[],handle:async()=>false}),options);
const register=(f,email,version)=>f.request('/api/register',{method:'POST',body:registration(email,version)});

test('registration records the current published version while older accepted versions remain unchanged',async()=>{
  let active=versionOne;const f=await service({legalVersionProvider:async()=>active});
  try{
    assert.equal(await f.accounts.currentLegalVersion(),versionOne);
    const first=await register(f,'legal-first@example.test',versionOne);assert.equal(first.status,200);
    const before=(await f.accounts.readDatabase()).users.find(user=>user.id===first.data.user.id).consents;assert.equal(before.legalVersion,versionOne);
    active=versionTwo;const me=await f.request('/api/me',{cookie:first.cookie});assert.equal(me.status,200);assert.equal(me.data.legalVersion,versionTwo);assert.equal(me.data.user.id,first.data.user.id);
    const second=await register(f,'legal-second@example.test',versionTwo);assert.equal(second.status,200);
    const db=await f.accounts.readDatabase();assert.deepEqual(db.users.find(user=>user.id===first.data.user.id).consents,before);assert.equal(db.users.find(user=>user.id===second.data.user.id).consents.legalVersion,versionTwo);
  }finally{await f.close();}
});

test('stale consent is rejected before password work and does not write an account or registration counters',async()=>{
  const f=await service({legalVersionProvider:()=>versionTwo});let derivations=0;const hook=createHook({init(_id,type){if(type==='SCRYPTREQUEST')derivations++;}});
  try{
    const before=await f.accounts.readDatabase();hook.enable();const result=await register(f,'stale-consent@example.test',versionOne);hook.disable();
    assert.equal(result.status,409);assert.equal(result.data.code,'LEGAL_VERSION_CHANGED');assert.equal(derivations,0);assert.equal(result.cookie,undefined);assert.deepEqual(await f.accounts.readDatabase(),before);
    const missing=await f.request('/api/register',{method:'POST',body:{...registration('missing-consent@example.test',versionTwo),acceptPrivacy:false}});assert.equal(missing.status,400);
  }finally{hook.disable();await f.close();}
});

test('a legal publication during password derivation prevents stale account creation inside the transaction',async()=>{
  let active=versionOne,changed=false;const f=await service({legalVersionProvider:()=>active}),hook=createHook({init(_id,type){if(type==='SCRYPTREQUEST'&&!changed){active=versionTwo;changed=true;}}});
  try{
    const before=await f.accounts.readDatabase();hook.enable();const result=await register(f,'racing-consent@example.test',versionOne);hook.disable();
    assert.equal(changed,true);assert.equal(result.status,409);assert.equal(result.data.code,'LEGAL_VERSION_CHANGED');assert.equal(result.cookie,undefined);assert.deepEqual(await f.accounts.readDatabase(),before);
    const retry=await register(f,'racing-consent@example.test',versionTwo);assert.equal(retry.status,200);const db=await f.accounts.readDatabase();assert.equal(db.users.length,1);assert.equal(db.users[0].consents.legalVersion,versionTwo);assert.equal(db.registrationStats.successful,1);
  }finally{hook.disable();await f.close();}
});

test('unavailable or invalid legal version providers fail closed without falling back to the bundled version',async()=>{
  for(const value of [null,1,{},'','OTHER-2026','ORBITA-injected&next=outside']){
    const f=await service({legalVersionProvider:async()=>value});
    try{
      const before=await f.accounts.readDatabase(),result=await register(f,'invalid-provider@example.test','ORBITA-2026-10-20');assert.equal(result.status,503);assert.equal(result.data.code,'LEGAL_VERSION_UNAVAILABLE');assert.deepEqual(await f.accounts.readDatabase(),before);
      assert.equal((await f.request('/api/me')).status,503);
    }finally{await f.close();}
  }
  const f=await service({legalVersionProvider:async()=>{throw Error('private-provider-location and secret');}});
  try{const result=await register(f,'unavailable-provider@example.test','ORBITA-2026-10-20');assert.equal(result.status,503);assert.equal(result.data.code,'LEGAL_VERSION_UNAVAILABLE');assert.ok(!JSON.stringify(result.data).includes('private-provider-location'));}
  finally{await f.close();}
});

test('a stale browser consent refreshes pinned document links and requires fresh explicit checks before retry',async()=>{
  const source=await readFile(new URL('../public/assets/account.js',import.meta.url),'utf8');
  const field=value=>({value,checked:true,disabled:false,required:false,focus(){}}),elements={email:field('browser-consent@example.test'),password:field('browser-consent-password'),code:field(''),acceptTerms:field(''),acceptPrivacy:field('')};
  const form={elements},nodes={accountForm:form,credentials:{querySelectorAll:()=>[elements.email,elements.password]},consents:{querySelectorAll:()=>[elements.acceptTerms,elements.acceptPrivacy]},termsLink:{href:''},privacyLink:{href:''}};
  for(const id of ['message','submit','switch','title','subtitle','mfaChallenge','cancelMfa'])nodes[id]={disabled:false,textContent:'',hidden:false};
  let active=versionOne,registrations=0,configurations=0;const bodies=[],navigations=[],location={origin:'https://orbita.example',protocol:'https:',href:'https://orbita.example/account.html?mode=register&plan=exclusive',search:'?mode=register&plan=exclusive',assign:value=>navigations.push(value)};
  const A={safeNext:()=>'/subscriptions.html',rememberPlan(){},preferredPlan:()=>null,request:async(path,options)=>{
    if(path==='/api/public-config'){configurations++;return {legalVersion:active};}
    assert.equal(path,'/api/register');registrations++;bodies.push(JSON.parse(options.body));
    if(registrations===1){active=versionTwo;throw Object.assign(Error('Updated terms'),{status:409,code:'LEGAL_VERSION_CHANGED'});}
    return {user:{id:'browser-consent',emailVerified:false,access:{hasSubscription:false}}};
  }};
  const context=vm.createContext({OrbitaAccess:A,document:{getElementById:id=>nodes[id]},location,history:{replaceState(){}},URL,URLSearchParams});await vm.runInContext(source,context);
  assert.equal(nodes.termsLink.href,'offer.html?version='+versionOne);assert.equal(nodes.privacyLink.href,'privacy.html?version='+versionOne);
  const submit=()=>form.onsubmit({preventDefault(){}});await submit();assert.equal(registrations,1);assert.equal(configurations,2);assert.equal(elements.acceptTerms.checked,false);assert.equal(elements.acceptPrivacy.checked,false);assert.equal(nodes.termsLink.href,'offer.html?version='+versionTwo);assert.equal(nodes.privacyLink.href,'privacy.html?version='+versionTwo);assert.match(nodes.message.textContent,/Документы обновились/);assert.deepEqual(navigations,[]);
  await submit();assert.equal(registrations,1,'clicking retry must not automatically agree to the new documents');elements.acceptTerms.checked=true;elements.acceptPrivacy.checked=true;await submit();assert.equal(registrations,2);assert.equal(bodies[1].legalVersion,versionTwo);assert.equal(bodies[1].acceptTerms,true);assert.equal(bodies[1].acceptPrivacy,true);assert.deepEqual(navigations,['/security.html?verify=1&plan=exclusive']);
});
