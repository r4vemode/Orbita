(() => {
  // This module only adds document links. It does not collect or record consent.
  if (/\/admin\.html$/.test(location.pathname) || new URLSearchParams(location.search).has('embed')) return;
  const addFooter = () => {
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
    footer.innerHTML = '<p>ORBITA · Информационные и аналитические материалы.<br>Торговля связана с риском убытков.</p><nav class="orbita-legal-links" aria-label="Правовые документы"><a href="offer.html">Публичная оферта</a><a href="privacy.html">Конфиденциальность</a><a href="refunds.html">Возврат оплаты</a></nav>';
    document.body.append(footer);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', addFooter, { once: true });
  else addFooter();
})();
