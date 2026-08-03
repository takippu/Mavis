'use strict';

// MT.md — XSS-safe markdown → DOM (createElement/textContent only; NEVER innerHTML with
// source). Real heading levels + anchors, clickable brain-links via MT.linkRoute, [[wiki]]
// tags, GitHub pipe tables, blockquotes, fenced code with light token tinting, lists, hr.
// render(text, cls, opts): opts.collapse=true wraps each H2-led section in a <details> so a
// long single doc (Rules, a full daily) reads as collapsible sections instead of a wall.
(function () {
  const MT = (window.MT = window.MT || {});
  const KW = /\b(?:const|let|var|function|return|if|else|for|while|async|await|new|class|try|catch|throw|import|export|from|typeof|instanceof|null|true|false|undefined|this|public|private|protected|static|void|def|fn|end|match|case|switch|break|continue|do|in|of|yield|use|namespace)\b/g;

  const slugify = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);

  // ---- link routing: a markdown target → an in-app action, or null (render as plain text) ----
  function routeLink(url) {
    const u = String(url || '').trim();
    if (/^https?:\/\//i.test(u)) return () => { try { window.mavis.openExternal(u); } catch { /* noop */ } };
    const base = u.split('#')[0];
    let m;
    if ((m = base.match(/projects\/([^/]+)\//))) { const slug = m[1]; return () => { if (MT.router) MT.router.show('detail', slug); }; }
    if ((m = base.match(/daily-memories\/(\d{4}-\d{2}-\d{2})\.md/))) { const d = m[1]; return () => { if (MT.router) MT.router.show('journal', d); }; }
    if ((m = u.match(/(?:topic_index|topics\/_index)\.md#([a-z0-9-]+)/i))) { const slug = m[1]; return () => { if (MT.router) MT.router.show('topics', slug); }; }
    if (/^[a-z0-9][a-z0-9-]*$/i.test(u)) { const slug = u; return () => { if (MT.router) MT.router.show('topics', slug); }; } // bare slug
    return null; // repo path, memory/*.md, raw anchor → not routable
  }
  MT.linkRoute = routeLink;

  // ---- inline: **bold** `code` *italic* [[wiki]] [text](url) ----
  function inline(text, parent) {
    const re = /(\[\[[^\]]+\]\]|\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*|_[^_\s][^_]*_|\[[^\]]+\]\([^)]+\))/g;
    let last = 0, m;
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));
      const tok = m[0];
      if (tok.startsWith('[[')) { const n = document.createElement('span'); n.className = 'mt-md-wiki'; n.textContent = tok.slice(2, -2); parent.appendChild(n); }
      else if (tok.startsWith('**')) { const n = document.createElement('strong'); n.textContent = tok.slice(2, -2); parent.appendChild(n); }
      else if (tok.charAt(0) === '`') { const n = document.createElement('code'); n.className = 'mt-md-ic'; n.textContent = tok.slice(1, -1); parent.appendChild(n); }
      else if (tok.charAt(0) === '[') {
        const close = tok.indexOf('](');
        const txt = tok.slice(1, close);
        const url = tok.slice(close + 2, -1);
        const handler = routeLink(url);
        if (handler) {
          const a = document.createElement('a'); a.className = 'mt-md-link'; a.textContent = txt;
          a.setAttribute('role', 'link'); a.tabIndex = 0; a.title = url;
          a.addEventListener('click', (e) => { e.preventDefault(); handler(); });
          a.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); handler(); } });
          parent.appendChild(a);
        } else parent.appendChild(document.createTextNode(txt));
      }
      else { const n = document.createElement('em'); n.textContent = tok.slice(1, -1); parent.appendChild(n); }
      last = m.index + tok.length;
    }
    if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
  }

  // ---- light code tinting (XSS-safe: every token via textContent) ----
  function tintCode(code, pre) {
    const re = /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\/\/[^\n]*|\/\*[\s\S]*?\*\/|\b\d[\d._]*\b)/g;
    const span = (s, cls) => { const n = document.createElement('span'); if (cls) n.className = cls; n.textContent = s; pre.appendChild(n); };
    const plain = (s) => {
      let l = 0, mm; KW.lastIndex = 0;
      while ((mm = KW.exec(s)) !== null) { if (mm.index > l) pre.appendChild(document.createTextNode(s.slice(l, mm.index))); span(mm[0], 'mt-tok-kw'); l = mm.index + mm[0].length; }
      if (l < s.length) pre.appendChild(document.createTextNode(s.slice(l)));
    };
    let last = 0, m;
    while ((m = re.exec(code)) !== null) {
      if (m.index > last) plain(code.slice(last, m.index));
      const t = m[0];
      const cls = (t[0] === '"' || t[0] === "'" || t[0] === '`') ? 'mt-tok-str' : (t[0] === '/' ? 'mt-tok-com' : 'mt-tok-num');
      span(t, cls);
      last = m.index + t.length;
    }
    if (last < code.length) plain(code.slice(last));
  }

  // ---- pipe table: header row + |---| separator + body rows ----
  function renderTable(lines, start, wrap) {
    const cells = (l) => l.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
    const header = cells(lines[start]);
    let i = start + 2; // skip header + separator
    const body = [];
    while (i < lines.length && lines[i].indexOf('|') !== -1 && lines[i].trim() !== '') { body.push(cells(lines[i])); i++; }
    const table = document.createElement('table'); table.className = 'mt-md-table';
    const thead = document.createElement('thead'); const htr = document.createElement('tr');
    header.forEach((c) => { const th = document.createElement('th'); inline(c, th); htr.appendChild(th); });
    thead.appendChild(htr); table.appendChild(thead);
    const tb = document.createElement('tbody');
    body.forEach((r) => { const tr = document.createElement('tr'); for (let c = 0; c < header.length; c++) { const td = document.createElement('td'); inline(r[c] || '', td); tr.appendChild(td); } tb.appendChild(tr); });
    table.appendChild(tb); wrap.appendChild(table);
    return i;
  }

  function renderProse(block, wrap) {
    const lines = block.split('\n');
    let i = 0, para = [], list = null, quote = null;
    const flushPara = () => { if (para.length) { const p = document.createElement('p'); p.className = 'mt-md-p'; inline(para.join('\n'), p); wrap.appendChild(p); para = []; } };
    const flushList = () => { if (list) { wrap.appendChild(list); list = null; } };
    const flushQuote = () => { if (quote) { wrap.appendChild(quote); quote = null; } };
    const flushAll = () => { flushPara(); flushList(); flushQuote(); };
    while (i < lines.length) {
      const line = lines[i];
      // table: a line with a pipe, next line a |---| separator
      if (line.indexOf('|') !== -1 && i + 1 < lines.length && lines[i + 1].indexOf('|') !== -1 && /^[\s:|-]*-{1,}[\s:|-]*$/.test(lines[i + 1].replace(/^\s*\|/, '').replace(/\|\s*$/, ''))) {
        flushAll(); i = renderTable(lines, i, wrap); continue;
      }
      const head = line.match(/^(#{1,6})\s+(.*)$/);
      if (head) { flushAll(); const lvl = Math.min(head[1].length, 4); const h = document.createElement('div'); h.className = 'mt-md-h mt-md-h' + lvl; h.id = 'h-' + slugify(head[2]); inline(head[2], h); wrap.appendChild(h); i++; continue; }
      if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { flushAll(); const hr = document.createElement('hr'); hr.className = 'mt-md-hr'; wrap.appendChild(hr); i++; continue; }
      const q = line.match(/^\s*>\s?(.*)$/);
      if (q) { flushPara(); flushList(); if (!quote) { quote = document.createElement('blockquote'); quote.className = 'mt-md-quote'; } const d = document.createElement('div'); inline(q[1], d); quote.appendChild(d); i++; continue; }
      const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
      const num = line.match(/^\s*\d+\.\s+(.*)$/);
      if (bullet || num) { flushPara(); flushQuote(); const tag = num ? 'ol' : 'ul'; if (!list || list.tagName.toLowerCase() !== tag) { flushList(); list = document.createElement(tag); list.className = 'mt-md-list'; } const li = document.createElement('li'); inline((bullet || num)[1], li); list.appendChild(li); i++; continue; }
      if (line.trim() === '') { flushAll(); i++; continue; }
      flushList(); flushQuote(); para.push(line); i++;
    }
    flushAll();
  }

  // post-process: wrap each H2-led run in a <details> (first one open)
  function collapseSections(wrap, cls) {
    const kids = Array.from(wrap.childNodes);
    const isH2 = (n) => n.nodeType === 1 && n.classList && n.classList.contains('mt-md-h2');
    if (!kids.some(isH2)) return wrap;
    const out = document.createElement('div'); out.className = cls;
    let i = 0, first = true;
    while (i < kids.length && !isH2(kids[i])) { out.appendChild(kids[i]); i++; }
    while (i < kids.length) {
      const h = kids[i]; i++;
      const det = document.createElement('details'); det.className = 'mt-md-sec'; if (first) det.open = true; first = false;
      const sum = document.createElement('summary'); sum.className = 'mt-md-sec-sum'; sum.textContent = h.textContent; det.appendChild(sum);
      const body = document.createElement('div'); det.appendChild(body);
      while (i < kids.length && !isH2(kids[i])) { body.appendChild(kids[i]); i++; }
      out.appendChild(det);
    }
    return out;
  }

  function render(text, cls, opts) {
    opts = opts || {};
    const wrap = document.createElement('div');
    const klass = 'mt-md' + (cls ? ' ' + cls : '');
    wrap.className = klass;
    String(text == null ? '' : text).split('```').forEach((block, bi) => {
      if (bi % 2 === 1) {
        const pre = document.createElement('pre'); pre.className = 'mt-md-code';
        const code = block.replace(/^[a-zA-Z0-9+#.-]*\n/, '').replace(/\n$/, '');
        try { tintCode(code, pre); } catch { pre.textContent = code; }
        wrap.appendChild(pre);
        return;
      }
      renderProse(block, wrap);
    });
    if (!wrap.childNodes.length) wrap.textContent = String(text || '');
    return opts.collapse ? collapseSections(wrap, klass) : wrap;
  }

  MT.md = { render, inline, linkRoute: routeLink };
})();
