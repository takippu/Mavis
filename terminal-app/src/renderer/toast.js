'use strict';

// MT.toast — in-app top-right toast stack. Used for request-complete alerts when the
// Mavis window is visible (the native OS toast is only used when the window is in the
// background — see notify.js). Themed via steep.css tokens, so it follows the active theme.
(function () {
  const MT = (window.MT = window.MT || {});
  let host = null;

  function ensureHost() {
    if (host && document.body.contains(host)) return host;
    host = document.createElement('div');
    host.className = 'mt-toast-host';
    host.setAttribute('aria-live', 'polite');
    document.body.appendChild(host);
    return host;
  }

  function show({ title, body, onClick, timeout = 6000 } = {}) {
    const h = ensureHost();
    const t = document.createElement('div');
    t.className = 'mt-toast';
    t.setAttribute('role', 'status');

    const ic = document.createElement('span');
    ic.className = 'mt-toast-ico';
    if (MT.icons) ic.innerHTML = MT.icons.svg('sparkles', 16);

    const main = document.createElement('div');
    main.className = 'mt-toast-main';
    const ti = document.createElement('div');
    ti.className = 'mt-toast-title';
    ti.textContent = title || 'Mavis';
    main.appendChild(ti);
    if (body) {
      const bd = document.createElement('div');
      bd.className = 'mt-toast-body';
      bd.textContent = body;
      main.appendChild(bd);
    }

    const close = document.createElement('button');
    close.className = 'mt-toast-close';
    close.type = 'button';
    close.textContent = '×';
    close.setAttribute('aria-label', 'Dismiss');

    t.append(ic, main, close);

    let done = false;
    const dismiss = () => {
      if (done) return;
      done = true;
      clearTimeout(tm);
      t.classList.remove('in');
      t.classList.add('out');
      setTimeout(() => { if (t.parentNode) t.remove(); }, 220);
    };
    close.addEventListener('click', (e) => { e.stopPropagation(); dismiss(); });
    if (onClick) { t.style.cursor = 'pointer'; t.addEventListener('click', () => { try { onClick(); } catch { /* noop */ } dismiss(); }); }

    h.appendChild(t);
    while (h.childElementCount > 4) h.firstElementChild.remove();
    requestAnimationFrame(() => t.classList.add('in'));

    let tm = setTimeout(dismiss, timeout);
    t.addEventListener('mouseenter', () => clearTimeout(tm));
    t.addEventListener('mouseleave', () => { tm = setTimeout(dismiss, 2500); });
    return t;
  }

  MT.toast = { show };
})();
