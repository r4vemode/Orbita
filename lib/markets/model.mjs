// Pure normalization for MOEX ISS futures data. No network or storage here, so
// every rule (units, dates, staleness) is testable against captured responses.
//
// Sources (all public MOEX ISS endpoints, verified 2026-11-08):
//  quotes    /iss/engines/futures/markets/forts/securities.json           (intraday, ~15 min delay without a paid key)
//  daily     /iss/history/engines/futures/markets/forts/securities/{SECID}.json  (completed sessions, T−1)
//  positions /iss/statistics/engines/futures/markets/forts/openpositions/{ASSET}.json (completed sessions, T−1)

export const ISS_BASE='https://iss.moex.com/iss';
export const SOURCE_LABEL='MOEX ISS';
export const DEFAULT_ASSETS=Object.freeze(['Si','CNY','Eu','IMOEX','MIX','RTS','BR','NG','GOLD','SBRF','GAZR','LKOH','VTBR','YDEX','GMKN']);
export const ASSET_NAMES=Object.freeze({Si:'Доллар США / рубль',CNY:'Юань / рубль',Eu:'Евро / рубль',IMOEX:'Индекс МосБиржи (вечный)',MIX:'Индекс МосБиржи',RTS:'Индекс РТС',BR:'Нефть Brent',NG:'Природный газ',GOLD:'Золото',SBRF:'Сбербанк',GAZR:'Газпром',LKOH:'Лукойл',VTBR:'ВТБ',YDEX:'Яндекс',GMKN:'Норникель'});
export const ASSET_GROUPS=Object.freeze({Si:'fx',CNY:'fx',Eu:'fx',IMOEX:'index',MIX:'index',RTS:'index',BR:'commodities',NG:'commodities',GOLD:'commodities',SBRF:'stocks',GAZR:'stocks',LKOH:'stocks',VTBR:'stocks',YDEX:'stocks',GMKN:'stocks'});
// Futures on a stock are linked to the stock ticker used in ORBITA ideas.
export const ASSET_UNDERLYING=Object.freeze({SBRF:'SBER',GAZR:'GAZP',LKOH:'LKOH',VTBR:'VTBR',YDEX:'YDEX',GMKN:'GMKN',IMOEX:'IMOEX',MIX:'IMOEX',RTS:'RTS'});
export const validAsset=value=>typeof value==='string'&&/^[A-Za-z0-9]{1,20}$/.test(value);
export const validSecid=value=>typeof value==='string'&&/^[A-Za-z0-9.-]{1,20}$/.test(value);
const fail=(code,message=code)=>{throw Object.assign(Error(message),{code});};
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const num=value=>finite(value)?value:null;
const count=value=>Number.isSafeInteger(value)&&value>=0?value:null;
export const dateOnly=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
export const moscowDate=(at=Date.now())=>new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(at));
export const addDays=(date,days)=>new Date(Date.parse(date+'T00:00:00Z')+days*86400000).toISOString().slice(0,10);
// ISS reports exchange clock time in Moscow (UTC+3, no DST).
export function moscowTimestamp(value){
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value))return null;
 const ms=Date.parse(value.replace(' ','T')+'+03:00');return Number.isFinite(ms)?new Date(ms).toISOString():null;
}

export function issTable(payload,block){
 const table=payload?.[block];
 if(!table||!Array.isArray(table.columns)||!Array.isArray(table.data)||table.data.length>50000)fail('ISS_INVALID_RESPONSE','ISS: нет блока '+block);
 const columns=table.columns.map(value=>String(value).toLowerCase());
 if(columns.length===1&&columns[0]==='error_message')fail('ISS_PROVIDER_ERROR',String(table.data?.[0]?.[0]||'ISS error').slice(0,200));
 return table.data.map(row=>{if(!Array.isArray(row)||row.length!==columns.length)fail('ISS_INVALID_RESPONSE','ISS: некорректная строка');return Object.fromEntries(columns.map((column,index)=>[column,row[index]]));});
}

// Picks the most liquid live contract of each asset (largest open interest at
// the previous clearing, then the nearest expiry). Expired contracts are skipped.
export function selectFrontContracts(payload,assets,{today}){
 const securities=issTable(payload,'securities'),marketdata=new Map(issTable(payload,'marketdata').map(row=>[row.secid,row]));
 const wanted=new Set(assets),result={};
 for(const row of securities){
  if(!wanted.has(row.assetcode)||!validSecid(row.secid)||!dateOnly(row.lasttradedate)||row.lasttradedate<today)continue;
  const current=result[row.assetcode],oi=count(row.prevopenposition)??0;
  if(!current||oi>current._oi||oi===current._oi&&row.lasttradedate<current.expiry)result[row.assetcode]={_oi:oi,secid:row.secid,shortName:String(row.shortname||row.secid).slice(0,40),name:String(row.secname||'').slice(0,120),expiry:row.lasttradedate,lotVolume:num(row.lotvolume),initialMargin:num(row.initialmargin),minStep:num(row.minstep),stepPrice:num(row.stepprice),prevSettlePrice:num(row.prevsettleprice),md:marketdata.get(row.secid)||null};
 }
 return result;
}

// ISS OPENPOSITION counts long and short sides together: the sum over an
// asset's contracts equals 2 × the open contracts reported by the open
// positions statistics (verified for Si on 2026-11-06: 9 913 346 / 2 =
// 4 956 673). ORBITA shows open interest as the number of open contracts.
export const openInterestFromIss=value=>Number.isSafeInteger(value)&&value>=0&&value%2===0?value/2:null;

export function normalizeQuote(contract,{receivedAt,delayMinutes}){
 const md=contract.md;if(!md)return null;
 const providerTime=moscowTimestamp(md.systime);
 return {secid:contract.secid,last:num(md.last),changePct:num(md.lasttoprevprice),volume:count(md.voltoday),valueRub:num(md.valtoday),openInterest:openInterestFromIss(md.openposition),settlePrice:num(md.settleprice),tradeDate:dateOnly(md.tradedate)?md.tradedate:null,sessionDate:dateOnly(md.trade_session_date)?md.trade_session_date:null,updateTime:typeof md.updatetime==='string'&&/^\d{2}:\d{2}:\d{2}$/.test(md.updatetime)?md.updatetime:null,
  // quoteTime: exchange time of the last trade shown; providerTime: ISS publication time.
  quoteTime:dateOnly(md.tradedate)&&/^\d{2}:\d{2}:\d{2}$/.test(md.updatetime||'')?moscowTimestamp(md.tradedate+' '+md.updatetime):null,providerTime,receivedAt,delayMinutes};
}

// Completed sessions only; rows are ordered by trade date and deduplicated.
export function normalizeHistory(payload,secid){
 const rows=issTable(payload,'history'),byDate=new Map();
 for(const row of rows){
  if(row.secid!==secid||!dateOnly(row.tradedate))continue;
  byDate.set(row.tradedate,{date:row.tradedate,close:num(row.close),settlePrice:num(row.settleprice),volume:count(row.volume),openInterest:openInterestFromIss(row.openposition),changePct:num(row.change)});
 }
 return [...byDate.values()].sort((a,b)=>a.date.localeCompare(b.date));
}

// One completed-session snapshot of open positions by client group. Exchange
// codes: is_fiz=0 legal entities (юрлица), is_fiz=1 individuals (физлица).
// Persons are the number of distinct clients holding that side.
export function normalizeOpenPositions(payload,asset){
 const rows=issTable(payload,'open_positions');if(!rows.length)return null;
 const dates=[...new Set(rows.map(row=>row.tradedate))];if(dates.length!==1||!dateOnly(dates[0]))fail('ISS_INVALID_RESPONSE','ISS: несколько дат в снимке позиций');
 const groups={};
 for(const row of rows){
  if(row.asset!==asset)continue;const key=row.is_fiz===1?'fiz':row.is_fiz===0?'yur':null;if(!key)continue;
  if(groups[key])fail('ISS_INVALID_RESPONSE','ISS: повтор группы участников');
  groups[key]={long:count(row.open_position_long),short:count(row.open_position_short),personsLong:count(row.persons_long),personsShort:count(row.persons_short),changeLong:Number.isSafeInteger(row.oichange_long)?row.oichange_long:null,changeShort:Number.isSafeInteger(row.oichange_short)?row.oichange_short:null};
 }
 if(!groups.fiz||!groups.yur)return null;
 const longs=groups.fiz.long!==null&&groups.yur.long!==null?groups.fiz.long+groups.yur.long:null,shorts=groups.fiz.short!==null&&groups.yur.short!==null?groups.fiz.short+groups.yur.short:null;
 return {date:dates[0],fiz:groups.fiz,yur:groups.yur,openInterest:longs!==null&&longs===shorts?longs:null,balanced:longs!==null&&longs===shorts};
}

const share=(part,total)=>finite(part)&&finite(total)&&total>0?part/total*100:null;
// Derived, clearly-defined indicators. Shares are of contracts, not of people.
export function positionMetrics(snapshot,previous=null,weekAgo=null){
 if(!snapshot)return null;
 const net=group=>group.long!==null&&group.short!==null?group.long-group.short:null;
 const diff=(a,b)=>finite(a)&&finite(b)?a-b:null;
 const result={date:snapshot.date,openInterest:snapshot.openInterest,fiz:{...snapshot.fiz,net:net(snapshot.fiz),longShare:share(snapshot.fiz.long,snapshot.openInterest),shortShare:share(snapshot.fiz.short,snapshot.openInterest)},yur:{...snapshot.yur,net:net(snapshot.yur),longShare:share(snapshot.yur.long,snapshot.openInterest),shortShare:share(snapshot.yur.short,snapshot.openInterest)}};
 result.change={previousDate:previous?.date||null,openInterest:diff(snapshot.openInterest,previous?.openInterest),fizNet:diff(result.fiz.net,previous?net(previous.fiz):null),yurNet:diff(result.yur.net,previous?net(previous.yur):null),weekDate:weekAgo?.date||null,openInterestWeek:diff(snapshot.openInterest,weekAgo?.openInterest),fizNetWeek:diff(result.fiz.net,weekAgo?net(weekAgo.fiz):null),yurNetWeek:diff(result.yur.net,weekAgo?net(weekAgo.yur):null)};
 return result;
}

// Freshness is judged from exchange-provided dates, never by labelling old
// values as "today". Weekends/holidays produce no new session, so a Friday
// snapshot stays valid on Sunday; it becomes stale only after `maxDays`.
export function freshness({kind,providerDate=null,providerTime=null,lastSuccess=null,now=Date.now(),quoteStaleMinutes=90,dailyStaleDays=5}){
 if(kind==='quote'){
  if(!providerTime)return {state:'missing'};
  const age=now-Date.parse(providerTime);return {state:age>quoteStaleMinutes*60000?'stale':'delayed',ageMinutes:Math.max(0,Math.round(age/60000))};
 }
 if(!providerDate)return {state:'missing'};
 const today=moscowDate(now),days=Math.round((Date.parse(today+'T00:00:00Z')-Date.parse(providerDate+'T00:00:00Z'))/86400000);
 const syncAge=lastSuccess?now-Date.parse(lastSuccess):Infinity;
 return {state:days>dailyStaleDays||syncAge>36*3600000?'stale':days===0?'today':'previous-session',days};
}

// Crowd-positioning extreme: how unusual today's individuals' net position is
// versus the previous `window` completed sessions (z-score, population σ).
// |z| ≥ 2 is flagged as an extreme. Futures only; not a trading signal.
export function sentiment(history,{window=20,minSessions=10}={}){
 const values=history.map(row=>row.fiz&&row.fiz.long!==null&&row.fiz.short!==null?row.fiz.long-row.fiz.short:row.fizNet).filter(v=>typeof v==='number'&&Number.isFinite(v));
 if(values.length<minSessions+1)return null;
 const last=values.at(-1),base=values.slice(-window-1,-1),mean=base.reduce((a,b)=>a+b,0)/base.length,sd=Math.sqrt(base.reduce((a,b)=>a+(b-mean)**2,0)/base.length);
 if(!(sd>0))return null;
 const z=(last-mean)/sd,level=Math.abs(z)>=2?'extreme':Math.abs(z)>=1?'elevated':'normal';
 return {z:Math.round(z*100)/100,level,direction:z>0?'long':'short',sessions:base.length,mean:Math.round(mean),last};
}

// Stock quotes (TQBR, T+ board). ISS shares marketdata has no TRADEDATE: the
// trade time is taken on the publication date, or the day before if later.
export function normalizeStockQuotes(payload,{receivedAt,delayMinutes}){
 const lots=payload?.securities?new Map(issTable(payload,'securities').map(row=>[row.secid,row])):new Map();
 const out={};for(const row of issTable(payload,'marketdata')){
  if(!validSecid(row.secid)||!finite(row.last))continue;const published=moscowTimestamp(row.systime);let quoteTime=null;
  if(published&&/^\d{2}:\d{2}:\d{2}$/.test(row.updatetime||'')){const date=row.systime.slice(0,10);quoteTime=moscowTimestamp(date+' '+row.updatetime);if(quoteTime&&quoteTime>published)quoteTime=moscowTimestamp(addDays(date,-1)+' '+row.updatetime);}
  out[row.secid]={secid:row.secid,last:row.last,changePct:num(row.lasttoprevprice),quoteTime,providerTime:published,receivedAt,delayMinutes,board:'TQBR',lotSize:Number.isSafeInteger(lots.get(row.secid)?.lotsize)&&lots.get(row.secid).lotsize>0?lots.get(row.secid).lotsize:null,minStep:num(lots.get(row.secid)?.minstep)};
 }
 return out;
}

// Contract specs + quote for any FORTS security (used for futures named in ideas).
export function futuresBySecid(payload,secids,{receivedAt,delayMinutes}){
 const wanted=new Set(secids.map(v=>String(v).toUpperCase())),md=new Map(issTable(payload,'marketdata').map(row=>[String(row.secid).toUpperCase(),row])),out={};
 for(const row of issTable(payload,'securities')){const id=String(row.secid).toUpperCase();if(!wanted.has(id)||!validSecid(row.secid))continue;
  const contract={secid:row.secid,shortName:String(row.shortname||row.secid).slice(0,40),expiry:dateOnly(row.lasttradedate)?row.lasttradedate:null,lotVolume:num(row.lotvolume),initialMargin:num(row.initialmargin),minStep:num(row.minstep),stepPrice:num(row.stepprice),md:md.get(id)||null};
  out[id]={contract:(({md,...rest})=>rest)(contract),quote:normalizeQuote(contract,{receivedAt,delayMinutes})};}
 return out;
}
