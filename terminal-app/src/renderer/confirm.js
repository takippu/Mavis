'use strict';

// MT.confirm({ title, message, okLabel, cancelLabel, danger }) -> Promise<boolean>
// A small themed confirmation dialog used to guard destructive actions (e.g. closing a live session)
// against a misclick. Resolves true on confirm, false on cancel / Esc / backdrop click. Enter confirms.
(function () {
  const MT = (window.MT = window.MT || {});
  const el = (t, c, x) => { const n = document.createElement(t); if (c) n.className = c; if (x != null) n.textContent = x; return n; };

  MT.confirm = function (opts) {
    const o = typeof opts === 'string' ? { message: opts } : (opts || {});
    return new Promise((resolve) => {
      const overlay = el('div', 'mt-confirm-overlay');
      const card = el('div', 'mt-confirm');
      card.setAttribute('role', 'alertdialog'); card.setAttribute('aria-modal', 'true');
      if (o.title) card.appendChild(el('div', 'mt-confirm-title', o.title));
      card.appendChild(el('div', 'mt-confirm-msg', o.message || 'Are you sure?'));
      const row = el('div', 'mt-confirm-actions');
      const cancel = el('button', 'mt-confirm-btn', o.cancelLabel || 'Cancel'); cancel.type = 'button';
      const ok = el('button', 'mt-confirm-btn ' + (o.danger === false ? 'primary' : 'danger'), o.okLabel || 'Close'); ok.type = 'button';
      const finish = (v) => { document.removeEventListener('keydown', onKey, true); if (overlay.parentNode) overlay.parentNode.removeChild(overlay); resolve(v); };
      const onKey = (e) => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
        else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); finish(true); }
      };
      cancel.addEventListener('click', () => finish(false));
      ok.addEventListener('click', () => finish(true));
      row.append(cancel, ok);
      card.append(row);
      overlay.appendChild(card);
      overlay.addEventListener('pointerdown', (e) => { if (e.target === overlay) finish(false); }); // backdrop click cancels
      document.addEventListener('keydown', onKey, true);
      document.body.appendChild(overlay);
      requestAnimationFrame(() => { overlay.classList.add('in'); ok.focus(); });
    });
  };
})();
