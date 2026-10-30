import https from 'node:https';
import {lookup} from 'node:dns';
import {safeSourceUrl,publicIp,plainText} from '../model.mjs';
const LIMIT=1048576;
const failure=code=>Object.assign(new Error(code),{code});
// The TLS connection uses this lookup result directly. There is no second DNS
// resolution between validation and connection; Host/SNI still use the origin.
export function publicLookup(hostname,options,callback){
 lookup(hostname,{all:true,verbatim:true},(cause,addresses)=>{
  if(cause||!addresses?.length||addresses.some(item=>!publicIp(item.address))){callback(failure('RADAR_UNSAFE_ADDRESS'));return;}
  if(options?.all)callback(null,addresses);else callback(null,addresses[0].address,addresses[0].family);
 });
}
async function safeHttpRequest(endpoint,{apiKey='',signal,timeoutMs=8000,method='GET',body}={}){
 const url=new URL(safeSourceUrl(endpoint));
 if(typeof apiKey!=='string'||apiKey.length>4096||/[\r\n]/.test(apiKey))throw failure('RADAR_INVALID_CREDENTIAL');
 const bytes=body===undefined?null:Buffer.from(JSON.stringify(body));if(bytes&&bytes.length>65536)throw failure('RADAR_REQUEST_LIMIT');
 return new Promise((resolve,reject)=>{
  let completed=false;const finish=(cause,result)=>{if(completed)return;completed=true;clearTimeout(timer);signal?.removeEventListener('abort',cancel);if(cause){request.destroy();reject(cause);}else resolve(result);};
  const request=https.request(url,{method,lookup:publicLookup,agent:false,maxHeaderSize:16384,headers:{Accept:'application/json, application/rss+xml, application/atom+xml, application/xml;q=0.8','Accept-Encoding':'identity',...(bytes?{'Content-Type':'application/json','Content-Length':bytes.length}:{}),...(apiKey?{Authorization:'Bearer '+apiKey}:{})}},response=>{
   if(response.statusCode!==200){response.destroy();finish(failure(response.statusCode>=300&&response.statusCode<400?'RADAR_REDIRECT_REJECTED':'RADAR_PROVIDER_HTTP'));return;}
   if(response.headers['content-encoding']&&!['identity'].includes(response.headers['content-encoding'])){response.destroy();finish(failure('RADAR_ENCODING_REJECTED'));return;}
   const length=Number(response.headers['content-length']);if(Number.isFinite(length)&&length>LIMIT){response.destroy();finish(failure('RADAR_RESPONSE_LIMIT'));return;}
   const chunks=[];let size=0;
   response.on('data',chunk=>{size+=chunk.length;if(size>LIMIT){response.destroy();finish(failure('RADAR_RESPONSE_LIMIT'));}else chunks.push(chunk);});
   response.once('error',()=>finish(failure('RADAR_PROVIDER_RESPONSE')));response.once('end',()=>finish(null,{body:Buffer.concat(chunks).toString('utf8'),contentType:String(response.headers['content-type']||'').split(';')[0].toLowerCase()}));
  });
  const cancel=()=>{request.destroy();finish(failure('RADAR_PROVIDER_ABORTED'));},timer=setTimeout(()=>{request.destroy();finish(failure('RADAR_PROVIDER_TIMEOUT'));},timeoutMs);timer.unref?.();
  request.once('error',()=>finish(failure('RADAR_PROVIDER_NETWORK')));
  signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted){cancel();return;}
  request.end(bytes);
 });
}
export const safeHttpGet=(endpoint,options={})=>safeHttpRequest(endpoint,{...options,method:'GET',body:undefined});
export const safeHttpPost=(endpoint,options={})=>safeHttpRequest(endpoint,{...options,method:'POST'});
const asciiLower=value=>value.replace(/[A-Z]/g,char=>char.toLowerCase());
function xmlField(xml,name){
 const lower=asciiLower(xml),open=lower.indexOf('<'+name);if(open<0)return '';
 const boundary=lower[open+name.length+1];if(boundary!=='>'&&!/\s/.test(boundary||''))throw failure('RADAR_INVALID_FEED');
 const begin=lower.indexOf('>',open+name.length+1),close=lower.indexOf('</'+name+'>',begin+1);
 if(begin<0||close<0||lower.indexOf('<'+name,begin+1)>=0)throw failure('RADAR_INVALID_FEED');
 let value=xml.slice(begin+1,close);if(value.startsWith('<![CDATA[')&&value.endsWith(']]>'))value=value.slice(9,-3);return value;
}
export function parseProviderResponse({body,contentType},{provider,sourceType,now=Date.now}={}){
 if(typeof body!=='string'||Buffer.byteLength(body)>LIMIT)throw failure('RADAR_RESPONSE_LIMIT');
 let events,cursor=null;
 if(contentType==='application/json'||body.trim().startsWith('{')||body.trim().startsWith('[')){
  let data;try{data=JSON.parse(body);}catch{throw failure('RADAR_INVALID_FEED');}
  events=Array.isArray(data)?data:data?.events;cursor=Array.isArray(data)?null:data?.cursor??null;
  if(cursor!==null&&(typeof cursor!=='string'||cursor.length>500))throw failure('RADAR_INVALID_CURSOR');
 }else if(['application/rss+xml','application/atom+xml','application/xml','text/xml'].includes(contentType)){
  if(/<!DOCTYPE|<!ENTITY/i.test(body))throw failure('RADAR_XML_ENTITY_REJECTED');
  const openings=[];for(const match of body.matchAll(/<(item|entry)(?=[\s>])/gi)){openings.push({type:match[1].toLowerCase(),index:match.index});if(openings.length>100)throw failure('RADAR_FEED_LIMIT');}
  const lower=asciiLower(body),entries=[];let afterPrevious=0;
  for(let index=0;index<openings.length;index++){
   const {type,index:open}=openings[index],begin=body.indexOf('>',open),close=lower.indexOf('</'+type+'>',begin+1),next=openings[index+1]?.index??body.length;
   if(open<afterPrevious||begin<0||close<0||next<close)throw failure('RADAR_INVALID_FEED');
   entries.push({type,xml:body.slice(begin+1,close)});afterPrevious=close+type.length+3;
  }
  const closingCount=[...body.matchAll(/<\/(?:item|entry)\s*>/gi)].length;if(closingCount!==entries.length)throw failure('RADAR_INVALID_FEED');
  events=entries.map(({type,xml})=>{let sourceUrl;
   if(type==='entry'){const lowerXml=asciiLower(xml),start=lowerXml.indexOf('<link'),end=xml.indexOf('>',start);if(start>=0&&end<0)throw failure('RADAR_INVALID_FEED');const tag=start>=0?xml.slice(start,end+1):'';sourceUrl=tag.match(/\bhref=["']([^"']+)["']/i)?.[1]||'';}
   else sourceUrl=xmlField(xml,'link');
   return {externalId:plainText(xmlField(xml,'guid')||xmlField(xml,'id')||sourceUrl,200),publishedAt:xmlField(xml,'pubDate')||xmlField(xml,'published')||xmlField(xml,'updated'),sourceUrl:plainText(sourceUrl,2048),title:plainText(xmlField(xml,'title'),400),rawText:plainText(xmlField(xml,'description')||xmlField(xml,'content')||xmlField(xml,'summary'),20000)};});
 }else throw failure('RADAR_UNSUPPORTED_FEED');
 if(!Array.isArray(events)||events.length>100)throw failure('RADAR_FEED_LIMIT');
 return {events:events.map(event=>{if(!event||typeof event!=='object'||Array.isArray(event)||event.isDemo===true)throw failure('RADAR_INVALID_FEED');return {...event,provider,sourceType,isDemo:false,detectedAt:new Date(now()).toISOString()};}),cursor};
}
export function createEndpointProvider({id,name,sourceType,endpoint='',apiKey='',enabled=false,interval=30000,requestImpl=safeHttpGet,now=Date.now}={}){
 if(endpoint)safeSourceUrl(endpoint);
 return {id,name,enabled,interval,configured:Boolean(endpoint),async fetchEvents({cursor,signal}={}){
  if(!endpoint)throw failure('RADAR_ENDPOINT_NOT_CONFIGURED');
  const url=new URL(endpoint);if(cursor){if(typeof cursor!=='string'||cursor.length>500)throw failure('RADAR_INVALID_CURSOR');url.searchParams.set('cursor',cursor);}
  try{return parseProviderResponse(await requestImpl(url.href,{apiKey,signal}),{provider:id,sourceType,now});}catch(cause){if(/^RADAR_[A-Z_]+$/.test(cause.code||''))throw cause;throw failure('RADAR_PROVIDER_FAILURE');}
 }};
}
