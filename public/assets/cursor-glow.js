(() => {
  const enabled = matchMedia('(any-hover: hover) and (any-pointer: fine) and (prefers-reduced-motion: no-preference)');
  const radius = 36;
  let glow, frame = null, x = 0, y = 0;

  function hide() {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    if (glow) glow.hidden = true;
  }

  function paint() {
    frame = null;
    if (!glow) {
      glow = document.createElement('div');
      glow.id = 'cursor-glow';
      glow.setAttribute('aria-hidden', 'true');
      Object.assign(glow.style, {
        position: 'fixed',
        top: '0',
        left: '0',
        width: `${radius * 2}px`,
        height: `${radius * 2}px`,
        borderRadius: '50%',
        background: 'radial-gradient(circle, rgba(121, 169, 255, .23), rgba(121, 169, 255, .10) 38%, transparent 72%)',
        pointerEvents: 'none',
        zIndex: '1000',
      });
      document.body.append(glow);
    }
    glow.style.transform = `translate3d(${x - radius}px, ${y - radius}px, 0)`;
    glow.hidden = false;
  }

  window.addEventListener('pointermove', event => {
    if (!enabled.matches || event.pointerType !== 'mouse') {
      hide();
      return;
    }
    x = event.clientX;
    y = event.clientY;
    if (frame === null) frame = requestAnimationFrame(paint);
  }, { passive: true });

  document.documentElement.addEventListener('pointerleave', hide);
  document.addEventListener('visibilitychange', hide);
  window.addEventListener('blur', hide);
  window.addEventListener('pagehide', hide);
  enabled.addEventListener?.('change', hide);
})();
