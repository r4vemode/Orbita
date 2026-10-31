import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

const source=await readFile(new URL('../public/assets/member-session.js',import.meta.url),'utf8');
const member={id:'member-a',access:{isAdmin:false,hasSubscription:true,activePlans:['pro']}};
function fixture(fetchImpl){
 const document=new EventTarget(),window=new EventTarget(),timers=new Map();document.hidden=false;let next=0;
 vm.runInNewContext(source,{window,document,fetch:fetchImpl,AbortController,setTimeout:callback=>{timers.set(++next,callback);return next;},clearTimeout:id=>timers.delete(id)});
 return {document,window,timers,watch:window.OrbitaMemberSession.watch};
}
test('paid view invalidates on another signed-in account and stops polling before exposing new state',async()=>{
 let calls=0;const changed=[],f=fixture(async(_url,options)=>{calls++;assert.equal(options.cache,'no-store');assert.equal(options.credentials,'same-origin');return {ok:true,status:200,json:async()=>({user:{...member,id:'member-b'}})};});
 const guard=f.watch(member,next=>changed.push(next.id));assert.equal(await guard.check(),false);assert.deepEqual(changed,['member-b']);assert.equal(f.timers.size,0);assert.equal(await guard.check(),false);f.document.dispatchEvent(new Event('visibilitychange'));assert.equal(calls,1);
});
test('paid view invalidates when one of two subscriptions expires, even while another remains active',async()=>{
 const changed=[],f=fixture(async()=>({ok:true,status:200,json:async()=>({user:member})}));
 const guard=f.watch({...member,access:{...member.access,activePlans:['pro','exclusive']}},next=>changed.push(next));
 assert.equal(await guard.check(),false);assert.equal(changed.length,1);assert.deepEqual(changed[0].access.activePlans,['pro']);
});
test('unchanged access and renewal dates do not clear authorized views',async()=>{
 let invalidated=false;const f=fixture(async()=>({ok:true,status:200,json:async()=>({user:{...member,subscriptions:[{plan:'pro',expiresAt:'2099-01-01T00:00:00Z'}]}})})),guard=f.watch(member,()=>{invalidated=true;});
 assert.equal(await guard.check(),true);assert.equal(invalidated,false);assert.equal(f.timers.size,1);guard.stop();assert.equal(f.timers.size,0);
});
test('concurrent visibility and manual checks share one request; logout clears once',async()=>{
 let complete,calls=0,changes=0;const f=fixture(()=>{calls++;return new Promise(resolve=>{complete=resolve;});}),guard=f.watch(member,next=>{assert.equal(next,null);changes++;});
 const first=guard.check(),second=guard.check();f.document.dispatchEvent(new Event('visibilitychange'));assert.equal(calls,1);complete({ok:false,status:401});
 assert.equal(await first,false);assert.equal(await second,false);assert.equal(changes,1);assert.equal(f.timers.size,0);
});
test('a transient network error schedules retry and does not invent a loss of access',async()=>{
 let failed=true,changes=0;const f=fixture(async()=>{if(failed)throw Error('offline');return {ok:true,status:200,json:async()=>({user:member})};}),guard=f.watch(member,()=>changes++);
 assert.equal(await guard.check(),true);assert.equal(changes,0);assert.equal(f.timers.size,1);failed=false;assert.equal(await guard.check(),true);guard.stop();
});
