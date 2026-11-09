/* Direction illustrations for ideas (not technical-analysis patterns).
   A calm price-like line with a soft area, dashed author levels and a glowing
   "now" dot. 8 bullish, 8 bearish and 5 neutral paths; the path is picked
   deterministically from the idea id, so an idea keeps its picture.
   Labelled as an illustration and drawn without dates: it must never look
   like real price history. */
(() => {
  'use strict';
  // Keypoints: x 0..1 (time), y 0..1 (1 = high). Smoothed and lightly jittered.
  const P = {
    long: [
      { key: 'rise-pullback', pts: [[0, .18], [.15, .3], [.3, .55], [.45, .78], [.55, .86], [.7, .72], [.85, .62], [1, .56]] },
      { key: 'steady-climb', pts: [[0, .08], [.2, .22], [.4, .38], [.6, .55], [.8, .72], [1, .86]] },
      { key: 'v-recovery', pts: [[0, .7], [.2, .45], [.38, .12], [.55, .3], [.75, .62], [1, .82]] },
      { key: 'stairs', pts: [[0, .1], [.15, .3], [.28, .26], [.42, .52], [.55, .48], [.7, .72], [.82, .68], [1, .88]] },
      { key: 'base-breakout', pts: [[0, .3], [.2, .24], [.4, .32], [.6, .26], [.75, .34], [.88, .62], [1, .84]] },
      { key: 'dip-rebound', pts: [[0, .45], [.2, .62], [.35, .5], [.55, .15], [.75, .42], [1, .7]] },
      { key: 'rounded-rise', pts: [[0, .62], [.2, .38], [.4, .22], [.6, .28], [.8, .55], [1, .86]] },
      { key: 'volatile-up', pts: [[0, .12], [.12, .38], [.22, .22], [.36, .55], [.48, .4], [.62, .72], [.74, .58], [.88, .86], [1, .78]] }
    ],
    short: [
      { key: 'fall-bounce', pts: [[0, .82], [.15, .7], [.3, .45], [.45, .22], [.55, .14], [.7, .28], [.85, .38], [1, .44]] },
      { key: 'steady-decline', pts: [[0, .92], [.2, .78], [.4, .62], [.6, .45], [.8, .28], [1, .14]] },
      { key: 'peak-reversal', pts: [[0, .3], [.2, .55], [.38, .88], [.55, .7], [.75, .38], [1, .18]] },
      { key: 'stairs-down', pts: [[0, .9], [.15, .7], [.28, .74], [.42, .48], [.55, .52], [.7, .28], [.82, .32], [1, .12]] },
      { key: 'top-breakdown', pts: [[0, .7], [.2, .76], [.4, .68], [.6, .74], [.75, .66], [.88, .38], [1, .16]] },
      { key: 'spike-fade', pts: [[0, .55], [.2, .38], [.35, .5], [.55, .85], [.75, .58], [1, .3]] },
      { key: 'rounded-fall', pts: [[0, .38], [.2, .62], [.4, .78], [.6, .72], [.8, .45], [1, .14]] },
      { key: 'volatile-down', pts: [[0, .88], [.12, .62], [.22, .78], [.36, .45], [.48, .6], [.62, .28], [.74, .42], [.88, .14], [1, .22]] }
    ],
    neutral: [
      { key: 'flat-waves', pts: [[0, .5], [.2, .62], [.4, .42], [.6, .6], [.8, .44], [1, .52]] },
      { key: 'range', pts: [[0, .4], [.15, .7], [.3, .35], [.5, .68], [.7, .36], [.85, .66], [1, .5]] },
      { key: 'drift', pts: [[0, .44], [.25, .52], [.5, .48], [.75, .58], [1, .54]] },
      { key: 'up-and-back', pts: [[0, .4], [.3, .66], [.55, .72], [.8, .5], [1, .42]] },
      { key: 'down-and-back', pts: [[0, .6], [.3, .36], [.55, .3], [.8, .5], [1, .58]] }
    ]
  };
  const hash = text => { let h = 2166136261; for (const ch of String(text)) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };
  const prng = s => () => { s |= 0; s = s + 0x6D2B79F5 | 0; let t = Math.imul(s ^ s >>> 15, 1 | s); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  const seedOf = record => record.id || ((record.d?.ticker || '') + (record.d?.dir || ''));
  function kind(record) { const d = record.d || {}; if (record.erroneous || d.state === 'cancelled') return 'neutral'; return d.dir === 'ШОРТ' ? 'short' : 'long'; }
  function pick(record) { const k = kind(record), list = P[k]; return { kind: k, ...list[hash(seedOf(record)) % list.length] }; }
  function series(record, n) {
    const f = pick(record), rnd = prng(hash(seedOf(record) + ':' + f.key)), pts = f.pts, out = [];
    const at = x => { let i = 0; while (i < pts.length - 2 && pts[i + 1][0] < x) i++; const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)], t = (x - p1[0]) / ((p2[0] - p1[0]) || 1), t2 = t * t, t3 = t2 * t; return .5 * ((2 * p1[1]) + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3); };
    // Small alternating jitter gives the gentle zig-zag of a price line.
    for (let i = 0; i < n; i++) { const x = i / (n - 1); out.push(at(x) + (i && i < n - 1 ? (rnd() - .5) * .05 + (i % 2 ? .012 : -.012) : 0)); }
    return { formation: f, values: out };
  }
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = v => Number(v).toLocaleString('ru-RU', { maximumFractionDigits: 8 });
  const okp = v => typeof v === 'number' && Number.isFinite(v) && v > 0;
  function svg(record, { width = 900, height = 460, compact = false, labelClass = 'fx-label', noteClass = 'fx-note', orbit = false } = {}) {
    const d = record.d || {}, targets = [d.target, ...(Array.isArray(d.targets) ? d.targets : [])].filter(okp);
    const long = d.dir !== 'ШОРТ', levels = okp(d.entry) && okp(d.stop) && targets.length > 0 && (long ? d.stop < d.entry && d.entry < targets[0] : targets[0] < d.entry && d.entry < d.stop);
    const n = compact ? 24 : 30, { formation: f, values } = series(record, n);
    const entry = levels ? d.entry : 100, stop = levels ? d.stop : entry + (long ? -3 : 3), tg = levels ? targets : [entry + (long ? 7 : -7)];
    const risk = Math.abs(entry - stop), reward = Math.abs(tg[0] - entry);
    // The line lives between the stop zone and part of the way to the first target.
    const lo = f.kind === 'neutral' ? entry - risk * .9 : long ? stop + risk * .3 : entry - reward * .5, hi = f.kind === 'neutral' ? entry + risk * .9 : long ? entry + reward * .5 : stop - risk * .3;
    const vMin = Math.min(...values), vMax = Math.max(...values), price = v => lo + (v - vMin) / ((vMax - vMin) || 1) * (hi - lo);
    const all = [...values.map(price), stop, ...tg, entry], top0 = Math.min(...all), top1 = Math.max(...all), pad = (top1 - top0) * .12;
    const labelW = compact ? 0 : 150, left = compact ? 4 : 30, right = width - labelW - (compact ? 4 : 16), top = compact ? 8 : 30, bottom = height - (compact ? 14 : 44);
    const endX = left + (right - left) * .9, X = i => left + i / (n - 1) * (endX - left), Y = p => top + (top1 + pad - p) / (top1 - top0 + 2 * pad) * (bottom - top);
    const pts = values.map((v, i) => [X(i), Y(price(v))]), line = pts.map(([x, y], i) => (i ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1)).join('');
    const id = 'fx' + hash(seedOf(record) + ':' + width + ':' + compact).toString(36), last = pts.at(-1);
    const area = `${line}L${last[0].toFixed(1)} ${bottom}L${left} ${bottom}Z`;
    const grid = [.15, .35, .55, .75, .95].map(k => `<line class="fx-grid" x1="${left}" x2="${right}" y1="${(top + (bottom - top) * k).toFixed(1)}" y2="${(top + (bottom - top) * k).toFixed(1)}"/>`).join('');
    let levelsSvg = '';
    if (levels) {
      const rows = [['entry', 'Вход', entry], ['stop', 'Стоп', stop], ...tg.map((v, i) => ['target', tg.length > 1 ? 'Цель ' + (i + 1) : 'Цель', v])].map(([c, name, v]) => ({ c, name, v, y: Y(v) })).sort((a, b) => a.y - b.y);
      rows.forEach((r, i) => { r.ly = i ? Math.max(r.y, rows[i - 1].ly + 20) : Math.max(r.y, top + 6); });
      levelsSvg = rows.map(r => `<line class="fx-level ${r.c}" x1="${left}" x2="${right}" y1="${r.y.toFixed(1)}" y2="${r.y.toFixed(1)}"/>${compact ? '' : `<text class="${labelClass} fx-l ${r.c}" x="${right + 12}" y="${(r.ly + 5).toFixed(1)}">${esc(r.name)} ${esc(num(r.v))}</text>`}`).join('');
    }
    const cx = left + (right - left) * .55, cy = top + (bottom - top) * .5, r = Math.min(bottom - top, right - left) * .42;
    const orbitLayer = orbit && !compact ? `<g class="fx-orbit" aria-hidden="true"><circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${(r * 1.3).toFixed(1)}" class="fx-orbit-ring outer"/><circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r.toFixed(1)}" class="fx-orbit-ring"/><g class="fx-orbit-spin" style="transform-origin:${cx.toFixed(1)}px ${cy.toFixed(1)}px"><circle cx="${cx.toFixed(1)}" cy="${(cy - r).toFixed(1)}" r="3.5" class="fx-orbit-dot"/></g><g class="fx-orbit-spin slow" style="transform-origin:${cx.toFixed(1)}px ${cy.toFixed(1)}px"><circle cx="${(cx + r * 1.3).toFixed(1)}" cy="${cy.toFixed(1)}" r="2" class="fx-orbit-dot dim"/></g></g>` : '';
    const note = levels ? 'Иллюстрация направления · не история цены' : f.kind === 'neutral' ? 'Иллюстрация · идея не активна' : 'Иллюстрация направления · уровни ещё не опубликованы';
    const aria = `${esc(d.ticker || '')} ${long ? 'LONG' : 'SHORT'}: иллюстрация направления${levels ? `, вход ${num(entry)}, стоп ${num(stop)}, ${tg.map((v, i) => 'цель ' + (i + 1) + ' ' + num(v)).join(', ')}` : ''}. Не история цены.`;
    return `<svg class="fx-chart${compact ? ' compact' : ''} fx-${f.kind}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${aria}" preserveAspectRatio="xMidYMid meet" data-formation="${f.key}"><defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" class="fx-area-top"/><stop offset="1" class="fx-area-bottom"/></linearGradient></defs>${orbitLayer}${grid}${levelsSvg}<path class="fx-area" d="${area}" fill="url(#${id})"/><path class="fx-line" d="${line}"/><line class="fx-drop" x1="${last[0].toFixed(1)}" x2="${last[0].toFixed(1)}" y1="${last[1].toFixed(1)}" y2="${bottom}"/><circle class="fx-glow" cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="${compact ? 6 : 11}"/><circle class="fx-now" cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="${compact ? 3 : 6}"/><text class="${noteClass} fx-caption" x="${left}" y="${height - (compact ? 3 : 14)}">${esc(note)}</text></svg>`;
  }
  window.OrbitaFormations = { svg, pick, series, FORMATIONS: P };
})();
