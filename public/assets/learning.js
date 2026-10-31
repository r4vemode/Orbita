(async () => {
  await window.ORBITA_LESSONS_READY;
  const lessons = window.ORBITA_LESSONS;
  const $ = id => document.getElementById(id);
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const account = await OrbitaAccess.current();
  if (!account) { location.replace('account.html?next=%2Flearn.html'); return; }
  let invalidated=false;
  const session=OrbitaMemberSession.watch(account,next=>{
    invalidated=true;lessons.splice(0);window.ORBITA_LESSONS=[];if($('article').open)$('article').close();$('articleBody').replaceChildren();$('lessons').replaceChildren();document.querySelector('main').hidden=true;
    location.replace(!next?'account.html?next=%2Flearn.html':!next.access?.hasSubscription?'subscriptions.html':location.pathname+location.search);
  });
  if(!await session.check())return;
  const key = 'orbita.learning.v2.' + account.id;
  let read = new Set(), category = 'Все темы', selected = 0, articleOrigin = null;
  try {
    const saved = JSON.parse(localStorage.getItem(key) || '[]');
    if (Array.isArray(saved)) read = new Set(saved.filter(id => lessons.some(l => l.id === id)));
  } catch {}
  const sources = {
    short: ['Механика коротких продаж · Investor.gov', 'https://www.investor.gov/introduction-investing/investing-basics/how-stock-markets-work/stock-purchases-and-sales-long-and'],
    orders: ['Типы заявок · Investor.gov', 'https://www.investor.gov/introduction-investing/investing-basics/how-stock-markets-work/types-orders'],
    leverage: ['Маржинальные счета · Investor.gov', 'https://www.investor.gov/introduction-investing/general-resources/news-alerts/alerts-bulletins/investor-bulletins-29']
  };
  $('categories').innerHTML = ['Все темы', ...new Set(lessons.map(l => l.category))].map(c => `<button aria-pressed="${c === category}" data-category="${esc(c)}">${esc(c)}</button>`).join('');
  $('progressBar').max = Math.max(1, lessons.length);

  function render() {
    if(invalidated)return;
    const query = $('search').value.trim().toLocaleLowerCase('ru');
    const rows = lessons.filter(l => (category === 'Все темы' || l.category === category) && [l.title, l.intro, ...l.sections.map(s => s.title + ' ' + s.text)].join(' ').toLocaleLowerCase('ru').includes(query));
    $('lessons').innerHTML = rows.map(l => `<button class="lesson-card" data-lesson="${esc(l.id)}"><span class="lesson-meta"><span>${esc(l.category)}</span><span>${String(lessons.indexOf(l) + 1).padStart(2, '0')} / ${String(lessons.length).padStart(2, '0')}</span></span><h2>${esc(l.title)}</h2><p>${esc(l.intro)}</p><span class="lesson-bottom"><span>${read.has(l.id) ? '✓ Прочитано' : 'Открыть материал'}</span><span aria-hidden="true">↗</span></span></button>`).join('');
    $('empty').hidden = !!rows.length;
    $('empty').textContent = lessons.length ? 'Ничего не найдено. Попробуйте другой запрос или раздел.' : 'Автор готовит материалы для вашей подписки. Тренажёр уже доступен выше.';
    $('resultCount').textContent = `Тем: ${rows.length}`;
    $('progress').textContent = `${read.size} из ${lessons.length} тем прочитано · на этом устройстве`;
    $('progressBar').value = read.size;
  }

  function setArticleUrl(id) {
    const url = new URL(location.href);
    if (id) url.searchParams.set('lesson', id);
    else url.searchParams.delete('lesson');
    url.hash = '';
    history.replaceState(null, '', url.pathname + url.search + url.hash);
  }

  function open(id, update = true) {
    if(invalidated)return;
    const index = lessons.findIndex(l => l.id === id);
    if (index < 0) { if (id) $('resultCount').textContent = 'Этот материал снят с публикации или недоступен по вашей подписке. Выберите другую тему.'; return; }
    selected = index;
    const lesson = lessons[index];
    if (!$('article').open) articleOrigin = document.activeElement?.closest('[data-lesson]')?.dataset.lesson || id;
    $('articleCategory').textContent = lesson.category + (lesson.access === 'exclusive' ? ' · EXCLUSIVE' : '') + ' / ' + String(index + 1).padStart(2, '0');
    $('articleBody').innerHTML = `<h1 id="articleTitle">${esc(lesson.title)}</h1><p class="article-lead">${esc(lesson.intro)}</p>` + lesson.sections.map(s => `<section><h2>${esc(s.title)}</h2><p>${esc(s.text)}</p></section>`).join('') + (sources[id] ? `<p class="article-source"><a href="${sources[id][1]}" target="_blank" rel="noopener noreferrer">${sources[id][0]} ↗</a></p>` : '');
    $('markRead').textContent = read.has(id) ? '✓ Прочитано' : 'Отметить прочитанным';
    $('markRead').disabled = read.has(id);
    $('nextArticle').disabled = index === lessons.length - 1;
    if (!$('article').open) $('article').showModal();
    $('article').scrollTop = 0;
    $('closeArticle').focus();
    if (update) setArticleUrl(id);
  }

  $('lessons').onclick = event => {
    const button = event.target.closest('[data-lesson]');
    if (button) open(button.dataset.lesson);
  };
  $('categories').onclick = event => {
    const button = event.target.closest('[data-category]');
    if (!button) return;
    category = button.dataset.category;
    document.querySelectorAll('[data-category]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
    render();
  };
  $('search').oninput = render;
  $('closeArticle').onclick = () => $('article').close();
  $('article').addEventListener('close', () => {
    setArticleUrl(null);
    const cards = [...$('lessons').querySelectorAll('[data-lesson]')];
    (cards.find(card => card.dataset.lesson === articleOrigin) || cards[0] || $('search')).focus();
    articleOrigin = null;
  });
  $('article').onclick = event => {
    if (event.target !== $('article')) return;
    const rect = event.target.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) event.target.close();
  };
  $('markRead').onclick = () => {
    read.add(lessons[selected].id);
    try { localStorage.setItem(key, JSON.stringify([...read])); } catch {}
    render();
    $('markRead').textContent = '✓ Прочитано';
    $('markRead').disabled = true;
  };
  $('nextArticle').onclick = () => {
    if (selected + 1 < lessons.length) open(lessons[selected + 1].id);
  };
  const openFromLocation = () => open(new URLSearchParams(location.search).get('lesson') || location.hash.slice(1), false);
  window.addEventListener('hashchange', openFromLocation);
  window.addEventListener('popstate', openFromLocation);
  render();
  openFromLocation();
})().catch(error=>{const node=document.getElementById('resultCount');if(node){node.textContent=error.message+' ';const retry=document.createElement('button');retry.type='button';retry.textContent='Повторить загрузку';retry.onclick=()=>location.reload();node.append(retry);}const progress=document.getElementById('progress');if(progress)progress.textContent='Материалы пока не загружены';});
