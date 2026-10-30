import {createHash,randomUUID} from 'node:crypto';
import {DEMO_COMPANIES,plainText,safeSourceUrl,matchCompany,validateAnalysis} from './model.mjs';
import {createRadarAnalysisService} from './analysis.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
const iso=(value,label)=>{const at=typeof value==='string'||value instanceof Date?Date.parse(value):NaN;if(!Number.isFinite(at))throw new TypeError('RADAR_INVALID_'+label);return new Date(at).toISOString();};
export function normalizeRawEvent(raw,{now=Date.now}={}){
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new TypeError('RADAR_INVALID_RAW');
 const provider=String(raw.provider||'');if(!/^[a-z][a-z0-9-]{0,39}$/.test(provider))throw new TypeError('RADAR_INVALID_PROVIDER');
 if(typeof raw.externalId!=='string'||!raw.externalId||raw.externalId.length>200)throw new TypeError('RADAR_INVALID_EXTERNAL_ID');
 const sourceType=raw.sourceType||'OTHER';if(!['DISCLOSURE','IR','NSD','FEDRESURS','OTHER'].includes(sourceType))throw new TypeError('RADAR_INVALID_SOURCE_TYPE');
 const title=plainText(raw.title||'',400),rawText=plainText(raw.rawText||'',20000);if(!title&&!rawText)throw new TypeError('RADAR_EMPTY_RAW');
 const publishedAt=iso(raw.publishedAt,'PUBLISHED_AT'),detectedAt=new Date(now()).toISOString();if(Date.parse(publishedAt)>now()+300000)throw new TypeError('RADAR_FUTURE_EVENT');
 const result={provider,externalId:raw.externalId,publishedAt,detectedAt,sourceUrl:safeSourceUrl(raw.sourceUrl),title,rawText,sourceType,companyName:plainText(raw.companyName||'',300),ticker:plainText(raw.ticker||'',30).toUpperCase(),isin:plainText(raw.isin||'',20).toUpperCase(),assetType:raw.assetType==='bond'?'bond':'stock',isDemo:raw.isDemo===true};
 for(const field of ['actualValue','expectedValue','previousValue'])if(raw[field]!==undefined&&raw[field]!==null){if(!Number.isFinite(raw[field]))throw new TypeError('RADAR_INVALID_METRIC');result[field]=raw[field];}
 return result;
}
export function createPipeline({analysis,marketDataProvider,now=Date.now}={}){
 const analyzer=analysis||createRadarAnalysisService();
 return {async process(raw,{companies=DEMO_COMPANIES,signal}={}){
  signal?.throwIfAborted();
  const input=normalizeRawEvent(raw,{now}),company=matchCompany(input,companies),at=()=>new Date(now()).toISOString(),trace=[{stage:'received',at:input.detectedAt},{stage:'normalized',at:at()},{stage:company?'company_matched':'company_unmatched',at:at()}];
  const candidate=typeof analyzer==='function'?await analyzer({...input,company,signal}):await analyzer.analyze({...input,company,signal});signal?.throwIfAborted();const {analysisMethod,...analysisValue}=candidate,analyzed={...validateAnalysis(analysisValue),analysisMethod:['rules','ai','manual'].includes(analysisMethod)?analysisMethod:'rules'};
  trace.push({stage:'classified',at:at()},{stage:analyzed.analysisMethod==='ai'?'ai_analysed':'rules_analysed',at:at()});
  const processedAt=at(),extractedData=analyzed.extractedData||{},actualValue=Number.isFinite(input.actualValue)?input.actualValue:extractedData.actualValue??null,expectedValue=input.expectedValue??null,previousValue=input.previousValue??null;
  const event={id:'radar-'+randomUUID(),companyId:company?.id||null,ticker:company?.ticker||input.ticker,companyName:company?.shortName||input.companyName||'Компания не определена',isin:input.isin||company?.isin||'',assetType:input.assetType==='bond'||company?.assetType==='bond'?'bond':'stock',eventType:analyzed.eventType,headline:analyzed.headline,summary:analyzed.summary,whyImportant:analyzed.whyImportant,impact:analyzed.impact,importanceScore:analyzed.importanceScore,confidence:analyzed.confidence,publishedAt:input.publishedAt,detectedAt:input.detectedAt,processedAt,notificationSentAt:null,status:company?'published':'draft',rawText:input.rawText,extractedData,tags:analyzed.tags,sources:[{id:'source-'+randomUUID(),provider:input.provider,externalId:input.externalId,url:input.sourceUrl,publishedAt:input.publishedAt,rawTitle:input.title,sourceType:input.sourceType}],marketReaction:null,actualValue,expectedValue,previousValue,surprisePercent:actualValue!==null&&expectedValue!==null&&expectedValue!==0?(actualValue-expectedValue)/Math.abs(expectedValue)*100:null,isDemo:input.isDemo,analysisMethod:analyzed.analysisMethod||'rules',trace,createdAt:processedAt,updatedAt:processedAt,revision:1,groupId:company?company.id+':'+(analyzed.tags.includes('dividend')?'dividend':analyzed.eventType):null};
  if(marketDataProvider&&input.isDemo)event.marketReaction=await marketDataProvider.reaction(event,{signal});signal?.throwIfAborted();
  return event;
 }};
}
function tokens(event){return new Set((event.rawText||event.summary||'').toLocaleLowerCase('ru-RU').replace(/ё/g,'е').split(/[^\p{L}\p{N}.,]+/u).filter(word=>word.length>2));}
export function deduplicateEvent(incoming,existing){
 // Source identities survive editorial suppression. A hidden duplicate is a
 // tombstone, not permission to publish the same disclosure on the next poll.
 const identity=existing.find(event=>event.sources.some(source=>incoming.sources.some(other=>source.provider===other.provider&&source.externalId===other.externalId)));
 if(identity)return identity;
 const candidates=[...existing.filter(event=>event.status!=='duplicate'),...existing.filter(event=>event.status==='duplicate')];
 return candidates.find(event=>{
  if(!incoming.companyId||event.companyId!==incoming.companyId||event.eventType!==incoming.eventType||event.assetType!==incoming.assetType||event.isin&&incoming.isin&&event.isin!==incoming.isin||Math.abs(Date.parse(event.publishedAt)-Date.parse(incoming.publishedAt))>6*3600000)return false;
  if(event.actualValue!==incoming.actualValue||event.expectedValue!==incoming.expectedValue||event.extractedData?.cancelled!==incoming.extractedData?.cancelled)return false;
  // Long boilerplate can differ in one material amount, date, or negation.
  // Such changes must survive fuzzy matching as separate events.
  const material=value=>({numbers:[...(value.rawText||'').matchAll(/\d+(?:[.,]\d+)?/g)].map(item=>item[0]).sort(),negations:[...(value.rawText||'').toLocaleLowerCase('ru-RU').matchAll(/\bnot\b|\bno\b|(?<!\p{L})(?:не|нет|без|отмена|отменены|отказ)(?!\p{L})/gu)].map(item=>item[0]).sort()});
  if(JSON.stringify(material(event))!==JSON.stringify(material(incoming)))return false;
  const a=(event.rawText||'').trim(),b=(incoming.rawText||'').trim();if(a&&b&&hash(a.toLocaleLowerCase('ru-RU'))===hash(b.toLocaleLowerCase('ru-RU')))return true;
  const first=tokens(event),second=tokens(incoming);if(first.size<6||second.size<6)return false;
  const shared=[...first].filter(token=>second.has(token)).length;return shared/(first.size+second.size-shared)>=.88;
 })||null;
}
