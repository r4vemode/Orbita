(() => { const box = document.getElementById('radarGuide'), hide = document.getElementById('radarGuideHide'); if (!box || !hide) return;
  try { if (localStorage.getItem('orbita.radar.guide.hidden') === '1') box.open = false; } catch {}
  hide.addEventListener('click', () => { box.open = false; try { localStorage.setItem('orbita.radar.guide.hidden', '1'); } catch {} }); })();
