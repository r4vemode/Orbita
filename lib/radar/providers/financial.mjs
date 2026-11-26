import {plainText} from '../model.mjs';
import {russianPressDay} from './press-html.mjs';

const ttPressEndpoint='https://t-technologies.ru/press-releases/';
const ttPressMaxBytes=2*1024*1024;
const ttDocument=/^https:\/\/cdn\.tbank-online\.com\/static\/documents\/[a-z0-9-]{1,160}\.pdf$/i;
const invalidFeed=()=>Object.assign(new Error('RADAR_INVALID_FEED'),{code:'RADAR_INVALID_FEED'});

export function parseTTechnologiesPressResponse({body,contentType}={}){
  if(contentType!=='text/html'||typeof body!=='string'||Buffer.byteLength(body)>ttPressMaxBytes)throw invalidFeed();
  const panels=[...body.matchAll(/<div\b[^>]*\bdata-test="panels-\d+"[^>]*\brole="listitem"[^>]*>/g)];
  if(!panels.length||panels.length>100)throw invalidFeed();
  const events=[];
  for(const [index,panel] of panels.entries()){
    const start=panel.index+panel[0].length;
    const row=body.slice(start,Math.min(start+12000,panels[index+1]?.index??body.length));
    const date=row.match(/<p>([^<]{3,80})<\/p>/)?.[1];
    const article=row.match(/<a\b[^>]*\bdata-test="panel-link"[^>]*\bhref="([^"]+)"[^>]*>[\s\S]*?<\/a>\s*<div\b[^>]*>\s*<p>([\s\S]{1,600}?)<\/p>/);
    if(!date||!article||!ttDocument.test(article[1]))continue;
    const publishedAt=russianPressDay(plainText(date,100));
    const title=plainText(article[2].replace(/<\/?nobr\b[^>]*>/gi,''),400);
    if(!publishedAt||!title)continue;
    events.push({title,sourceUrl:article[1],publishedAt});
  }
  if(!events.length)throw invalidFeed();
  return {events};
}

export const financialSources=[
  ['official-t-technologies','Т-Технологии · пресс-релизы','T',ttPressEndpoint,
    ['t-technologies.ru','cdn.tbank-online.com'],parseTTechnologiesPressResponse,ttPressMaxBytes]
];
