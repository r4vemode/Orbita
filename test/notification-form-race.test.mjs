import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

const source=await readFile(new URL('../public/assets/notifications.js',import.meta.url),'utf8'),flush=()=>new Promise(resolve=>setImmediate(resolve));

test('notification preferences changed during a slow save remain in the form and duplicate submits cannot race',async()=>{
 const flags=['ideaUpdates','newSignals','expiryReminders','radarEvents'],nodes=new Map(),listeners={},calls=[];let finish;
 const node=id=>{if(!nodes.has(id))nodes.set(id,{hidden:false,disabled:false,textContent:'',classList:{toggle(){}},addEventListener(name,listener){listeners[id+':'+name]=listener;},removeAttribute(name){delete this[name];}});return nodes.get(id);};
 const form=node('notificationForm');form.elements=Object.fromEntries(flags.map(flag=>[flag,{checked:false}]));
 let preferences=Object.fromEntries(flags.map(flag=>[flag,false]));
 const state=()=>({configured:false,preferences:{...preferences},telegram:{linked:false}});
 const context=vm.createContext({document:{getElementById:node},window:{addEventListener(){}},location:{replace(){throw Error('Unexpected login redirect');}},OrbitaAccess:{supportMessage:data=>data.error},fetch:async(path,options={})=>{
  let data;if(path==='/api/me')data={user:{id:'temporary-user',email:'temporary@example.test'}};
  else if(options.method==='PUT'){const payload=JSON.parse(options.body);calls.push(payload);if(calls.length===1)await new Promise(resolve=>{finish=resolve;});preferences=payload;data=state();}
  else data=state();return {status:200,ok:true,json:async()=>data};
 },setInterval(){return 1;},clearInterval(){},URL,Intl});
 vm.runInContext(source,context);await flush();await flush();
 form.elements.ideaUpdates.checked=true;listeners['notificationForm:change']();const pending=listeners['notificationForm:submit']({preventDefault(){}});await flush();assert.equal(calls.length,1);assert.equal(node('saveNotifications').disabled,true);
 form.elements.ideaUpdates.checked=false;form.elements.radarEvents.checked=true;listeners['notificationForm:change']();await listeners['notificationForm:submit']({preventDefault(){}});assert.equal(calls.length,1);
 finish();await pending;assert.equal(form.elements.ideaUpdates.checked,false);assert.equal(form.elements.radarEvents.checked,true);assert.match(node('notificationStatus').textContent,/новые изменения/);assert.equal(node('saveNotifications').disabled,false);
 await listeners['notificationForm:submit']({preventDefault(){}});assert.equal(calls.length,2);assert.equal(calls[1].ideaUpdates,false);assert.equal(calls[1].radarEvents,true);assert.match(node('notificationStatus').textContent,/Настройки сохранены/);
});
