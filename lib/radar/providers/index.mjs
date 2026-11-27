import {createEndpointProvider} from './http.mjs';
import {createMockProvider} from './mock.mjs';
import {radarConfiguration} from '../config.mjs';
import {createOfficialFeedProvider} from './official.mjs';
import {parsePolyusPressResponse,polyusPressEndpoint} from './polyus.mjs';
import {parseX5PressResponse} from './x5.mjs';
import {oilSources} from './oil.mjs';
import {metalSources} from './metals.mjs';
import {financialSources} from './financial.mjs';
import {consumerSources} from './consumer.mjs';
import {rostelecomSource} from './telecom.mjs';
export {createMockProvider} from './mock.mjs';
export {MockMarketDataProvider} from './market.mjs';
export {createEndpointProvider,safeHttpGet,safeHttpPost,parseProviderResponse} from './http.mjs';
const officialSources=[
 ['official-yandex','Яндекс · пресс-релизы','YDEX','https://ir.yandex.ru/press-releases/news.rss',['ir.yandex.ru']],
 ['official-x5','X5 · пресс-релизы','X5','https://www.x5.ru/wp-json/wp/v2/news?per_page=20&lang=ru&_fields=id,date_gmt,link,title,lang',['www.x5.ru','x5.ru'],parseX5PressResponse],
 ['official-polyus','Полюс · пресс-релизы','PLZL',polyusPressEndpoint,['polyus.com'],parsePolyusPressResponse],
 ...oilSources,
 ...metalSources,
 ...financialSources,
 ...consumerSources,
 rostelecomSource
];
export const officialProviderIds=Object.freeze(officialSources.map(([id])=>id));
export function isOfficialIssuerSource(provider,ticker,value){
 const definition=officialSources.find(([id])=>id===provider);
 if(!definition||definition[2]!==ticker)return false;
 try{
  const url=new URL(value);
  return url.protocol==='https:'&&!url.username&&!url.password&&!url.port&&definition[4].includes(url.hostname);
 }catch{return false;}
}
const flag=(env,key)=>{const value=env[key];if(value===undefined||value===''||value==='false'||value==='0')return false;if(value==='true'||value==='1')return true;throw Error(key+': используйте true или false.');};
export function createProviderRegistry({env=process.env,now=Date.now,requestImpl}={}){
 const {mode}=radarConfiguration(env);
 const mock=createMockProvider({now});mock.enabled=mode==='mock';
 const definitions=[['edisclosure','RADAR_EDISCLOSURE','Корпоративное раскрытие','DISCLOSURE',5000],['company-ir','RADAR_IR','IR компаний','IR',30000],['nsd','RADAR_NSD','НРД','NSD',60000],['fedresurs','RADAR_FEDRESURS','Федресурс','FEDRESURS',60000]];
 const official=officialSources.map(([id,name,ticker,endpoint,allowedHosts,parseResponse,maxResponseBytes],index)=>({
   ...createOfficialFeedProvider({id,name,ticker,endpoint,allowedHosts,parseResponse,maxResponseBytes,enabled:mode==='live',now,interval:15*60*1000,requestImpl}),
   startupDelayMs:index*400
 }));
 return [mock,...official,...definitions.map(([id,prefix,name,sourceType,fallback])=>{const requested=flag(env,prefix+'_ENABLED'),interval=Number(env[prefix+'_INTERVAL']||fallback);if(!Number.isSafeInteger(interval)||interval<1000||interval>3600000)throw Error(prefix+'_INTERVAL: допустимо 1000–3600000 миллисекунд.');return createEndpointProvider({id,name,sourceType,enabled:mode==='live'&&requested,interval,endpoint:env[prefix+'_ENDPOINT']||'',apiKey:env[prefix+'_API_KEY']||'',now,...(requestImpl?{requestImpl}:{})});})];
}
