/* Applies the colour theme before the first paint (loaded synchronously in <head>).
   Preference: 'dark' (default, the brand look) | 'light' | 'system', stored on this device. */
(() => {
  const KEY = 'orbita.theme', root = document.documentElement, media = matchMedia('(prefers-color-scheme: light)');
  const read = () => { try { const v = localStorage.getItem(KEY); return ['light', 'dark', 'system'].includes(v) ? v : 'dark'; } catch { return 'dark'; } };
  function apply(pref = read()) {
    const theme = pref === 'system' ? (media.matches ? 'light' : 'dark') : pref;
    root.dataset.theme = theme; root.dataset.themePref = pref; root.style.colorScheme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'light' ? '#f5f7fb' : '#0f141f');
    document.querySelectorAll('[data-theme-toggle]').forEach(paint);
    return theme;
  }
  const labels = { system: 'Тема: как в системе', light: 'Тема: светлая', dark: 'Тема: тёмная' }, order = ['dark', 'light', 'system'];
  function paint(button) { const pref = read(); button.textContent = labels[pref]; button.setAttribute('aria-label', labels[pref] + '. Нажмите, чтобы сменить'); }
  function toggle() { const next = order[(order.indexOf(read()) + 1) % order.length]; try { localStorage.setItem(KEY, next); } catch {} apply(next); }
  function button() { const b = document.createElement('button'); b.type = 'button'; b.className = 'theme-toggle'; b.dataset.themeToggle = ''; b.addEventListener('click', toggle); paint(b); return b; }
  media.addEventListener?.('change', () => { if (read() === 'system') apply(); });
  addEventListener('storage', e => { if (e.key === KEY) apply(); });
  apply();
  // Place the switch: in the App Shell account block, or in an admin page header.
  addEventListener('DOMContentLoaded', () => {
    if (document.querySelector('[data-theme-toggle]')) return;
    const shell = document.querySelector('.shell-account'), header = document.querySelector('body > header nav, body > header');
    if (shell) shell.insertBefore(button(), shell.querySelector('.shell-logout')); else if (header) header.append(button());
    else { const b = button(); b.classList.add('floating'); document.body.append(b); }
  });
  window.OrbitaTheme = { apply, toggle, read };
})();
