import {mkdir,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {tierOf} from './access.mjs';
import {strategyAllowsMarket} from './ideas.mjs';
import {readPrivateJson,writeDurable} from './durable-file.mjs';
import {reclaimAbandonedLock} from './storage-lock.mjs';

const storeName='demo-history.json';
const bundledFile=fileURLToPath(new URL('../fixtures/demo-trades.json',import.meta.url));
const maxBytes=16*1024*1024;
const analysisFields=['entryReason','context','factors','levels','risks','exitReason'];
const reasons=['stop','target','time'];
const object=value=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value);
const positive=value=>Number.isFinite(value)&&value>0&&value<=1e12;
const text=(value,max)=>typeof value==='string'&&Boolean(value.trim())&&value.length<=max;
const revision=value=>Number.isSafeInteger(value)&&value>=0;
const moscowDate=at=>new Date(at+3*60*60*1000).toISOString().slice(0,10);

function fail(code,message){
  throw Object.assign(new Error(message),{code});
}

function timestamp(value){
  if(typeof value!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(value))return NaN;
  const at=Date.parse(value),date=value.slice(0,10),day=Date.parse(date);
  if(!Number.isFinite(at)||!Number.isFinite(day)||new Date(day).toISOString().slice(0,10)!==date)return NaN;
  return at;
}

function source(value,{market,ticker,opened,closed}){
  if(!text(value,1500))return false;
  try{
    const url=new URL(value);
    if(url.protocol!=='https:'||url.port||url.username||url.password||url.hash)return false;
    if(market!=='crypto'){
      const marketPath=market==='stocks'?'/stock/markets/shares/':'/futures/markets/forts/';
      const [from,till]=['from','till'].map(field=>url.searchParams.get(field));
      return url.hostname==='iss.moex.com'&&url.pathname.startsWith('/iss/engines'+marketPath)
        &&url.pathname.toUpperCase().endsWith('/SECURITIES/'+ticker.toUpperCase()+'/CANDLES.JSON')
        &&from!==null&&till!==null&&from<=moscowDate(opened)&&till>=moscowDate(closed);
    }
    const instrument=ticker.replace('/','').toUpperCase();
    if(url.hostname==='api.kraken.com')return url.pathname==='/0/public/OHLC'
      &&[instrument,instrument.replace(/^BTC/,'XBT')].includes(url.searchParams.get('pair')?.toUpperCase());
    const [start,end]=['start','end'].map(field=>url.searchParams.get(field));
    return ['api.bybit.com','api.bybitglobal.com'].includes(url.hostname)&&url.pathname==='/v5/market/kline'
      &&url.searchParams.get('symbol')===instrument&&/^\d+$/.test(start)&&/^\d+$/.test(end)
      &&Number(start)<=opened&&Number(end)>=closed;
  }catch{return false;}
}

function normalizeTrade(trade,index){
  const invalid=field=>fail('DEMO_HISTORY_INVALID',`Запись ${index+1} в демоистории: проверьте ${field}.`);
  if(!object(trade))invalid('формат');
  const {id,tier,strategy,ticker,name,market,direction,openedAt,closedAt,entry,exit,stop,target,comment,analysis,sourceUrl,candles}=trade;
  if(typeof id!=='string'||id.length>100||!/^demo-history-[a-zA-Z0-9_-]+$/.test(id))invalid('идентификатор');
  if(!['pro','exclusive'].includes(tier)||!strategyAllowsMarket(strategy,market)||tierOf(strategy)!==tier)invalid('рынок и стратегию');
  if(typeof ticker!=='string'||!/^[-A-Z0-9._/]{1,32}$/i.test(ticker)||!text(name,100))invalid('тикер и название');
  if(!['LONG','SHORT'].includes(direction))invalid('направление');
  const opened=timestamp(openedAt),closed=timestamp(closedAt),long=direction==='LONG';
  if(!Number.isFinite(opened)||!Number.isFinite(closed)||closed<=opened)invalid('время входа и выхода');
  if(tier==='pro'){
    const maxIntradayMs=24*60*60*1000;
    if(closed-opened>=maxIntradayMs||(market!=='crypto'&&moscowDate(opened)!==moscowDate(closed)))invalid('длительность внутридневной позиции');
  }
  if(![entry,exit,stop,target].every(positive))invalid('цены');
  if(long?stop>=entry||target<=entry:stop<=entry||target>=entry)invalid('расположение стопа и цели');
  if(!text(comment,4000))invalid('комментарий');
  if((tier==='exclusive'||analysis!==undefined)&&(!object(analysis)||!analysisFields.every(key=>text(analysis[key],3000))))invalid('аналитические разделы');
  if(!source(sourceUrl,{market,ticker,opened,closed}))invalid('ссылку на свечи');
  if(!Array.isArray(candles)||!candles.length||candles.length>1000)invalid('количество свечей');
  const date=at=>new Date(at).toISOString();
  let previous=opened-1,previousEnd=opened-1,result='time';
  const chart=candles.map((candle,position)=>{
    if(!object(candle))invalid('формат свечи');
    const {at,end,open,high,low,close}=candle;
    const starts=timestamp(at),ends=end===undefined?undefined:timestamp(end);
    if(!Number.isFinite(starts)||starts<=previous||starts<previousEnd||starts>=closed)invalid('порядок свечей');
    if(ends!==undefined&&(!Number.isFinite(ends)||ends<=starts||ends>closed))invalid('время закрытия свечи');
    if(![open,high,low,close].every(positive)||low>Math.min(open,close)||high<Math.max(open,close))invalid('цены свечи');
    const first=position===0,last=position===candles.length-1;
    if(first&&(starts!==opened||open!==entry))invalid('цену входа по открытию свечи');
    const stopTouched=long?low<=stop:high>=stop;
    const targetTouched=long?high>=target:low<=target;
    if((stopTouched&&targetTouched)||(!last&&(stopTouched||targetTouched)))invalid('последовательность касаний уровней');
    if(last){
      if(close!==exit||(ends!==undefined&&ends!==closed))invalid('цену и время выхода по закрытию свечи');
      if((stopTouched&&(long?close>stop:close<stop))||(targetTouched&&(long?close<target:close>target)))invalid('подтверждение уровня ценой закрытия');
      if(stopTouched)result='stop';
      if(targetTouched)result='target';
    }
    previous=starts;
    previousEnd=ends??starts;
    return {at:date(starts),...(ends===undefined?{}:{end:date(ends)}),open,high,low,close};
  });
  if(trade.closeReason!==undefined&&(!reasons.includes(trade.closeReason)||trade.closeReason!==result))invalid('причину закрытия');
  return {id,tier,strategy,ticker,name,market,direction,openedAt:date(opened),closedAt:date(closed),entry,exit,stop,target,comment,
    ...(analysis===undefined?{}:{analysis:Object.fromEntries(analysisFields.map(key=>[key,analysis[key]]))}),
    closeReason:result,sourceUrl,candles:chart};
}

function normalizeFixture(fixture){
  if(!object(fixture)||fixture.version!==1||!Array.isArray(fixture.trades)||fixture.trades.length>1000){
    fail('DEMO_HISTORY_INVALID','Демоистория должна содержать version: 1 и массив trades до 1000 записей.');
  }
  const ids=new Set(),executions=new Set();
  const trades=fixture.trades.map((value,index)=>{
    const trade=normalizeTrade(value,index);
    const execution=JSON.stringify([trade.tier,trade.market,trade.ticker.toUpperCase(),trade.openedAt,trade.closedAt,trade.direction]);
    if(ids.has(trade.id)||executions.has(execution))fail('DEMO_HISTORY_DUPLICATE',`Запись ${index+1} дублирует сделку или идентификатор.`);
    ids.add(trade.id);
    executions.add(execution);
    return trade;
  });
  return trades.sort((a,b)=>b.closedAt.localeCompare(a.closedAt)||a.id.localeCompare(b.id));
}

export function validateDemoHistoryFixture(fixture){
  try{normalizeFixture(fixture);return true;}catch{return false;}
}

function storeHeaderValid(value){
  return object(value)&&revision(value.revision)
    &&(value.previousRevision===null||revision(value.previousRevision)&&value.previousRevision<value.revision);
}

export function validateDemoHistoryStore(value){
  return storeHeaderValid(value)&&validateDemoHistoryFixture(value);
}

async function readStore(file){
  const value=await readPrivateJson(file,storeHeaderValid,{maxBytes});
  return {...value,trades:normalizeFixture(value)};
}

async function currentStore(directory){
  try{return await readStore(path.join(directory,storeName));}
  catch(cause){if(cause.code==='ENOENT')return null;throw cause;}
}

export async function loadDemoHistoryFixture(file=bundledFile){
  // Validate separately so an operator receives the invalid row number.
  const fixture=await readPrivateJson(file,()=>true,{maxBytes});
  return {version:1,trades:normalizeFixture(fixture)};
}

export async function readBundledDemoHistory(){
  try{return (await loadDemoHistoryFixture()).trades;}
  catch(cause){if(cause.code==='ENOENT')return [];throw cause;}
}

export async function readDemoHistory(directory,{useBundled=true}={}){
  const current=await currentStore(directory);
  if(current)return current.trades;
  return useBundled?readBundledDemoHistory():[];
}

const emptyStore=()=>({version:1,revision:0,previousRevision:null,trades:[]});
const backupFile=(file,number)=>file+'.backup-'+number;
const contents=value=>JSON.stringify(value);
const summary=(store,persisted,changed)=>({
  persisted,changed,revision:store.revision,previousRevision:store.previousRevision,
  total:store.trades.length,pro:store.trades.filter(trade=>trade.tier==='pro').length,
  exclusive:store.trades.filter(trade=>trade.tier==='exclusive').length
});

export async function getDemoHistoryStatus(directory){
  const current=await currentStore(directory);
  if(current)return summary(current,true,false);
  return summary({...emptyStore(),trades:await readDemoHistory(directory)},false,false);
}

async function withStoreLock(directory,callback){
  await mkdir(directory,{recursive:true,mode:0o700});
  const file=path.join(directory,storeName),lock=file+'.lock',deadline=Date.now()+5000;
  for(;;){
    try{await mkdir(lock,{mode:0o700});break;}
    catch(cause){
      if(cause.code!=='EEXIST')throw cause;
      if(await reclaimAbandonedLock(lock))continue;
      if(Date.now()>=deadline)fail('DEMO_HISTORY_BUSY','Демоистория обновляется. Повторите команду.');
      await delay(35);
    }
  }
  try{
    await writeFile(path.join(lock,'owner.json'),JSON.stringify({pid:process.pid,at:Date.now()}),{mode:0o600,flag:'wx'});
    return await callback(file,await currentStore(directory));
  }finally{await rm(lock,{recursive:true,force:true});}
}

async function writeChange(file,current,trades,previousRevision){
  if(current.revision>=Number.MAX_SAFE_INTEGER)fail('DEMO_HISTORY_REVISION_LIMIT','Достигнут предел ревизий демоистории.');
  const next={version:1,revision:current.revision+1,previousRevision,trades};
  const bytes=contents(next);
  if(Buffer.byteLength(bytes)>maxBytes)fail('DEMO_HISTORY_TOO_LARGE','Файл демоистории превышает 16 МиБ.');
  const backup=backupFile(file,current.revision);
  let existing;
  try{existing=await readStore(backup);}
  catch(cause){if(cause.code!=='ENOENT')throw cause;}
  if(existing&&contents(existing)!==contents(current))fail('DEMO_HISTORY_BACKUP_CONFLICT','Сохранённая резервная копия не соответствует текущей ревизии.');
  if(!existing)await writeDurable(backup,contents(current));
  await writeDurable(file,bytes);
  return summary(next,true,true);
}

export async function importDemoHistory(directory,fixture){
  const trades=normalizeFixture(fixture);
  return withStoreLock(directory,async(file,stored)=>{
    if(stored&&contents(stored.trades)===contents(trades))return summary(stored,true,false);
    const current=stored??emptyStore();
    return writeChange(file,current,trades,current.revision);
  });
}

export async function rollbackDemoHistory(directory,expectedRevision){
  if(expectedRevision!==undefined&&!revision(expectedRevision))fail('DEMO_HISTORY_INVALID','Укажите целый неотрицательный номер ревизии.');
  return withStoreLock(directory,async(file,stored)=>{
    const current=stored??emptyStore();
    if(expectedRevision!==undefined&&current.revision!==expectedRevision){
      fail('DEMO_HISTORY_REVISION_CONFLICT',`Текущая ревизия демоистории ${current.revision}. Проверьте status перед повтором.`);
    }
    if(current.previousRevision===null)return summary(current,Boolean(stored),false);
    const previous=await readStore(backupFile(file,current.previousRevision));
    if(previous.revision!==current.previousRevision)fail('DEMO_HISTORY_BACKUP_CONFLICT','Номер ревизии в резервной копии не совпадает.');
    return writeChange(file,current,previous.trades,previous.previousRevision);
  });
}
