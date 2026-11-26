import {createHash} from 'node:crypto';
import {plainText,safeSourceUrl} from '../model.mjs';
import {parseProviderResponse,safeHttpGet} from './http.mjs';

const MAX_FEED_ITEMS=100;
const RECENT_WINDOW=14*86400000;
const MONTHS=['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
const FINANCIAL_TITLES=[
 /финансов\S*\s+(?:(?:и|&)[ ]+операционн\S*\s+)?(?:результат|отчет)|пресс-релиз\s+по\s+результат\S*\s+за\s+\d|результат\S*\s+по\s+(?:мсфо|рсбу)|(?:рост|снижени)\S*\s+(?:выручк|чист\S*\s+прибыл)|(?:мсфо|рсбу)[^.\n]{0,65}отчет|\b(?:financial results|earnings results|quarterly results)\b/u,
 /производственн\S*\s+(?:результат|показател)|операционн\S*\s+(?:результат|показател)|итоги работы\s+(?:пао|групп\S*|компани\S*)[^.\n]{0,65}\s+за\s+(?:\d|[iv]+\s|полугод|квартал)|\b(?:operating|production) results\b/u,
 /дивиденд|обратн\S*\s+выкуп|выкуп\S*\s+(?:собственн\S*\s+)?акци|\b(?:dividend|dividends|buyback|share repurchase)\b/u,
 /прогноз\S*[^.\n]{0,55}(?:выручк|прибыл|производств|добыч|финансов|ebitda)|(?:финансов\S*|производственн\S*)\s+(?:прогноз|ориентир)|\b(?:revenue|earnings|financial) guidance\b/u,
 /допэмисси|дополнительн\S*\s+(?:эмисси|выпуск\S*\s+акци)|вторичн\S*\s+размещени|продаж\S*\s+пакет\S*\s+акци|\bspo\b/u,
 /приобретени\S*\s+(?:компани|бизнес|дол[июе]\s)|слияни\S*\s+(?:с|компани|бизнес)|поглощени\S*\s+(?:компани|бизнес)|\bm&a\b/u,
 /(?:выпуск|выпуст|размещени|размест|погашени|погас|купон|оферт)\S*[^.\n]{0,55}облигац|кредитн\S*\s+рейтинг|техническ\S*\s+дефолт|дефолт\S*\s+по\s+облигац|реструктуризаци\S*\s+долг/u,
 /капитальн\S*\s+затрат|\bcapex\b|дроблени\S*\s+акци|консолидаци\S*\s+акци/u,
 /(?:разворачива\S*|закупа\S*|ввод\S*\s+в\s+эксплуатацию)[^.\n]{0,55}(?:парк|техник)[^.\n]{0,60}сух(?:ой|ого|ом|ому)\s+лог/u,
];
const LEADERSHIP_ROLE=/(?:совет\S*\s+директор|генеральн\S*\s+директор|\bboard of directors\b)/u;
const LEADERSHIP_CHANGE=/(?:покин\S*|избран\S*|избрал\S*|назнач\S*|переизбран\S*|прекрат\S*\s+полномочи|не\s+вош\S*|отставк|смен\S*\s+состав|\b(?:resigns?|appointments?|appointed)\b)/u;
const failure=code=>Object.assign(new Error(code),{code});

function materialTitle(title){
 const text=title.toLocaleLowerCase('ru-RU').replace(/ё/g,'е');
 return FINANCIAL_TITLES.some(pattern=>pattern.test(text))||(LEADERSHIP_ROLE.test(text)&&LEADERSHIP_CHANGE.test(text));
}

function publicationTime(value){
 if(typeof value!=='string'||value.length>80)return NaN;
 const date=value.trim();
 const iso=date.match(/^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/i);
 const rss=date.match(/^(?:[a-z]{3},\s+)?(\d{1,2})\s+([a-z]{3})\s+(\d{4}|\d{2})\s+\d{2}:\d{2}(?::\d{2})?\s+(?:[+-]\d{4}|[a-z]{1,3})$/i);
 if(!iso&&!rss)return NaN;
 const [year,month,day]=iso?[Number(iso[1]),Number(iso[2])-1,Number(iso[3])]:[Number(rss[3]),MONTHS.indexOf(rss[2].toLowerCase()),Number(rss[1])];
 // Date.parse normalizes some invalid days, such as February 31.
 const civil=new Date(Date.UTC(year,month,day));
 if(month<0||civil.getUTCMonth()!==month||civil.getUTCDate()!==day)return NaN;
 return Date.parse(date);
}

function officialArticle(value,hosts){
 let url;
 try{url=new URL(safeSourceUrl(value));}catch{return null;}
 if(!hosts.has(url.hostname))return null;
 url.hash='';
 for(const key of [...url.searchParams.keys()])if(/^utm_/i.test(key))url.searchParams.delete(key);
 const sourceUrl=url.href;
 if(sourceUrl.length>2000)return null;
 url.searchParams.sort();
 return {sourceUrl,externalId:createHash('sha256').update(url.href).digest('hex')};
}

export function createOfficialFeedProvider({id,name,ticker,endpoint,allowedHosts,enabled=true,interval=600000,now=Date.now,requestImpl=safeHttpGet,parseResponse=parseProviderResponse,maxResponseBytes=1024*1024}={}){
 if(typeof id!=='string'||!/^[a-z][a-z0-9-]{0,39}$/.test(id)||typeof name!=='string'||!name.trim()||name.length>100||typeof ticker!=='string'||!/^[A-Z0-9_.-]{1,30}$/i.test(ticker)||typeof enabled!=='boolean'||!Number.isSafeInteger(interval)||interval<1000||interval>3600000||typeof now!=='function'||typeof requestImpl!=='function'||typeof parseResponse!=='function'||!Number.isSafeInteger(maxResponseBytes)||maxResponseBytes<1||maxResponseBytes>2*1024*1024)throw failure('RADAR_OFFICIAL_CONFIGURATION');
 if(!Array.isArray(allowedHosts)||!allowedHosts.length||allowedHosts.length>20||allowedHosts.some(host=>typeof host!=='string'||!/^[-a-z0-9.]+$/i.test(host)))throw failure('RADAR_OFFICIAL_CONFIGURATION');
 const hosts=new Set(allowedHosts.map(host=>new URL(safeSourceUrl('https://'+host)).hostname));
 function feedAddress(){
  const url=new URL(safeSourceUrl(typeof endpoint==='function'?endpoint(now()):endpoint));
  if(!hosts.has(url.hostname)||url.hash)throw failure('RADAR_OFFICIAL_CONFIGURATION');
  return url.href;
 }
 feedAddress();
 return {id,name,enabled,interval,configured:true,async fetchEvents({signal}={}){
  try{
   const feedUrl=feedAddress();
   const response=await requestImpl(feedUrl,{signal,maxResponseBytes});
   if(typeof response?.body!=='string'||Buffer.byteLength(response.body)>maxResponseBytes)throw failure('RADAR_RESPONSE_LIMIT');
   const fetchedAt=now(),detectedAt=new Date(fetchedAt).toISOString();
   const parsed=await parseResponse(response,{provider:id,sourceType:'IR',now,feedUrl});
   if(!Array.isArray(parsed?.events)||parsed.events.length>MAX_FEED_ITEMS)throw failure('RADAR_FEED_LIMIT');
   const byLink=new Map();
   for(const row of parsed.events){
    if(!row||typeof row.title!=='string'||row.title.length>1200)continue;
    const title=plainText(row.title,400);
    const publicationDay=/^\d{4}-\d{2}-\d{2}$/.test(row.publishedAt)?row.publishedAt:null;
    const at=publicationTime(publicationDay?publicationDay+'T00:00:00+03:00':row.publishedAt);
    if(!title||!Number.isFinite(at)||at>fetchedAt||at<fetchedAt-RECENT_WINDOW||!materialTitle(title))continue;
    const article=officialArticle(row.sourceUrl,hosts);
    if(!article||byLink.get(article.externalId)?.at>=at)continue;
    const event={...article,provider:id,sourceType:'IR',ticker:ticker.toUpperCase(),title,rawText:title,publishedAt:new Date(at).toISOString(),...(publicationDay?{publicationDay}:{}),detectedAt,isDemo:false};
    byLink.set(article.externalId,{at,event});
   }
   const events=[...byLink.values()].sort((a,b)=>b.at-a.at||a.event.externalId.localeCompare(b.event.externalId)).map(({event})=>event);
   return {events,cursor:null};
  }catch(cause){
   if(/^RADAR_[A-Z_]+$/.test(cause.code||''))throw cause;
   throw failure('RADAR_PROVIDER_FAILURE');
  }
 }};
}
