import {plainText} from '../model.mjs';
import {russianPressDay} from './press-html.mjs';

const MAX_HTML_BYTES = 1048576;
const MAX_ITEMS = 100;
const badFeed = () => Object.assign(new Error('RADAR_INVALID_FEED'), {code: 'RADAR_INVALID_FEED'});

function checkedHtml({body, contentType} = {}) {
  if (contentType !== 'text/html' || typeof body !== 'string' || Buffer.byteLength(body) > MAX_HTML_BYTES) throw badFeed();
  return body;
}

function metadataEvent(title, sourceUrl, publishedAt) {
  if (typeof title !== 'string' || title.length > 1200 || !publishedAt || !sourceUrl) return null;
  const headline = plainText(title, 400).replace(/\s+/gu, ' ');
  return headline ? {title: headline, sourceUrl, publishedAt} : null;
}

function result(events) {
  if (!events.length) throw badFeed();
  return {events};
}

const mtsOrigin = 'https://ir.mts.ru';
const mtsEndpoint = mtsOrigin + '/news_and_events/corporate_releases';

function parseMts(response) {
  const body = checkedHtml(response);
  const events = [];
  const releases = /<div class="card__date">([^<]{1,256})<\/div>\s*<div class="card__title">\s*<a href="(\/news_and_events\/corporate_releases\/details\/\d+)">([^<]{1,4000})<\/a>/g;
  for (const [, date, url, title] of body.matchAll(releases)) {
    const event = metadataEvent(plainText(title, 1400), mtsOrigin + url, russianPressDay(plainText(date, 128)));
    if (event) events.push(event);
    if (events.length === MAX_ITEMS) break;
  }
  return result(events);
}

const vkOrigin = 'https://vk.company.ru';
const vkEndpoint = vkOrigin + '/ru/investors/news/';

function parseVk(response) {
  const body = checkedHtml(response);
  const data = body.match(/<script id="__NEXT_DATA__" type="application\/json">([^<]+)<\/script>/)?.[1];
  let rows;
  try { rows = JSON.parse(data).props.pageProps.irPressReleases; }
  catch { throw badFeed(); }
  if (!Array.isArray(rows) || rows.length > MAX_ITEMS) throw badFeed();
  return result(rows.flatMap(row => {
    const path = row?.public_url;
    if (typeof path !== 'string' || !/^\/investors\/info\/\d+\/$/.test(path)) return [];
    const publishedAt = typeof row.pub_date === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(row.pub_date) ? row.pub_date : null;
    const event = metadataEvent(row.title, vkOrigin + '/ru' + path, publishedAt);
    return event ? [event] : [];
  }));
}

const headOrigin = 'https://investor.hh.ru';
const headEndpoint = headOrigin + '/ru/press-center';

function parseHeadHunter(response) {
  const body = checkedHtml(response);
  // The public server-rendered page includes the card IDs and source links
  // as JSON-encoded text. Parse that data without executing page scripts.
  const pushes = /<script>self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)<\/script>/g;
  for (const [, encoded] of body.matchAll(pushes)) {
    if (!encoded.includes('press_center_card_id')) continue;
    let records;
    try { records = JSON.parse(encoded).split('\n'); }
    catch { continue; }
    for (const line of records) {
      if (!/^\w+:\[/.test(line) || !line.includes('press_center_card_id')) continue;
      let cards;
      try { cards = JSON.parse(line.slice(line.indexOf(':') + 1))?.[3]?.data?.cards; }
      catch { continue; }
      if (!Array.isArray(cards) || cards.length > MAX_ITEMS) continue;
      return result(cards.flatMap(row => {
        const date = typeof row?.date === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(row.date) ? row.date.slice(0, 10) : null;
        const title = Array.isArray(row?.translations) ? row.translations.find(value => value?.Languages_code === 'ru-RU')?.text : null;
        const fileId = row?.file?.id;
        const path = typeof fileId === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(fileId) ? '/directus-assets/' + fileId : null;
        const event = metadataEvent(title, path && headOrigin + path, date);
        return event ? [event] : [];
      }));
    }
  }
  throw badFeed();
}

export const consumerSources = [
  ['official-mts','МТС · корпоративные релизы','MTSS',mtsEndpoint,[new URL(mtsOrigin).hostname],parseMts],
  ['official-vk','VK · пресс-релизы для инвесторов','VKCO',vkEndpoint,[new URL(vkOrigin).hostname],parseVk],
  ['official-headhunter','Хэдхантер · пресс-центр','HEAD',headEndpoint,[new URL(headOrigin).hostname],parseHeadHunter],
];
