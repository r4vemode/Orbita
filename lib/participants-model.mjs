export const COVERAGE_NOTE='FUTOI показывает открытые позиции категорий участников во фьючерсах. Это не позиции в самих акциях и не доля людей; проценты рассчитываются по объёму контрактов отдельно среди лонгов и среди шортов.';
export const SOURCE_URL='https://www.moex.com/ru/analyticalproducts?futoi';
const definitions=[
 ['SBER','Сбербанк','stocks','SR'],['LKOH','Лукойл','stocks','LK'],['GAZP','Газпром','stocks','GZ'],['VTBR','ВТБ','stocks','VB'],['YDEX','Яндекс','stocks','YD'],['OZON','Ozon','stocks','OZ'],['NVTK','Новатэк','stocks','NV'],['PLZL','Полюс','stocks','PZ'],['GMKN','Норникель','stocks','NK'],['ROSN','Роснефть','stocks','RN'],['MOEX','Московская биржа','stocks','ME'],['CHMF','Северсталь','stocks','SV'],['NLMK','НЛМК','stocks','NL'],['MAGN','ММК','stocks','MG'],['TATN','Татнефть','stocks','TT'],['SNGS','Сургутнефтегаз','stocks','SN'],['T','Т-Технологии','stocks','TI'],['IMOEX','Индекс Мосбиржи','index','MX'],['RTS','Индекс РТС','index','RI'],['USDRUB','Доллар / рубль','fx','SI'],['CNYRUB','Юань / рубль','fx','CR'],['GOLD','Золото','commodities','GD'],['BRENT','Нефть Brent','commodities','BR']
];
export const PARTICIPANT_CATALOG=Object.freeze(definitions.map(([symbol,name,group,demoFuturesCode])=>Object.freeze({symbol,stockTicker:group==='stocks'?symbol:null,underlyingTicker:symbol,name,group,underlyingType:group==='stocks'?'stock':group==='commodities'?'commodity':group,market:'futures',futuresCode:null,coverage:'unavailable',demoFuturesCode,indexMembership:{verified:false,asOf:null}})));
const aliases={IMOEX:['IMOEX','MIX'],RTS:['RTS'],USDRUB:['USDRUB','USD000UTSTOM','USD/RUB'],CNYRUB:['CNYRUB','CNYRUB_TOM','CNY/RUB'],GOLD:['GOLD'],BRENT:['BRENT','BR']};
const plain=value=>typeof value==='string'&&value.length<=100&&!/[\u0000-\u001f\u007f]/.test(value);
export const validSymbol=value=>typeof value==='string'&&/^[A-Z0-9_.-]{1,30}$/.test(value);
const dateOnly=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value+'T00:00:00Z'))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
const clockTime=value=>typeof value==='string'&&/^\d{2}:\d{2}:\d{2}$/.test(value)&&value<='23:59:59'&&Number(value.slice(3,5))<=59&&Number(value.slice(6,8))<=59;
const iso=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)&&dateOnly(value.slice(0,10))&&clockTime(value.slice(11,19))&&Number.isFinite(Date.parse(value));
const count=value=>value===null||value===undefined?null:Number.isSafeInteger(value)&&value>=0?value:(()=>{throw Object.assign(Error('Invalid position amount'),{code:'MOEX_INVALID_POSITIONS'});})();
const sum=(a,b)=>a===null||b===null?null:count(a+b);
const shares=(first,second)=>{const total=sum(first,second);return total===null||total===0?{legal:null,individual:null}:{legal:first/total*100,individual:second/total*100};};
export function positionSnapshot({symbol,underlyingTicker=symbol,name=symbol,futuresCode=null,group='stocks',legal={},individual={},dataAsOf,receivedAt,isDemo=false,sourceUrl=SOURCE_URL}){
 if(!validSymbol(symbol)||!validSymbol(underlyingTicker)||!plain(name)||!['stocks','index','fx','commodities'].includes(group)||futuresCode!==null&&!validSymbol(futuresCode)||!iso(dataAsOf)||!iso(receivedAt))throw Object.assign(Error('Invalid position snapshot'),{code:'MOEX_INVALID_SNAPSHOT'});
 const y={long:count(legal.long),short:count(legal.short)},f={long:count(individual.long),short:count(individual.short)},totalLong=sum(y.long,f.long),totalShort=sum(y.short,f.short);
 const complete=[y.long,y.short,f.long,f.short].every(value=>value!==null),balanced=complete&&totalLong===totalShort;
 const status=!complete?'incomplete':!balanced?'unbalanced':totalLong===0?'empty':'complete';
 return {symbol,underlyingTicker,name,futuresCode,market:'futures',group,legal:y,individual:f,totalLong,totalShort,longShares:balanced?shares(y.long,f.long):{legal:null,individual:null},shortShares:balanced?shares(y.short,f.short):{legal:null,individual:null},net:{legal:y.long===null||y.short===null?null:y.long-y.short,individual:f.long===null||f.short===null?null:f.long-f.short},unit:'contracts',countMetrics:null,dataAsOf:new Date(dataAsOf).toISOString(),receivedAt:new Date(receivedAt).toISOString(),isDemo:isDemo===true,status,stale:false,sourceUrl};
}
export function issRows(payload,block){
 const table=payload?.[block];if(!table||!Array.isArray(table.columns)||!Array.isArray(table.data)||table.columns.length>100||table.data.length>20000)throw Object.assign(Error('Invalid MOEX table'),{code:'MOEX_INVALID_RESPONSE'});
 const columns=table.columns.map(value=>String(value).toLowerCase());if(new Set(columns).size!==columns.length||columns.some(value=>!validSymbol(value.toUpperCase())))throw Object.assign(Error('Invalid MOEX columns'),{code:'MOEX_INVALID_RESPONSE'});
 return table.data.map(row=>{if(!Array.isArray(row)||row.length!==columns.length)throw Object.assign(Error('Invalid MOEX row'),{code:'MOEX_INVALID_RESPONSE'});return Object.fromEntries(columns.map((column,index)=>[column,row[index]]));});
}
export function normalizeIndexMembership(payload,date,receivedAt){
 if(!dateOnly(date)||!iso(receivedAt))throw Object.assign(Error('Invalid membership date'),{code:'MOEX_INVALID_MEMBERSHIP'});
 const rows=issRows(payload,'tickers'),tickers=new Set();
 for(const row of rows){const ticker=typeof row.ticker==='string'?row.ticker.toUpperCase():'';if(!validSymbol(ticker)||row.from!==null&&row.from!==undefined&&!dateOnly(row.from)||row.till!==null&&row.till!==undefined&&!dateOnly(row.till)||row.from&&row.till&&row.from>row.till)throw Object.assign(Error('Invalid member ticker or interval'),{code:'MOEX_INVALID_MEMBERSHIP'});if(row.from&&row.from>date||row.till&&row.till<date)continue;tickers.add(ticker);}
 if(!tickers.size||tickers.size>200)throw Object.assign(Error('Empty membership'),{code:'MOEX_NO_MEMBERSHIP'});
 return {verified:true,asOf:date,receivedAt,tickers:[...tickers].sort(),sourceUrl:'https://iss.moex.com/iss/statistics/engines/stock/markets/index/analytics/IMOEX/tickers.json?date='+date};
}
export function buildCoverage(referenceRows=[],membership={verified:false,asOf:null,tickers:[]}){
 if(!Array.isArray(referenceRows)||referenceRows.length>20000)throw Object.assign(Error('Invalid futures reference'),{code:'MOEX_INVALID_REFERENCE'});
 if(!membership||typeof membership!=='object'||typeof membership.verified!=='boolean'||membership.verified&&(!dateOnly(membership.asOf)||!Array.isArray(membership.tickers)||!membership.tickers.length||membership.tickers.length>200||membership.tickers.some(ticker=>!validSymbol(ticker))))throw Object.assign(Error('Invalid index membership'),{code:'MOEX_INVALID_MEMBERSHIP'});
 if(referenceRows.some(row=>!row||typeof row!=='object'||Array.isArray(row)))throw Object.assign(Error('Invalid futures reference row'),{code:'MOEX_INVALID_REFERENCE'});
 const catalogue=PARTICIPANT_CATALOG.map(item=>structuredClone(item));
 for(const ticker of membership.verified?membership.tickers:[])if(!catalogue.some(item=>item.symbol===ticker))catalogue.push({symbol:ticker,stockTicker:ticker,underlyingTicker:ticker,name:ticker,group:'stocks',underlyingType:'stock',market:'futures',futuresCode:null,coverage:'unavailable',indexMembership:{verified:false,asOf:null}});
 return catalogue.map(item=>{
  const assetCodes=new Set((aliases[item.symbol]||[item.symbol]).map(value=>value.toUpperCase())),families=new Set();
  for(const row of referenceRows){const asset=typeof row.assetcode==='string'?row.assetcode.toUpperCase():'',type=typeof row.sectype==='string'?row.sectype.toUpperCase():'';if(assetCodes.has(asset)&&validSymbol(type))families.add(type);}
  const futuresCode=families.size===1?[...families][0]:null;
  return {...item,futuresCode,coverage:futuresCode?'futures-only':'unavailable',coverageReason:families.size>1?'ambiguous-futures-family':futuresCode?null:'reference-not-matched',indexMembership:{verified:membership.verified===true,asOf:membership.asOf||null,inIndex:membership.verified?membership.tickers.includes(item.symbol):null}};
 });
}
function sourceTime(row){
 if(!dateOnly(row.tradedate)||!clockTime(row.tradetime))throw Object.assign(Error('Invalid market time'),{code:'MOEX_INVALID_TIME'});
 const value=Date.parse(row.tradedate+'T'+row.tradetime+'+03:00');if(!Number.isFinite(value))throw Object.assign(Error('Invalid market time'),{code:'MOEX_INVALID_TIME'});return value;
}
export function normalizeFutoiResponse(payload,{coverage=[],receivedAt=new Date().toISOString(),now=Date.now}={}){
 const rows=Array.isArray(payload)?payload:issRows(payload,'futoi');if(rows.length>20000)throw Object.assign(Error('Oversized FUTOI batch'),{code:'MOEX_RESPONSE_LIMIT'});
 const groups=new Map();
 for(const row of rows){
  if(!row||typeof row!=='object'||Array.isArray(row))throw Object.assign(Error('Invalid FUTOI row'),{code:'MOEX_INVALID_RESPONSE'});
  const ticker=typeof row.ticker==='string'?row.ticker.toUpperCase():'',clgroup=String(row.clgroup||'').toUpperCase();if(!validSymbol(ticker)||!['FIZ','YUR'].includes(clgroup))continue;
  const marketTime=sourceTime(row);if(marketTime>now()+300000)throw Object.assign(Error('Future market time'),{code:'MOEX_FUTURE_SNAPSHOT'});
  if(!Number.isSafeInteger(row.sess_id)||row.sess_id<0||!Number.isSafeInteger(row.seqnum)||row.seqnum<0||row.trade_session_date!==null&&row.trade_session_date!==undefined&&!dateOnly(row.trade_session_date))throw Object.assign(Error('Invalid market identity'),{code:'MOEX_INVALID_SNAPSHOT'});
  const long=count(row.pos_long),short=row.pos_short===null||row.pos_short===undefined?null:Number.isSafeInteger(row.pos_short)&&row.pos_short<=0?count(-row.pos_short):( ()=>{throw Object.assign(Error('Invalid signed short amount'),{code:'MOEX_INVALID_POSITIONS'});})();
  if(row.pos!==undefined&&row.pos!==null&&long!==null&&short!==null&&row.pos!==long-short)throw Object.assign(Error('Inconsistent net position'),{code:'MOEX_INVALID_POSITIONS'});
  const key=JSON.stringify([ticker,row.sess_id,row.seqnum,row.tradedate,row.tradetime,row.trade_session_date||null]);let snapshot=groups.get(key);if(!snapshot){snapshot={ticker,marketTime,seqnum:row.seqnum,sess_id:row.sess_id,groups:{}};groups.set(key,snapshot);}
  const next={long,short},previous=snapshot.groups[clgroup];if(previous&&JSON.stringify(previous)!==JSON.stringify(next))throw Object.assign(Error('Conflicting repeated group'),{code:'MOEX_CONFLICTING_SNAPSHOT'});snapshot.groups[clgroup]=next;
 }
 const latest=new Map();for(const snapshot of groups.values()){const previous=latest.get(snapshot.ticker);if(!previous||snapshot.marketTime>previous.marketTime||snapshot.marketTime===previous.marketTime&&snapshot.seqnum>previous.seqnum)latest.set(snapshot.ticker,snapshot);}
 const result=[];for(const item of coverage){if(!item.futuresCode)continue;const snapshot=latest.get(item.futuresCode);if(!snapshot)continue;result.push(positionSnapshot({...item,legal:snapshot.groups.YUR||{},individual:snapshot.groups.FIZ||{},dataAsOf:new Date(snapshot.marketTime).toISOString(),receivedAt}));}
 return result;
}
