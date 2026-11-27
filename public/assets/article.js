(() => {
  'use strict';
  const status = document.getElementById('articleStatus');
  const article = document.getElementById('articleBody');
  const id = new URLSearchParams(location.search).get('id');
  const validId = /^[A-Za-z0-9_-]{1,100}$/.test(id || '');
  const dateFormat = new Intl.DateTimeFormat('ru-RU', {dateStyle: 'long', timeStyle: 'short', timeZone: 'Europe/Moscow'});
  const topics = {stocks: 'Акции', crypto: 'Криптовалюты', macro: 'Макро'};
  let request, privateMaterial = false, revision;

  function element(tag, text) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function urlLink(href, label) {
    const link = element('a', label);
    link.href = href;
    return link;
  }

  function externalLink(value, label) {
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' || url.username || url.password) return null;
      const link = urlLink(url.href, label || url.hostname);
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      return link;
    } catch {
      return null;
    }
  }

  function showStatus(heading, detail, action) {
    document.title = 'ORBITA · Материал';
    article.replaceChildren();
    article.hidden = true;
    privateMaterial = false;
    revision = undefined;
    status.replaceChildren(element('h1', heading), element('p', detail));
    if (action) status.append(action);
    status.hidden = false;
  }

  function render(lesson) {
    const updated = lesson.updatedAt + '|' + lesson.access + '|' + lesson.publication?.id;
    if (revision === updated && !article.hidden) return;
    const title = element('h1', lesson.title);
    title.id = 'articleTitle';
    const category = lesson.kind === 'news' ? topics[lesson.category] || lesson.category : lesson.category;
    const label = [lesson.kind === 'news' ? 'Новость' : 'Статья', category, ...(lesson.tickers || [])];
    const meta = element('p', label.join(' · '));
    meta.className = 'legal-meta';
    const publishedAt = lesson.publication?.publishedAt;
    if (publishedAt && Number.isFinite(Date.parse(publishedAt))) {
      const time = element('time', dateFormat.format(new Date(publishedAt)) + ' МСК');
      time.dateTime = publishedAt;
      meta.append(' · ', time);
    }
    const sections = lesson.sections.map(section => {
      const node = element('section');
      node.append(element('h2', section.title));
      for (const text of section.text.split(/\r?\n/)) {
        if (text.trim()) node.append(element('p', text));
      }
      return node;
    });
    const sources = (lesson.sources || []).map(source => externalLink(source)).filter(Boolean);
    const attachment = externalLink(lesson.attachmentUrl, 'Открыть вложение ↗');
    const references = [];
    if (sources.length) {
      const list = element('ul');
      for (const link of sources) {
        const item = element('li');
        item.append(link);
        list.append(item);
      }
      references.push(element('h2', 'Источники'), list);
    }
    if (attachment) references.push(attachment);
    document.title = `${lesson.title} · ORBITA`;
    article.replaceChildren(meta, title, element('p', lesson.intro), ...sections, ...references);
    privateMaterial = lesson.access !== 'public';
    revision = updated;
    status.hidden = true;
    article.hidden = false;
  }

  async function load() {
    if (request) return;
    if (!validId) {
      showStatus('Материал недоступен', 'Проверьте ссылку или откройте раздел материалов.');
      return;
    }
    const controller = new AbortController();
    request = controller;
    const timeout = setTimeout(() => controller.abort(), 10000);
    const options = {cache: 'no-store', credentials: 'same-origin', signal: controller.signal};
    try {
      const response = await fetch('/api/articles/' + encodeURIComponent(id), options);
      if ([401, 403, 404].includes(response.status)) {
        const next = encodeURIComponent('/article.html?id=' + id);
        const profile = await fetch('/api/me', options);
        const user = profile.ok ? (await profile.json()).user : null;
        const action = user
          ? urlLink('/subscriptions.html?next=' + next, 'Проверить подписку →')
          : urlLink('/account.html?next=' + next, 'Войти в ORBITA →');
        showStatus('Материал недоступен', 'Проверьте подписку или уточните, опубликован ли материал.', action);
        return;
      }
      if (!response.ok) throw Error('Article unavailable');
      const {lesson} = await response.json();
      if (lesson?.id !== id || !Array.isArray(lesson.sections)) throw Error('Invalid article response');
      if (!document.hidden || lesson.access === 'public') render(lesson);
    } catch {
      const retry = element('button', 'Повторить загрузку');
      retry.type = 'button';
      retry.addEventListener('click', load);
      showStatus('Не удалось загрузить материал', 'Обновите страницу или повторите загрузку.', retry);
    } finally {
      clearTimeout(timeout);
      request = null;
    }
  }

  function hidePrivateMaterial() {
    if (!privateMaterial) return;
    article.replaceChildren();
    article.hidden = true;
    document.title = 'ORBITA · Материал';
    status.textContent = 'Проверяем доступ…';
    status.hidden = false;
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) hidePrivateMaterial();
    else void load();
  });
  setInterval(() => {
    if (privateMaterial && !document.hidden) void load();
  }, 30000);
  window.addEventListener('pagehide', hidePrivateMaterial);
  window.addEventListener('pageshow', event => {
    if (event.persisted) void load();
  });
  void load();
})();
