import {randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile,rename,rm,lstat,stat} from 'node:fs/promises';
import path from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {hasSubscription,requireMember} from './access.mjs';
import {error,json,readJson,safeFailure} from './http.mjs';
import {safeHttpGet} from './radar/providers/http.mjs';
import {PARTICIPANT_CATALOG,COVERAGE_NOTE,SOURCE_URL,validSymbol,positionSnapshot,issRows,buildCoverage,normalizeIndexMembership,normalizeFutoiResponse} from './participants-model.mjs';

const MAX_BYTES=8*1024*1024,MAX_INSTRUMENTS=250,MAX_WATCHLISTS=20000;
const object=value=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value);
const iso=value=>typeof value==='string'&&value.length<=40&&Number.isFinite(Date.parse(value));
const dateOnly=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value+'T00:00:00Z'))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
const nullableTime=value=>value===null||iso(value);
const same=isDeepStrictEqual;
const invalid=()=>Object.assign(Error('Invalid participants store'),{code:'DATA_INVALID'});
const emptyMembership=()=>({verified:false,asOf:null,tickers:[]});
function only(value,keys){if(!object(value)||Object.keys(value).some(key=>!keys.includes(key)))throw invalid();}
export function participantsConfiguration(env=process.env){
 const boolean=(key,fallback)=>{const value=env[key];if(value===undefined||value==='')return fallback;if(value==='true')return true;if(value==='false')return false;throw Error('Invalid '+key);};
 const integer=(key,fallback,min,max)=>{const raw=env[key];if(raw===undefined||raw==='')return fallback;if(!/^\d+$/.test(raw)||!Number.isSafeInteger(Number(raw))||Number(raw)<min||Number(raw)>max)throw Error('Invalid '+key);return Number(raw);};
 const mode=env.MOEX_POSITIONS_MODE||'off';if(!['off','moex'].includes(mode))throw Error('Invalid MOEX_POSITIONS_MODE');
 const apiKey=env.MOEX_API_KEY||'';if(typeof apiKey!=='string'||apiKey.length>4096||/[\u0000-\u0020\u007f]/.test(apiKey))throw Error('Invalid MOEX_API_KEY');
 return {enabled:boolean('MOEX_POSITIONS_ENABLED',true),mode,intervalSeconds:integer('MOEX_POSITIONS_INTERVAL_SECONDS',300,60,3600),staleMinutes:integer('MOEX_POSITIONS_STALE_MINUTES',30,5,1440),apiKey};
}
function membershipValid(value){
 only(value,['verified','asOf','tickers','receivedAt','sourceUrl']);
 if(typeof value.verified!=='boolean'||!Array.isArray(value.tickers)||value.tickers.length>200||new Set(value.tickers).size!==value.tickers.length||!value.tickers.every(validSymbol))return false;
 if(!value.verified)return value.asOf===null&&value.tickers.length===0;
 return dateOnly(value.asOf)&&iso(value.receivedAt)&&value.tickers.length>0&&value.sourceUrl==='https://iss.moex.com/iss/statistics/engines/stock/markets/index/analytics/IMOEX/tickers.json?date='+value.asOf;
}
export function validateParticipantsDatabase(db){
 try{
  only(db,['version','revision','instruments','reference','indexMembership','watchlists','lastSuccess','lastAttempt','lastError']);
  if(db.version!==1||!Number.isSafeInteger(db.revision)||db.revision<0||!Array.isArray(db.instruments)||db.instruments.length>MAX_INSTRUMENTS||!Array.isArray(db.reference)||db.reference.length>20000||!membershipValid(db.indexMembership)||!Array.isArray(db.watchlists)||db.watchlists.length>MAX_WATCHLISTS||!nullableTime(db.lastSuccess)||!nullableTime(db.lastAttempt)||![null,'MOEX_SOURCE_UNAVAILABLE'].includes(db.lastError))return false;
  if(db.reference.some(row=>!object(row)||Object.keys(row).some(key=>!['assetcode','sectype'].includes(key))||typeof row.assetcode!=='string'||row.assetcode.length>40||!validSymbol(row.sectype)))return false;
  const symbols=new Set();
  for(const item of db.instruments){if(!object(item)||item.isDemo!==false||typeof item.stale!=='boolean'||item.sourceUrl!==SOURCE_URL||symbols.has(item.symbol)||!same({...positionSnapshot(item),stale:item.stale},item))return false;symbols.add(item.symbol);}
  const users=new Set();for(const entry of db.watchlists){only(entry,['userId','symbols']);if(typeof entry.userId!=='string'||!/^[A-Za-z0-9_-]{1,100}$/.test(entry.userId)||users.has(entry.userId)||!Array.isArray(entry.symbols)||entry.symbols.length>100||new Set(entry.symbols).size!==entry.symbols.length||!entry.symbols.every(validSymbol))return false;users.add(entry.userId);}
  return Buffer.byteLength(JSON.stringify(db))<=MAX_BYTES;
 }catch{return false;}
}

export async function createParticipants(directory,{accounts,env=process.env,now=Date.now,requestImpl=safeHttpGet}={}){
 if(!accounts?.checkRequest)throw Error('Participants requires trusted accounts.');
 const config=participantsConfiguration(env),file=path.join(directory,'participants.json'),lock=file+'.lock';
 let queue=Promise.resolve(),pending=null,timer=null,controller=null,closed=false,started=false,failures=0;
 const stamp=()=>new Date(now()).toISOString();
 const initial=()=>({version:1,revision:0,instruments:[],reference:[],indexMembership:emptyMembership(),watchlists:[],lastSuccess:null,lastAttempt:null,lastError:null});
 await mkdir(directory,{recursive:true,mode:0o700});
 async function load(){
  try{const info=await lstat(file);if(!info.isFile()||info.isSymbolicLink()||info.size>MAX_BYTES)throw Object.assign(Error('Unsafe participants store'),{code:'DATA_UNSAFE'});const bytes=await readFile(file);if(bytes.length>MAX_BYTES)throw invalid();const db=JSON.parse(bytes);if(!validateParticipantsDatabase(db))throw invalid();return db;}
  catch(cause){if(cause.code==='ENOENT')return initial();if(cause instanceof SyntaxError)throw invalid();throw cause;}
 }
 await load();
 async function acquire(){
  const deadline=Date.now()+5000;
  while(true){
   try{await mkdir(lock,{mode:0o700});try{await writeFile(path.join(lock,'owner.json'),JSON.stringify({pid:process.pid}),{mode:0o600});}catch(cause){await rm(lock,{recursive:true,force:true});throw cause;}return;}
   catch(cause){if(cause.code!=='EEXIST')throw cause;try{const owner=JSON.parse(await readFile(path.join(lock,'owner.json'),'utf8'));if(Number.isSafeInteger(owner.pid)&&owner.pid>0)try{process.kill(owner.pid,0);}catch(gone){if(gone.code==='ESRCH'){await rm(lock,{recursive:true,force:true});continue;}}}catch(missing){if(missing.code==='ENOENT')try{if(Date.now()-(await stat(lock)).mtimeMs>30000){await rm(lock,{recursive:true,force:true});continue;}}catch{}}
    if(Date.now()>=deadline)throw error(409,'Данные участников заняты. Повторите действие.');await new Promise(resolve=>setTimeout(resolve,25));}
  }
 }
 function transact(work){const job=queue.then(async()=>{await acquire();let temp;try{const db=await load(),result=await work(db);if(db.revision>=Number.MAX_SAFE_INTEGER)throw invalid();db.revision++;if(!validateParticipantsDatabase(db))throw invalid();temp=file+'.tmp-'+randomUUID();await writeFile(temp,JSON.stringify(db),{mode:0o600,flag:'wx'});await rename(temp,file);temp=null;return structuredClone(result);}finally{if(temp)await rm(temp,{force:true});await rm(lock,{recursive:true,force:true});}});queue=job.catch(()=>{});return job;}
 async function readDatabase(){await queue;return load();}
 const canAccess=user=>Boolean(config.enabled&&hasSubscription(user,now()));
 function requireAccess(user){requireMember(user);if(!hasSubscription(user,now()))throw error(403,'Для доступа нужна действующая подписка.');if(!config.enabled)throw error(403,'Раздел позиций участников пока отключён.','PARTICIPANTS_DISABLED');}
 function staleItem(item,db){return item.stale||!config.enabled||config.mode!=='moex'||Boolean(db.lastError)||now()-Date.parse(item.dataAsOf)>config.staleMinutes*60000;}
 function state(db){const configured=config.enabled&&config.mode==='moex',stale=db.instruments.some(item=>staleItem(item,db));return {enabled:config.enabled,mode:config.mode,configured,lastSuccess:db.lastSuccess,lastAttempt:db.lastAttempt,status:!config.enabled?'disabled':!configured?'off':db.lastError?'error':!db.lastSuccess?'waiting':stale?'stale':'online',stale,source:'MOEX FUTOI',coverageNote:COVERAGE_NOTE};}
 function feed(db){const settings=state(db),instruments=db.instruments.map(item=>({...item,stale:staleItem(item,db)}));return {...settings,instruments,dataAsOf:instruments.length?instruments.map(item=>item.dataAsOf).sort().at(-1):null,receivedAt:db.lastSuccess,isDemo:false,checkedAt:stamp()};}
 async function demo(){
  const fixtures=JSON.parse(await readFile(new URL('../fixtures/participants-demo.json',import.meta.url),'utf8')),at=stamp();
  const instruments=fixtures.map(row=>{const entry=PARTICIPANT_CATALOG.find(item=>item.symbol===row.symbol);if(!entry)throw invalid();return positionSnapshot({...entry,...row,futuresCode:entry.demoFuturesCode,dataAsOf:at,receivedAt:at,isDemo:true});});
  return {instruments,isDemo:true,stale:false,status:'demo',configured:false,dataAsOf:at,receivedAt:at,coverageNote:COVERAGE_NOTE,checkedAt:at};
 }
 const base=config.apiKey?'https://apim.moex.com/iss':'https://iss.moex.com/iss';
 async function table(endpoint,block,signal){
  let start=0,previous=null;const rows=[];
  for(let page=0;page<20;page++){
   const url=new URL(base+endpoint);url.searchParams.set('start',String(start));
   const response=await requestImpl(url.href,{apiKey:config.apiKey,signal,timeoutMs:8000});
   if(typeof response?.body!=='string'||Buffer.byteLength(response.body)>1048576)throw Error('MOEX response limit');
   const payload=JSON.parse(response.body),batch=issRows(payload,block);if(rows.length+batch.length>20000)throw Error('MOEX row limit');
   const cursor=payload[block+'.cursor'];
   const fingerprint=JSON.stringify(batch);if(!cursor&&batch.length&&fingerprint===previous)throw Error('MOEX pagination did not advance');previous=fingerprint;rows.push(...batch);
   if(cursor){const values=issRows(payload,block+'.cursor');if(values.length!==1)throw Error('Invalid MOEX cursor');const item=values[0];if(![item.index,item.total,item.pagesize].every(Number.isSafeInteger)||item.index!==start||item.total<0||item.total>20000||item.pagesize<0||item.index+batch.length>item.total)throw Error('Invalid MOEX cursor');if(start+batch.length>=item.total)return rows;if(!batch.length||item.pagesize<batch.length)throw Error('Invalid MOEX cursor');}
   else if(!batch.length)return rows;
   start+=batch.length;
  }
  throw Error('MOEX pagination limit');
 }
 function refresh(){
  if(pending)return pending;if(closed||!config.enabled||config.mode!=='moex')return Promise.resolve({skipped:true});
  controller=new AbortController();const signal=controller.signal;
  pending=(async()=>{
   const attempted=stamp();
   try{
    const date=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(now()));
    const [rawReference,rawFutoi]=await Promise.all([table('/engines/futures/markets/forts/boards/RFUD/securities.json','securities',signal),table('/analyticalproducts/futoi/securities.json?date='+date,'futoi',signal)]);
    let membership=emptyMembership();try{const rows=await table('/statistics/engines/stock/markets/index/analytics/IMOEX/tickers.json?date='+date,'tickers',signal);membership=normalizeIndexMembership({tickers:{columns:['ticker','from','till'],data:rows.map(row=>[row.ticker,row.from??null,row.till??null])}},date,stamp());}catch{if(signal.aborted)throw Error('Stopped');}
    const reference=[...new Map(rawReference.filter(row=>typeof row.assetcode==='string'&&row.assetcode.length<=40&&validSymbol(row.sectype)).map(row=>[row.assetcode+'|'+row.sectype,{assetcode:row.assetcode,sectype:row.sectype}])).values()];
    if(!reference.length)throw Error('No futures reference');
    const instruments=normalizeFutoiResponse(rawFutoi,{coverage:buildCoverage(reference,membership),receivedAt:stamp(),now});
    if(!instruments.some(item=>item.status==='complete'||item.status==='empty'))throw Error('No coherent FUTOI snapshot');
    if(closed||signal.aborted)throw Error('Stopped');
    await transact(db=>{
     const next=new Map(db.instruments.map(item=>[item.symbol,{...item,stale:true}]));
     for(const item of instruments){const previous=next.get(item.symbol);if(!previous||Date.parse(item.dataAsOf)>=Date.parse(previous.dataAsOf))next.set(item.symbol,item);}
     db.instruments=[...next.values()];db.reference=reference;db.indexMembership=membership;db.lastSuccess=stamp();db.lastAttempt=attempted;db.lastError=null;
    });failures=0;return {updated:true};
   }catch(cause){
    controller?.abort();if(!closed){failures=Math.min(6,failures+1);await transact(db=>{db.lastAttempt=attempted;db.lastError='MOEX_SOURCE_UNAVAILABLE';});}return {updated:false};
   }finally{pending=null;controller=null;}
  })();return pending;
 }
 function schedule(){if(closed)return;timer=setTimeout(async()=>{try{await refresh();}catch{failures=Math.min(6,failures+1);}finally{schedule();}},Math.min(3600000,config.intervalSeconds*1000*2**failures));timer.unref?.();}
 async function start(){if(started||closed||!config.enabled||config.mode!=='moex')return;started=true;try{await refresh();}finally{schedule();}}
 async function close(){closed=true;clearTimeout(timer);controller?.abort();await pending;await queue;}
 async function handle(req,res,url,user){
  if(url.pathname!=='/api/participants'&&!url.pathname.startsWith('/api/participants/'))return false;
  try{
   requireAccess(user);accounts.checkRequest(req);const route=url.pathname.slice('/api/participants'.length);
   if(req.method!=='GET'&&!(route==='/watchlist'&&req.method==='PUT'))throw error(405,'Метод не поддерживается.');
   const detail=route&&!['/config','/coverage','/demo','/watchlist'].includes(route);
   if([...url.searchParams.keys()].some(key=>!detail||key!=='demo')||url.searchParams.getAll('demo').length>1||url.searchParams.has('demo')&&url.searchParams.get('demo')!=='1')throw error(400,'Некорректные параметры запроса.');
   if(route==='/demo'){json(res,200,await demo());return true;}
   const db=await readDatabase();
   if(!route)json(res,200,feed(db));
   else if(route==='/config')json(res,200,state(db));
   else if(route==='/coverage')json(res,200,{instruments:buildCoverage(db.reference,db.indexMembership),indexMembership:db.indexMembership});
   else if(route==='/watchlist'){
    if(req.method==='GET')json(res,200,{symbols:db.watchlists.find(entry=>entry.userId===user.id)?.symbols||[]});
    else{
     const payload=await readJson(req,8192);user=await accounts.identify(req);requireAccess(user);if(Object.keys(payload).some(key=>key!=='symbols')||!Array.isArray(payload.symbols)||payload.symbols.length>100||new Set(payload.symbols).size!==payload.symbols.length)throw error(400,'Передайте до 100 разных тикеров.');
     const known=new Set([...buildCoverage(db.reference,db.indexMembership).map(item=>item.symbol),...(db.watchlists.find(entry=>entry.userId===user.id)?.symbols||[])]);if(payload.symbols.some(symbol=>!validSymbol(symbol)||!known.has(symbol)))throw error(400,'Неизвестный тикер инструмента.');
     json(res,200,await transact(current=>{let entry=current.watchlists.find(item=>item.userId===user.id);if(!entry){if(current.watchlists.length>=MAX_WATCHLISTS)throw error(409,'Хранилище отслеживания заполнено.');entry={userId:user.id,symbols:[]};current.watchlists.push(entry);}entry.symbols=[...payload.symbols];return {symbols:entry.symbols};}));
    }
   }else{
    const symbol=route.slice(1);if(!validSymbol(symbol))throw error(404,'Инструмент не найден.');const result=url.searchParams.get('demo')==='1'?await demo():feed(db),instrument=result.instruments.find(item=>item.symbol===symbol);if(!instrument)throw error(404,'Для инструмента ещё нет снимка позиций.');json(res,200,{instrument,history:[]});
   }
  }catch(cause){if(cause.status)json(res,cause.status,{error:cause.message,...(cause.code?{code:cause.code}:{})});else safeFailure(res,cause,{scope:'participants',route:url.pathname});}
  return true;
 }
 return {handle,start,close,config: {enabled:config.enabled,mode:config.mode},canAccess,readDatabase,refresh,webhookPaths:[]};
}
