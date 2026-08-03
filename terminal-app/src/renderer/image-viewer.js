'use strict';

// MT.imageViewer — fullscreen zoom/pan lightbox for one image (a data: URL we
// already loaded). Wheel-zoom toward the cursor, drag to pan, ±/fit controls,
// double-click to toggle, Esc/backdrop/× to close. Independent overlay on <body>.
(function () {
  const MT = (window.MT = window.MT || {});
  const icon = (n, s) => (MT.icons ? MT.icons.svg(n, s) : '');

  let overlay = null;
  let keyHandler = null;
  let prevFocus = null;

  function close() {
    if (!overlay) return;
    const node = overlay, h = keyHandler, pf = prevFocus;
    overlay = null; keyHandler = null; prevFocus = null;
    if (h) document.removeEventListener('keydown', h, true);
    node.classList.remove('in');
    setTimeout(() => { if (node && node.parentNode) node.remove(); }, 200);
    if (pf && typeof pf.focus === 'function') pf.focus();
  }

  function open(src, alt) {
    if (!src) return;
    if (overlay) close();
    prevFocus = document.activeElement;

    const node = document.createElement('div');
    node.className = 'mt-lb-overlay';
    node.setAttribute('role', 'dialog');
    node.setAttribute('aria-modal', 'true');
    node.setAttribute('aria-label', 'Image viewer');

    const stage = document.createElement('div');
    stage.className = 'mt-lb-stage';
    const img = document.createElement('img');
    img.className = 'mt-lb-img';
    img.alt = alt || 'image';
    img.draggable = false;
    stage.appendChild(img);
    node.appendChild(stage);

    // ---- transform state ----
    // zoom range is relative to the fit scale (which varies with image size), so
    // "100%" always means fit-to-screen and zoom behaves the same for any image.
    let scale = 1, tx = 0, ty = 0, nw = 1, nh = 1, fitScale = 1;
    const MIN_FACTOR = 0.8, MAX_FACTOR = 12;
    const rect = () => node.getBoundingClientRect();
    const pct = document.createElement('span');
    pct.className = 'mt-lb-pct';
    const apply = () => {
      img.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + scale + ')';
      pct.textContent = Math.round((scale / (fitScale || 1)) * 100) + '%';
    };
    function fit() {
      const r = rect();
      fitScale = Math.min((r.width * 0.94) / nw, (r.height * 0.9) / nh) || 1;
      scale = fitScale;
      tx = (r.width - nw * scale) / 2;
      ty = (r.height - nh * scale) / 2;
      apply();
    }
    function zoomAt(px, py, factor) {
      const lo = fitScale * MIN_FACTOR, hi = fitScale * MAX_FACTOR;
      const ns = Math.max(lo, Math.min(hi, scale * factor));
      if (ns === scale) return;
      const ix = (px - tx) / scale, iy = (py - ty) / scale;
      scale = ns; tx = px - ix * scale; ty = py - iy * scale;
      apply();
    }
    const zoomCenter = (factor) => { const r = rect(); zoomAt(r.width / 2, r.height / 2, factor); };

    // ---- controls ----
    const bar = document.createElement('div');
    bar.className = 'mt-lb-bar';
    const mkBtn = (name, title, fn) => {
      const b = document.createElement('button');
      b.className = 'mt-lb-btn'; b.type = 'button'; b.title = title; b.setAttribute('aria-label', title);
      b.innerHTML = icon(name, 17);
      b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
      return b;
    };
    bar.appendChild(mkBtn('zoomout', 'Zoom out', () => zoomCenter(1 / 1.25)));
    bar.appendChild(pct);
    bar.appendChild(mkBtn('zoomin', 'Zoom in', () => zoomCenter(1.25)));
    bar.appendChild(mkBtn('expand', 'Fit to screen', fit));
    node.appendChild(bar);

    const closeBtn = document.createElement('button');
    closeBtn.className = 'mt-lb-close'; closeBtn.type = 'button'; closeBtn.title = 'Close (Esc)';
    closeBtn.setAttribute('aria-label', 'Close image viewer');
    closeBtn.innerHTML = icon('close', 18);
    closeBtn.addEventListener('click', (e) => { e.stopPropagation(); close(); });
    node.appendChild(closeBtn);

    img.addEventListener('load', () => { nw = img.naturalWidth || 1; nh = img.naturalHeight || 1; fit(); });
    img.src = src;

    // wheel zoom toward the cursor
    node.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = rect();
      zoomAt(e.clientX - r.left, e.clientY - r.top, e.deltaY < 0 ? 1.12 : 1 / 1.12);
    }, { passive: false });

    // drag to pan
    let dragging = false, moved = false, lx = 0, ly = 0;
    node.addEventListener('pointerdown', (e) => {
      if (bar.contains(e.target) || closeBtn.contains(e.target)) return;
      dragging = true; moved = false; lx = e.clientX; ly = e.clientY;
      try { node.setPointerCapture(e.pointerId); } catch { /* noop */ }
      node.classList.add('grabbing');
    });
    node.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      if (Math.abs(e.clientX - lx) + Math.abs(e.clientY - ly) > 3) moved = true;
      tx += e.clientX - lx; ty += e.clientY - ly; lx = e.clientX; ly = e.clientY;
      apply();
    });
    const endDrag = () => { dragging = false; node.classList.remove('grabbing'); };
    node.addEventListener('pointerup', endDrag);
    node.addEventListener('pointercancel', endDrag);

    img.addEventListener('dblclick', (e) => {
      const r = rect();
      if (scale > fitScale * 1.2) fit();
      else zoomAt(e.clientX - r.left, e.clientY - r.top, (fitScale * 2.4) / scale);
    });

    // click empty backdrop closes — but not if a drag just happened, or a control was hit
    node.addEventListener('click', (e) => {
      if (moved) { moved = false; return; }
      if (e.target === node || e.target === stage) close();
    });

    keyHandler = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); close(); }
      else if (e.key === '+' || e.key === '=') { e.preventDefault(); zoomCenter(1.25); }
      else if (e.key === '-' || e.key === '_') { e.preventDefault(); zoomCenter(1 / 1.25); }
      else if (e.key === '0') { e.preventDefault(); fit(); }
    };
    document.addEventListener('keydown', keyHandler, true);

    document.body.appendChild(node);
    overlay = node;
    requestAnimationFrame(() => { if (overlay === node) node.classList.add('in'); });
    closeBtn.focus();
  }

  MT.imageViewer = { open, close, isOpen: () => !!overlay };
})();
