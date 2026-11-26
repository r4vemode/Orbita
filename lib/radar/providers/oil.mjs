import {russianPressDay} from './press-html.mjs';

const lukoilOrigin='https://lukoil.ru';
const novatekOrigin='https://www.novatek.ru';
const scfOrigin='https://www.scf-group.ru';

function invalidFeed(){
  return Object.assign(new Error('RADAR_INVALID_FEED'),{code:'RADAR_INVALID_FEED'});
}

function parsePressPage({body,contentType}={},pattern,origin){
  if(typeof body!=='string'||Buffer.byteLength(body)>1048576||typeof contentType!=='string'||contentType.split(';')[0].trim().toLowerCase()!=='text/html')throw invalidFeed();
  const events=[];
  for(const {groups:{link,date,title}} of body.matchAll(pattern)){
    if(events.length===100)break;
    const publishedAt=russianPressDay(date);
    if(!publishedAt||!title.trim())continue;
    events.push({title:title.trim().replace(/\s+/g,' '),sourceUrl:origin+link,publishedAt});
  }
  if(!events.length)throw invalidFeed();
  return {events};
}

export function parseLukoilPressResponse(response){
  // The rendered links are canonical HTTPS. Embedded metadata includes HTTP URLs.
  const card=/<a\b[^<>]{0,500}?\bhref=['"]https:\/\/lukoil\.ru(?<link>\/PressCenter\/Pressreleases\/Pressrelease\/[a-z0-9_-]{1,180})['"][^<>]{0,150}>\s*<h2>\s*<span class="date">\s*(?<date>\d{2}\.\d{2}\.\d{4})\s*-\s*<\/span>\s*<span class="title">(?<title>[^<]{1,1200})<\/span>/gi;
  return parsePressPage(response,card,lukoilOrigin);
}

export function parseNovatekPressResponse(response){
  const card=/<div data-list-item="1" class="onenews [^"]{1,30}">\s*<div class="inner">\s*<div class="img">\s*<div class="date">(?<date>[^<]{1,80})<\/div>\s*(?:<img\b[^<>]{1,600}>\s*)?<\/div>\s*<div class="text">\s*<a href="(?<link>\/ru\/press\/releases\/index\.php\?id_4=\d{1,10})">(?<title>[^<]{1,1200})<\/a>/gi;
  return parsePressPage(response,card,novatekOrigin);
}

export function parseScfPressResponse(response){
  const card=/<article class="press-list__item">\s*<div class="press-list__date">(?<date>[^<]{1,80})<\/div>\s*<h5 class="press-list__title">\s*<a href="(?<link>\/media\/press_releases\/item\d{1,10}\.html)">(?<title>[^<]{1,1200})<\/a>/gi;
  return parsePressPage(response,card,scfOrigin);
}

export const oilSources=[
  ['official-lukoil','ЛУКОЙЛ · пресс-релизы','LKOH',lukoilOrigin+'/PressCenter/Pressreleases',['lukoil.ru'],parseLukoilPressResponse],
  ['official-novatek','НОВАТЭК · пресс-релизы','NVTK',novatekOrigin+'/ru/press/releases/',['www.novatek.ru'],parseNovatekPressResponse],
  ['official-scf','Совкомфлот · пресс-релизы','FLOT',scfOrigin+'/media/press_releases/',['www.scf-group.ru'],parseScfPressResponse],
];

