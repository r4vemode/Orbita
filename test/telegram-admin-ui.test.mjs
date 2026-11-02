import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

const source=await readFile(new URL('../public/assets/telegram-admin.js',import.meta.url),'utf8');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const baseState=()=>({enabled:true,configured:true,botUsername:'OrbitaFixtureBot',linked:false,binding:null,preferences:{instantPublish:false,strategy:'Momentum RU'}});
function fixture({initial=baseState(),owner={id:'fixture-admin'},link,confirmValue=true}={}){
 const nodes={},calls=[],timers=new Map(),documentListeners=new Map(),windowListeners=new Map();let clear,stopped=false,serial=0,state=structuredClone(initial);
 function node(id){return nodes[id]??=(function(){const handlers=new Map(),value={id,textContent:'',hidden:false,disabled:false,checked:false,value:'',dataset:{},classList:{toggle(){}},addEventListener(type,handler){handlers.set(type,handler);},removeAttribute(name){delete value[name];},fire(type){return handlers.get(type)?.({preventDefault(){}});}};Object.defineProperty(value,'innerHTML',{set(){throw Error('Unsafe HTML rendering');}});return value;})();}
 for(const id of ['telegramPreferencesForm','telegramStatus','telegramCode','telegramCodeExpiry','telegramCodePanel','telegramBotUrl','telegramBinding','telegramConnectionState','telegramExplanation','telegramPreferencesMessage','telegramWorkspace','telegramLink','telegramRefresh','telegramUnlink','telegramStrategy','telegramInstant','telegramSave','telegramCopy'])node(id);
 nodes.telegramWorkspace.hidden=nodes.telegramCodePanel.hidden=true;nodes.telegramPreferencesForm.reset=()=>{nodes.telegramStrategy.value='Momentum RU';nodes.telegramInstant.checked=false;};
 async function request(path,options){calls.push({path,options});if(stopped)throw Object.assign(Error('Account changed'),{status:403});if(path==='/api/admin/telegram')return structuredClone(state);if(path==='/api/admin/telegram/link'&&options?.method==='POST')return typeof link==='function'?link():link??{code:'FixtureConnectionCode123456',expiresAt:new Date(Date.now()+600000).toISOString(),botUrl:'https://t.me/OrbitaFixtureBot'};if(path==='/api/admin/telegram/preferences'){state.preferences=JSON.parse(options.body);return structuredClone(state);}if(path==='/api/admin/telegram/link'&&options?.method==='DELETE'){state.linked=false;state.binding=null;return {ok:true};}throw Error('Unexpected fixture request');}
 const document={hidden:false,getElementById:node,addEventListener(type,handler){documentListeners.set(type,handler);}},window={OrbitaAccess:{requireAdmin:async()=>owner},OrbitaAdminSession:{watch(user,options){clear=options.clear;return {request,stop(){stopped=true;}};}},addEventListener(type,handler){windowListeners.set(type,handler);}};
 const context=vm.createContext({window,document,URL,confirm:()=>confirmValue,navigator:{clipboard:{writeText:async()=>{}}},setTimeout(fn){const key=++serial;timers.set(key,fn);return key;},clearTimeout(key){timers.delete(key);}});
 const ready=vm.runInContext(source,context);
 return {nodes,calls,ready,async hide(){document.hidden=true;documentListeners.get('visibilitychange')?.();await tick();},clear(){clear();},expire(){for(const handler of [...timers.values()])handler();},setState(value){state=structuredClone(value);},leave(){windowListeners.get('pagehide')?.();}};
}

test('Telegram settings never load privileged data without an authenticated administrator',async()=>{
 const f=fixture({owner:null});await f.ready;assert.equal(f.calls.length,0);assert.equal(f.nodes.telegramWorkspace.hidden,true);
});

test('an unavailable bot keeps a previous binding revocable and does not claim publication is online',async()=>{
 const state={...baseState(),enabled:false,configured:false,linked:true,binding:{telegramUserId:'123456789',linkedAt:new Date().toISOString()}};
 const f=fixture({initial:state});await f.ready;assert.equal(f.nodes.telegramLink.disabled,true);assert.equal(f.nodes.telegramUnlink.hidden,false);assert.equal(f.nodes.telegramUnlink.disabled,false);assert.match(f.nodes.telegramExplanation.textContent,/сейчас недоступен/);
 await f.nodes.telegramUnlink.fire('click');assert.equal(f.calls.filter(call=>call.options?.method==='DELETE').length,1);assert.equal(f.nodes.telegramBinding.textContent,'');assert.equal(f.nodes.telegramUnlink.hidden,true);
});

test('one-use Telegram codes are cleared on expiry, hidden tabs and administrative account invalidation',async()=>{
 const f=fixture();await f.ready;await f.nodes.telegramLink.fire('click');assert.match(f.nodes.telegramCode.textContent,/^\/connect FixtureConnection/);assert.equal(f.nodes.telegramCodePanel.hidden,false);
 f.expire();assert.equal(f.nodes.telegramCode.textContent,'');assert.equal(f.nodes.telegramCodePanel.hidden,true);assert.equal(f.nodes.telegramBotUrl.href,undefined);
 await f.nodes.telegramLink.fire('click');await f.hide();assert.equal(f.nodes.telegramCode.textContent,'');assert.equal(f.nodes.telegramCodePanel.hidden,true);
 f.clear();assert.equal(f.nodes.telegramWorkspace.hidden,true);assert.equal(f.nodes.telegramStrategy.value,'Momentum RU');assert.equal(f.nodes.telegramInstant.checked,false);
});

test('a late connection response cannot reveal a code after the tab was hidden or the account changed',async()=>{
 for(const action of ['hide','clear']){
  const pending=deferred(),f=fixture({link:()=>pending.promise});await f.ready;const work=f.nodes.telegramLink.fire('click');await tick();if(action==='hide')await f.hide();else f.clear();pending.resolve({code:'FixtureConnectionCode123456',expiresAt:new Date(Date.now()+600000).toISOString(),botUrl:'https://t.me/OrbitaFixtureBot'});await work;assert.equal(f.nodes.telegramCode.textContent,'');assert.equal(f.nodes.telegramCodePanel.hidden,true);
 }
});

test('Instant Publish cannot be enabled when the administrator cancels its explicit confirmation',async()=>{
 const f=fixture({initial:{...baseState(),linked:true,binding:{telegramUserId:'123456789',linkedAt:new Date().toISOString()}},confirmValue:false});await f.ready;f.nodes.telegramInstant.checked=true;f.nodes.telegramPreferencesForm.fire('submit');await tick();assert.equal(f.calls.filter(call=>call.options?.method==='PUT').length,0);assert.equal(f.nodes.telegramInstant.checked,false);assert.match(f.nodes.telegramStatus.textContent,/остаётся выключенной/);
});

test('connection payloads cannot redirect the administrator to an unrelated Telegram bot',async()=>{
 const f=fixture({link:{code:'FixtureConnectionCode123456',expiresAt:new Date(Date.now()+600000).toISOString(),botUrl:'https://t.me/AnotherFixtureBot'}});await f.ready;await f.nodes.telegramLink.fire('click');assert.equal(f.nodes.telegramCodePanel.hidden,true);assert.equal(f.nodes.telegramCode.textContent,'');assert.equal(f.nodes.telegramBotUrl.href,undefined);assert.match(f.nodes.telegramStatus.textContent,/Не удалось подтвердить/);
});
