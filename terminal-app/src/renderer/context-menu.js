'use strict';

// MT.contextMenu — a themed right-click menu (the OS-native menu can't be themed in Chromium,
// same reason MT.dropdown exists). Body-appended, position:fixed, viewport-clamped + flipped so
// it never spills off-screen; closes on click-outside / Esc / window blur / resize. One menu open
// at a time. items: an array of { label, icon, accel, enabled, danger, onClick } and { separator:true }.
(function () {
  const MT = (window.MT = window.MT || {});
  let openEl = null, cleanup = null;

  function icon(name) { return MT.icons ? MT.icons.svg(name, 15) : ''; }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function close() {
    if (cleanup) { cleanup(); cleanup = null; }
    if (openEl && openEl.parentNode) openEl.parentNode.removeChild(openEl);
    openEl = null;
  }

  function show(x, y, items) {
    close();
    const menu = document.createElement('div');
    menu.className = 'mt-ctx-menu';
    menu.setAttribute('role', 'menu');
    for (const it of (items || [])) {
      if (!it) continue;
      if (it.separator) { const s = document.createElement('div'); s.className = 'mt-ctx-sep'; menu.appendChild(s); continue; }
      const enabled = it.enabled !== false;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'mt-ctx-item' + (it.danger ? ' danger' : '') + (enabled ? '' : ' disabled');
      b.setAttribute('role', 'menuitem');
      if (!enabled) b.disabled = true;
      b.innerHTML =
        '<span class="mt-ctx-ico">' + (it.icon ? icon(it.icon) : '') + '</span>' +
        '<span class="mt-ctx-label">' + esc(it.label) + '</span>' +
        (it.accel ? '<span class="mt-ctx-accel">' + esc(it.accel) + '</span>' : '');
      if (enabled) b.addEventListener('click', () => { close(); try { it.onClick && it.onClick(); } catch { /* noop */ } });
      menu.appendChild(b);
    }
    document.body.appendChild(menu);

    // clamp to the viewport; flip to the left / up when there isn't room at the cursor
    const mw = menu.offsetWidth || 200, mh = menu.offsetHeight || 120;
    let left = x, top = y;
    if (left + mw + 8 > window.innerWidth) left = Math.max(8, x - mw);
    if (top + mh + 8 > window.innerHeight) top = Math.max(8, window.innerHeight - mh - 8);
    menu.style.left = Math.round(left) + 'px';
    menu.style.top = Math.round(top) + 'px';
    requestAnimationFrame(() => menu.classList.add('in'));
    openEl = menu;

    const onDocDown = (e) => { if (openEl && !openEl.contains(e.target)) close(); };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopImmediatePropagation(); close(); } };
    const onAway = () => close();
    // defer wiring so the same click that opened the menu doesn't immediately close it
    setTimeout(() => {
      document.addEventListener('pointerdown', onDocDown, true);
      document.addEventListener('keydown', onKey, true);
      window.addEventListener('blur', onAway);
      window.addEventListener('resize', onAway);
    }, 0);
    cleanup = () => {
      document.removeEventListener('pointerdown', onDocDown, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', onAway);
      window.removeEventListener('resize', onAway);
    };
  }

  MT.contextMenu = { show, close };
})();
