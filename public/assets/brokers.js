const MARKET_INFO = Object.freeze({
  stocks: {
    title: 'Акции', heading: 'Брокер для акций', icon: '↗',
    description: 'Для сделок с акциями и спокойных позиций на несколько дней или недель.',
    features: ['Доступ к нужным акциям и торговым сессиям', 'Комиссии за сделки и обслуживание счёта', 'Условия выплаты дивидендов и хранения бумаг']
  },
  futures: {
    title: 'Фьючерсы', heading: 'Брокер для фьючерсов', icon: '⇄',
    description: 'Для срочного рынка: внутридневных идей и позиций с заранее определённым риском.',
    features: ['Доступ к срочному рынку и нужному контракту', 'Гарантийное обеспечение и стоимость переноса', 'Дата экспирации и правила исполнения']
  },
  crypto: {
    title: 'Крипто', heading: 'Криптовалютная биржа', icon: '◈',
    description: 'Для торговли цифровыми активами. Сравните доступность площадки и условия хранения средств.',
    features: ['Доступность биржи в вашей стране', 'Комиссии за сделки, ввод и вывод средств', 'Различия спота, деривативов и хранения активов']
  }
});

export function safePartnerUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' || url.username || url.password || !url.hostname) return null;
    return url.href;
  } catch { return null; }
}

export function normalisePartnerOffers(value) {
  if (!Array.isArray(value)) return [];
  return value.filter(offer => offer && typeof offer === 'object').map(offer => ({
    id: typeof offer.id === 'string' ? offer.id : '',
    name: typeof offer.name === 'string' ? offer.name.trim().slice(0, 100) : '',
    markets: Array.isArray(offer.markets) ? [...new Set(offer.markets.filter(market => Object.hasOwn(MARKET_INFO, market)))] : [],
    url: safePartnerUrl(offer.url)
  })).filter(offer => offer.markets.length);
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function card(offer, market) {
  const info = MARKET_INFO[market];
  const isActive = Boolean(offer?.name && offer?.url);
  const node = element('article', `partner-card${isActive ? '' : ' pending'}`);
  const top = element('div', 'partner-card-head');
  const icon = element('span', 'partner-market-icon', info.icon);
  icon.setAttribute('aria-hidden', 'true');
  top.append(icon, element('span', 'partner-card-label', isActive ? 'ПАРТНЁРСКОЕ РАЗМЕЩЕНИЕ' : 'ПРЕДЛОЖЕНИЯ СКОРО'));
  node.append(top, element('h3', '', offer?.name || info.heading), element('p', 'market-name', info.title), element('p', '', info.description));
  const list = element('ul', 'partner-features');
  info.features.forEach(feature => list.append(element('li', '', feature)));
  node.append(list);
  const link = element(isActive ? 'a' : 'button', 'partner-link', isActive ? 'Перейти к партнёру' : 'Предложения скоро');
  if (isActive) {
    link.href = offer.url;
    link.target = '_blank';
    link.rel = 'sponsored noopener noreferrer';
    link.setAttribute('aria-label', `Перейти к партнёру ${offer.name}, откроется в новой вкладке`);
    const arrow = element('span', '', '↗');
    arrow.setAttribute('aria-hidden', 'true');
    link.append(arrow);
  } else {
    link.type = 'button';
    link.disabled = true;
  }
  node.append(link);
  return node;
}

export async function initPartnersPage() {
  const offersNode = document.getElementById('partnerOffers');
  if (!offersNode) return;
  const parameters = new URLSearchParams(window.location.search);
  const requestedMarket = parameters.get('market');
  let selectedMarket = Object.hasOwn(MARKET_INFO, requestedMarket) ? requestedMarket : 'all';
  let offers = [], unavailable = false;
  try {
    const response = await fetch('/api/product-settings', {cache:'no-store'});
    if (!response.ok) throw Error();
    offers = normalisePartnerOffers((await response.json()).partnerOffers);
  } catch { unavailable = true; }
  const filters = [...document.querySelectorAll('[data-market]')];

  function render() {
    const markets = selectedMarket === 'all' ? Object.keys(MARKET_INFO) : [selectedMarket];
    offersNode.replaceChildren();
    let activeCount = 0;
    markets.forEach(market => {
      const matches = offers.filter(offer => offer.markets.includes(market) && offer.name && offer.url);
      if (matches.length) {
        activeCount += matches.length;
        matches.forEach(offer => offersNode.append(card(offer, market)));
      } else {
        const draft = offers.find(offer => offer.markets.includes(market));
        offersNode.append(card(draft, market));
      }
    });
    filters.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.market === selectedMarket)));
    const status = document.getElementById('offersStatus');
    status.textContent = unavailable ? 'Не удалось загрузить предложения. Обновите страницу, чтобы повторить.' : activeCount
      ? 'Сравните условия на сайте партнёра перед открытием счёта.'
      : 'Подбираем партнёров для этого рынка. Предложения появятся здесь.';
  }

  filters.forEach(button => button.addEventListener('click', () => {
    const market = button.dataset.market;
    if (market !== 'all' && !Object.hasOwn(MARKET_INFO, market)) return;
    selectedMarket = market;
    const url = new URL(window.location.href);
    if (market === 'all') url.searchParams.delete('market');
    else url.searchParams.set('market', market);
    window.history.replaceState(null, '', url.href);
    render();
  }));

  if (parameters.get('settings') === '1') {
    const response = await fetch('/api/me', {cache:'no-store'}).catch(() => null);
    const user = response?.ok ? (await response.json()).user : null;
    if (user?.access?.isAdmin) {
      const link = element('a', 'guide-link', 'Настроить общие партнёрские ссылки →');
      link.href = 'settings-admin.html#partners';
      offersNode.before(link);
    }
  }
  render();
}

if (typeof document !== 'undefined') initPartnersPage();
