import {PARTICIPANT_CATALOG} from './participants-model.mjs';

// A shared instrument directory, not a quote feed or a claim about live listing.
// Futures roots identify a family; an exact expiry may be learned only from an
// existing, non-demo publication. No synthetic fixture expands this directory.
const strategyMarkets=Object.freeze({'Momentum RU':'stocks','Trend RU':'stocks','Orbita Exclusive':'stocks','Импульс':'futures','Crypto Momentum':'crypto','Crypto Trend':'crypto'});
const defaults=Object.freeze({stocks:'Momentum RU',futures:'Импульс',crypto:'Crypto Momentum'});
const units=Object.freeze({stocks:'₽',futures:'пт',crypto:'USDT'});
const tickerValid=value=>typeof value==='string'&&/^[A-Z0-9][A-Z0-9._:/-]{0,19}$/.test(value);
const nameValid=value=>typeof value==='string'&&value.trim().length>0&&value.length<=80&&!/[\u0000-\u001f\u007f]/.test(value);
const make=(ticker,name,market,strategy=defaults[market])=>Object.freeze({id:market+':'+ticker,ticker,name,market,unit:units[market],strategy});
const stocks=PARTICIPANT_CATALOG.filter(item=>item.group==='stocks').map(item=>make(item.symbol,item.name,'stocks'));
const extraStocks=[['SBERP','Сбербанк-п'],['TATNP','Татнефть-п'],['SNGSP','Сургутнефтегаз-п'],['TRNFP','Транснефть-п']].map(([ticker,name])=>make(ticker,name,'stocks'));
const futures=[['SI','Доллар / рубль · фьючерсная серия Si'],['RI','Индекс РТС · фьючерсная серия'],['MX','Индекс Мосбиржи · фьючерсная серия'],['BR','Нефть Brent · фьючерсная серия'],['GOLD','Золото · фьючерсная серия'],['CR','Юань / рубль · фьючерсная серия']].map(([ticker,name])=>make(ticker,name,'futures'));
const crypto=[['BTCUSDT','Bitcoin / USDT'],['ETHUSDT','Ethereum / USDT']].map(([ticker,name])=>make(ticker,name,'crypto'));
export const INSTRUMENTS=Object.freeze([...stocks,...extraStocks,...futures,...crypto]);

/** Exact ticker/crypto-pair matches take priority over suggestions. */
export function findInstruments(query,{records=[]}={}){
 if(typeof query!=='string'||query.length>80)return [];
 const input=query.trim().toUpperCase();if(!input||/[\u0000-\u001f\u007f]/.test(input))return [];
 const directory=new Map(INSTRUMENTS.map(item=>[item.id,item]));
 for(const record of Array.isArray(records)?records.slice(0,10000):[]){
  const d=record?.d;
  if(!record||record.demo===true||record.isDemo===true||record.erroneous===true||record.published!==true||typeof record.id!=='string'||/^(?:demo-|exclusive-)/.test(record.id)||!d||typeof d.market!=='string'||!Object.hasOwn(defaults,d.market)||strategyMarkets[d.strategy]!==d.market||typeof d.ticker!=='string')continue;
  const ticker=d.ticker.trim().toUpperCase();if(!tickerValid(ticker)||!nameValid(d.name))continue;
  const item=make(ticker,d.name.trim(),d.market,d.strategy);if(!directory.has(item.id))directory.set(item.id,item);
 }
 const all=[...directory.values()],exact=all.filter(item=>item.ticker===input);
 if(exact.length)return exact;
 const pair=input.replace('/','');
 const cryptoMatch=all.filter(item=>item.market==='crypto'&&item.ticker.replace('/','')===pair);
 if(cryptoMatch.length)return cryptoMatch;
 return all.filter(item=>item.ticker.startsWith(input)||item.name.toUpperCase().includes(input)).sort((a,b)=>a.ticker.localeCompare(b.ticker)||a.market.localeCompare(b.market)).slice(0,8);
}
