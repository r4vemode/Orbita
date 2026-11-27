import {EVENT_TYPES} from './model.mjs';
import {isOfficialIssuerSource,officialProviderIds} from './providers/index.mjs';

export const defaultModeration=()=>({
  version:1,
  revision:0,
  enabled:false,
  minimumImportance:9,
  minimumConfidence:0.9,
  maxAgeMinutes:120,
  providerIds:[],
  eventTypes:[]
});

const allowedValues=(values,allowed)=>Array.isArray(values)&&values.length<=allowed.length
  &&new Set(values).size===values.length&&values.every(value=>allowed.includes(value));
const within=(value,min,max)=>Number.isFinite(value)&&value>=min&&value<=max;
const unconfirmedClaim=/(?:риск|вероятност|возмож(?:н|ен)|потенциальн|гипотетическ|рассмотрит|рассматрива|планиру|предполага|слух|опроверг|уточнени|комментар)\p{L}*|не\s+(?:подтвержд\p{L}*|наступ\p{L}*|произош\p{L}*|допущ\p{L}*)|\?/iu;

export function validModeration(settings){
  return Boolean(settings&&typeof settings==='object'&&!Array.isArray(settings)
    &&Object.keys(settings).every(key=>Object.hasOwn(defaultModeration(),key))
    &&settings.version===1&&Number.isSafeInteger(settings.revision)&&settings.revision>=0
    &&typeof settings.enabled==='boolean'&&within(settings.minimumImportance,9,10)
    &&within(settings.minimumConfidence,0.7,1)
    &&Number.isInteger(settings.maxAgeMinutes)&&within(settings.maxAgeMinutes,5,240)
    &&allowedValues(settings.providerIds,officialProviderIds)
    &&allowedValues(settings.eventTypes,EVENT_TYPES)
    &&(!settings.enabled||settings.providerIds.length>0&&settings.eventTypes.length>0));
}

export function canAutoPublish(event,{settings,provider,enabled,at}){
  const source=event.sources[0];
  const publishedAt=Date.parse(source?.publishedAt);
  const age=at-publishedAt;
  return Boolean(settings.enabled&&enabled&&source?.provider===provider
    &&settings.providerIds.includes(provider)&&settings.eventTypes.includes(event.eventType)
    &&event.companyId&&event.analysisMethod==='rules'&&event.status==='published'
    &&event.importanceScore>=settings.minimumImportance&&event.confidence>=settings.minimumConfidence
    &&!unconfirmedClaim.test(source.rawTitle)
    &&!event.publicationDay&&!source.publicationDay
    &&source.sourceType==='IR'&&isOfficialIssuerSource(provider,event.ticker,source.url)
    &&Date.parse(event.publishedAt)===publishedAt&&age>=0&&age<=settings.maxAgeMinutes*60000);
}
