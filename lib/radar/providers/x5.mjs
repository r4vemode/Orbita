import {plainText,safeSourceUrl} from '../model.mjs';

const MAX_RESPONSE_BYTES=1048576;
const MAX_ROWS=100;
const sourceHosts=new Set(['www.x5.ru','x5.ru']);
const gmtDate=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;

function invalidFeed(){
  throw Object.assign(new Error('RADAR_INVALID_FEED'),{code:'RADAR_INVALID_FEED'});
}

export function parseX5PressResponse({body,contentType}={}){
  if(typeof contentType!=='string'||contentType.split(';',1)[0].trim().toLowerCase()!=='application/json'||
     typeof body!=='string'||Buffer.byteLength(body)>MAX_RESPONSE_BYTES)invalidFeed();
  let rows;
  try{rows=JSON.parse(body);}catch{invalidFeed();}
  if(!Array.isArray(rows)||rows.length>MAX_ROWS)invalidFeed();

  const events=[];
  for(const row of rows){
    if(!row||typeof row!=='object'||Array.isArray(row)||typeof row.lang!=='string'||!row.lang)invalidFeed();
    if(row.lang!=='ru')continue;
    if(!Number.isSafeInteger(row.id)||row.id<1||typeof row.date_gmt!=='string'||!gmtDate.test(row.date_gmt)||
       !row.title||typeof row.title.rendered!=='string'||row.title.rendered.length>900)invalidFeed();

    const timestamp=new Date(row.date_gmt+'Z');
    if(!Number.isFinite(timestamp.getTime())||timestamp.toISOString()!==row.date_gmt+'.000Z')invalidFeed();
    let url;
    try{url=new URL(safeSourceUrl(row.link));}catch{invalidFeed();}
    if(!sourceHosts.has(url.hostname)||!/^\/ru\/news\/[a-z0-9-]+\/$/.test(url.pathname)||url.search||url.hash)invalidFeed();

    const title=plainText(row.title.rendered,300);
    if(!title)invalidFeed();
    events.push({title,sourceUrl:url.href,publishedAt:timestamp.toISOString()});
  }
  return {events};
}
