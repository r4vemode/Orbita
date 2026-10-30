import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import {EventEmitter} from 'node:events';
import {createProviderRegistry,createEndpointProvider,parseProviderResponse,safeHttpGet} from '../lib/radar/providers/index.mjs';
import {publicIp,safeSourceUrl} from '../lib/radar/model.mjs';
test('Radar provider registry isolates configuration and enables mocks or live adapters only explicitly',()=>{
 assert.equal(createProviderRegistry({env:{}}).some(provider=>provider.enabled),false);
 const mocks=createProviderRegistry({env:{RADAR_PROVIDER_MODE:'mock'}});assert.deepEqual(mocks.filter(provider=>provider.enabled).map(provider=>provider.id),['mock']);
 const live=createProviderRegistry({env:{RADAR_PROVIDER_MODE:'live',RADAR_EDISCLOSURE_ENABLED:'true',RADAR_EDISCLOSURE_ENDPOINT:'https://feed.moex.com/events'}});assert.deepEqual(live.filter(provider=>provider.enabled).map(provider=>provider.id),['edisclosure']);assert.equal(live.find(provider=>provider.id==='edisclosure').interval,5000);
 assert.throws(()=>createProviderRegistry({env:{RADAR_PROVIDER_MODE:'all'}}));assert.throws(()=>createProviderRegistry({env:{RADAR_IR_ENABLED:'yes'}}));assert.throws(()=>createProviderRegistry({env:{RADAR_IR_INTERVAL:'10'}}));
});
test('Radar JSON adapter normalizes provider identity, bounds cursor and avoids returning configuration credentials',async()=>{
 let request;const provider=createEndpointProvider({id:'edisclosure',name:'Disclosure',sourceType:'DISCLOSURE',endpoint:'https://feed.moex.com/events',apiKey:'unit-private-key',enabled:true,requestImpl:async(url,options)=>{request={url,options};return {contentType:'application/json',body:JSON.stringify({events:[{externalId:'event1',sourceUrl:'https://www.moex.com/news/1',publishedAt:'2026-10-30T10:00:00Z',title:'Сбер',rawText:'Решение',provider:'spoof'}],cursor:'next-1'})};}});
 const result=await provider.fetchEvents({cursor:'old cursor'});assert.equal(result.events[0].provider,'edisclosure');assert.equal(result.events[0].sourceType,'DISCLOSURE');assert.equal(result.events[0].isDemo,false);assert.equal(result.cursor,'next-1');assert.equal(new URL(request.url).searchParams.get('cursor'),'old cursor');assert.equal(request.options.apiKey,'unit-private-key');assert.ok(!JSON.stringify(provider).includes('unit-private-key'));assert.ok(!JSON.stringify(result).includes('unit-private-key'));
 await assert.rejects(createEndpointProvider({id:'nsd',sourceType:'NSD'}).fetchEvents(),{code:'RADAR_ENDPOINT_NOT_CONFIGURED'});
});
test('Radar official RSS/Atom normalization rejects entity expansion and malformed or oversized feeds',()=>{
 const rss='<?xml version="1.0"?><rss><channel><item><guid>1</guid><title><![CDATA[<b>Сбер</b>]]></title><link>https://www.moex.com/news/1</link><pubDate>Fri, 30 Oct 2026 10:00:00 GMT</pubDate><description><![CDATA[<p>Дивиденды</p>]]></description></item></channel></rss>';
 const result=parseProviderResponse({body:rss,contentType:'application/rss+xml'},{provider:'edisclosure',sourceType:'DISCLOSURE'});assert.equal(result.events[0].title,'Сбер');assert.equal(result.events[0].rawText,'Дивиденды');assert.equal(result.events[0].externalId,'1');
 const atom='<feed><entry><id>a1</id><title>Отчёт</title><link href="https://www.moex.com/news/a1"/><updated>2026-10-30T10:00:00Z</updated><summary>Описание</summary></entry></feed>';assert.equal(parseProviderResponse({body:atom,contentType:'application/atom+xml'},{provider:'company-ir',sourceType:'IR'}).events[0].sourceUrl,'https://www.moex.com/news/a1');
 assert.throws(()=>parseProviderResponse({body:'<!DOCTYPE a [<!ENTITY x "boom">]><rss/>',contentType:'application/xml'},{provider:'nsd'}),{code:'RADAR_XML_ENTITY_REJECTED'});
 assert.throws(()=>parseProviderResponse({body:'{"events":[{}],"cursor":{}}',contentType:'application/json'},{provider:'nsd'}),{code:'RADAR_INVALID_CURSOR'});
 assert.throws(()=>parseProviderResponse({body:'a'.repeat(1048577),contentType:'text/html'},{provider:'nsd'}),{code:'RADAR_RESPONSE_LIMIT'});
 assert.throws(()=>parseProviderResponse({body:JSON.stringify({events:Array(101).fill({})}),contentType:'application/json'},{provider:'nsd'}),{code:'RADAR_FEED_LIMIT'});
});
test('Radar rejects large malformed RSS and repeated field openings without quadratic scans',()=>{
 const parse=body=>parseProviderResponse({body,contentType:'application/rss+xml'},{provider:'edisclosure',sourceType:'DISCLOSURE'}),started=performance.now();
 assert.throws(()=>parse('<rss>'+'<item>'.repeat(160000)+'</rss>'),{code:'RADAR_FEED_LIMIT'});
 for(const body of ['<rss><item><title>Незакрыто</rss>','<rss><item><item></item></item></rss>','<rss></item></rss>','<rss><item>'+'<title>'.repeat(100000)+'</item></rss>'])assert.throws(()=>parse(body),{code:'RADAR_INVALID_FEED'});
 assert.ok(performance.now()-started<1500,'Malformed feed should fail before expensive parsing');
});
test('Radar provider endpoint safety rejects private, mapped, credentialed and non-HTTPS origins before connecting',async()=>{
 for(const address of ['127.0.0.1','10.1.2.3','172.16.0.1','192.168.1.1','169.254.169.254','100.64.0.1','0.0.0.0','::1','::ffff:127.0.0.1','fe80::1','fec0::1','fd00::1','2001:db8::1','64:ff9b::7f00:1','2002:7f00:1::','2001::7f00:1'])assert.equal(publicIp(address),false,address);
 assert.equal(publicIp('8.8.8.8'),true);assert.equal(publicIp('2606:4700:4700::1111'),true);
 for(const url of ['http://www.moex.com/','https://127.1/','https://2130706433/','https://0x7f000001/','https://[::ffff:7f00:1]/','https://secret@www.moex.com/','https://www.moex.com:8443/','https://service.internal/']){assert.throws(()=>safeSourceUrl(url));await assert.rejects(safeHttpGet(url));}
});
test('Radar HTTP transport destroys redirect/error bodies, enforces response size, compression policy and deadline',async t=>{
 const scenarios=[{status:302,code:'RADAR_REDIRECT_REJECTED'},{status:500,code:'RADAR_PROVIDER_HTTP'},{status:200,headers:{'content-encoding':'gzip'},code:'RADAR_ENCODING_REJECTED'},{status:200,headers:{'content-length':'2000000'},code:'RADAR_RESPONSE_LIMIT'},{status:200,chunks:[Buffer.alloc(1048577)],code:'RADAR_RESPONSE_LIMIT'},{hang:true,code:'RADAR_PROVIDER_TIMEOUT'}];
 for(const scenario of scenarios){let request,response;const original=https.request;https.request=(url,options,callback)=>{request=new EventEmitter();request.destroyed=false;request.destroy=()=>{request.destroyed=true;};request.end=()=>{if(scenario.hang)return;queueMicrotask(()=>{response=new EventEmitter();response.statusCode=scenario.status;response.headers=scenario.headers||{};response.destroyed=false;response.destroy=()=>{response.destroyed=true;};callback(response);if(!response.destroyed){for(const chunk of scenario.chunks||[])response.emit('data',chunk);if(!response.destroyed)response.emit('end');}});};return request;};
  try{await assert.rejects(safeHttpGet('https://www.moex.com/feed',{timeoutMs:20}),{code:scenario.code});assert.equal(request.destroyed,true);if(response&&scenario.status!==200)assert.equal(response.destroyed,true);}finally{https.request=original;}
 }
});
