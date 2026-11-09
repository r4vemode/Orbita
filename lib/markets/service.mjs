import {mkdir} from 'node:fs/promises';
import path from 'node:path';
import {readPrivateJson,writeDurable} from '../durable-file.mjs';
import {hasSubscription,isAdmin,requireAdmin} from '../access.mjs';
import {error,json,readJson,safeFailure} from '../http.mjs';
import {safeHttpGet} from '../radar/providers/http.mjs';
import {DEFAULT_ASSETS,ASSET_NAMES,ASSET_GROUPS,ASSET_UNDERLYING,SOURCE_LABEL,validAsset,validSecid,moscowDate,addDays,selectFrontContracts,normalizeQuote,normalizeHistory,normalizeOpenPositions,positionMetrics,freshness,dateOnly,sentiment,normalizeStockQuotes,futuresBySecid} from './model.mjs';

const MAX_BYTES=8*1024*1024,KEEP_DAILY=40,KEEP_POSITIONS=90,KEEP_RUNS=30,BACKFILL_SESSIONS=20;
const KINDS=['quotes','daily','positions'];
const object=value=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value);
const iso=value=>value===null||typeof value==='string'&&Number.isFinite(Date.parse(value));

export function marketsConfiguration(env=process.env){
 const integer=(key,fallback,min,max)=>{const raw=env[key];if(raw===undefined||raw==='')return fallback;if(!/^\d+$/.test(raw)||Number(raw)<min||Number(raw)>max)throw Error('Invalid '+key);return Number(raw);};
 const mode=env.MARKETS_MODE||'moex';if(!['off','moex'].includes(mode))throw Error('Invalid MARKETS_MODE: используйте off или moex.');
 const assets=env.MARKETS_ASSETS?env.MARKETS_ASSETS.split(',').map(value=>value.trim()).filter(Boolean):[...DEFAULT_ASSETS];
 if(!assets.length||assets.length>40||new Set(assets).size!==assets.length||!assets.every(validAsset))throw Error('Invalid MARKETS_ASSETS: до 40 кодов базовых активов MOEX через запятую.');
 const apiKey=env.MOEX_API_KEY||'';if(apiKey.length>4096||/[\u0000- \u007f]/.test(apiKey))throw Error('Invalid MOEX_API_KEY');
 // Publishing exchange data in a paid product needs MOEX's terms. A public
 // HTTPS deployment keeps the section off until the operator confirms them.
 const production=String(env.ORBITA_PUBLIC_ORIGIN||'').startsWith('https://'),licensed=env.MARKETS_LICENSE_CONFIRMED==='true';
 return Object.freeze({mode:production&&!licensed?'off':mode,blockedByLicense:production&&!licensed&&mode==='moex',assets:Object.freeze(assets),apiKey,
  quoteIntervalSeconds:integer('MARKETS_QUOTES_INTERVAL_SECONDS',300,60,3600),dailyIntervalSeconds:integer('MARKETS_DAILY_INTERVAL_SECONDS',3600,600,86400),
  quoteStaleMinutes:integer('MARKETS_QUOTE_STALE_MINUTES',90,15,1440),dailyStaleDays:integer('MARKETS_DAILY_STALE_DAYS',5,1,30),
  requestSpacingMs:integer('MARKETS_REQUEST_SPACING_MS',300,0,10000),manualCooldownSeconds:integer('MARKETS_MANUAL_COOLDOWN_SECONDS',60,0,3600),
  // The free ISS feed is delayed by ~15 minutes; a paid AlgoPack key may reduce it.
  delayMinutes:apiKey?0:15,base:apiKey?'https://apim.moex.com/iss':'https://iss.moex.com/iss'});
}

const emptySource=()=>({lastAttempt:null,lastSuccess:null,lastError:null,providerTime:null,records:0});
const initial=()=>({version:1,revision:0,instruments:{},stocks:{},sources:Object.fromEntries(KINDS.map(kind=>[kind,emptySource()])),runs:[]});
export function validateMarketsDatabase(db){
 try{
  if(!object(db)||db.version!==1||!Number.isSafeInteger(db.revision)||!object(db.instruments)||db.stocks!==undefined&&!object(db.stocks)||db.futures!==undefined&&!object(db.futures)||!object(db.sources)||!Array.isArray(db.runs)||db.runs.length>KEEP_RUNS)return false;
  for(const kind of KINDS){const s=db.sources[kind];if(!object(s)||![s.lastAttempt,s.lastSuccess,s.providerTime].every(iso)||s.lastError!==null&&(typeof s.lastError!=='string'||s.lastError.length>300)||!Number.isSafeInteger(s.records))return false;}
  for(const [asset,item]of Object.entries(db.instruments)){
   if(!validAsset(asset)||!object(item)||item.asset!==asset||item.contract!==null&&(!object(item.contract)||!validSecid(item.contract.secid))||!Array.isArray(item.daily)||item.daily.length>KEEP_DAILY||!Array.isArray(item.positions)||item.positions.length>KEEP_POSITIONS)return false;
   const dates=new Set();for(const row of item.positions){if(!object(row)||!dateOnly(row.date)||dates.has(row.date))return false;dates.add(row.date);}
   const days=new Set();for(const row of item.daily){if(!object(row)||!dateOnly(row.date)||days.has(row.date))return false;days.add(row.date);}
  }
  return Buffer.byteLength(JSON.stringify(db))<=MAX_BYTES;
 }catch{return false;}
}

export async function createMarkets(directory,{accounts,ideas=null,env=process.env,now=Date.now,requestImpl=safeHttpGet,sleep=ms=>new Promise(resolve=>{const t=setTimeout(resolve,ms);t.unref?.();})}={}){
 const config=marketsConfiguration(env),file=path.join(directory,'markets.json');
 await mkdir(directory,{recursive:true,mode:0o700});
 let queue=Promise.resolve(),closed=false,started=false;const timers=[],running=new Map(),lastManual=new Map(),controller=new AbortController();
 const stamp=()=>new Date(now()).toISOString();
 async function load(){try{return await readPrivateJson(file,validateMarketsDatabase,{maxBytes:MAX_BYTES});}catch(cause){if(cause.code==='ENOENT')return initial();throw cause;}}
 await load();
 // Single-writer queue inside the process; writes are atomic and fsynced.
 function transact(work){const job=queue.then(async()=>{const db=await load(),result=await work(db);db.revision++;if(!validateMarketsDatabase(db))throw Object.assign(Error('Invalid markets store'),{code:'DATA_INVALID'});await writeDurable(file,Buffer.from(JSON.stringify(db)));return result;});queue=job.catch(()=>{});return job;}
 async function read(){await queue;return load();}

 // Sequential, spaced requests with bounded retries for transient failures only.
 let lastRequest=0,requests=Promise.resolve();
 function request(endpoint){
  const job=requests.then(async()=>{
   for(let attempt=0;;attempt++){
    if(closed)throw Object.assign(Error('Stopped'),{code:'STOPPED'});
    const wait=lastRequest+config.requestSpacingMs-Date.now();if(wait>0)await sleep(wait);lastRequest=Date.now();
    try{const response=await requestImpl(config.base+endpoint,{apiKey:config.apiKey,signal:controller.signal,timeoutMs:10000});if(typeof response?.body!=='string')throw Object.assign(Error('Empty response'),{code:'ISS_EMPTY'});return JSON.parse(response.body);}
    catch(cause){const transient=!['ISS_PROVIDER_ERROR','STOPPED'].includes(cause.code)&&!(cause instanceof SyntaxError);if(!transient||attempt>=2||closed)throw cause;await sleep(1000*3**attempt);}
   }
  });requests=job.catch(()=>{});return job;
 }
 const describe=cause=>String(cause?.code||'ERROR')+(cause?.message&&cause.message!==cause.code?': '+cause.message:'').slice(0,200);

 async function record(kind,started,outcome){
  await transact(db=>{const source=db.sources[kind];source.lastAttempt=started;if(outcome.ok){source.lastSuccess=stamp();source.lastError=outcome.partialError||null;source.records=outcome.records;if(outcome.providerTime)source.providerTime=outcome.providerTime;}else source.lastError=outcome.error;
   db.runs.unshift({kind,startedAt:started,finishedAt:stamp(),ok:outcome.ok,records:outcome.records||0,error:outcome.ok?outcome.partialError||null:outcome.error,trigger:outcome.trigger});db.runs=db.runs.slice(0,KEEP_RUNS);});
 }
 const ensure=(db,asset)=>db.instruments[asset]??={asset,name:ASSET_NAMES[asset]||asset,group:ASSET_GROUPS[asset]||'other',underlying:ASSET_UNDERLYING[asset]||null,contract:null,quote:null,daily:[],positions:[]};

 async function refreshQuotes(){
  const payload=await request('/engines/futures/markets/forts/securities.json?iss.meta=off&iss.only=securities,marketdata&securities.columns=SECID,SHORTNAME,SECNAME,ASSETCODE,LASTTRADEDATE,PREVSETTLEPRICE,PREVOPENPOSITION,LOTVOLUME,STEPPRICE,MINSTEP,INITIALMARGIN&marketdata.columns=SECID,LAST,LASTTOPREVPRICE,VOLTODAY,VALTODAY,OPENPOSITION,SETTLEPRICE,UPDATETIME,SYSTIME,TRADEDATE,TRADE_SESSION_DATE');
  const contracts=selectFrontContracts(payload,config.assets,{today:moscowDate(now())}),receivedAt=stamp();let records=0,providerTime=null;
  await transact(db=>{for(const asset of config.assets){const contract=contracts[asset];if(!contract)continue;const item=ensure(db,asset),{md,_oi,...meta}=contract,quote=normalizeQuote(contract,{receivedAt,delayMinutes:config.delayMinutes});
   item.contract=meta;if(quote){item.quote=quote;records++;if(quote.providerTime&&(!providerTime||quote.providerTime>providerTime))providerTime=quote.providerTime;}}});
  if(!records)throw Object.assign(Error('Нет котировок по выбранным активам'),{code:'ISS_NO_DATA'});
  // Futures named in open ideas (any contract, not only the tracked assets).
  const futureTickers=(await ideas?.activeTickers?.('futures')||[]).slice(0,100);
  if(futureTickers.length){const extra=futuresBySecid(payload,futureTickers,{receivedAt,delayMinutes:config.delayMinutes});await transact(db=>{db.futures=extra;});}
  // Stocks: only tickers of open ORBITA ideas, in one request.
  const tickers=(await ideas?.activeTickers?.('stocks')||[]).filter(t=>/^[A-Z0-9]{1,12}$/.test(t)).slice(0,100);
  if(tickers.length){try{const quotes=normalizeStockQuotes(await request(`/engines/stock/markets/shares/boards/TQBR/securities.json?iss.meta=off&iss.only=securities,marketdata&securities=${tickers.join(',')}&securities.columns=SECID,LOTSIZE,MINSTEP&marketdata.columns=SECID,LAST,UPDATETIME,SYSTIME,LASTTOPREVPRICE`),{receivedAt,delayMinutes:config.delayMinutes});await transact(db=>{db.stocks={...(db.stocks||{}),...quotes};for(const key of Object.keys(db.stocks))if(!tickers.includes(key))delete db.stocks[key];});records+=Object.keys(quotes).length;}catch(cause){if(closed)throw cause;}}
  return {records,providerTime};
 }
 async function refreshDaily(){
  const db=await read();let records=0,latest=null;const errors=[];
  for(const asset of config.assets){const secid=db.instruments[asset]?.contract?.secid;if(!secid)continue;
   try{const rows=normalizeHistory(await request(`/history/engines/futures/markets/forts/securities/${encodeURIComponent(secid)}.json?iss.meta=off&from=${addDays(moscowDate(now()),-45)}&history.columns=TRADEDATE,SECID,CLOSE,SETTLEPRICE,VOLUME,OPENPOSITION,CHANGE`),secid);
    await transact(store=>{const item=ensure(store,asset),merged=new Map(item.daily.filter(row=>row.secid===secid).map(row=>[row.date,row]));for(const row of rows)merged.set(row.date,{...row,secid});item.daily=[...merged.values()].sort((a,b)=>a.date.localeCompare(b.date)).slice(-KEEP_DAILY);});
    records+=rows.length;const last=rows.at(-1)?.date;if(last&&(!latest||last>latest))latest=last;
   }catch(cause){if(closed)throw cause;errors.push(asset+': '+describe(cause));}}
  if(!records)throw Object.assign(Error(errors[0]||'Нет итогов сессий'),{code:'ISS_NO_DATA'});
  return {records,providerTime:latest?latest+'T00:00:00.000Z':null,partialError:errors.length?errors.slice(0,3).join('; '):null};
 }
 // Trading dates come from the exchange's own history (no calendar guessing):
 // the latest snapshot plus a one-time backfill of recent completed sessions.
 async function refreshPositions(){
  const db=await read();let records=0,latest=null;const errors=[];
  const sessions=[...new Set(Object.values(db.instruments).flatMap(item=>item.daily.map(row=>row.date)))].sort().slice(-BACKFILL_SESSIONS);
  for(const asset of config.assets){
   try{
    const known=new Set(db.instruments[asset]?.positions.map(row=>row.date)||[]),snapshots=[];
    const current=normalizeOpenPositions(await request(`/statistics/engines/futures/markets/forts/openpositions/${encodeURIComponent(asset)}.json?iss.meta=off`),asset);if(current)snapshots.push(current);
    for(const date of sessions)if(!known.has(date)&&date!==current?.date){const snapshot=normalizeOpenPositions(await request(`/statistics/engines/futures/markets/forts/openpositions/${encodeURIComponent(asset)}.json?iss.meta=off&date=${date}`),asset);if(snapshot)snapshots.push(snapshot);}
    if(!snapshots.length)continue;
    await transact(store=>{const item=ensure(store,asset),merged=new Map(item.positions.map(row=>[row.date,row]));for(const row of snapshots)merged.set(row.date,row);item.positions=[...merged.values()].sort((a,b)=>a.date.localeCompare(b.date)).slice(-KEEP_POSITIONS);});
    records+=snapshots.length;if(current&&(!latest||current.date>latest))latest=current.date;
   }catch(cause){if(closed)throw cause;errors.push(asset+': '+describe(cause));}
  }
  if(!records&&errors.length)throw Object.assign(Error(errors[0]),{code:'ISS_NO_DATA'});
  return {records,providerTime:latest?latest+'T00:00:00.000Z':null,partialError:errors.length?errors.slice(0,3).join('; '):null};
 }
 const handlers={quotes:refreshQuotes,daily:refreshDaily,positions:refreshPositions};
 // One run per kind at a time; concurrent callers share the same promise.
 function run(kind,trigger='schedule'){
  if(running.has(kind))return running.get(kind);
  if(closed||config.mode!=='moex')return Promise.resolve({skipped:true});
  const started=stamp(),job=(async()=>{try{const outcome=await handlers[kind]();await record(kind,started,{ok:true,...outcome,trigger});return {ok:true,...outcome};}
   catch(cause){if(!closed){console.error(`Рынки (${kind}): обновление не выполнено (${describe(cause)}).`);await record(kind,started,{ok:false,error:describe(cause),trigger}).catch(()=>{});}return {ok:false,error:describe(cause)};}
   finally{running.delete(kind);}})();
  running.set(kind,job);return job;
 }
 async function refreshAll(trigger){await run('quotes',trigger);await run('daily',trigger);await run('positions',trigger);}
 function every(task,seconds){const timer=setInterval(()=>{void task();},seconds*1000);timer.unref?.();timers.push(timer);}
 async function start(){if(started||closed||config.mode!=='moex')return;started=true;every(()=>run('quotes'),config.quoteIntervalSeconds);every(async()=>{await run('daily');await run('positions');},config.dailyIntervalSeconds);await refreshAll('startup');}
 async function close(){closed=true;timers.forEach(clearInterval);controller.abort();await Promise.allSettled([...running.values()]);await queue;}

 function sourceState(db,kind){const s=db.sources[kind],configured=config.mode==='moex';return {...s,status:!configured?(config.blockedByLicense?'license':'off'):running.has(kind)?'running':s.lastError&&(!s.lastSuccess||s.lastAttempt>s.lastSuccess)?'error':!s.lastSuccess?'waiting':'ok'};}
 function view(db,{relatedIdeas=new Map()}={}){
  const at=now(),instruments=config.assets.map(asset=>db.instruments[asset]).filter(Boolean).map(item=>{
   const positions=item.positions,last=positions.at(-1)||null,previous=positions.at(-2)||null,week=positions.length>5?positions.at(-6):null,daily=item.daily.at(-1)||null;
   return {asset:item.asset,name:item.name,group:item.group,underlying:item.underlying,contract:item.contract,
    quote:item.quote?{...item.quote,freshness:freshness({kind:'quote',providerTime:item.quote.quoteTime||item.quote.providerTime,now:at,quoteStaleMinutes:config.quoteStaleMinutes})}:null,
    session:daily?{...daily,freshness:freshness({kind:'daily',providerDate:daily.date,lastSuccess:db.sources.daily.lastSuccess,now:at,dailyStaleDays:config.dailyStaleDays})}:null,
    positions:last?{...positionMetrics(last,previous,week),freshness:freshness({kind:'daily',providerDate:last.date,lastSuccess:db.sources.positions.lastSuccess,now:at,dailyStaleDays:config.dailyStaleDays})}:null,
    sentiment:sentiment(positions),
    history:positions.slice(-30).map(row=>({date:row.date,openInterest:row.openInterest,fizNet:row.fiz.long!==null&&row.fiz.short!==null?row.fiz.long-row.fiz.short:null,yurNet:row.yur.long!==null&&row.yur.short!==null?row.yur.long-row.yur.short:null,fizPersonsLong:row.fiz.personsLong,fizPersonsShort:row.fiz.personsShort})),
    sessions:item.daily.slice(-30).map(row=>({date:row.date,close:row.close,settlePrice:row.settlePrice,openInterest:row.openInterest,volume:row.volume})),
    ideas:relatedIdeas.get(item.underlying)||relatedIdeas.get(item.contract?.secid)||[]};
  });
  return {mode:config.mode,source:SOURCE_LABEL,delayMinutes:config.delayMinutes,checkedAt:stamp(),sources:Object.fromEntries(KINDS.map(kind=>[kind,sourceState(db,kind)])),instruments};
 }
 // Links to ORBITA ideas the user may read (server-side entitlement filter).
 async function related(user){
  const map=new Map();if(!ideas?.list)return map;
  try{for(const record of (await ideas.list(user)).records||[]){if(!record.published||record.archived||!['announced','waiting','active'].includes(record.d?.state))continue;const key=String(record.d.ticker||'').toUpperCase();const list=map.get(key)||[];if(list.length<3)list.push({id:record.id,dir:record.d.dir,tier:record.tier,status:record.d.status});map.set(key,list);}}catch(cause){if(![401,403].includes(cause.status))throw cause;}
  return map;
 }
 // Verified last price for derived public results; never a demo or guessed value.
 async function priceFor(market,ticker){
  if(typeof ticker!=='string')return null;const db=await read(),secid=ticker.toUpperCase();
  if(market==='stocks'){const q=db.stocks?.[secid];if(!q||!Number.isFinite(q.last))return null;const state=freshness({kind:'quote',providerTime:q.quoteTime||q.providerTime,now:now(),quoteStaleMinutes:config.quoteStaleMinutes});if(state.state==='stale')return null;return {price:q.last,providerTime:q.quoteTime||q.providerTime,source:SOURCE_LABEL,delayMinutes:config.delayMinutes};}
  if(market!=='futures')return null;
  const extra=db.futures?.[secid]?.quote;if(extra&&Number.isFinite(extra.last)){const state=freshness({kind:'quote',providerTime:extra.quoteTime||extra.providerTime,now:now(),quoteStaleMinutes:config.quoteStaleMinutes});if(state.state!=='stale')return {price:extra.last,providerTime:extra.quoteTime||extra.providerTime,source:SOURCE_LABEL,delayMinutes:config.delayMinutes};}
  for(const item of Object.values(db.instruments)){if(item.contract?.secid?.toUpperCase()===secid&&item.quote&&Number.isFinite(item.quote.last)){const state=freshness({kind:'quote',providerTime:item.quote.quoteTime||item.quote.providerTime,now:now(),quoteStaleMinutes:config.quoteStaleMinutes});if(state.state==='stale')return null;return {price:item.quote.last,providerTime:item.quote.quoteTime||item.quote.providerTime,source:SOURCE_LABEL,delayMinutes:config.delayMinutes};}}
  return null;
 }
 // Telegram alerts: an individuals' positioning extreme on the latest
 // completed session. Ids are stable per asset and date (no duplicates).
// Verified prices for a set of open ideas (used by the feed for a live, estimated result).
 async function quotesFor(records){const out={};for(const r of records){const key=String(r.d?.ticker||'').toUpperCase();if(!key||out[key]!==undefined||r.d?.state!=='active')continue;out[key]=await priceFor(r.d.market,key);if(!out[key])delete out[key];}return out;}
 // Exchange specs for the position calculator: lot size (stocks), point value and margin (futures).
 async function specsFor(records){const db=await read(),out={};for(const r of records){const key=String(r.d?.ticker||'').toUpperCase();if(!key||out[key])continue;
   if(r.d.market==='stocks'&&db.stocks?.[key]?.lotSize)out[key]={kind:'stock',lotSize:db.stocks[key].lotSize};
   if(r.d.market==='futures'){const c=db.futures?.[key]?.contract||Object.values(db.instruments).find(i=>i.contract?.secid?.toUpperCase()===key)?.contract;if(c&&Number.isFinite(c.stepPrice)&&Number.isFinite(c.minStep)&&c.minStep>0)out[key]={kind:'future',stepPrice:c.stepPrice,minStep:c.minStep,margin:c.initialMargin??null,secid:c.secid};}}
  return out;}
 async function alerts({since=0}={}){
  const db=await read(),at=Date.parse(db.sources.positions.lastSuccess||'');if(!Number.isFinite(at)||at<since)return [];
  const out=[];for(const asset of config.assets){const item=db.instruments[asset];if(!item?.positions.length)continue;const last=item.positions.at(-1),s=sentiment(item.positions);
   if(!s||s.level!=='extreme')continue;out.push({id:`${asset}:${last.date}`,asset,name:item.name,date:last.date,z:s.z,direction:s.direction,net:s.last,at:new Date(at).toISOString()});}
  return out;
 }
 async function alert(id){return (await alerts()).find(item=>item.id===id)||null;}
 async function handle(req,res,url,user){
  const member=url.pathname==='/api/markets',admin=url.pathname==='/api/admin/markets'||url.pathname==='/api/admin/markets/refresh';
  if(!member&&!admin)return false;
  try{
   accounts.checkRequest(req);
   if(member){if(!user)throw error(401,'Войдите в аккаунт.');if(!hasSubscription(user,now()))throw error(403,'Раздел «Рынки» доступен по подписке PRO или EXCLUSIVE.','SUBSCRIPTION_REQUIRED');if(req.method!=='GET')throw error(405,'Метод не поддерживается.');json(res,200,view(await read(),{relatedIdeas:await related(user)}));return true;}
   requireAdmin(user);
   if(url.pathname==='/api/admin/markets'){if(req.method!=='GET')throw error(405,'Метод не поддерживается.');const db=await read();json(res,200,{mode:config.mode,blockedByLicense:config.blockedByLicense,assets:config.assets,keyConfigured:Boolean(config.apiKey),delayMinutes:config.delayMinutes,intervals:{quotesSeconds:config.quoteIntervalSeconds,dailySeconds:config.dailyIntervalSeconds},sources:Object.fromEntries(KINDS.map(kind=>[kind,sourceState(db,kind)])),runs:db.runs,checkedAt:stamp()});return true;}
   if(req.method!=='POST')throw error(405,'Метод не поддерживается.');
   const body=await readJson(req,1024),current=await accounts.identify(req);requireAdmin(current);const kind=body.kind??'all';
   if(Object.keys(body).some(key=>key!=='kind')||![...KINDS,'all'].includes(kind))throw error(400,'Укажите kind: quotes, daily, positions или all.');
   if(config.mode!=='moex')throw error(409,config.blockedByLicense?'Источник выключен до подтверждения условий MOEX (MARKETS_LICENSE_CONFIRMED=true).':'Источник выключен (MARKETS_MODE=off).','MARKETS_OFF');
   const kinds=kind==='all'?KINDS:[kind];if(kinds.some(item=>running.has(item)))throw error(409,'Обновление уже выполняется. Дождитесь завершения.','MARKETS_BUSY');
   const since=Math.min(...kinds.map(item=>now()-(lastManual.get(item)??-Infinity)));if(since<config.manualCooldownSeconds*1000)throw error(429,`Повторный ручной запуск возможен через ${Math.ceil((config.manualCooldownSeconds*1000-since)/1000)} с.`,'MARKETS_COOLDOWN');
   for(const item of kinds)lastManual.set(item,now());
   const results={};for(const item of kinds)results[item]=await run(item,'manual:'+current.id.slice(0,12));
   const after=await read();json(res,200,{results,sources:Object.fromEntries(KINDS.map(item=>[item,sourceState(after,item)]))});return true;
  }catch(cause){if(cause.status)json(res,cause.status,{error:cause.message,...(cause.code?{code:cause.code}:{})});else safeFailure(res,cause,{scope:'markets',route:url.pathname});}
  return true;
 }
 return {handle,start,close,run,read,priceFor,quotesFor,specsFor,alerts,alert,config,canAccess:user=>hasSubscription(user,now())||isAdmin(user)};
}
