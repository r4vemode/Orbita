import {isIP} from 'node:net';
export const EVENT_TYPES=Object.freeze(['DIVIDEND','EARNINGS','GUIDANCE','BUYBACK','SPO','SECONDARY_OFFERING','SHARE_ISSUE','M_AND_A','CONTRACT','BOARD_MEETING','BOARD_DECISION','MANAGEMENT_CHANGE','CREDIT_RATING','DEFAULT','TECHNICAL_DEFAULT','BANKRUPTCY','DEBT','BOND_COUPON','BOND_OFFER','BOND_REDEMPTION','CAPEX','CORPORATE_ACTION','LEGAL','OTHER']);
export const IMPACTS=Object.freeze(['POSITIVE','NEGATIVE','NEUTRAL','MIXED']);
const definitions=[
 ['sber','ПАО Сбербанк','Сбер','SBER','RU0009029540',['Сбербанк России','Сбербанк','Sberbank'],'Финансы'],
 ['lkoh','ПАО ЛУКОЙЛ','Лукойл','LKOH','RU0009024277',['Lukoil'],'Нефть и газ'],
 ['gazp','ПАО Газпром','Газпром','GAZP','RU0007661625',['Gazprom'],'Нефть и газ'],
 ['vtbr','ПАО Банк ВТБ','ВТБ','VTBR','RU000A0JP5V6',['VTB','Банк ВТБ'],'Финансы'],
 ['ydex','МКПАО Яндекс','Яндекс','YDEX','RU000A107T19',['Yandex'],'Технологии'],
 ['ozon','МКПАО Озон','Ozon','OZON','RU000A10CW00',['Озон','Ozon Holdings'],'Потребительский сектор'],
 ['nvtk','ПАО НОВАТЭК','Новатэк','NVTK','RU000A0DKVS5',['Novatek'],'Нефть и газ'],
 ['smlt','ПАО ГК Самолет','Самолёт','SMLT','RU000A0ZZG02',['Самолет','ГК Самолет'],'Недвижимость'],
 ['moex','ПАО Московская Биржа','Московская биржа','MOEX','RU000A0JR4A1',['Мосбиржа','Moscow Exchange'],'Финансы'],
 ['plzl','ПАО Полюс','Полюс','PLZL','RU000A0JNAA8',['Polyus'],'Металлы'],
 ['t','МКПАО Т-Технологии','Т-Технологии','T','RU000A107UL4',['Т Технологии','T-Technologies','Тинькофф'],'Финансы'],
 ['nlmk','ПАО НЛМК','НЛМК','NLMK','RU0009046452',['Новолипецкий металлургический комбинат'],'Металлы'],
 ['rosn','ПАО НК Роснефть','Роснефть','ROSN','RU000A0J2Q06',['Rosneft'],'Нефть и газ'],
 ['gmkn','ПАО ГМК Норильский никель','Норникель','GMKN','RU0007288411',['Норильский никель','Nornickel'],'Металлы'],
 ['chmf','ПАО Северсталь','Северсталь','CHMF','RU0009046510',['Severstal'],'Металлы'],
 ['magn','ПАО ММК','ММК','MAGN','RU0009084396',['Магнитогорский металлургический комбинат'],'Металлы'],
 ['demo-bond','Учебный облигационный эмитент','Демо Облигации','DEMO-BOND','XX0000000001',['Учебный эмитент облигаций'],'Учебный кредитный риск']
];
export const DEMO_COMPANIES=Object.freeze(definitions.map(([id,name,shortName,ticker,isin,aliases,sector])=>Object.freeze({id,name,shortName,ticker,isin,aliases:[...new Set([name,shortName,ticker,...aliases])],sector,active:true,assetType:id==='demo-bond'?'bond':'stock',irUrl:'',newsUrl:'',investorRelationsUrl:'',providerType:'company-ir'})));
export function plainText(value,max=20000){
 if(typeof value!=='string')throw new TypeError('RADAR_INVALID_TEXT');
 if(value.length>max*3)throw new RangeError('RADAR_TEXT_LIMIT');
 // Scan once: regular expressions with nested/unclosed '<' can rescan the
 // complete remainder for every opening delimiter and block the event loop.
 const parts=[],lower=value.replace(/[A-Z]/g,char=>char.toLowerCase());let cursor=0;
 while(cursor<value.length){
  if(value[cursor]!=='<'){const next=value.indexOf('<',cursor);parts.push(value.slice(cursor,next<0?value.length:next));cursor=next<0?value.length:next;continue;}
  let end=cursor+1;while(end<value.length&&value[end]!=='<'&&value[end]!=='>')end++;
  if(end>=value.length){parts.push(value.slice(cursor));break;}
  if(value[end]==='<'){parts.push(value.slice(cursor,end));cursor=end;continue;}
  const token=value.slice(cursor,end+1),tag=token.match(/^<\s*\/?\s*([A-Za-z][A-Za-z0-9:-]*)(?=[\s/>])/),name=tag?.[1].toLowerCase();
  if(name&&['script','style','iframe','object'].includes(name)&&!/^<\s*\//.test(token)){
   let close=lower.indexOf('</'+name,end+1);while(close>=0&&!/[\s>]/.test(value[close+name.length+2]||''))close=lower.indexOf('</'+name,close+name.length+2);
   if(close<0){parts.push(' ');break;}
   const after=lower.indexOf('>',close+name.length+2);cursor=after<0?value.length:after+1;parts.push(' ');continue;
  }
  parts.push(name?' ':token);cursor=end+1;
 }
 return parts.join('').replace(/&#(x[0-9a-f]+|\d+);/gi,(_,v)=>{const n=v[0].toLowerCase()==='x'?parseInt(v.slice(1),16):Number(v);return n>0&&n<=0x10ffff?String.fromCodePoint(n):' ';}).replace(/&(nbsp|amp|lt|gt|quot|apos);/gi,(_,name)=>({nbsp:' ',amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"}[name.toLowerCase()])).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,' ').replace(/[ \t]+/g,' ').trim().slice(0,max);
}
export function publicIp(address){
 if(isIP(address)===4){const [a,b,c]=address.split('.').map(Number);return !(a===0||a===10||a===127||a>=224||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&(b===168||b===0)||a===100&&b>=64&&b<=127||a===198&&(b===18||b===19||b===51&&c===100)||a===203&&b===0&&c===113);}
 if(isIP(address)===6){const value=new URL('http://['+address+']/').hostname.slice(1,-1);return /^[23][a-f0-9]{0,3}:/.test(value)&&!/^2001:(?:db8:|0:|:)/.test(value)&&!value.startsWith('2002:');}
 return false;
}
export function safeSourceUrl(value,{allowEmpty=false}={}){
 if((value===undefined||value==='')&&allowEmpty)return '';
 if(typeof value!=='string'||value.length>2048)throw new TypeError('RADAR_INVALID_SOURCE_URL');
 let url;try{url=new URL(value);}catch{throw new TypeError('RADAR_INVALID_SOURCE_URL');}
 const host=url.hostname.replace(/^\[|\]$/g,'').toLowerCase();
 if(url.protocol!=='https:'||url.username||url.password||url.port&&url.port!=='443'||!host.includes('.')&&isIP(host)!==6||/(?:^|\.)(?:localhost|local|internal|test|invalid|example|onion)$/.test(host)||isIP(host)&&!publicIp(host))throw new TypeError('RADAR_INVALID_SOURCE_URL');
 return url.href;
}
export const matchKey=value=>plainText(String(value),21000).toLocaleLowerCase('ru-RU').replace(/ё/g,'е').replace(/[^\p{L}\p{N}]+/gu,' ').trim();
export function matchCompany(raw,companies=DEMO_COMPANIES){
 const active=companies.filter(company=>company.active!==false),ticker=String(raw.ticker||'').trim().toUpperCase(),isin=String(raw.isin||'').trim().toUpperCase();
 const explicit=active.filter(company=>(ticker&&company.ticker.toUpperCase()===ticker)||(isin&&company.isin?.toUpperCase()===isin));
 if(explicit.length)return explicit.length===1?explicit[0]:null;
 const name=matchKey(raw.companyName||''),body=' '+matchKey([raw.title,raw.rawText].filter(Boolean).join(' '))+' ';
 const matches=active.filter(company=>[company.name,company.shortName,company.ticker,...company.aliases||[]].some(alias=>{const key=matchKey(alias);return key&&(name===key||key.length>=3&&body.includes(' '+key+' '));}));
 return matches.length===1?matches[0]:null;
}
export function cleanRecord(value,{depth=0}={}){
 if(depth>4)throw new TypeError('RADAR_INVALID_DATA');
 if(value===null||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value))return value;
 if(typeof value==='string')return plainText(value,1000);
 if(Array.isArray(value)){if(value.length>50)throw new TypeError('RADAR_INVALID_DATA');return value.map(item=>cleanRecord(item,{depth:depth+1}));}
 if(value&&typeof value==='object'&&Object.getPrototypeOf(value)===Object.prototype){const keys=Object.keys(value);if(keys.length>50||keys.some(key=>['__proto__','constructor','prototype'].includes(key)||key.length>80))throw new TypeError('RADAR_INVALID_DATA');return Object.fromEntries(keys.map(key=>[key,cleanRecord(value[key],{depth:depth+1})]));}
 throw new TypeError('RADAR_INVALID_DATA');
}
export function validateAnalysis(value){
 const keys=['eventType','importanceScore','impact','confidence','headline','summary','whyImportant','extractedData','tags'];
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!keys.includes(key))||!EVENT_TYPES.includes(value.eventType)||!IMPACTS.includes(value.impact)||!Number.isFinite(value.importanceScore)||value.importanceScore<0||value.importanceScore>10||!Number.isFinite(value.confidence)||value.confidence<0||value.confidence>1)throw new TypeError('RADAR_INVALID_ANALYSIS');
 const result={...value};for(const [key,max]of [['headline',180],['summary',1600],['whyImportant',2000]]){if(typeof value[key]!=='string'||!value[key].trim()||value[key].length>max)throw new TypeError('RADAR_INVALID_ANALYSIS');result[key]=plainText(value[key],max);if(!result[key])throw new TypeError('RADAR_INVALID_ANALYSIS');}
 if(!Array.isArray(value.tags)||value.tags.length>20||value.tags.some(tag=>typeof tag!=='string'||tag.length>50))throw new TypeError('RADAR_INVALID_ANALYSIS');result.tags=[...new Set(value.tags.map(tag=>plainText(tag,50)))];result.extractedData=cleanRecord(value.extractedData||{});if(JSON.stringify(result.extractedData).length>8000)throw new TypeError('RADAR_INVALID_ANALYSIS');return result;
}
