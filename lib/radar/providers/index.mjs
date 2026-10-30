import {createEndpointProvider} from './http.mjs';
import {createMockProvider} from './mock.mjs';
export {createMockProvider} from './mock.mjs';
export {MockMarketDataProvider} from './market.mjs';
export {createEndpointProvider,safeHttpGet,safeHttpPost,parseProviderResponse} from './http.mjs';
const flag=(env,key)=>{const value=env[key];if(value===undefined||value===''||value==='false'||value==='0')return false;if(value==='true'||value==='1')return true;throw Error(key+': используйте true или false.');};
export function createProviderRegistry({env=process.env,now=Date.now,requestImpl}={}){
 const mode=env.RADAR_PROVIDER_MODE||'off';if(!['off','mock','live'].includes(mode))throw Error('RADAR_PROVIDER_MODE: используйте off, mock или live.');
 const mock=createMockProvider({now});mock.enabled=mode==='mock';
 const definitions=[['edisclosure','RADAR_EDISCLOSURE','Корпоративное раскрытие','DISCLOSURE',5000],['company-ir','RADAR_IR','IR компаний','IR',30000],['nsd','RADAR_NSD','НРД','NSD',60000],['fedresurs','RADAR_FEDRESURS','Федресурс','FEDRESURS',60000]];
 return [mock,...definitions.map(([id,prefix,name,sourceType,fallback])=>{const requested=flag(env,prefix+'_ENABLED'),interval=Number(env[prefix+'_INTERVAL']||fallback);if(!Number.isSafeInteger(interval)||interval<1000||interval>3600000)throw Error(prefix+'_INTERVAL: допустимо 1000–3600000 миллисекунд.');return createEndpointProvider({id,name,sourceType,enabled:mode==='live'&&requested,interval,endpoint:env[prefix+'_ENDPOINT']||'',apiKey:env[prefix+'_API_KEY']||'',now,...(requestImpl?{requestImpl}:{})});})];
}
