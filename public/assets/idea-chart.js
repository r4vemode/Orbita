/* Deterministic schematic chart for a trade idea.
   - The shape is a stylised scenario, never presented as price history: every
     chart carries the caption "Схема" and an accessible description saying so.
   - The pattern and noise come from a seeded PRNG keyed by the idea id, so a
     given idea keeps the same drawing across reloads and devices.
   - The vertical scale always contains entry, stop and every target. */
(() => {
  'use strict';
  const PATTERNS = {
    long: [['trend', 'Восходящий тренд с коррекциями'], ['breakout', 'Пробой сопротивления'], ['range', 'Консолидация с выходом вверх'], ['bounce', 'Отскок от поддержки']],
    short: [['trend', 'Нисходящий тренд с отскоками'], ['breakout', 'Пробой поддержки'], ['range', 'Консолидация с выходом вниз'], ['bounce', 'Отскок от сопротивления']]
  };
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = v => Number(v).toLocaleString('ru-RU', { maximumFractionDigits: 8 });
  const ok = v => typeof v === 'number' && Number.isFinite(v) && v > 0;
  // FNV-1a hash → mulberry32 PRNG: stable across browsers.
  function seed(text) { let h = 2166136261; for (const ch of String(text)) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
  function rng(s) { return () => { s |= 0; s = s + 0x6D2B79F5 | 0; let t = Math.imul(s ^ s >>> 15, 1 | s); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  function pattern(record) { const dir = record.d?.dir === 'ШОРТ' ? 'short' : 'long', list = PATTERNS[dir]; return { dir, key: list[seed(record.id) % list.length][0], label: list[seed(record.id) % list.length][1] }; }
  // Builds a pre-entry path in "level units": 0 = entry, −1 = stop distance.
  // Values are expressed for LONG and mirrored for SHORT.
  function scenario(key, random, n) {
    const out = [], noise = a => (random() - .5) * a;
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1); let v;
      if (key === 'trend') v = -2.2 + 2.2 * t + Math.sin(t * Math.PI * 3.2) * .35 * (1 - t * .4) + noise(.22);
      else if (key === 'breakout') v = t < .78 ? -.55 + Math.sin(t * Math.PI * 4.5) * .38 + noise(.16) - .05 : -.2 + (t - .78) / .22 * .2 + noise(.08);
      else if (key === 'range') v = t < .72 ? -.6 + Math.sin(t * Math.PI * 6) * .28 + noise(.12) : -.6 + (t - .72) / .28 * .6 + noise(.1);
      else v = t < .55 ? -.1 - t / .55 * .8 + noise(.18) : -.9 + (t - .55) / .45 * .9 + Math.sin(t * 14) * .05 + noise(.12);
      out.push(v);
    }
    out[n - 1] = 0; return out;
  }
  function svg(record, { compact = false, width = compact ? 320 : 640, height = compact ? 132 : 260 } = {}) {
    if (window.OrbitaFormations && record.d) return `<figure class="idea-chart${compact ? ' compact' : ''}">${OrbitaFormations.svg(record, { compact, width, height: compact ? height : 300 })}</figure>`;
    const d = record.d || {}, targets = [d.target, ...(Array.isArray(d.targets) ? d.targets : [])].filter(ok);
    const levels = ok(d.entry) && ok(d.stop) && targets.length > 0, long = d.dir !== 'ШОРТ';
    if (!levels || (long ? !(d.stop < d.entry && d.entry < targets[0]) : !(targets[0] < d.entry && d.entry < d.stop))) {
      return `<div class="idea-chart idea-chart-empty" role="img" aria-label="Уровни ещё не опубликованы"><span>${long ? 'LONG' : 'SHORT'} · уровни будут опубликованы автором</span></div>`;
    }
    const { key, label } = pattern(record), random = rng(seed(record.id + ':' + key)), n = compact ? 28 : 44;
    const risk = Math.abs(d.entry - d.stop), sign = long ? 1 : -1;
    const pre = scenario(key, random, n).map(v => d.entry + sign * v * risk);
    const values = [...pre, d.entry, d.stop, ...targets];
    const lo = Math.min(...values), hi = Math.max(...values), pad = (hi - lo) * .08 || d.entry * .002;
    const top = 10, bottom = height - (compact ? 14 : 22), labelW = compact ? 0 : 128, left = 6, right = width - labelW - 8;
    const y = v => top + (hi + pad - v) / (hi - lo + 2 * pad) * (bottom - top);
    const splitX = left + (right - left) * .62, x = i => left + i / (n - 1) * (splitX - left);
    const path = pre.map((v, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(v).toFixed(1)).join('');
    const lines = [['entry', 'Вход', d.entry], ['stop', 'Стоп', d.stop], ...targets.map((t, i) => ['target', targets.length > 1 ? 'Цель ' + (i + 1) : 'Цель', t])];
    // Keep right-hand labels from overlapping.
    const labels = lines.map(([cls, name, v]) => ({ cls, name, v, y: y(v) })).sort((a, b) => a.y - b.y);
    labels.forEach((l, i) => { l.ly = i ? Math.max(l.y, labels[i - 1].ly + 15) : Math.max(l.y, top + 8); });
    const grid = [.25, .5, .75].map(f => `<line class="ic-grid" x1="${left}" x2="${right}" y1="${(top + (bottom - top) * f).toFixed(1)}" y2="${(top + (bottom - top) * f).toFixed(1)}"/>`).join('');
    const zones = `<rect class="ic-reward" x="${splitX}" width="${right - splitX}" y="${Math.min(y(d.entry), y(targets.at(-1))).toFixed(1)}" height="${Math.abs(y(d.entry) - y(targets.at(-1))).toFixed(1)}"/><rect class="ic-risk" x="${splitX}" width="${right - splitX}" y="${Math.min(y(d.entry), y(d.stop)).toFixed(1)}" height="${Math.abs(y(d.entry) - y(d.stop)).toFixed(1)}"/>`;
    const levelLines = labels.map(l => `<line class="ic-level ic-${l.cls}" x1="${left}" x2="${right}" y1="${l.y.toFixed(1)}" y2="${l.y.toFixed(1)}"/>${compact ? '' : `<text class="ic-label ic-${l.cls}" x="${right + 8}" y="${(l.ly + 4).toFixed(1)}">${esc(l.name)} ${esc(num(l.v))}</text>`}`).join('');
    const description = `${esc(d.ticker || '')} ${long ? 'LONG' : 'SHORT'}: схема «${esc(label)}». Вход ${num(d.entry)}, стоп ${num(d.stop)}, ${targets.map((t, i) => 'цель ' + (i + 1) + ' ' + num(t)).join(', ')}. Линия — иллюстрация сценария, не история цены.`;
    return `<figure class="idea-chart${compact ? ' compact' : ''}"><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${description}" preserveAspectRatio="xMidYMid meet">${grid}${zones}${levelLines}<path class="ic-path" d="${path}"/><circle class="ic-dot" cx="${splitX.toFixed(1)}" cy="${y(d.entry).toFixed(1)}" r="${compact ? 2.5 : 3.5}"/><text class="ic-caption" x="${left}" y="${height - 4}">Схема: ${esc(label.toLowerCase())} · не история цены</text></svg></figure>`;
  }
  window.OrbitaIdeaChart = { svg, pattern, PATTERNS };
})();
