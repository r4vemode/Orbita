import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {serviceFixture} from './service-fixture.mjs';
import {LEGAL_VERSION} from '../lib/access.mjs';
import {securityEmail} from '../lib/mail.mjs';

const payload=(email,plan)=>({email,password:'continuation-password-2026',acceptTerms:true,acceptPrivacy:true,legalVersion:LEGAL_VERSION,plan});
const mailUrl=mail=>new URL(mail.text.match(/https?:\/\/\S+/)[0]);

test('registration and resend preserve only recognised plan in verification email without granting access',async()=>{
  const f=await serviceFixture(async()=>({webhookPaths:[],handle:async()=>false}));
  try{
    const response=await f.request('/api/register',{method:'POST',body:payload('plan@example.test','exclusive')});assert.equal(response.status,200);
    const original=mailUrl(f.emails.at(-1));assert.equal(original.searchParams.get('plan'),'exclusive');assert.match(original.hash,/^#token=[a-f0-9]{64}$/);assert.deepEqual(response.data.user.subscriptions,[]);assert.equal(response.data.user.access.hasSubscription,false);assert.ok(!JSON.stringify(response.data).includes(original.hash.slice(7)));
    const resend=await f.request('/api/security/resend-verification',{method:'POST',cookie:response.cookie,body:{plan:'pro'}});assert.equal(resend.status,200);const next=mailUrl(f.emails.at(-1));assert.equal(next.searchParams.get('plan'),'pro');assert.notEqual(next.hash,original.hash);
    const verify=await f.request('/api/security/verify-email',{method:'POST',body:{token:next.hash.slice(7)}});assert.equal(verify.status,200);const user=(await f.request('/api/me',{cookie:response.cookie})).data.user;assert.equal(user.emailVerified,true);assert.deepEqual(user.subscriptions,[]);
    for(const value of ['admin','https://outside.example','exclusive&redirect=//outside.example',null]){
      const email=securityEmail('verify','sample@example.test','a'.repeat(64),f.base,{plan:value});assert.equal(mailUrl(email).search,'');
    }
    assert.equal(mailUrl(securityEmail('reset','sample@example.test','a'.repeat(64),f.base,{plan:'exclusive'})).search,'');
  }finally{await f.close();}
});

test('preferred tariff is scoped by account and survives a new page without becoming an entitlement',async()=>{
  const source=await readFile(new URL('../public/assets/access.js',import.meta.url),'utf8'),values=new Map();
  const localStorage={getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value)};
  function page(){const window={addEventListener(){}},context=vm.createContext({window,localStorage,location:{origin:'https://orbita.example'},URL});vm.runInContext(source,context);return window.OrbitaAccess;}
  const first=page();first.rememberPlan('one','exclusive');assert.equal(page().preferredPlan('one'),'exclusive');assert.equal(page().preferredPlan('two'),null);first.rememberPlan('one','admin');assert.equal(page().preferredPlan('one'),'exclusive');assert.equal(first.user,null);
  values.set('orbita.selected-plan.v1.one','javascript:alert(1)');assert.equal(page().preferredPlan('one'),null);
});

test('verification opened in a new browser keeps email plan and strips token before continuing',async()=>{
  const source=await readFile(new URL('../public/assets/security.js',import.meta.url),'utf8'),button={disabled:false},form={hidden:false,querySelector:()=>button},nodes={verifyEmailForm:form,verifyMessage:{},verifiedContinue:{hidden:true}},calls=[];
  const window={addEventListener(){}},location={hash:'#token='+'b'.repeat(64),search:'?plan=exclusive',pathname:'/verify-email.html'},history={replaceState(_a,_b,url){assert.equal(url,'/verify-email.html?plan=exclusive');location.hash='';}};
  const A={preferredPlan:()=>null,rememberPlan(){throw Error('There is no logged-in user');},current:async()=>null,request:async(path,options)=>{calls.push({path,body:JSON.parse(options.body)});return {ok:true};}};
  const context=vm.createContext({window,location,history,URLSearchParams,document:{body:{dataset:{securityPage:'verify'}},getElementById:id=>nodes[id]},OrbitaAccess:A});
  await vm.runInContext(source,context);await form.onsubmit({preventDefault(){}});
  assert.equal(location.hash,'');assert.equal(nodes.verifiedContinue.href,'subscriptions.html?plan=exclusive');assert.equal(nodes.verifiedContinue.hidden,false);assert.equal(calls[0].path,'/api/security/verify-email');assert.equal(calls[0].body.token,'b'.repeat(64));assert.equal(form.hidden,true);
});
