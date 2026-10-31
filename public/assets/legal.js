(() => {
  // This module only adds document links. It does not collect or record consent.
  if (/\/admin\.html$/.test(location.pathname) || new URLSearchParams(location.search).has('embed')) return;
  const addFooter = () => {
    const existing = document.querySelector('[data-orbita-legal]');
    if (existing && !existing.querySelector('a[href="guide.html"]')) {
      const link = document.createElement('a'); link.href = 'guide.html'; link.textContent = 'С чего начать и помощь';
      (existing.querySelector('nav') || existing).append(link);
    }
    if (existing && !existing.querySelector('a[href^="support.html"]')) {
      const link = document.createElement('a'); link.href = 'support.html?from=' + encodeURIComponent(location.pathname); link.textContent = 'Обратиться в поддержку';
      (existing.querySelector('nav') || existing).append(link);
    }
    if (document.querySelector('[data-orbita-legal]')) return;
    if (!document.querySelector('link[data-orbita-legal-style], link[href$="assets/legal.css"]')) {
      const stylesheet = document.createElement('link');
      stylesheet.rel = 'stylesheet';
      stylesheet.href = 'assets/legal.css';
      stylesheet.dataset.orbitaLegalStyle = '';
      document.head.append(stylesheet);
    }
    const footer = document.createElement('footer');
    footer.className = 'orbita-legal-footer';
    footer.dataset.orbitaLegal = '';
    footer.innerHTML = '<p>ORBITA · Информационные и аналитические материалы.<br>Торговля связана с риском убытков.</p><nav class="orbita-legal-links" aria-label="Правовые документы"><a href="guide.html">С чего начать и помощь</a><a href="support.html">Обратиться в поддержку</a><a href="offer.html">Публичная оферта</a><a href="privacy.html">Конфиденциальность</a><a href="refunds.html">Возврат оплаты</a></nav>';
    footer.querySelector('a[href="support.html"]').href = 'support.html?from=' + encodeURIComponent(location.pathname);
    document.body.append(footer);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', addFooter, { once: true });
  else addFooter();
})();
