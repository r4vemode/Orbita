import {readFileSync} from 'node:fs';
const fixtures=JSON.parse(readFileSync(new URL('../../../fixtures/radar-events.json',import.meta.url),'utf8'));
export function createMockProvider({now=Date.now}={}){
 return {id:'mock',name:'Учебный источник Radar',enabled:true,configured:true,interval:15000,async fetchEvents({cursor,signal}={}){
  signal?.throwIfAborted();if(cursor==='radar-demo-v1')return {events:[],cursor};
  return {events:fixtures.map((item,index)=>{const {offsetMinutes,...raw}=item;return {...raw,provider:'mock',externalId:'radar-demo-v1-'+(index+1),sourceType:raw.sourceType||'DISCLOSURE',publishedAt:new Date(now()-offsetMinutes*60000).toISOString(),detectedAt:new Date(now()).toISOString(),isDemo:true};}),cursor:'radar-demo-v1'};
 }};
}
