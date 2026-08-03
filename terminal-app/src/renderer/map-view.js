'use strict';

// MT.map — embeds the local brain-viz cytoscape graph in a locked <webview>, served
// over the loopback viz server (http://127.0.0.1) so its ES modules load.
(function () {
  const MT = (window.MT = window.MT || {});
  const el = (t, c, x) => { const n = document.createElement(t); if (c) n.className = c; if (x != null) n.textContent = x; return n; };

  MT.map = {
    async render(host) {
      host.innerHTML = '';
      host.appendChild(el('div', 'mt-page-title', 'Map'));

      let st;
      try { st = await window.mavis.mapStatus(); } catch { st = { ready: false }; }

      // built, but the local loopback preview server couldn't start
      if (st && st.ready && !st.url) {
        const c = el('div', 'mt-card');
        c.style.cssText = 'padding:24px;margin-top:16px';
        c.appendChild(el('div', 'mt-row-name', 'Map preview unavailable'));
        c.appendChild(el('div', 'mt-row-sub', 'The map is built, but the local preview server couldn’t start.'));
        const b = el('button', 'mt-pill', 'Retry');
        b.style.marginTop = '12px';
        b.addEventListener('click', () => MT.map.render(host));
        c.appendChild(b);
        host.appendChild(c);
        return;
      }

      if (!st || !st.ready) {
        const c = el('div', 'mt-card');
        c.style.cssText = 'padding:24px;margin-top:16px';
        c.appendChild(el('div', 'mt-row-name', 'Build the brain map'));
        c.appendChild(el('div', 'mt-row-sub', 'The graph (viz) isn’t built yet.'));
        const b = el('button', 'mt-pill', 'Build map');
        b.style.marginTop = '12px';
        const status = el('span');
        status.style.cssText = 'color:var(--color-graphite);font-size:13px;margin-left:10px';
        b.addEventListener('click', async () => {
          b.textContent = 'Building…'; b.disabled = true;
          const r = await window.mavis.mapRebuild();
          if (r && r.ok) MT.map.render(host);
          else { b.disabled = false; b.textContent = 'Build map'; status.textContent = (r && r.reason) || 'failed'; }
        });
        c.appendChild(b);
        c.appendChild(status);
        host.appendChild(c);
        return;
      }

      const bar = el('div');
      bar.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin:8px 0 12px';
      bar.appendChild(el('span', 'mt-label', 'Brain graph'));
      const reb = el('button', 'mt-link', 'Rebuild');
      reb.addEventListener('click', async () => { reb.textContent = 'Rebuilding…'; await window.mavis.mapRebuild(); MT.map.render(host); });
      bar.appendChild(reb);
      host.appendChild(bar);

      const frame = el('div', 'mt-map-frame');
      const wv = document.createElement('webview');
      wv.setAttribute('src', st.url);
      wv.style.cssText = 'width:100%;height:100%;border:0';
      frame.appendChild(wv);
      host.appendChild(frame);
    },
  };
})();
