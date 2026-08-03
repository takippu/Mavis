'use strict';

// MT.skeleton — shimmer placeholders shaped per view. The router shows one while a
// data view's async render is in flight (delayed, so fast local loads don't flash).
// Pure DOM; decorative only (aria-hidden) — the real view announces itself on swap.
(function () {
  const MT = (window.MT = window.MT || {});

  function bar(w, h, mt) {
    const n = document.createElement('div');
    n.className = 'mt-skel';
    n.style.width = w || '100%';
    n.style.height = h || '12px';
    if (mt) n.style.marginTop = mt;
    return n;
  }
  function box(cls) {
    const n = document.createElement('div');
    n.className = cls || '';
    return n;
  }
  // a white card holding skeleton bars (matches .mt-card silhouette)
  function cardWrap(pad) {
    const c = box('mt-card mt-skel-card');
    if (pad) c.style.padding = pad;
    return c;
  }
  function add(parent, child) { parent.appendChild(child); return child; }

  function dashboard(host) {
    add(host, bar('44%', '40px'));            // serif greeting
    add(host, bar('30%', '15px', '14px'));    // sub line
    const tiles = add(host, box('mt-tiles'));
    for (let i = 0; i < 4; i++) {
      const t = add(tiles, cardWrap('18px 20px'));
      add(t, bar('40%', '30px'));
      add(t, bar('66%', '11px', '12px'));
    }
    const cols = add(host, box('mt-cols'));
    for (let i = 0; i < 2; i++) {
      const c = add(cols, cardWrap('18px'));
      add(c, bar('38%', '11px'));
      for (let r = 0; r < 3; r++) add(c, bar(r % 2 ? '72%' : '84%', '13px', '14px'));
    }
  }

  function projects(host) {
    const head = add(host, box());
    head.style.cssText = 'display:flex;justify-content:space-between;align-items:flex-end;gap:16px;margin-bottom:16px';
    add(head, bar('30%', '40px'));            // serif title
    const s = add(head, bar('220px', '38px')); // search
    s.style.borderRadius = 'var(--radius-inputs)';
    const chips = add(host, box('mt-filters'));
    for (let i = 0; i < 5; i++) { const c = add(chips, bar((46 + i * 8) + 'px', '28px')); c.style.borderRadius = 'var(--radius-pill)'; }
    const grid = add(host, box('mt-grid'));
    for (let i = 0; i < 6; i++) {
      const card = add(grid, cardWrap('16px 18px'));
      add(card, bar('64%', '15px'));
      add(card, bar('86%', '11px', '12px'));
    }
  }

  function pm(host) {
    add(host, bar('34%', '40px'));            // "Project Manager"
    add(host, bar('40%', '14px', '8px'));     // sub line
    const board = add(host, box('mt-kanban'));
    board.style.marginTop = '22px';
    for (let col = 0; col < 3; col++) {
      const c = add(board, box('mt-kan-col'));
      const h = add(c, box('mt-kan-head'));
      add(h, bar('40%', '12px'));
      const body = add(c, box('mt-kan-body'));
      const n = col === 1 ? 2 : 3;
      for (let i = 0; i < n; i++) {
        const card = add(body, cardWrap('13px 15px'));
        add(card, bar('80%', '13px'));
        add(card, bar('55%', '10px', '9px'));
      }
    }
  }

  function detail(host) {
    add(host, bar('90px', '14px'));           // back link
    add(host, bar('46%', '40px', '14px'));    // title
    add(host, bar('60%', '13px', '10px'));    // meta
    const grid = add(host, box('mt-detail-grid'));
    grid.style.marginTop = '16px';
    for (let i = 0; i < 4; i++) {
      const c = add(grid, cardWrap('18px'));
      add(c, bar('40%', '11px'));
      for (let r = 0; r < 3; r++) add(c, bar(r % 2 ? '70%' : '88%', '12px', '12px'));
    }
  }

  function dailyops(host) {
    add(host, bar('30%', '40px'));            // title
    const lay = add(host, box('mt-dailyops-layout'));
    const left = add(lay, box());
    for (let i = 0; i < 3; i++) {
      const e = add(left, cardWrap('14px 18px'));
      e.style.marginTop = i ? '12px' : '12px';
      add(e, bar('45%', '13px'));
      add(e, bar('100%', '46px', '10px'));
    }
    const right = add(lay, cardWrap('22px'));
    add(right, bar('50%', '16px'));
    add(right, bar('100%', '13px', '14px'));
    add(right, bar('100%', '120px', '16px'));
  }

  const VIEWS = { dashboard, projects, pm, detail, dailyops };

  MT.skeleton = {
    bar,
    // returns a builder(host) for views that load async, or null
    forView(view) {
      const fn = VIEWS[view];
      if (!fn) return null;
      return (host) => {
        host.setAttribute('aria-hidden', 'true');
        host.classList.add('mt-skel-wrap');
        fn(host);
      };
    },
  };
})();
