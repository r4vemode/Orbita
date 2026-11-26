import {russianPressDay} from './press-html.mjs';

const origin='https://www.company.rt.ru';
const moscowYear=new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Moscow',year:'numeric'});
const endpoint=now=>origin+'/ir/news_calendar/'+moscowYear.format(now)+'/';
const invalid=()=>Object.assign(new Error('RADAR_INVALID_FEED'),{code:'RADAR_INVALID_FEED'});

export function parseRostelecomPressResponse({body,contentType},{feedUrl}){
 const year=new URL(feedUrl).pathname.match(/^\/ir\/news_calendar\/(\d{4})\/$/)?.[1];
 if(!year||contentType!=='text/html'||typeof body!=='string'||Buffer.byteLength(body)>1048576)throw invalid();
 const records=body.split(/<div id="bx_\d+_\d+" class="item news_item\b[^">]*">/g,102).slice(1);
 if(!records.length||records.length>100)throw invalid();
 const events=[];
 for(const record of records){
  if(!record.includes('href="/press/news/"'))continue;
  const path=record.match(/<a class="item_link" href="(\/ir\/news_calendar\/d\d+\/)"/)?.[1];
  const day=record.match(/<span class="item_date-day">(\d{1,2})<\/span>/)?.[1];
  const month=record.match(/<span class="item_date-month">([А-Яа-я]+)<\/span>/u)?.[1];
  const title=record.match(/<div class="item_text">([^<]{1,1200})<\/div>/)?.[1];
  if(!path||!day||!month||!title)continue;
  const publishedAt=russianPressDay(day+' '+month+' '+year);
  if(publishedAt)events.push({title,sourceUrl:origin+path,publishedAt});
 }
 return {events};
}

export const rostelecomSource=['official-rostelecom','Ростелеком · новости для инвесторов','RTKM',endpoint,['www.company.rt.ru'],parseRostelecomPressResponse];
