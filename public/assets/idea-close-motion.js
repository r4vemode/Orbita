(() => {
  'use strict';

  const flights = new Map();
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const limit = 8;
  const sourceSelector = ':scope > .irow-main';
  const percent = new Intl.NumberFormat('ru-RU', {maximumFractionDigits:2, signDisplay:'exceptZero'});

  function cancel() {
    for (const flight of flights.values()) flight.cancel();
  }

  function flightPreview(card, source) {
    const preview = source.cloneNode(true);
    for (const node of [preview, ...preview.querySelectorAll('[id], [data-id], [data-idea]')]) {
      node.removeAttribute('id');
      node.removeAttribute('data-id');
      node.removeAttribute('data-idea');
    }
    if (card === source) return preview;
    const row = card.cloneNode(false);
    row.removeAttribute('id');
    row.removeAttribute('data-id');
    row.append(preview);
    return row;
  }

  function fly(card, target, pct) {
    if (document.hidden || reducedMotion.matches || flights.size >= limit || flights.has(card) ||
        !card?.isConnected || typeof card.animate !== 'function') return Promise.resolve();

    const source = card.querySelector(sourceSelector) || card;
    const from = source.getBoundingClientRect();
    const {innerWidth:width, innerHeight:height} = window;
    if (!from.width || !from.height ||
        from.bottom <= 0 || from.top >= height || from.right <= 0 || from.left >= width ||
        getComputedStyle(source).visibility !== 'visible') {
      return Promise.resolve();
    }

    let destination = {transform:'scale(1)', opacity:0, offset:1};
    let duration = 420;
    const to = target?.isConnected ? target.getBoundingClientRect() : null;
    if (to?.width && to.height && getComputedStyle(target).visibility === 'visible') {
      const centerX = Math.max(12, Math.min(width - 12, to.left + to.width / 2));
      const centerY = Math.max(12, Math.min(height - 12, to.top + to.height / 2));
      const dx = centerX - (from.left + from.width / 2);
      const dy = centerY - (from.top + from.height / 2);
      destination = {transform:`translate(${dx}px, ${dy}px) scale(.07)`, opacity:.14, offset:1};
      duration = 660;
    }
    const overlay = document.createElement('div');
    overlay.className = 'idea-close-flight';
    overlay.dataset.outcome = pct >= 0.005 ? 'positive' : pct <= -0.005 ? 'negative' : 'neutral';
    overlay.inert = true;
    overlay.setAttribute('aria-hidden', 'true');
    Object.assign(overlay.style, {
      left: `${from.left}px`,
      top: `${from.top}px`,
      width: `${from.width}px`,
      height: `${from.height}px`,
      borderRadius: getComputedStyle(source).borderRadius
    });
    overlay.append(flightPreview(card, source));
    if (Number.isFinite(pct)) {
      const result = document.createElement('span');
      result.className = 'idea-close-flight-result';
      result.textContent = percent.format(pct).replace('-', '−') + '%';
      overlay.append(result);
    }
    document.body.append(overlay);
    source.classList.add('idea-close-source');

    const animation = overlay.animate([
      {transform:'scale(1)', opacity:1, offset:0},
      {transform:'scale(1.012)', opacity:1, offset:0.31, easing:'cubic-bezier(.48,.01,.4,1)'},
      destination
    ], {duration, delay:flights.size * 36, fill:'both'});

    let finished = false;
    function cleanup() {
      if (finished) return;
      finished = true;
      flights.delete(card);
      source.classList.remove('idea-close-source');
      overlay.remove();
    }
    flights.set(card,{cancel(){animation.cancel();cleanup();}});
    return animation.finished.then(cleanup, cleanup);
  }

  reducedMotion.addEventListener?.('change', event => { if (event.matches) cancel(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) cancel(); });
  window.addEventListener('pagehide', cancel);
  window.OrbitaIdeaCloseMotion = Object.freeze({fly,cancel});
})();
