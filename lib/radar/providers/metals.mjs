const maxBytes = 1024 * 1024;
const maxCards = 100;
const months = ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];

const mmk = 'https://mmk.ru/ru/press-center/news/';
const rusal = 'https://rusal.ru/press-center/press-releases/';
const phosagro = 'https://www.phosagro.ru/press/company/';
const seligdar = 'https://seligdar.ru/media/news/?PAGEN_1=1';

function invalidFeed() {
  return Object.assign(new Error('RADAR_INVALID_FEED'),{code:'RADAR_INVALID_FEED'});
}

function publicationDay(year,month,day) {
  if(!year||!month||!day)return null;
  const iso=[year.length===2?'20'+year:year,month.padStart(2,'0'),day.padStart(2,'0')].join('-');
  const at=new Date(iso+'T00:00:00Z');
  return Number.isFinite(at.valueOf())&&at.toISOString().startsWith(iso+'T')?iso:null;
}

function russianDay(raw) {
  const fields=raw?.replace(/&nbsp;|&#160;/g,' ').trim().match(/^(\d{1,2})\s+([а-яё]+)\s+['‘’]?(\d{4}|\d{2})(?:\s+г\.?)?$/i);
  if(!fields)return null;
  const index=months.indexOf(fields[2].toLowerCase());
  return index<0?null:publicationDay(fields[3],String(index+1),fields[1]);
}

function dottedDay(raw) {
  const fields=raw?.trim().match(/^(\d{2})\.(\d{2})\.(\d{4}|\d{2})$/);
  return fields?publicationDay(fields[3],fields[2],fields[1]):null;
}

function parseCards({body,contentType},endpoint,cardPattern,parseCard) {
  if(contentType!=='text/html'||typeof body!=='string'||Buffer.byteLength(body)>maxBytes)throw invalidFeed();
  const cards=body.split(cardPattern,maxCards+2).slice(1);
  if(!cards.length||cards.length>maxCards)throw invalidFeed();
  const events=[];
  for(const card of cards){
    const [path,title,publishedAt]=parseCard(card);
    if(path&&title&&publishedAt)events.push({
      title:title.trim(),
      sourceUrl:new URL(path,endpoint).href,
      publishedAt
    });
  }
  if(!events.length)throw invalidFeed();
  return {events};
}

export function parseMmkPressResponse(response) {
  return parseCards(response,mmk,/<div class="card-news-list__card"[^>]*>/g,card=>{
    const path=card.match(/<a class="card-article__link" href="(\/ru\/press-center\/news\/[a-z0-9_-]+\/)"/i)?.[1];
    const title=card.match(/<div class="card-article__title"[^>]*>([^<]+)<\/div>/)?.[1];
    const date=card.match(/<span class="card-article__date"[^>]*>([^<]+)<\/span>/)?.[1];
    return [path,title,russianDay(date)];
  });
}

export function parseRusalPressResponse(response) {
  return parseCards(response,rusal,/<div class="invest-card">/g,card=>{
    const path=card.match(/<a class="invest-card__bottom" href="(\/press-center\/press-releases\/[a-z0-9_-]+\/)"/i)?.[1];
    const title=card.match(/<div class="invest-card__name [^"]*">\s*<span>([\s\S]*?)<\/span>/)?.[1];
    const date=card.match(/<div class="invest-card__date [^"]*">\s*<span>([^<]+)<\/span>/)?.[1];
    return [path,title,dottedDay(date)];
  });
}

export function parsePhosagroPressResponse(response) {
  return parseCards(response,phosagro,/(?=<a href="\/press\/company\/[a-z0-9_-]+\/" class="press__card )/g,card=>{
    const end=card.indexOf('</a>');
    if(end<0)return [];
    const anchor=card.slice(0,end);
    const path=anchor.match(/^<a href="(\/press\/company\/[a-z0-9_-]+\/)"/i)?.[1];
    const title=anchor.match(/<h4[^>]*>([\s\S]*?)<\/h4>/)?.[1];
    const date=anchor.match(/<div class="press__card-date">([^<]+)<\/div>/)?.[1];
    return [path,title,russianDay(date)];
  });
}

export function parseSeligdarPressResponse(response) {
  return parseCards(response,seligdar,/<li id="bx_[0-9_]+">/g,card=>{
    const match=card.match(/^<a href="(\/media\/news\/[a-z0-9_-]+\/)">\s*<span class="date">([^<]+)<\/span>\s*<br\s*\/?>\s*([^<]+)<\/a>/i);
    return match?[match[1],match[3],dottedDay(match[2])]:[];
  });
}

export const metalSources = [
  ['official-mmk','ММК · пресс-релизы','MAGN',mmk,['mmk.ru'],parseMmkPressResponse],
  ['official-rusal','РУСАЛ · пресс-релизы','RUAL',rusal,['rusal.ru'],parseRusalPressResponse],
  ['official-phosagro','ФосАгро · пресс-релизы','PHOR',phosagro,['www.phosagro.ru'],parsePhosagroPressResponse],
  ['official-seligdar','Селигдар · пресс-релизы','SELG',seligdar,['seligdar.ru'],parseSeligdarPressResponse]
];
