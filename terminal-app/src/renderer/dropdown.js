'use strict';

// MT.dropdown — a themed, custom-rendered <select> replacement. Native <select> open-lists are
// OS-rendered and ignore our CSS, so they don't follow the app theme; this draws the list itself
// (a body-appended, viewport-clamped popup) so it matches every theme and never clips inside a
// scrolling card/menu. Near drop-in for a <select>: the returned element exposes a `value`
// get/set (programmatic set does NOT fire change, matching native) and dispatches a 'change'
// event on user pick — so existing `el.value` reads and `addEventListener('change', …)` keep working.
(function () {
  const MT = (window.MT = window.MT || {});
  const CHEV = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>';

  let openDD = null;
  function closeOpen() { if (openDD) { const d = openDD; openDD = null; d._close(); } }
  // outside-click / Esc / scroll / resize all dismiss the open popup
  document.addEventListener('pointerdown', (e) => { if (openDD && !openDD._owns(e.target)) closeOpen(); }, true);
  document.addEventListener('keydown', (e) => { if (openDD && e.key === 'Escape') { e.stopImmediatePropagation(); e.preventDefault(); closeOpen(); } }, true);
  window.addEventListener('resize', closeOpen);
  window.addEventListener('scroll', closeOpen, true);

  function create(opts = {}) {
    const { className = '', ariaLabel = '', placeholder = 'Select…', onChange = null } = opts;
    let options = Array.isArray(opts.options) ? opts.options.slice() : [];
    let value = opts.value != null ? opts.value : (options[0] ? options[0].value : null);

    const wrap = document.createElement('div');
    wrap.className = 'mt-dd';

    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'mt-dd-trigger' + (className ? ' ' + className : '');
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');
    if (ariaLabel) trigger.setAttribute('aria-label', ariaLabel);
    const labelEl = document.createElement('span'); labelEl.className = 'mt-dd-label';
    const chev = document.createElement('span'); chev.className = 'mt-dd-chev'; chev.innerHTML = CHEV;
    trigger.append(labelEl, chev);
    wrap.appendChild(trigger);

    let pop = null;
    const labelFor = (v) => { const o = options.find((x) => x.value === v); return o ? o.label : (v != null && v !== '' ? String(v) : placeholder); };
    const paintLabel = () => { labelEl.textContent = labelFor(value); };
    paintLabel();

    function buildPop() {
      pop = document.createElement('div');
      pop.className = 'mt-dd-pop';
      pop.setAttribute('role', 'listbox');
      options.forEach((o) => {
        const it = document.createElement('button');
        it.type = 'button';
        it.className = 'mt-dd-opt' + (o.value === value ? ' active' : '');
        it.textContent = o.label;
        it.setAttribute('role', 'option');
        it.addEventListener('click', (e) => { e.stopPropagation(); pick(o.value); });
        pop.appendChild(it);
      });
      document.body.appendChild(pop);
    }
    function place() {
      if (!pop) return;
      const r = trigger.getBoundingClientRect();
      pop.style.minWidth = Math.round(r.width) + 'px';
      const ph = pop.offsetHeight, pw = pop.offsetWidth;
      let top = r.bottom + 4;
      if (top + ph > window.innerHeight - 8 && r.top - ph - 4 > 8) top = r.top - ph - 4; // flip up if no room below
      const left = Math.min(r.left, window.innerWidth - pw - 8);
      pop.style.top = Math.round(Math.max(8, top)) + 'px';
      pop.style.left = Math.round(Math.max(8, left)) + 'px';
    }
    function open() {
      if (pop) return;
      closeOpen();
      buildPop();
      place();
      requestAnimationFrame(() => { if (pop) pop.classList.add('in'); });
      trigger.setAttribute('aria-expanded', 'true');
      openDD = controls;
      const act = pop.querySelector('.mt-dd-opt.active'); if (act) { try { act.scrollIntoView({ block: 'nearest' }); } catch { /* noop */ } }
    }
    function close() {
      if (pop && pop.parentNode) pop.parentNode.removeChild(pop);
      pop = null;
      trigger.setAttribute('aria-expanded', 'false');
      if (openDD === controls) openDD = null;
    }
    function pick(v) {
      const changed = v !== value;
      value = v; paintLabel(); close();
      if (changed) { if (onChange) { try { onChange(v); } catch { /* noop */ } } wrap.dispatchEvent(new Event('change', { bubbles: true })); }
    }

    trigger.addEventListener('click', (e) => { e.stopPropagation(); if (pop) close(); else open(); });
    trigger.addEventListener('keydown', (e) => { if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (!pop) open(); } });

    const controls = { _close: close, _owns: (t) => wrap.contains(t) || (pop && pop.contains(t)) };

    Object.defineProperty(wrap, 'value', {
      get() { return value; },
      set(v) { value = v; paintLabel(); if (pop) for (const c of pop.children) c.classList.toggle('active', c.textContent === labelFor(v)); },
      configurable: true,
    });
    wrap.setOptions = (next) => { options = Array.isArray(next) ? next.slice() : []; if ((value == null || !options.some((o) => o.value === value)) && options[0]) value = options[0].value; paintLabel(); if (pop) { close(); open(); } };
    wrap.focusTrigger = () => { try { trigger.focus(); } catch { /* noop */ } };

    return wrap;
  }

  MT.dropdown = { create };
})();
