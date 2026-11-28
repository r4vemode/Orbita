import {drawResultCard, shareLink} from './result-share-card.js';

const fontSample = 'ORBITA SBER 0123456789 Средняя цена выхода Расчётный результат';

export function createResultShare(dialog, request) {
  const find = selector => dialog.querySelector(selector);
  const canvas = find('canvas');
  const format = find('#resultShareFormat');
  const channel = find('#resultShareChannel');
  const status = find('#resultShareStatus');
  const link = find('#resultShareLink');
  const copy = find('#resultShareCopy');
  const download = find('#resultShareDownload');
  let ideaId = null, card = null, busy = false, revision = 0;

  function setStatus(message='', error=false) {
    status.textContent = message;
    status.classList.toggle('is-error', error);
  }

  function controls() {
    for (const field of [format,channel]) field.disabled = busy || !card;
    for (const button of [copy,download]) button.disabled = busy || !link.value;
  }

  function clearPreview() {
    canvas.hidden = true;
    canvas.width = canvas.height = 1;
    canvas.removeAttribute('aria-label');
    link.value = '';
  }

  function clear() {
    revision++;
    ideaId = card = null;
    busy = false;
    clearPreview();
    setStatus();
    controls();
  }

  function refreshPreview() {
    if (!card) return;
    const url = shareLink(card.publicOrigin, channel.value);
    const label = drawResultCard(canvas, card, url, format.value);
    canvas.hidden = false;
    canvas.setAttribute('aria-label', label);
    link.value = url.href;
    link.scrollLeft = 0;
    controls();
  }

  function loadCard(id) {
    return request('/api/admin/ideas/' + encodeURIComponent(id) + '/share-card').then(result => result.card);
  }

  async function open(id) {
    if (dialog.open) return;
    clear();
    const token = revision;
    ideaId = id;
    busy = true;
    controls();
    setStatus('Готовим карточку…');
    dialog.showModal();
    try {
      const [source] = await Promise.all([
        loadCard(id),
        document.fonts?.load('800 48px Manrope', fontSample).catch(() => {})
      ]);
      if (revision !== token) return;
      card = source;
      refreshPreview();
      setStatus();
    } catch (err) {
      if (revision === token) {
        card = null;
        clearPreview();
        setStatus(err.message || 'Не удалось подготовить карточку.', true);
      }
    } finally {
      if (revision === token) { busy = false; controls(); }
    }
  }

  function close() {
    clear();
    if (dialog.open) dialog.close();
  }

  dialog.addEventListener('cancel', event => {
    event.preventDefault();
    close();
  });
  find('#resultShareClose').addEventListener('click', close);
  for (const field of [format,channel]) {
    field.addEventListener('change', () => {
      try {
        refreshPreview();
        setStatus();
      } catch (err) {
        clearPreview();
        controls();
        setStatus(err.message || 'Не удалось обновить карточку.', true);
      }
    });
  }

  copy.addEventListener('click', async () => {
    const value = link.value;
    const token = revision;
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      if (revision === token && link.value === value) setStatus('Ссылка скопирована.');
    } catch {
      if (revision !== token || link.value !== value) return;
      link.focus();
      link.select();
      setStatus('Скопируйте выделенную ссылку.');
    }
  });

  download.addEventListener('click', async () => {
    if (busy || !ideaId || !card || !link.value) return;
    const token = revision;
    busy = true;
    controls();
    setStatus('Проверяем результат и готовим PNG…');
    try {
      const fresh = await loadCard(ideaId);
      if (revision !== token) return;
      if (JSON.stringify(fresh) !== JSON.stringify(card)) {
        card = fresh;
        refreshPreview();
        setStatus('Данные идеи обновились. Проверьте карточку перед скачиванием.');
        return;
      }
      const png = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
      if (revision !== token) return;
      if (!png) throw new Error('Браузер не смог сохранить PNG.');
      const url = URL.createObjectURL(png);
      const file = document.createElement('a');
      const ticker = card.ticker.replace(/[^\p{L}\p{N}_-]+/gu, '-');
      file.href = url;
      file.download = `ORBITA-${ticker}-${canvas.width}x${canvas.height}.png`;
      dialog.appendChild(file).click();
      file.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      setStatus('PNG скачивается.');
    } catch (err) {
      if (revision === token) {
        card = null;
        clearPreview();
        setStatus(err.message || 'Не удалось скачать PNG. Откройте карточку заново.', true);
      }
    } finally {
      if (revision === token) { busy = false; controls(); }
    }
  });

  window.addEventListener('pagehide', close);
  return {open, close};
}
