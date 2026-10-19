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
const STORAGE_KEY = 'orbita.partnerOffers.v1';

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

function readOffers(fallback) {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved !== null) {
      const parsed = JSON.parse(saved);
      if (Array.isArray(parsed)) return normalisePartnerOffers(parsed);
    }
  } catch { /* Fall back to the shared configuration if storage is unavailable. */ }
  return normalisePartnerOffers(fallback);
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

export function initPartnersPage() {
  const offersNode = document.getElementById('partnerOffers');
  if (!offersNode) return;
  const parameters = new URLSearchParams(window.location.search);
  const requestedMarket = parameters.get('market');
  let selectedMarket = Object.hasOwn(MARKET_INFO, requestedMarket) ? requestedMarket : 'all';
  let offers = readOffers(window.ORBITA_PARTNER_OFFERS);
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
    status.textContent = activeCount
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

  const settings = document.getElementById('partnerSettings');
  if (parameters.get('settings') === '1' && settings) {
    settings.hidden = false;
    const fields = document.getElementById('partnerFields');
    Object.entries(MARKET_INFO).forEach(([market, info]) => {
      const group = element('fieldset');
      group.append(element('legend', '', info.title));
      for (const [field, title, type] of [['name', 'Название брокера или биржи', 'text'], ['url', 'Партнёрская HTTPS-ссылка', 'url']]) {
        const label = element('label', '', title);
        const input = element('input');
        input.name = `${market}-${field}`;
        input.id = `partner-${market}-${field}`;
        input.type = type;
        input.autocomplete = 'off';
        input.maxLength = field === 'name' ? 100 : 2048;
        if (field === 'url') { input.spellcheck = false; input.inputMode = 'url'; }
        label.append(input);
        group.append(label);
      }
      fields.append(group);
    });

    function fillFields() {
      Object.keys(MARKET_INFO).forEach(market => {
        const offer = offers.find(item => item.markets.includes(market));
        document.getElementById(`partner-${market}-name`).value = offer?.name || '';
        document.getElementById(`partner-${market}-url`).value = offer?.url || '';
      });
    }
    const message = document.getElementById('partnerSettingsMessage');
    function feedback(text, isError = false) {
      message.textContent = text;
      message.classList.toggle('error', isError);
    }
    document.getElementById('partnerSettingsForm').addEventListener('submit', event => {
      event.preventDefault();
      let invalidInput = null;
      const nextOffers = Object.keys(MARKET_INFO).map(market => {
        const nameInput = document.getElementById(`partner-${market}-name`);
        const urlInput = document.getElementById(`partner-${market}-url`);
        const name = nameInput.value.trim();
        const value = urlInput.value.trim();
        const url = safePartnerUrl(value);
        nameInput.removeAttribute('aria-invalid');
        urlInput.removeAttribute('aria-invalid');
        if (value && !url) { urlInput.setAttribute('aria-invalid', 'true'); invalidInput ||= urlInput; }
        if (value && !name) { nameInput.setAttribute('aria-invalid', 'true'); invalidInput ||= nameInput; }
        return { id: market, markets: [market], name, url: url || '' };
      });
      if (invalidInput) {
        feedback('Укажите название и полную HTTPS-ссылку без логина и пароля. Незаполненные предложения можно оставить пустыми.', true);
        invalidInput.focus();
        return;
      }
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(nextOffers));
      } catch {
        feedback('Браузер не разрешил сохранить настройки. Разрешите локальное хранилище и попробуйте снова.', true);
        return;
      }
      offers = normalisePartnerOffers(nextOffers);
      render();
      feedback('Ссылки сохранены в этом браузере. Предложения с заполненными названием и ссылкой уже доступны.');
    });
    document.getElementById('resetPartnerSettings').addEventListener('click', () => {
      try { localStorage.removeItem(STORAGE_KEY); }
      catch { feedback('Браузер не разрешил сбросить настройки.', true); return; }
      offers = normalisePartnerOffers(window.ORBITA_PARTNER_OFFERS);
      fillFields();
      render();
      feedback('Общие настройки восстановлены.');
    });
    fillFields();
  }
  render();
}

if (typeof document !== 'undefined') initPartnersPage();
