const origin = 'https://polyus.com';
export const polyusPressEndpoint = origin + '/ru/media/press-releases/';

export function parsePolyusPressResponse({body,contentType}){
  const invalid = () => Object.assign(new Error('Неверный формат пресс-ленты «Полюса»'),{code:'RADAR_INVALID_FEED'});
  if(contentType!=='text/html'||typeof body!=='string'||Buffer.byteLength(body)>1048576)throw invalid();
  const events=[];
  for(const [,article] of body.matchAll(/<article class="news-item">([\s\S]*?)<\/article>/g)){
    if(events.length>=100)throw invalid();
    const headline=article.match(/<h3 class="news-item__title">\s*<a href="(\/ru\/media\/press-releases\/[a-z0-9-]+\/)">([^<]+)<\/a>/);
    const time=article.match(/<time class="news-item__time" datetime="(\d{4}-\d{2}-\d{2})">[^<]*,\s+(\d{2}:\d{2})<\/time>/);
    if(!headline||!time)continue;
    events.push({title:headline[2],sourceUrl:origin+headline[1],publishedAt:time[1]+'T'+time[2]+':00+03:00'});
  }
  if(!events.length)throw invalid();
  return {events,cursor:null};
}
