(() => {
  'use strict';

  function watch(load, interval) {
    let stream = null, timer = null, running = null, pending = false, eligible = false, stopped = false;

    function closeStream() {
      stream?.close();
      stream = null;
      window.OrbitaIdeaCloseMotion?.cancel();
    }

    function setEligible(value) {
      eligible = value;
      if (!eligible) { closeStream(); return; }
      if (stream || stopped || document.hidden || typeof EventSource !== 'function') return;
      const source = new EventSource('/api/ideas/stream');
      stream = source;
      const update = () => { if (stream === source) void refresh(); };
      source.addEventListener('ready', update);
      source.addEventListener('ideas-update', update);
      source.addEventListener('error', () => {
        if (stream === source && source.readyState === 2) closeStream();
      });
    }

    function refresh() {
      if (stopped || document.hidden) return;
      if (running) { pending = true; return running; }
      clearTimeout(timer);
      running = Promise.resolve().then(load).finally(() => {
        running = null;
        if (stopped || document.hidden) return;
        setEligible(eligible);
        if (pending) { pending = false; void refresh(); }
        else timer = setTimeout(refresh, interval);
      });
      return running;
    }

    function onVisibility() {
      if (!document.hidden) { void refresh(); return; }
      clearTimeout(timer);
      closeStream();
    }

    function onPageHide(event) {
      clearTimeout(timer);
      closeStream();
      if (!event.persisted) stop();
    }

    function onPageShow(event) { if (event.persisted) void refresh(); }

    function stop() {
      stopped = true;
      clearTimeout(timer);
      closeStream();
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('pageshow', onPageShow);
    }

    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('pageshow', onPageShow);
    if (!document.hidden) timer = setTimeout(refresh, interval);
    return { refresh, setEligible, stop };
  }

  function showUnread(button, count) {
    const badge = button.querySelector('.idea-close-count');
    badge.textContent = count ? String(count) : '';
    badge.hidden = !count;
    if (count) button.setAttribute('aria-label', 'История, новых закрытий: ' + count);
    else button.removeAttribute('aria-label');
  }

  window.OrbitaIdeaFeedLive = { watch, showUnread };
})();
