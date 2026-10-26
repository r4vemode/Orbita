import {isIP} from 'node:net';
import {json} from './http.mjs';

const clients=new WeakMap();
function normalizeAddress(value){
  if(typeof value!=='string'||!isIP(value))return null;
  if(isIP(value)===4)return value;
  const canonical=new URL('http://['+value+']/').hostname.slice(1,-1);
  const mapped=canonical.match(/^::ffff:([a-f0-9]{1,4}):([a-f0-9]{1,4})$/);
  if(mapped){const high=parseInt(mapped[1],16),low=parseInt(mapped[2],16);return [high>>>8,high&255,low>>>8,low&255].join('.');}
  return canonical;
}
export function parseTrustedProxyIps(value=''){
  if(typeof value!=='string')throw Error('ORBITA_TRUSTED_PROXY_IPS: укажите IP-адреса через запятую.');
  if(!value.trim())return new Set();
  const entries=value.split(',');
  if(entries.length>32)throw Error('ORBITA_TRUSTED_PROXY_IPS: не больше 32 IP-адресов.');
  const addresses=entries.map(value=>normalizeAddress(value.trim()));
  if(addresses.some(value=>!value))throw Error('ORBITA_TRUSTED_PROXY_IPS: допустимы только отдельные IPv4/IPv6-адреса, без масок и имён.');
  return new Set(addresses);
}
export function resolveClientAddress(req,trusted=new Set()){
  const peer=normalizeAddress(req.socket?.remoteAddress)||'unknown';
  if(!trusted.has(peer))return peer;
  const header=req.headers?.['x-forwarded-for'];
  if(typeof header!=='string'||header.length>2048)return peer;
  const parts=header.split(',');if(parts.length>16)return peer;
  const forwarded=parts.map(value=>normalizeAddress(value.trim()));if(forwarded.some(value=>!value))return peer;
  // Peel only explicitly trusted hops, from the socket back toward the client.
  let address=peer;
  for(let index=forwarded.length-1;index>=0&&trusted.has(address);index--)address=forwarded[index];
  return address;
}
export const requestAddress=req=>clients.get(req)||normalizeAddress(req.socket?.remoteAddress)||'unknown';

export function createRequestSecurity({trustedProxyIps='',now=Date.now,windowMs=60000,readLimit=600,writeLimit=60,maxEntries=10000,maxActive=32,maxWebhookActive=8,maxClientActive=8}={}){
  const trusted=parseTrustedProxyIps(trustedProxyIps),entries=new Map();let active=0,webhookActive=0,nextSweep=0;
  for(const value of [windowMs,readLimit,writeLimit,maxEntries,maxActive,maxWebhookActive,maxClientActive])if(!Number.isSafeInteger(value)||value<1)throw Error('Invalid request security limit');
  function refuse(res,status,code,retry){
    json(res,status,{error:status===429?'Слишком много запросов. Подождите немного и повторите попытку.':'Сервис занят. Повторите запрос через несколько секунд.',code},{'Retry-After':String(Math.max(1,retry)),'Connection':'close'});return false;
  }
  function enter(req,res,{webhook=false}={}){
    const address=resolveClientAddress(req,trusted);clients.set(req,address);
    const at=now();
    if(at>=nextSweep){for(const [key,item]of entries)if(item.until<=at&&item.active===0)entries.delete(key);nextSweep=at+Math.min(windowMs,10000);}
    let item=entries.get(address);
    if(!item){if(entries.size>=maxEntries)return refuse(res,429,'REQUEST_LIMIT',Math.ceil(windowMs/1000));item={until:at+windowMs,reads:0,writes:0,active:0};entries.set(address,item);}
    if(item.until<=at){item.until=at+windowMs;item.reads=0;item.writes=0;}
    const kind=['GET','HEAD','OPTIONS'].includes(req.method)?'reads':'writes',limit=kind==='reads'?readLimit:writeLimit;
    if(item[kind]>=limit)return refuse(res,429,'REQUEST_LIMIT',Math.ceil((item.until-at)/1000));
    item[kind]++;
    if(item.active>=maxClientActive)return refuse(res,429,'REQUEST_BUSY',1);
    if(webhook?webhookActive>=maxWebhookActive:active>=maxActive)return refuse(res,503,'SERVICE_BUSY',1);
    item.active++;if(webhook)webhookActive++;else active++;
    let released=false;
    const release=()=>{if(released)return;released=true;item.active--;if(webhook)webhookActive--;else active--;res.removeListener('finish',release);res.removeListener('close',release);};
    res.once('finish',release);res.once('close',release);return true;
  }
  return {enter};
}
