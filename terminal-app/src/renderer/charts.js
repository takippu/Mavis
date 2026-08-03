'use strict';

// MT.charts — dependency-free SVG/DOM charts for the dashboard, in the Steep
// aesthetic: rust the only accent, no gridlines/axes/chartjunk, every datum
// inspectable on hover via a shared floating tooltip. Each builder returns
// { node, ... }. All user text is set with textContent (XSS-safe).
(function () {
  const MT = (window.MT = window.MT || {});
  const SVGNS = 'http://www.w3.org/2000/svg';

  // CSS custom properties don't resolve inside SVG *presentation attributes*, so
  // the Steep palette is duplicated here as literals for fills/strokes.
  const RUST = '#5d2a1a';
  const RUST_MID = '#a14a2b';
  const INK = '#17191c';
  const FOG = '#efe9e7';
  const RAMP = ['#efe9e7', 'rgba(93,42,26,.30)', 'rgba(93,42,26,.55)', 'rgba(93,42,26,.80)', RUST];
  const level = (n) => (n <= 0 ? 0 : n <= 1 ? 1 : n <= 3 ? 2 : n <= 6 ? 3 : 4);

  // Resolve the active theme's chart palette from CSS vars at render time — CSS custom
  // properties don't resolve inside SVG *presentation attributes*, so we read them in JS.
  function cssVar(name, fallback) {
    try { const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim(); return v || fallback; } catch { return fallback; }
  }
  function rgbaFrom(color, a) {
    let r = 93, g = 42, b = 26;
    const s = String(color).trim();
    let m = s.match(/^#([0-9a-fA-F]{3})$/);
    if (m) { r = parseInt(m[1][0] + m[1][0], 16); g = parseInt(m[1][1] + m[1][1], 16); b = parseInt(m[1][2] + m[1][2], 16); }
    else if ((m = s.match(/^#([0-9a-fA-F]{6})$/))) { r = parseInt(m[1].slice(0, 2), 16); g = parseInt(m[1].slice(2, 4), 16); b = parseInt(m[1].slice(4, 6), 16); }
    else if ((m = s.match(/rgba?\(([^)]+)\)/))) { const q = m[1].split(',').map(Number); r = q[0]; g = q[1]; b = q[2]; }
    return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
  }
  function pal() {
    const accent = cssVar('--chart-accent', RUST);
    const ink = cssVar('--chart-ink', INK);
    const track = cssVar('--chart-track', FOG);
    return {
      accent, ink, track,
      mid: rgbaFrom(accent, 0.62),
      ramp: [track, rgbaFrom(accent, 0.30), rgbaFrom(accent, 0.55), rgbaFrom(accent, 0.80), accent],
    };
  }

  const el = (t, c, x) => { const n = document.createElement(t); if (c) n.className = c; if (x != null) n.textContent = x; return n; };
  const svgEl = (t, attrs) => { const n = document.createElementNS(SVGNS, t); if (attrs) for (const k in attrs) n.setAttribute(k, attrs[k]); return n; };

  const isoLocal = (dt) => dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0');
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const WDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const fmtFull = (dt) => WDAYS[dt.getDay()] + ', ' + dt.getDate() + ' ' + MONTHS[dt.getMonth()];
  const fmtDay = (dt) => dt.getDate() + ' ' + MONTHS[dt.getMonth()];
  const plural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');

  // ---------- shared floating tooltip ----------
  let tipEl = null;
  function tip() {
    if (!tipEl) { tipEl = el('div', 'mt-tip'); tipEl.setAttribute('role', 'status'); tipEl.setAttribute('aria-live', 'polite'); document.body.appendChild(tipEl); }
    return tipEl;
  }
  function showTip(evt, title, sub) {
    const t = tip();
    t.innerHTML = '';
    t.appendChild(el('div', 'mt-tip-t', title));
    if (sub) t.appendChild(el('div', 'mt-tip-s', sub));
    t.classList.add('show');
    const pad = 14, r = t.getBoundingClientRect(), vw = window.innerWidth, vh = window.innerHeight;
    let x = evt.clientX + pad, y = evt.clientY + pad;
    if (x + r.width > vw - 8) x = evt.clientX - r.width - pad;
    if (y + r.height > vh - 8) y = evt.clientY - r.height - pad;
    t.style.left = Math.max(8, x) + 'px';
    t.style.top = Math.max(8, y) + 'px';
  }
  function hideTip() { if (tipEl) tipEl.classList.remove('show'); }
  MT.chartTip = { hide: hideTip };

  // cardinal-spline smooth path through points [[x,y],...]
  function smoothPath(p) {
    if (!p.length) return '';
    if (p.length < 3) return 'M' + p.map((q) => q[0] + ',' + q[1]).join(' L');
    let d = 'M' + p[0][0] + ',' + p[0][1];
    for (let i = 0; i < p.length - 1; i++) {
      const p0 = p[i - 1] || p[i], p1 = p[i], p2 = p[i + 1], p3 = p[i + 2] || p2;
      const c1x = p1[0] + (p2[0] - p0[0]) / 6, c1y = p1[1] + (p2[1] - p0[1]) / 6;
      const c2x = p2[0] - (p3[0] - p1[0]) / 6, c2y = p2[1] - (p3[1] - p1[1]) / 6;
      d += 'C' + c1x + ',' + c1y + ' ' + c2x + ',' + c2y + ' ' + p2[0] + ',' + p2[1];
    }
    return d;
  }

  // build a counts map { 'YYYY-MM-DD': n } from [{date,count}]
  function countMap(activityByDay) {
    const m = {};
    (activityByDay || []).forEach((d) => { if (d && d.date) m[d.date] = (m[d.date] || 0) + (Number(d.count) || 0); });
    return m;
  }

  // ---------- 1. Pulse — hero activity waveform ----------
  function pulse(activityByDay, opts) {
    const o = opts || {};
    const DAYS = o.days || 90;
    // bot lifted off the floor (was H-16) so the resting baseline isn't jammed against
    // the card's bottom edge — gives the waveform vertical breathing room.
    // padR > padX so the most-recent point's end "beacon" dot and the final peak have
    // room on the right — otherwise today's spike sits flush on the edge and (with the
    // non-uniform x-stretch from preserveAspectRatio="none") renders clipped.
    const W = 1000, H = o.height || 230, padX = 16, padR = 34, top = 70, bot = H - 30;
    const counts = countMap(activityByDay);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const series = [];
    for (let i = DAYS - 1; i >= 0; i--) { const dt = new Date(today); dt.setDate(today.getDate() - i); series.push({ dt, v: counts[isoLocal(dt)] || 0 }); }
    const n = series.length;
    const max = Math.max(1, ...series.map((p) => p.v));
    const xs = (i) => padX + i * ((W - padX - padR) / Math.max(1, n - 1));
    const ys = (v) => bot - (v / max) * (bot - top);
    const pts = series.map((p, i) => [xs(i), ys(p.v)]);
    const line = smoothPath(pts);
    const last = pts[n - 1];
    const area = line + ' L' + last[0] + ',' + bot + ' L' + pts[0][0] + ',' + bot + ' Z';
    const total = series.reduce((s, p) => s + p.v, 0);
    const streak = Number(o.streak) || 0;

    const wrap = el('div', 'mt-pulse');
    const stat = el('div', 'mt-pulse-stat');
    const big = el('div', 'mt-pulse-big');
    big.appendChild(el('span', 'mt-pulse-big-n', '0'));
    big.appendChild(el('span', 'mt-pulse-big-u', ' sections · ' + plural(streak, 'day') + ' streak'));
    stat.appendChild(big);
    wrap.appendChild(stat);

    const p = pal();
    const svg = svgEl('svg', { class: 'mt-pulse-svg', width: '100%', height: H, viewBox: '0 0 ' + W + ' ' + H, preserveAspectRatio: 'none' });
    svg.innerHTML =
      '<defs>' +
      '<linearGradient id="mt-pulse-grad" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" stop-color="' + p.accent + '" stop-opacity=".32"/>' +
      '<stop offset="1" stop-color="' + p.accent + '" stop-opacity="0"/></linearGradient>' +
      // explicit userSpaceOnUse region over the whole viewBox — the default objectBoundingBox region
      // can clip the rightmost glow under preserveAspectRatio="none", so the final spike loses its halo.
      '<filter id="mt-pulse-glow" filterUnits="userSpaceOnUse" x="-20" y="-20" width="' + (W + 40) + '" height="' + (H + 40) + '"><feGaussianBlur stdDeviation="3.2" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>' +
      '</defs>' +
      '<path class="mt-pulse-area" d="' + area + '" fill="url(#mt-pulse-grad)"/>' +
      '<path class="mt-pulse-line" pathLength="1" d="' + line + '" fill="none" stroke="' + p.accent + '" stroke-width="2.4" stroke-linejoin="round" filter="url(#mt-pulse-glow)" vector-effect="non-scaling-stroke"/>' +
      '<line class="mt-pulse-guide" x1="0" y1="' + (top - 10) + '" x2="0" y2="' + bot + '" stroke="' + p.accent + '" stroke-opacity=".4" stroke-dasharray="3 4" style="opacity:0"/>' +
      '<circle class="mt-pulse-cursor" r="4.5" fill="' + p.accent + '" stroke="#fff" stroke-width="2" style="opacity:0" vector-effect="non-scaling-stroke"/>' +
      '<circle class="mt-pulse-beacon" cx="' + last[0] + '" cy="' + last[1] + '" r="5" fill="' + p.accent + '"/>' +
      '<circle cx="' + last[0] + '" cy="' + last[1] + '" r="4.5" fill="' + p.accent + '" stroke="#fff" stroke-width="2" vector-effect="non-scaling-stroke"/>';
    wrap.appendChild(svg);

    const guide = svg.querySelector('.mt-pulse-guide');
    const cursor = svg.querySelector('.mt-pulse-cursor');
    svg.addEventListener('pointermove', (e) => {
      const r = svg.getBoundingClientRect(); if (!r.width) return;
      let i = Math.round(((e.clientX - r.left) / r.width) * (n - 1));
      i = Math.max(0, Math.min(n - 1, i));
      const p = pts[i];
      guide.setAttribute('x1', p[0]); guide.setAttribute('x2', p[0]); guide.style.opacity = '1';
      cursor.setAttribute('cx', p[0]); cursor.setAttribute('cy', p[1]); cursor.style.opacity = '1';
      const s = series[i];
      showTip(e, plural(s.v, 'section'), fmtFull(s.dt));
    });
    svg.addEventListener('pointerleave', () => { guide.style.opacity = '0'; cursor.style.opacity = '0'; hideTip(); });

    // After the draw-on completes, drop the stroke-dash so the resting line is a plain solid
    // glowing stroke. The pathLength + dasharray + non-scaling-stroke + filter combo can otherwise
    // leave the final segment (the most-recent spike) unrendered at rest in Chromium → no end glow.
    const lineEl = svg.querySelector('.mt-pulse-line');
    if (lineEl) setTimeout(() => { try { lineEl.style.strokeDasharray = 'none'; lineEl.style.strokeDashoffset = '0'; } catch { /* noop */ } }, 1700);

    // count-up the headline number
    const nEl = big.querySelector('.mt-pulse-big-n');
    let c = 0; const step = Math.max(1, Math.ceil(total / 40));
    const tm = setInterval(() => { c += step; if (c >= total) { c = total; clearInterval(tm); } nEl.textContent = String(c); }, 24);

    return { node: wrap, total };
  }

  // ---------- 2. Radial year — 52 week wedges ----------
  function radialYear(activityByDay, opts) {
    const o = opts || {};
    const SZ = 300, cx = 150, cy = 150, r0 = 52, rMin = 18, rExtra = 74, WEEKS = 52;
    const counts = countMap(activityByDay);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const start = new Date(today); start.setDate(today.getDate() - today.getDay() - (WEEKS - 1) * 7);

    const weeks = [];
    let yearTotal = 0;
    for (let w = 0; w < WEEKS; w++) {
      const wkStart = new Date(start); wkStart.setDate(start.getDate() + w * 7);
      let sum = 0;
      for (let d = 0; d < 7; d++) { const dt = new Date(wkStart); dt.setDate(wkStart.getDate() + d); if (dt <= today) sum += counts[isoLocal(dt)] || 0; }
      weeks.push({ start: wkStart, sum });
      yearTotal += sum;
    }
    const peak = Math.max(1, ...weeks.map((w) => w.sum));
    const p = pal();

    const svg = svgEl('svg', { class: 'mt-radial', width: '100%', viewBox: '0 0 ' + SZ + ' ' + SZ, preserveAspectRatio: 'xMidYMid meet' });
    const TAU = Math.PI * 2, gap = 0.004;
    const polar = (r, a) => [cx + r * Math.cos(a - Math.PI / 2), cy + r * Math.sin(a - Math.PI / 2)];
    weeks.forEach((wk, i) => {
      const a0 = (i / WEEKS) * TAU + gap, a1 = ((i + 1) / WEEKS) * TAU - gap;
      const lvl = level(wk.sum);
      const rr = r0 + rMin + rExtra * (wk.sum / peak);
      const [x0, y0] = polar(r0, a0), [x1, y1] = polar(rr, a0), [x2, y2] = polar(rr, a1), [x3, y3] = polar(r0, a1);
      const seg = svgEl('path', {
        class: 'mt-radial-seg',
        d: 'M' + x0 + ',' + y0 + ' L' + x1 + ',' + y1 + ' A' + rr + ',' + rr + ' 0 0 1 ' + x2 + ',' + y2 + ' L' + x3 + ',' + y3 + ' A' + r0 + ',' + r0 + ' 0 0 0 ' + x0 + ',' + y0 + ' Z',
        fill: p.ramp[lvl],
      });
      seg.style.animationDelay = (i * 12) + 'ms';
      const endIso = new Date(wk.start); endIso.setDate(wk.start.getDate() + 6);
      seg.addEventListener('pointerenter', (e) => { seg.classList.add('hot'); showTip(e, plural(wk.sum, 'section'), 'Week of ' + fmtDay(wk.start)); });
      seg.addEventListener('pointermove', (e) => showTip(e, plural(wk.sum, 'section'), 'Week of ' + fmtDay(wk.start)));
      seg.addEventListener('pointerleave', () => { seg.classList.remove('hot'); hideTip(); });
      svg.appendChild(seg);
    });
    const tTotal = svgEl('text', { x: cx, y: cy - 2, 'text-anchor': 'middle', class: 'mt-radial-total' });
    tTotal.textContent = yearTotal.toLocaleString();
    const tCap = svgEl('text', { x: cx, y: cy + 18, 'text-anchor': 'middle', class: 'mt-radial-cap' });
    tCap.textContent = 'sections · 52 wks';
    svg.appendChild(tTotal); svg.appendChild(tCap);
    return { node: svg, total: yearTotal };
  }

  // ---------- 3. Momentum rings ----------
  function rings(data) {
    const d = data || {};
    const streak = d.streak || { current: 0, best: 0 };
    const week = d.week || { current: 0, peak: 0 };
    const active = Number(d.active) || 0, total = Number(d.total) || 0;
    const SZ = 190, cx = 95, cy = 95;
    const cp = pal();
    const specs = [
      { r: 78, col: cp.accent, p: streak.best ? streak.current / streak.best : 0, label: 'Streak', val: streak.current + ' / ' + (streak.best || 0) + ' days' },
      { r: 60, col: cp.mid, p: week.peak ? week.current / week.peak : 0, label: 'This week', val: week.current + ' / ' + (week.peak || 0) + ' peak' },
      { r: 42, col: cp.ink, p: total ? active / total : 0, label: 'Active load', val: active + ' / ' + total + ' projects' },
    ];
    const W = 13;
    const wrap = el('div', 'mt-rings');
    const svg = svgEl('svg', { class: 'mt-rings-svg', width: '100%', viewBox: '0 0 ' + SZ + ' ' + SZ, preserveAspectRatio: 'xMidYMid meet' });
    specs.forEach((s, i) => {
      const circ = 2 * Math.PI * s.r;
      const p = Math.max(0, Math.min(1, s.p));
      const off = circ * (1 - p);
      svg.appendChild(svgEl('circle', { cx, cy, r: s.r, fill: 'none', stroke: s.col, 'stroke-opacity': '.12', 'stroke-width': W }));
      const fill = svgEl('circle', { cx, cy, r: s.r, fill: 'none', stroke: s.col, 'stroke-width': W, 'stroke-linecap': 'round', class: 'mt-ring-fill', 'stroke-dasharray': circ });
      fill.style.setProperty('--circ', circ);
      fill.style.setProperty('--off', off);
      fill.style.strokeDashoffset = circ;
      fill.style.animationDelay = (i * 130) + 'ms';
      const hot = svgEl('circle', { cx, cy, r: s.r, fill: 'none', stroke: 'transparent', 'stroke-width': W + 6, class: 'mt-ring-hit' });
      const pct = Math.round(p * 100);
      hot.addEventListener('pointerenter', (e) => showTip(e, s.label + ' · ' + pct + '%', s.val));
      hot.addEventListener('pointermove', (e) => showTip(e, s.label + ' · ' + pct + '%', s.val));
      hot.addEventListener('pointerleave', hideTip);
      svg.appendChild(fill); svg.appendChild(hot);
    });
    const tn = svgEl('text', { x: cx, y: cy - 2, 'text-anchor': 'middle', class: 'mt-rings-num' });
    tn.textContent = String(streak.current);
    const tc = svgEl('text', { x: cx, y: cy + 16, 'text-anchor': 'middle', class: 'mt-rings-cap' });
    tc.textContent = 'day streak';
    svg.appendChild(tn); svg.appendChild(tc);
    wrap.appendChild(svg);

    const legend = el('div', 'mt-rings-legend');
    specs.forEach((s) => {
      const row = el('div', 'mt-rings-leg-row');
      const sw = el('span', 'mt-rings-sw'); sw.style.background = s.col;
      row.appendChild(sw);
      row.appendChild(el('span', 'mt-rings-leg-l', s.label));
      row.appendChild(el('span', 'mt-rings-leg-v', s.val));
      legend.appendChild(row);
    });
    wrap.appendChild(legend);
    return { node: wrap };
  }

  // ---------- 4. Constellation — projects as bubbles ----------
  function constellation(projectActivity) {
    const items = (projectActivity || []).filter((p) => p && p.name).slice(0, 10);
    const wrap = el('div', 'mt-constel');
    if (!items.length) { wrap.appendChild(el('div', 'mt-empty', 'No project activity yet')); return { node: wrap }; }
    const max = Math.max(1, ...items.map((p) => Number(p.count) || 0));
    // sort big→small, then interleave so large bubbles don't all clump on one side
    items.sort((a, b) => (b.count || 0) - (a.count || 0));
    items.forEach((it, i) => {
      // smaller range so the top-10 fit two roomy rows (was 46–110 → 3 rows that spilled the card)
      const sz = Math.round(44 + ((Number(it.count) || 0) / max) * 36);
      const b = el('button', 'mt-bub' + (it.active === false ? ' paused' : ''));
      b.type = 'button';
      b.style.width = sz + 'px'; b.style.height = sz + 'px';
      b.style.animationDelay = (i * 70) + 'ms, ' + (i * 70 + 520) + 'ms';
      const inner = el('div', 'mt-bub-in');
      inner.appendChild(el('div', 'mt-bub-n', String(it.count)));
      inner.appendChild(el('div', 'mt-bub-name', it.name));
      b.appendChild(inner);
      const sub = (it.active === false ? 'paused' : 'active');
      b.addEventListener('pointerenter', (e) => showTip(e, it.name, plural(it.count, 'update') + ' · ' + sub));
      b.addEventListener('pointermove', (e) => showTip(e, it.name, plural(it.count, 'update') + ' · ' + sub));
      b.addEventListener('pointerleave', hideTip);
      // clicking a bubble opens that project (best-effort; matches whole-row-clickable pref)
      if (window.MT && typeof window.MT.openProjectByName === 'function') {
        b.addEventListener('click', () => window.MT.openProjectByName(it.name));
      }
      wrap.appendChild(b);
    });
    return { node: wrap };
  }

  MT.charts = { pulse, radialYear, rings, constellation };
})();
