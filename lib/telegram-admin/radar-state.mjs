import {EVENT_TYPES} from '../radar/model.mjs';
import {error} from '../http.mjs';
const object=v=>v&&typeof v==='object'&&!Array.isArray(v),id=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(v),integer=v=>Number.isSafeInteger(v)&&v>=0;
export const radarDefaults=()=>({enabled:false,minimumImportance:7,criticalImportance:9,stocks:true,bonds:true,eventTypes:[],quietStart:23,quietEnd:8});
export const emptyRadarState=()=>({version:1,preferences:[],alerts:[],ignored:[],drafts:[]});
export function radarPreferences(input){
 if(!object(input)||Object.keys(input).some(k=>!Object.hasOwn(radarDefaults(),k)))throw error(400,'Неизвестные настройки Radar.');
 const p={...radarDefaults(),...input};
 if(['enabled','stocks','bonds'].some(k=>typeof p[k]!=='boolean')||!Number.isFinite(p.minimumImportance)||p.minimumImportance<6||p.minimumImportance>10||!Number.isFinite(p.criticalImportance)||p.criticalImportance<p.minimumImportance||p.criticalImportance>10||!['quietStart','quietEnd'].every(k=>Number.isInteger(p[k])&&p[k]>=0&&p[k]<=23)||!Array.isArray(p.eventTypes)||p.eventTypes.length>EVENT_TYPES.length||new Set(p.eventTypes).size!==p.eventTypes.length||p.eventTypes.some(t=>!EVENT_TYPES.includes(t)))throw error(400,'Проверьте порог важности, часы тишины и типы событий.');
 return p;
}
export function validateRadarAdminState(s){
 if(s===undefined)return true;
 if(!object(s)||s.version!==1||!['preferences','alerts','ignored','drafts'].every(k=>Array.isArray(s[k]))||s.preferences.length>1000||s.alerts.length>10000||s.ignored.length>10000||s.drafts.length>2000)return false;
 try{
  for(const p of s.preferences){if(!id(p.bindingId)||!integer(p.enabledAt))return false;radarPreferences(p.value);}
  const keys=new Set();for(const a of s.alerts){if(!id(a.id)||keys.has(a.id)||!id(a.bindingId)||!id(a.eventId)||!integer(a.createdAt)||!integer(a.nextAttemptAt)||!integer(a.attempts)||!['pending','sending','sent','failed','skipped'].includes(a.status)||a.leaseUntil!==undefined&&!integer(a.leaseUntil))return false;keys.add(a.id);}
  for(const i of s.ignored)if(!id(i.userId)||!id(i.eventId)||!integer(i.at))return false;
  for(const d of s.drafts)if(!id(d.id)||!id(d.userId)||!id(d.eventId)||!integer(d.createdAt)||!integer(d.expiresAt)||!integer(d.eventRevision)||typeof d.requestId!=='string'||typeof d.eventHash!=='string'||typeof d.relatedFingerprint!=='string'||typeof d.instrumentId!=='string')return false;
  return true;
 }catch{return false;}
}
