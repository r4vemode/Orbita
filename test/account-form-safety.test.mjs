import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

const source=await readFile(new URL('../public/assets/account.js',import.meta.url),'utf8');
const accessSource=await readFile(new URL('../public/assets/access.js',import.meta.url),'utf8');
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function harness({search='',configuration=Promise.resolve({legalVersion:'CURRENT-LEGAL'}),user={id:'fixture-user',emailVerified:false,access:{hasSubscription:false}}}={}){
  const field=value=>({value,disabled:false,required:false,checked:true,focus(){}}),elements={email:field('fixture@example.test'),password:field('fixture-test-password'),code:field(''),acceptTerms:field(''),acceptPrivacy:field('')};
  const form={elements},nodes={accountForm:form,credentials:{querySelectorAll:()=>[elements.email,elements.password]},consents:{querySelectorAll:()=>[elements.acceptTerms,elements.acceptPrivacy]}};
  for(const id of ['message','submit','switch','title','subtitle','mfaChallenge','cancelMfa'])nodes[id]={disabled:id==='submit',textContent:'',hidden:false};
  const location={origin:'https://orbita.example',protocol:'https:',href:'https://orbita.example/account.html'+search,search,assign(value){navigations.push(value);}},navigations=[],calls=[];
  const context=vm.createContext({window:{addEventListener(){}},document:{getElementById:id=>nodes[id]},location,history:{replaceState(){}},URL,URLSearchParams,localStorage:{getItem:()=>null,setItem(){}}});
  vm.runInContext(accessSource,context);
  const A=context.window.OrbitaAccess;A.request=async(path,options)=>{calls.push({path,body:options?.body?JSON.parse(options.body):null});if(path==='/api/public-config')return typeof configuration==='function'?configuration():configuration;return {user};};context.OrbitaAccess=A;
  const completion=vm.runInContext(source,context);
  let prevented=false;const submit=()=>form.onsubmit({preventDefault(){prevented=true;}});
  return {nodes,elements,calls,navigations,completion,submit,get prevented(){return prevented;}};
}

test('login submit is guarded before delayed public configuration and never needs native form navigation',async()=>{
  const pending=deferred(),page=harness({configuration:pending.promise});
  assert.equal(typeof page.nodes.accountForm.onsubmit,'function');assert.equal(page.nodes.submit.disabled,false);
  await page.submit();assert.equal(page.prevented,true);assert.equal(page.calls.filter(call=>call.path==='/api/login').length,1);assert.match(page.navigations[0],/^\/security\.html/);assert.ok(!page.navigations[0].includes('password'));
  pending.resolve({legalVersion:'CURRENT-LEGAL'});await page.completion;
});

test('registration waits for current consent version and ignores repeated submit while configuration is pending',async()=>{
  const pending=deferred(),page=harness({search:'?mode=register&plan=exclusive',configuration:pending.promise});
  const first=page.submit();await page.submit();await tick();assert.equal(page.prevented,true);assert.equal(page.calls.filter(call=>call.path==='/api/register').length,0);assert.equal(page.nodes.submit.disabled,true);
  pending.resolve({legalVersion:'CURRENT-LEGAL'});await first;await page.completion;
  const submitted=page.calls.filter(call=>call.path==='/api/register');assert.equal(submitted.length,1);assert.equal(submitted[0].body.legalVersion,'CURRENT-LEGAL');assert.equal(submitted[0].body.plan,'exclusive');assert.equal(page.navigations[0],'/security.html?verify=1&plan=exclusive');
});

test('failed or malformed configuration cannot register with a stale fallback consent version',async()=>{
  for(const configuration of [Promise.reject(Error('Configuration unavailable')),{legalVersion:null},null]){
    const page=harness({search:'?mode=register',configuration});await page.completion;await page.submit();assert.equal(page.prevented,true);assert.equal(page.calls.filter(call=>call.path==='/api/register').length,0);assert.equal(page.navigations.length,0);assert.ok(page.nodes.message.textContent);assert.equal(page.nodes.submit.disabled,false);
  }
});

test('registration retries failed configuration on the same page and uses the recovered consent version once',async()=>{
  const initial=deferred();let configurationCalls=0;
  const page=harness({search:'?mode=register&plan=exclusive',configuration:()=>++configurationCalls===1?initial.promise:Promise.resolve({legalVersion:'RECOVERED-LEGAL'})});
  const first=page.submit();initial.reject(Error('Temporary configuration failure'));await first;await page.completion;
  assert.equal(page.calls.filter(call=>call.path==='/api/register').length,0);assert.equal(page.navigations.length,0);assert.equal(page.nodes.submit.disabled,false);
  await page.submit();const registered=page.calls.filter(call=>call.path==='/api/register');assert.equal(configurationCalls,2);assert.equal(registered.length,1);assert.equal(registered[0].body.legalVersion,'RECOVERED-LEGAL');assert.equal(registered[0].body.plan,'exclusive');assert.equal(page.navigations[0],'/security.html?verify=1&plan=exclusive');
});

test('tariff survives a subscription paywall next URL, explicit selection wins, and external next cannot inject a tariff',async()=>{
  for(const [search,expected]of [
    ['?next='+encodeURIComponent('/subscriptions.html?plan=exclusive'),'exclusive'],
    ['?plan=pro&next='+encodeURIComponent('/subscriptions.html?plan=exclusive'),'pro'],
    ['?next='+encodeURIComponent('https://orbita.example/subscriptions.html?plan=exclusive'),'exclusive'],
    ['?next='+encodeURIComponent('https://outside.example/subscriptions.html?plan=exclusive'),null],
    ['?next='+encodeURIComponent('/app.html?plan=exclusive'),null]
  ]){
    const page=harness({search});await page.completion;await page.submit();assert.equal(page.navigations[0],'/security.html?verify=1'+(expected?'&plan='+expected:''));
  }
});

test('account HTML uses POST and starts disabled as a fail-safe before JavaScript binds its handler',async()=>{
  const html=await readFile(new URL('../public/account.html',import.meta.url),'utf8');assert.match(html,/<form\b[^>]*id="accountForm"[^>]*method="post"/i);assert.match(html,/<button\b[^>]*id="submit"[^>]*disabled/);
});
