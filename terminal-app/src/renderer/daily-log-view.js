'use strict';

// MT.dailyLog — a timeline/journal browser over daily-memories: a left rail of dates
// (newest first, with project chips), a main pane showing the selected day rendered.
(function () {
  const MT = (window.MT = window.MT || {});
  const el = (t, c, x) => { const n = document.createElement(t); if (c) n.className = c; if (x != null) n.textContent = x; return n; };

  function fmt(iso) {
    const d = new Date(String(iso) + 'T00:00:00');
    if (isNaN(d.getTime())) return String(iso);
    try { return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }); }
    catch { return String(iso); }
  }

  const remembered = new Map();
  MT.dailyLog = {
    async render(host, initialDate, opts = {}) {
      host.innerHTML = '';
      host.appendChild(el('div', 'mt-page-title', 'Daily log'));

      const scope = opts.project || 'all'; const state = remembered.get(scope) || {};
      let days = [];
      try { days = await window.mavis.listDailyMemories(); } catch { host.appendChild(el('p', '', 'Could not load daily memories.')); const retry = el('button', 'mt-btn', 'Retry'); retry.onclick = () => MT.dailyLog.render(host, initialDate, opts); host.appendChild(retry); return; }
      if (opts.project && Array.isArray(days)) days = days.filter(day => (day.projects || []).includes(opts.project));
      if (!Array.isArray(days) || !days.length) { host.appendChild(el('div', 'mt-empty', 'No daily memories yet.')); return; }
      host.appendChild(el('div', 'mt-sub', days.length + ' day' + (days.length === 1 ? '' : 's') + ' logged'));

      const layout = el('div', 'mt-dl-layout');
      const rail = el('div', 'mt-dl-rail');
      const main = el('div', 'mt-dl-main');
      layout.appendChild(rail); layout.appendChild(main);
      host.appendChild(layout);

      initialDate ||= state.date;
      let selected = (initialDate && days.some((d) => d.date === initialDate)) ? initialDate : days[0].date;
      const items = {};
      let loadSeq = 0;

      async function loadDay(date) {
        const my = ++loadSeq;
        main.innerHTML = '';
        main.appendChild(el('div', 'mt-empty', 'Loading…'));
        let res;
        try { res = await window.mavis.getDailyMemory(date); } catch { res = null; }
        if (my !== loadSeq) return;
        main.innerHTML = '';
        main.appendChild(el('div', 'mt-dl-day-title', fmt(date)));
        if (!res || res.error) { main.appendChild(el('p', '', 'Could not load this day.')); const retry = el('button', 'mt-btn', 'Retry'); retry.onclick = () => loadDay(date); main.appendChild(retry); return; }
        const body = MT.workspaceData.daily(res.content, opts.project)
          .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')       // drop frontmatter
          .replace(/^#\s+\d{4}-\d{2}-\d{2}\s*\r?\n/, '');         // drop the H1 date
        if (body.trim() && MT.md) main.appendChild(MT.md.render(body, 'mt-dl-content', { collapse: true }));
        else if (body.trim()) { const pre = el('pre', 'mt-dl-content'); pre.textContent = body; main.appendChild(pre); }
        else main.appendChild(el('div', 'mt-empty', 'Empty day.'));
      }

      days.forEach((d) => {
        const item = el('div', 'mt-dl-date' + (d.date === selected ? ' active' : ''));
        item.setAttribute('role', 'button'); item.setAttribute('tabindex', '0');
        const top = el('div', 'mt-dl-date-top');
        top.appendChild(el('span', 'mt-dl-date-label', fmt(d.date)));
        if (d.count && !opts.project) top.appendChild(el('span', 'mt-dl-date-count', String(d.count)));
        item.appendChild(top);
        if (d.projects && d.projects.length) {
          const chips = el('div', 'mt-dl-projs');
          d.projects.filter(p => !opts.project || p === opts.project).slice(0, 6).forEach((p) => chips.appendChild(el('span', 'mt-dl-proj', p)));
          item.appendChild(chips);
        }
        const open = () => { if (selected === d.date) return; selected = d.date; state.date = selected; remembered.set(scope, state); for (const k in items) items[k].classList.toggle('active', k === d.date); loadDay(d.date); };
        item.addEventListener('click', open);
        item.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
        items[d.date] = item;
        rail.appendChild(item);
      });

      const search = el('input', 'ws-input'); search.type = 'search'; search.placeholder = 'Filter dates or projects…'; search.setAttribute('aria-label', 'Filter daily log'); search.value = state.query || ''; const filter = () => { state.query = search.value; remembered.set(scope, state); const query = search.value.toLowerCase(); days.forEach(day => { items[day.date].hidden = !(day.date + ' ' + fmt(day.date) + ' ' + (day.projects || []).join(' ')).toLowerCase().includes(query); }); }; search.oninput = filter; layout.before(search); filter();
      await loadDay(selected);
    },
  };
})();
