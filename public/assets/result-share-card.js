import {qrcode} from './vendor/qrcode-generator-2.0.4.js';

const layouts = {
  feed: {height:1350, top:116, ticker:333, result:590, stats:755, footer:977, note:1246, orbitY:460, right:76},
  vertical: {height:1920, top:238, ticker:521, result:808, stats:1013, footer:1282, note:1570, orbitY:634, right:120}
};
const channels = {pulse:'pulse', x:'x', tiktok:'tiktok', telegram:'telegram', other:'social'};
const colors = {white:'#f0f6ff', muted:'#b3c5db', faint:'#8da7c5', blue:'#aaceff'};
const date = new Intl.DateTimeFormat('ru-RU', {
  timeZone:'Europe/Moscow', day:'2-digit', month:'2-digit', year:'numeric'
});
const time = new Intl.DateTimeFormat('ru-RU', {timeZone:'Europe/Moscow', hour:'2-digit', minute:'2-digit'});
const number = new Intl.NumberFormat('ru-RU', {maximumFractionDigits:8});
const percent = new Intl.NumberFormat('ru-RU', {
  minimumFractionDigits:2, maximumFractionDigits:2, signDisplay:'exceptZero'
});

export function shareLink(origin, channel) {
  const url = new URL('/results.html', origin);
  if (url.protocol !== 'https:' || url.username || url.password || !Object.hasOwn(channels, channel)) {
    throw new Error('Не удалось создать ссылку на ORBITA.');
  }
  url.search = new URLSearchParams({
    type:'actual', utm_source:channels[channel], utm_medium:'social', utm_campaign:'orbita_results'
  }).toString();
  return url;
}

function text(ctx, value, x, y, {size, color=colors.white, weight=500, maxWidth=Infinity, align='left'}) {
  ctx.font = `${weight} ${size}px Manrope, Arial, sans-serif`;
  const naturalWidth = ctx.measureText(value).width;
  if (naturalWidth > maxWidth) {
    ctx.font = `${weight} ${Math.floor(size * maxWidth / naturalWidth)}px Manrope, Arial, sans-serif`;
  }
  ctx.textAlign = align;
  ctx.fillStyle = color;
  ctx.fillText(value, x, y);
}

function box(ctx, x, y, width, height, radius, fill, stroke) {
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, radius);
  if (fill) { ctx.fillStyle = fill; ctx.fill(); }
  if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1.5; ctx.stroke(); }
}

function orbit(ctx, x, y) {
  ctx.save();
  ctx.translate(x, y);
  const light = ctx.createRadialGradient(-54, -48, 10, 0, 0, 310);
  light.addColorStop(0, '#4984ca50');
  light.addColorStop(1, '#4984ca00');
  ctx.fillStyle = light;
  ctx.fillRect(-340, -340, 680, 680);
  ctx.rotate(-Math.PI / 5);
  const ring = ctx.createLinearGradient(-290, -100, 280, 135);
  ring.addColorStop(0, '#5688c52a');
  ring.addColorStop(0.55, '#82b4ff85');
  ring.addColorStop(1, '#dbedffe0');
  ctx.strokeStyle = ring;
  for (let i = 0; i < 3; i++) {
    ctx.beginPath();
    ctx.lineWidth = i === 0 ? 2.2 : 1;
    ctx.ellipse(0, 0, 223 + i * 31, 54 + i * 22, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
  const planet = ctx.createRadialGradient(-58, -70, 0, 20, 13, 152);
  planet.addColorStop(0, '#91bff7');
  planet.addColorStop(0.35, '#396dab');
  planet.addColorStop(0.73, '#172f53');
  planet.addColorStop(0.96, '#0e1e36');
  planet.addColorStop(1, '#7aa4d7');
  ctx.fillStyle = planet;
  ctx.beginPath();
  ctx.arc(0, 0, 142, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = ring;
  ctx.beginPath();
  ctx.lineWidth = 2.5;
  ctx.ellipse(0, 0, 253, 76, 0, 0.04, Math.PI);
  ctx.stroke();
  ctx.shadowColor = '#aaceff';
  ctx.shadowBlur = 22;
  ctx.fillStyle = '#d9ecff';
  ctx.beginPath();
  ctx.arc(230, 31.5, 6, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function logo(ctx, left, baseline) {
  const centerX = left + 22, centerY = baseline - 19;
  ctx.fillStyle = colors.blue;
  for (let index = 0; index < 12; index++) {
    const angle = index * Math.PI / 6;
    ctx.beginPath();
    ctx.arc(centerX + 16 * Math.cos(angle), centerY + 16 * Math.sin(angle), index === 10 ? 3.8 : 2, 0, Math.PI * 2);
    ctx.fill();
  }
  text(ctx, 'ORBITA', left + 56, baseline, {size:45, weight:800});
}

function drawQr(ctx, url, right, centerY) {
  const code = qrcode(0, 'M');
  code.addData(url.href);
  code.make();
  const count = code.getModuleCount();
  const quiet = 4;
  const step = Math.floor(216 / (count + 2 * quiet));
  const size = (count + 2 * quiet) * step;
  const x = right - size, y = centerY - Math.floor(size / 2);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(x, y, size, size);
  ctx.fillStyle = '#0b1728';
  for (let row = 0; row < count; row++) {
    for (let column = 0; column < count; column++) {
      if (code.isDark(row, column)) ctx.fillRect(x + (column + quiet) * step, y + (row + quiet) * step, step, step);
    }
  }
}

function drawPrices(ctx, card, left, right, top) {
  const split = (left + right) / 2;
  const stats = [
    {label:'Цена входа', value:card.entry, x:left + 34},
    {label:card.exitAveraged ? 'Средняя цена выхода' : 'Цена выхода', value:card.exit, x:split + 34}
  ];
  box(ctx, left, top, right - left, 149, 25, '#091626b8', '#7497c54d');
  ctx.strokeStyle = '#7497c54d';
  ctx.beginPath();
  ctx.moveTo(split, top + 28);
  ctx.lineTo(split, top + 121);
  ctx.stroke();
  for (const {label, value, x} of stats) {
    text(ctx, label, x, top + 53, {size:27, color:colors.muted, maxWidth:split - left - 65});
    text(ctx, [number.format(value), card.unit].filter(Boolean).join(' '), x, top + 110, {
      size:43, weight:750, maxWidth:split - left - 68
    });
  }
}

export function drawResultCard(canvas, card, url, format) {
  if (!Object.hasOwn(layouts, format)) throw new Error('Выберите формат карточки.');
  const layout = layouts[format];
  canvas.width = 1080;
  canvas.height = layout.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Браузер не смог отрисовать карточку.');
  const left = 76, right = 1080 - layout.right;
  const closed = new Date(card.closedAt);
  const formattedPct = percent.format(card.pct).replace('-', '−');
  const resultColor = formattedPct.startsWith('+') ? '#9ae5c2' : formattedPct.startsWith('−') ? '#ffaeae' : colors.white;
  const resultText = `${formattedPct}%`;
  const direction = card.dir === 'ШОРТ' ? 'ШОРТ' : 'ЛОНГ';

  const background = ctx.createLinearGradient(0, 0, 980, layout.height);
  background.addColorStop(0, '#0e192b');
  background.addColorStop(0.67, '#102540');
  background.addColorStop(1, '#091321');
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  box(ctx, 36, 36, canvas.width - 72, canvas.height - 72, 34, null, '#83a8d643');
  orbit(ctx, format === 'vertical' ? 773 : 814, layout.orbitY);
  const shade = ctx.createLinearGradient(0, 0, 765, 0);
  shade.addColorStop(0, '#0b162440');
  shade.addColorStop(0.63, '#0b16244d');
  shade.addColorStop(1, '#0b162400');
  ctx.fillStyle = shade;
  ctx.fillRect(0, 36, 765, layout.height - 72);

  logo(ctx, left, layout.top);
  box(ctx, right - 167, layout.top - 45, 167, 48, 24, '#34527765', '#a0c6fa7f');
  text(ctx, card.tier === 'exclusive' ? 'EXCLUSIVE' : 'PRO', right - 83.5, layout.top - 13,
    {size:23, color:colors.blue, weight:750, align:'center'});

  text(ctx, 'ЗАКРЫТАЯ ИДЕЯ', left, layout.ticker - 92, {size:25, color:colors.blue, weight:750});
  text(ctx, card.ticker, left, layout.ticker, {size:71, weight:800, maxWidth:505});
  text(ctx, `${direction} · ${date.format(closed)} · ${time.format(closed)} МСК`, left, layout.ticker + 63,
    {size:29, color:colors.muted, maxWidth:690});
  text(ctx, resultText, left - 5, layout.result, {size:138, weight:800, color:resultColor, maxWidth:705});
  text(ctx, 'Расчётный результат', left + 2, layout.result + 65, {size:34, color:colors.muted});

  drawPrices(ctx, card, left, right, layout.stats);
  box(ctx, left, layout.footer, right - left, 234, 25, '#091625dc', '#7497c55d');
  text(ctx, 'Архив идей ORBITA', left + 34, layout.footer + 77, {size:41, weight:800, maxWidth:right - left - 290});
  text(ctx, url.hostname, left + 34, layout.footer + 137, {size:30, color:colors.blue, maxWidth:right - left - 290});
  text(ctx, 'Сканируйте QR, чтобы открыть архив', left + 34, layout.footer + 178,
    {size:21, color:colors.muted, maxWidth:right - left - 290});
  drawQr(ctx, url, right - 20, layout.footer + 117);
  text(ctx, 'Расчёт без комиссий и проскальзывания.', left, layout.note,
    {size:25, color:colors.muted, maxWidth:right - left});

  return `${card.ticker} · ${direction} · ${resultText} · закрыта ${date.format(closed)}`;
}
