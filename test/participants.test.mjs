import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,symlink,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createParticipants,participantsConfiguration,validateParticipantsDatabase} from '../lib/participants.mjs';
import {serviceFixture} from './service-fixture.mjs';

async function users(f,{all=false}={}){
 const admin=await f.register('positions-admin@example.test');await f.accounts.promote(admin.data.user.email);
 const pro=await f.register('positions-pro@example.test');
 const grant=async(account,plan)=>f.request('/api/admin/subscriptions',{method:'POST',cookie:admin.cookie,body:{userId:account.data.user.id,plan,expiresAt:new Date(Date.now()+86400000).toISOString(),reason:'Isolated participants fixture'}});
 assert.equal((await grant(pro,'pro')).status,200);
 if(!all)return {admin,pro};
 const exclusive=await f.register('positions-exclusive@example.test'),free=await f.register('positions-free@example.test');assert.equal((await grant(exclusive,'exclusive')).status,200);
 return {admin,pro,exclusive,free};
}
function provider(clock,{apiKey=''}={}){
 const calls=[];let mode='valid';
 const request=async(endpoint,options)=>{
  calls.push({endpoint,apiKey:options.apiKey});if(mode==='fail')throw Error('SENSITIVE-MOEX-RESPONSE');
  const url=new URL(endpoint);assert.equal(url.hostname,apiKey?'apim.moex.com':'iss.moex.com');assert.equal(options.apiKey,apiKey);assert.ok(options.signal instanceof AbortSignal);
  const market=new Date(clock()+3*3600000).toISOString(),date=market.slice(0,10),time=market.slice(11,19);
  let block,columns,data;
  if(url.pathname.includes('/RFUD/')){block='securities';columns=['ASSETCODE','SECTYPE'];data=[['SBER','SR'],['SBER','SR']];}
  else if(url.pathname.includes('/futoi/')){
   block='futoi';columns=['sess_id','seqnum','tradedate','tradetime','ticker','clgroup','pos','pos_long','pos_short','trade_session_date','systime'];
   data=[[1,1,date,time,'SR','YUR',-350,300,-650,date,'2001-01-01 00:00:00'],[1,1,date,time,'SR','FIZ',350,700,-350,date,'2001-01-01 00:00:00']];
   if(mode==='invalid')data[0][8]=650;
  }else{
   assert.match(url.pathname,/\/IMOEX\/tickers\.json$/);assert.equal(url.searchParams.get('date'),date);if(mode==='no-membership')throw Error('No membership');
   block='tickers';columns=['ticker','from','till'];data=[['SBER','2000-01-01','2099-01-01'],['TESTNOFUT','2000-01-01','2099-01-01']];
  }
  if(mode==='repeat')return {body:JSON.stringify({[block]:{columns,data}})};
  const start=Number(url.searchParams.get('start'));if(mode==='paged'){
   const total=data.length;data=data.slice(start,start+1);return {body:JSON.stringify({[block]:{columns,data},[block+'.cursor']:{columns:['INDEX','TOTAL','PAGESIZE'],data:[[start,total,1]]}})};
  }
  return {body:JSON.stringify({[block]:{columns,data},[block+'.cursor']:{columns:['INDEX','TOTAL','PAGESIZE'],data:[[0,data.length,data.length]]}})};
 };
 return {request,calls,setMode:value=>{mode=value;}};
}

test('participants configuration is strict, source endpoints are fixed and off is the default',()=>{
 const config=participantsConfiguration({});assert.equal(config.enabled,true);assert.equal(config.mode,'off');assert.equal(config.intervalSeconds,300);assert.equal(config.staleMinutes,30);
 for(const patch of [{MOEX_POSITIONS_ENABLED:'1'},{MOEX_POSITIONS_MODE:'https://internal.test'},{MOEX_POSITIONS_INTERVAL_SECONDS:'59'},{MOEX_POSITIONS_INTERVAL_SECONDS:'3601'},{MOEX_POSITIONS_STALE_MINUTES:'4'},{MOEX_POSITIONS_STALE_MINUTES:'1441'},{MOEX_API_KEY:'bad\r\nheader'}])assert.throws(()=>participantsConfiguration(patch));
 assert.equal(participantsConfiguration({MOEX_POSITIONS_ENABLED:'false'}).enabled,false);
});

test('all participants endpoints require a current subscription; explicit demo never becomes real data',async()=>{
 const f=await serviceFixture(({directory,accounts})=>createParticipants(directory,{accounts,env:{}}));
 try{
  const {admin,pro,exclusive,free}=await users(f,{all:true});
  const routes=['/api/participants','/api/participants/config','/api/participants/coverage','/api/participants/watchlist','/api/participants/demo','/api/participants/SBER?demo=1'];
  for(const route of routes){assert.equal((await f.request(route)).status,401);assert.equal((await f.request(route,{cookie:free.cookie})).status,403);for(const user of [admin,pro,exclusive])assert.equal((await f.request(route,{cookie:user.cookie})).status,200);}
  const demo=(await f.request('/api/participants/demo',{cookie:pro.cookie})).data,sber=demo.instruments.find(item=>item.symbol==='SBER');assert.equal(demo.isDemo,true);assert.ok(demo.instruments.length>=15);assert.ok(demo.instruments.every(item=>item.isDemo));assert.equal(sber.longShares.individual,70);assert.equal(sber.shortShares.legal,65);assert.equal(sber.unit,'contracts');assert.equal(sber.market,'futures');
  const real=(await f.request('/api/participants',{cookie:pro.cookie})).data;assert.equal(real.isDemo,false);assert.deepEqual(real.instruments,[]);assert.equal(real.configured,false);assert.equal((await f.request('/api/participants/SBER',{cookie:pro.cookie})).status,404);
  const coverage=(await f.request('/api/participants/coverage',{cookie:pro.cookie})).data;assert.equal(coverage.indexMembership.verified,false);assert.ok(coverage.instruments.every(item=>item.futuresCode===null));
  await assert.rejects(readFile(join(f.directory,'participants.json')),cause=>cause.code==='ENOENT');
  await f.accounts.transact(db=>{db.users.find(user=>user.id===pro.data.user.id).subscriptions=[];});assert.equal((await f.request('/api/participants/demo',{cookie:pro.cookie})).status,403);
 }finally{await f.close();}
});

test('participants watchlists are account-bound, survive restart and reject unknown symbols and injected fields',async()=>{
 const f=await serviceFixture(({directory,accounts})=>createParticipants(directory,{accounts,env:{}}));
 try{
  const {admin,pro}=await users(f),put=body=>f.request('/api/participants/watchlist',{method:'PUT',body,cookie:pro.cookie});
  for(const payload of [{symbols:['SBER','SBER']},{symbols:['UNKNOWN']},{symbols:['../accounts']},{symbols:['SBER'],userId:admin.data.user.id},{symbols:Array(101).fill('SBER')},{symbols:'SBER'}])assert.equal((await put(payload)).status,400);
  assert.equal((await put({symbols:['SBER','IMOEX']})).status,200);assert.deepEqual((await f.request('/api/participants/watchlist',{cookie:admin.cookie})).data.symbols,[]);
  const db=await f.service.readDatabase();assert.equal(validateParticipantsDatabase(db),true);assert.deepEqual(db.instruments,[]);assert.equal((await stat(join(f.directory,'participants.json'))).mode&0o777,0o600);
  const reopened=await createParticipants(f.directory,{accounts:f.accounts,env:{}});try{assert.deepEqual((await reopened.readDatabase()).watchlists,[{userId:pro.data.user.id,symbols:['SBER','IMOEX']}]);}finally{await reopened.close();}
  assert.equal((await f.request('/api/participants/watchlist',{method:'PUT',cookie:pro.cookie,body:{symbols:[]},headers:{Origin:'http://evil.example'}})).status,403);assert.deepEqual((await f.request('/api/participants/watchlist',{cookie:pro.cookie})).data.symbols,['SBER','IMOEX']);
  for(const route of ['/api/participants?demo=1','/api/participants/demo?demo=1','/api/participants/config?apiKey=secret','/api/participants/SBER?demo=1&demo=1','/api/participants/SBER?demo=0'])assert.equal((await f.request(route,{cookie:pro.cookie})).status,400);
  assert.equal((await f.request('/api/participants',{method:'POST',body:{},cookie:pro.cookie})).status,405);
 }finally{await f.close();}
});

test('MOEX refresh normalizes coherent signed contracts, date-pinned membership and dynamic futures mapping without leaking credentials',async()=>{
 let clock=Date.now()-1000;const source=provider(()=>clock,{apiKey:'TEST-ONLY-API-KEY'});
 const f=await serviceFixture(({directory,accounts})=>createParticipants(directory,{accounts,env:{MOEX_POSITIONS_MODE:'moex',MOEX_API_KEY:'TEST-ONLY-API-KEY'},now:()=>clock,requestImpl:source.request}));
 try{
  const {pro}=await users(f);source.setMode('paged');const together=await Promise.all([f.service.refresh(),f.service.refresh()]);assert.deepEqual(together,[{updated:true},{updated:true}]);assert.equal(source.calls.length,6,'Concurrent refreshes must share one bounded provider operation');
  const before=source.calls.length,feed=(await f.request('/api/participants',{cookie:pro.cookie})).data,settings=(await f.request('/api/participants/config',{cookie:pro.cookie})).data,detail=(await f.request('/api/participants/SBER',{cookie:pro.cookie})).data;assert.equal(source.calls.length,before,'Browser reads must never trigger MOEX requests');
  assert.equal(feed.instruments.length,1);const sber=feed.instruments[0];assert.equal(sber.symbol,'SBER');assert.equal(sber.futuresCode,'SR');assert.equal(sber.isDemo,false);assert.equal(sber.legal.short,650);assert.equal(sber.longShares.individual,70);assert.equal(sber.shortShares.legal,65);assert.equal(sber.net.legal,-350);assert.equal(sber.net.individual,350);assert.ok(Math.abs(Date.parse(sber.dataAsOf)-clock)<1000);assert.equal(sber.stale,false);assert.deepEqual(detail.history,[]);assert.equal(settings.status,'online');
  const coverage=(await f.request('/api/participants/coverage',{cookie:pro.cookie})).data;assert.equal(coverage.indexMembership.verified,true);assert.equal(coverage.instruments.find(item=>item.symbol==='TESTNOFUT').coverage,'unavailable');assert.equal(coverage.instruments.find(item=>item.symbol==='SBER').indexMembership.inIndex,true);
  assert.equal(validateParticipantsDatabase(await f.service.readDatabase()),true);for(const value of [feed,settings,detail,coverage,await f.service.readDatabase()])assert.ok(!JSON.stringify(value).includes('TEST-ONLY-API-KEY'));
 }finally{await f.close();}
});

test('source failure retains last good snapshot, reports stale and recovers without switching to demonstration',async()=>{
 let clock=Date.now()-1000;const source=provider(()=>clock),f=await serviceFixture(({directory,accounts})=>createParticipants(directory,{accounts,env:{MOEX_POSITIONS_MODE:'moex',MOEX_POSITIONS_STALE_MINUTES:'5'},now:()=>clock,requestImpl:source.request}));
 try{
  const {pro}=await users(f);await f.service.refresh();const original=(await f.request('/api/participants',{cookie:pro.cookie})).data;clock+=6*60000;
  const aged=(await f.request('/api/participants',{cookie:pro.cookie})).data;assert.equal(aged.stale,true);assert.equal(aged.instruments[0].stale,true);
  source.setMode('fail');assert.deepEqual(await f.service.refresh(),{updated:false});const failed=(await f.request('/api/participants',{cookie:pro.cookie})).data;assert.equal(failed.isDemo,false);assert.equal(failed.status,'error');assert.equal(failed.instruments[0].dataAsOf,original.instruments[0].dataAsOf);assert.equal(failed.instruments[0].longShares.individual,70);assert.equal(failed.instruments[0].stale,true);assert.ok(!JSON.stringify(failed).includes('SENSITIVE-MOEX-RESPONSE'));
  source.setMode('valid');assert.deepEqual(await f.service.refresh(),{updated:true});const recovered=(await f.request('/api/participants',{cookie:pro.cookie})).data;assert.equal(recovered.status,'online');assert.equal(recovered.stale,false);assert.notEqual(recovered.dataAsOf,original.dataAsOf);
 }finally{await f.close();}
});

test('partial MOEX batches retain missing instruments as stale and older snapshots never rewind newer positions',async()=>{
 let clock=Date.now()-1000,phase='full';const source=provider(()=>clock);
 const requestImpl=async(endpoint,options)=>{
  const response=await source.request(endpoint,options),payload=JSON.parse(response.body);
  if(payload.securities){payload.securities.data.push(['LKOH','LK']);payload['securities.cursor'].data=[[0,3,3]];}
  if(payload.futoi){
   const rows=payload.futoi.data;
   if(phase!=='missing')rows.push(...rows.map(row=>row.map((value,index)=>index===4?'LK':value)));
   if(phase==='older'){const old=new Date(clock-60000+3*3600000).toISOString();for(const row of rows)if(row[4]==='SR'){row[2]=old.slice(0,10);row[3]=old.slice(11,19);row[9]=old.slice(0,10);}}
   payload['futoi.cursor'].data=[[0,rows.length,rows.length]];
  }
  return {body:JSON.stringify(payload)};
 };
 const f=await serviceFixture(({directory,accounts})=>createParticipants(directory,{accounts,env:{MOEX_POSITIONS_MODE:'moex'},now:()=>clock,requestImpl}));
 try{
  const {pro}=await users(f);assert.deepEqual(await f.service.refresh(),{updated:true});const initial=(await f.service.readDatabase()).instruments;assert.equal(initial.length,2);assert.ok(initial.every(item=>!item.stale));
  clock+=10000;phase='missing';assert.deepEqual(await f.service.refresh(),{updated:true});const partial=(await f.request('/api/participants',{cookie:pro.cookie})).data;assert.equal(partial.stale,true);const oldLkoh=partial.instruments.find(item=>item.symbol==='LKOH');assert.equal(oldLkoh.stale,true);assert.equal(oldLkoh.dataAsOf,initial.find(item=>item.symbol==='LKOH').dataAsOf);const recentSber=partial.instruments.find(item=>item.symbol==='SBER');assert.equal(recentSber.stale,false);
  clock+=10000;phase='older';assert.deepEqual(await f.service.refresh(),{updated:true});const older=(await f.request('/api/participants',{cookie:pro.cookie})).data;const preserved=older.instruments.find(item=>item.symbol==='SBER');assert.equal(preserved.dataAsOf,recentSber.dataAsOf);assert.equal(preserved.stale,true);assert.equal(older.instruments.find(item=>item.symbol==='LKOH').stale,false);assert.equal(validateParticipantsDatabase(await f.service.readDatabase()),true);
  clock+=10000;phase='full';assert.deepEqual(await f.service.refresh(),{updated:true});const restored=(await f.request('/api/participants',{cookie:pro.cookie})).data;assert.equal(restored.stale,false);assert.ok(restored.instruments.every(item=>!item.stale));assert.ok(restored.instruments.every(item=>item.dataAsOf>preserved.dataAsOf));
 }finally{await f.close();}
});

test('invalid, nonadvancing or unavailable MOEX tables do not replace valid cache; membership can be unavailable independently',async()=>{
 const clock=Date.now()-1000,source=provider(()=>clock),f=await serviceFixture(({directory,accounts})=>createParticipants(directory,{accounts,env:{MOEX_POSITIONS_MODE:'moex'},now:()=>clock,requestImpl:source.request}));
 try{
  source.setMode('no-membership');assert.deepEqual(await f.service.refresh(),{updated:true});const original=await f.service.readDatabase();assert.equal(original.indexMembership.verified,false);assert.equal(original.instruments.length,1);
  for(const mode of ['invalid','repeat']){source.setMode(mode);assert.deepEqual(await f.service.refresh(),{updated:false});const db=await f.service.readDatabase();assert.deepEqual(db.instruments,original.instruments);assert.equal(db.lastError,'MOEX_SOURCE_UNAVAILABLE');}
  const forged=structuredClone(await f.service.readDatabase());forged.instruments[0].longShares.individual=99;assert.equal(validateParticipantsDatabase(forged),false);const demo=structuredClone(original);demo.instruments[0].isDemo=true;assert.equal(validateParticipantsDatabase(demo),false);
 }finally{await f.close();}
});

test('disabled participants rejects even members and performs no provider requests',async()=>{
 let calls=0;const f=await serviceFixture(({directory,accounts})=>createParticipants(directory,{accounts,env:{MOEX_POSITIONS_ENABLED:'false',MOEX_POSITIONS_MODE:'moex'},requestImpl:async()=>{calls++;throw Error('must not run');}}));
 try{const {pro}=await users(f);await f.service.start();await f.service.refresh();assert.equal(calls,0);for(const route of ['/api/participants','/api/participants/config','/api/participants/demo']){const response=await f.request(route,{cookie:pro.cookie});assert.equal(response.status,403);assert.equal(response.data.code,'PARTICIPANTS_DISABLED');}}
 finally{await f.close();}
});

test('participants startup rejects corrupted and symlinked private stores instead of resetting data',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'orbita-participants-storage-')),accounts={checkRequest(){}};
 try{
  const file=join(directory,'participants.json');await writeFile(file,'{"version":1}');await assert.rejects(createParticipants(directory,{accounts,env:{}}),cause=>cause.code==='DATA_INVALID');assert.equal(await readFile(file,'utf8'),'{"version":1}');
  await rm(file);await writeFile(join(directory,'target.json'),'{}');await symlink(join(directory,'target.json'),file);await assert.rejects(createParticipants(directory,{accounts,env:{}}),cause=>cause.code==='DATA_UNSAFE');assert.equal(await readFile(join(directory,'target.json'),'utf8'),'{}');
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('participants shutdown aborts an in-flight shared source refresh without persisting an artificial error',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'orbita-participants-shutdown-'));let seen=0,entered;
 const ready=new Promise(resolve=>{entered=resolve;}),service=await createParticipants(directory,{accounts:{checkRequest(){}},env:{MOEX_POSITIONS_MODE:'moex'},requestImpl:async(_endpoint,{signal})=>{seen++;entered();return new Promise((_resolve,reject)=>{signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true});});}});
 try{const starting=service.start();await ready;await service.close();await starting;assert.equal(seen,2);assert.deepEqual((await service.readDatabase()).instruments,[]);await assert.rejects(readFile(join(directory,'participants.json')),cause=>cause.code==='ENOENT');}
 finally{await service.close();await rm(directory,{recursive:true,force:true});}
});
