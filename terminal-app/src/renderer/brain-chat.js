'use strict';

// MT.brainChat — the "Ask Mavis" chat, now a first-class router VIEW (not a floating panel).
// The headless claude session over the brain (in main) spawns on the FIRST question, is multi-turn
// (context carries), and lives until "End session". Read-only Q&A — the model answers FROM the brain,
// never writes.
//
// PERSISTENCE (the DailyOps pattern — see notes [[embedding-claude-code]] "Router rebuilds #view-host"):
// the conversation + the in-flight turn live at MODULE level (a shared MT.async.controller), NOT in
// render()'s closure. The router destroys #view-host on every nav, so render() is a pure view of the
// module `state`; navigating away / back (or closing) re-renders from `state` instead of resetting, and
// a turn that resolves while you're on another screen just updates `state`. The main-process claude
// session already survives nav; this keeps the RENDERER conversation alongside it.
(function () {
  const MT = (window.MT = window.MT || {});
  const el = (t, c, x) => { const n = document.createElement(t); if (c) n.className = c; if (x != null) n.textContent = x; return n; };
  const icon = (n, s) => (MT.icons ? MT.icons.svg(n, s) : '');
  const LOGO = './assets/mavis-logo.png';

  // ---- persistent state (survives view nav / re-render / close) ----
  // messages: [{ role:'user'|'assistant'|'error', text }]; active: a claude session is open; pending: a
  // turn is in flight. Held in a controller so turn.run() seq-guards the await (End-session supersedes an
  // in-flight turn) and turn.isBusy() drives app.js's brain-changed skip-list.
  const turn = MT.async.controller(
    { messages: [], active: false, pending: false, pendingSince: 0 },
    { busyWhen: (s) => s.pending }
  );
  const state = turn.state;

  // ---- live render targets (refreshed on every render) ----
  let msgsEl = null, input = null, sendBtn = null, statusEl = null, endBtn = null, loader = null;

  // inline markdown: **bold**, `code`, *italic* / _italic_, [text](url) → text.
  // textContent / createElement only (no innerHTML) so model output can't inject markup.
  function inlineMd(text, parent) {
    const re = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*|_[^_\s][^_]*_|\[[^\]]+\]\([^)]+\))/g;
    let last = 0, m;
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));
      const tok = m[0];
      if (tok.startsWith('**')) { const n = document.createElement('strong'); n.textContent = tok.slice(2, -2); parent.appendChild(n); }
      else if (tok.charAt(0) === '`') { const n = document.createElement('code'); n.textContent = tok.slice(1, -1); parent.appendChild(n); }
      else if (tok.charAt(0) === '[') { parent.appendChild(document.createTextNode(tok.slice(1, tok.indexOf(']')))); }
      else { const n = document.createElement('em'); n.textContent = tok.slice(1, -1); parent.appendChild(n); }
      last = m.index + tok.length;
    }
    if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
  }

  // markdown-lite → DOM: fenced code, headings, bullet/numbered lists, paragraphs.
  function renderAnswer(text) {
    const wrap = el('div', 'mt-bc-md');
    String(text == null ? '' : text).split('```').forEach((block, bi) => {
      if (bi % 2 === 1) { // fenced code block
        const pre = el('pre', 'mt-bc-code');
        pre.textContent = block.replace(/^[a-zA-Z0-9+#.-]*\n/, '').replace(/\n$/, '');
        wrap.appendChild(pre);
        return;
      }
      let para = [], list = null;
      const flushPara = () => { if (para.length) { const p = el('p', 'mt-bc-p'); inlineMd(para.join('\n'), p); wrap.appendChild(p); para = []; } };
      const flushList = () => { if (list) { wrap.appendChild(list); list = null; } };
      block.split('\n').forEach((line) => {
        const head = line.match(/^(#{1,4})\s+(.*)$/);
        const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
        const num = line.match(/^\s*\d+\.\s+(.*)$/);
        if (head) { flushPara(); flushList(); const h = el('div', 'mt-bc-h'); inlineMd(head[2], h); wrap.appendChild(h); }
        else if (bullet || num) {
          flushPara();
          const tag = num ? 'ol' : 'ul';
          if (!list || list.tagName.toLowerCase() !== tag) { flushList(); list = document.createElement(tag); list.className = 'mt-bc-list'; }
          const li = document.createElement('li'); inlineMd((bullet || num)[1], li); list.appendChild(li);
        }
        else if (line.trim() === '') { flushPara(); flushList(); }
        else { flushList(); para.push(line); }
      });
      flushPara(); flushList();
    });
    if (!wrap.childNodes.length) wrap.textContent = String(text || '');
    return wrap;
  }

  function bubble(role, content) {
    const row = el('div', 'mt-bc-msg mt-bc-' + role);
    const b = el('div', 'mt-bc-bubble');
    if (typeof content === 'string') b.textContent = content; else b.appendChild(content);
    row.appendChild(b);
    msgsEl.appendChild(row);
    return row;
  }

  function emptyState() {
    const e = el('div', 'mt-bc-empty');
    e.appendChild(el('div', 'mt-bc-empty-title', 'Ask Mavis'));
    // The example uses an angle-bracket placeholder rather than a real project name (same idiom as
    // the new-project modal's "<root>\<slug>" hint) — it teaches the useful shape of a question,
    // scoping to one project, without naming a project this brain may not have.
    e.appendChild(el('div', 'mt-bc-empty-sub', 'About your projects, notes, daily logs, decisions — answered from the brain. e.g. “what did I do on <project> last week?”'));
    msgsEl.appendChild(e);
  }

  // staged "thinking" loader (perceived progress — the real claude turn is one opaque call), same
  // pattern as the DailyOps generator: each step fades up, the current one spins, completed steps get a
  // rust ✓; the last step keeps spinning until the answer.
  const THINK_STEPS = ['Connecting to Claude', 'Reading the brain', 'Searching notes & daily logs', 'Composing the answer'];
  const THINK_STEP_MS = 1400;
  // startAt = the ms timestamp the turn began (state.pendingSince). When we re-render after a nav
  // away/back, the same in-flight turn is still running in main — resume the loader at the elapsed
  // step instead of restarting at step 1 (which made it look like the whole request restarted).
  function makeLoader(startAt) {
    const wrap = el('div', 'mt-do-steps mt-bc-steps');
    wrap.setAttribute('role', 'status'); wrap.setAttribute('aria-live', 'polite');
    let timer = null;
    let i = startAt ? Math.min(THINK_STEPS.length - 1, Math.floor((Date.now() - startAt) / THINK_STEP_MS)) : 0;
    // pre-render the steps already elapsed as completed (✓), so the resume looks continuous
    for (let k = 0; k < i; k++) {
      const s = el('div', 'mt-do-step done in');
      const ic = el('span', 'mt-do-step-ico'); ic.textContent = '✓';
      s.appendChild(ic); s.appendChild(el('span', 'mt-do-step-label', THINK_STEPS[k]));
      wrap.appendChild(s);
    }
    const spawnCurrent = () => {
      const s = el('div', 'mt-do-step current');
      const ico = el('span', 'mt-do-step-ico');
      const sp = el('span', 'mt-do-spinner'); sp.setAttribute('aria-hidden', 'true');
      ico.appendChild(sp); s.appendChild(ico);
      s.appendChild(el('span', 'mt-do-step-label', THINK_STEPS[i]));
      wrap.appendChild(s);
      requestAnimationFrame(() => s.classList.add('in'));
      if (msgsEl) msgsEl.scrollTop = msgsEl.scrollHeight;
    };
    spawnCurrent();
    const advance = () => {
      if (!wrap.isConnected || i >= THINK_STEPS.length - 1) { if (timer) { clearInterval(timer); timer = null; } return; }
      const cur = wrap.querySelector('.mt-do-step.current');
      if (cur) { cur.classList.remove('current'); cur.classList.add('done'); const ic = cur.querySelector('.mt-do-step-ico'); if (ic) ic.textContent = '✓'; }
      i++;
      spawnCurrent();
    };
    timer = setInterval(advance, THINK_STEP_MS);
    return { node: wrap, stop: () => { if (timer) { clearInterval(timer); timer = null; } } };
  }

  function setActive(on) {
    state.active = on;
    if (endBtn) endBtn.style.display = on ? '' : 'none';
    if (statusEl) statusEl.textContent = on ? 'Session active' : '';
  }

  // rebuild the message list from module state (called on render + after every state change). Cheap —
  // the conversation is short and createElement-only.
  function repaint() {
    if (loader) { loader.stop(); loader = null; }
    if (!msgsEl) return;
    msgsEl.innerHTML = '';
    if (!state.messages.length && !state.pending) { emptyState(); return; }
    for (const m of state.messages) {
      if (m.role === 'assistant') bubble('assistant', renderAnswer(m.text));
      else if (m.role === 'error') bubble('error', m.text);
      else bubble('user', m.text);
    }
    if (state.pending) { loader = makeLoader(state.pendingSince); bubble('assistant', loader.node); }
    msgsEl.scrollTop = msgsEl.scrollHeight;
  }

  async function send() {
    const q = input.value.trim();
    if (!q || state.pending) return;
    input.value = ''; input.style.height = ''; sendBtn.disabled = true;
    state.messages.push({ role: 'user', text: q });
    state.pending = true;
    state.pendingSince = Date.now();
    setActive(true);
    repaint();
    const r = await turn.run(() => window.mavis.brainChatAsk(q));
    if (r.superseded) return; // End-session / reset took over mid-flight → drop this turn (state already reset)
    state.pending = false;
    if (r.ok && r.result && r.result.ok) {
      state.messages.push({ role: 'assistant', text: r.result.answer });
    } else {
      const errMsg = (r.ok && r.result && r.result.error) || 'network error';
      state.messages.push({ role: 'error', text: 'Couldn’t answer: ' + errMsg });
      if (input) input.value = q; // keep the question for a retry
    }
    repaint();
    if (sendBtn) sendBtn.disabled = !(input && input.value.trim());
    if (input) input.focus();
  }

  function endSession() {
    turn.invalidate(); // supersede any in-flight turn
    state.pending = false;
    state.messages = [];
    try { window.mavis.brainChatEnd(); } catch { /* noop */ }
    setActive(false);
    repaint();
    if (sendBtn) sendBtn.disabled = !(input && input.value.trim());
  }

  MT.brainChat = {
    render(host) {
      host.innerHTML = '';
      // The router wraps every view in a bare auto-height <div>, which breaks a child's height:100%
      // chain — that's why Ask Mavis collapsed to the top instead of filling the pane. Give the wrapper
      // a definite height (the view-host is position:absolute inset:0) so .mt-bc-view fills, the empty
      // state centers, and the composer pins to the bottom.
      host.style.height = '100%';
      const view = el('div', 'mt-bc-view');
      view.setAttribute('role', 'region');
      view.setAttribute('aria-label', 'Ask Mavis');

      const head = el('div', 'mt-bc-head');
      const title = el('div', 'mt-bc-title');
      const hl = el('img', 'mt-bc-head-logo'); hl.src = LOGO; hl.alt = ''; hl.setAttribute('aria-hidden', 'true');
      title.appendChild(hl); title.appendChild(el('span', null, 'Ask Mavis'));
      statusEl = el('span', 'mt-bc-status');
      statusEl.textContent = state.active ? 'Session active' : '';
      const headRight = el('div', 'mt-bc-head-right');
      endBtn = el('button', 'mt-bc-end', 'End session');
      endBtn.type = 'button';
      endBtn.style.display = state.active ? '' : 'none';
      endBtn.addEventListener('click', endSession);
      headRight.appendChild(endBtn);
      head.appendChild(title); head.appendChild(statusEl); head.appendChild(headRight);

      msgsEl = el('div', 'mt-bc-msgs');

      const composer = el('div', 'mt-bc-composer');
      input = el('textarea', 'mt-bc-input');
      input.rows = 1; input.placeholder = 'Ask about your work…';
      input.setAttribute('aria-label', 'Ask Mavis a question');
      input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 160) + 'px'; if (!state.pending) sendBtn.disabled = !input.value.trim(); });
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
      sendBtn = el('button', 'mt-bc-send');
      sendBtn.type = 'button'; sendBtn.title = 'Send'; sendBtn.setAttribute('aria-label', 'Send');
      sendBtn.innerHTML = icon('send', 17);
      sendBtn.addEventListener('click', send);
      sendBtn.disabled = true;
      composer.appendChild(input); composer.appendChild(sendBtn);

      view.appendChild(head); view.appendChild(msgsEl); view.appendChild(composer);
      host.appendChild(view);

      repaint(); // rehydrate the conversation (+ resume the loader if a turn is mid-flight)
      // focus the composer once the router attaches the frag (it renders detached first)
      requestAnimationFrame(() => { try { if (input && input.isConnected) input.focus(); } catch { /* noop */ } });
      return Promise.resolve();
    },
    // app.js brain-changed skip-list (a turn in flight shouldn't be rebuilt)
    isBusy: () => turn.isBusy(),
  };
})();
