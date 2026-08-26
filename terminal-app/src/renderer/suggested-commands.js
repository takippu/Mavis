'use strict';

// Transcript-backed command drawer. xterm is a canvas/terminal surface, so it cannot host stable
// DOM buttons beside rendered code. This drawer reads the raw assistant Markdown through a scoped
// IPC and copies exact fenced-block bytes: no ANSI, terminal wrapping, prompt glyphs, or selection.
(function () {
  window.MT = window.MT || {};
  const el = (tag, cls, text) => { const node = document.createElement(tag); if (cls) node.className = cls; if (text != null) node.textContent = text; return node; };
  let overlay = null;
  let keyHandler = null;
  let returnFocus = null;

  function close() {
    if (!overlay) return;
    const node = overlay;
    overlay = null;
    if (keyHandler) document.removeEventListener('keydown', keyHandler, true);
    keyHandler = null;
    node.classList.remove('in');
    setTimeout(() => { if (node.parentNode) node.parentNode.removeChild(node); }, 190);
    try { if (returnFocus) returnFocus.focus(); } catch { /* noop */ }
    returnFocus = null;
  }

  async function copyBlock(button, content) {
    try {
      await navigator.clipboard.writeText(content);
      const old = button.textContent;
      button.textContent = 'Copied';
      button.classList.add('copied');
      setTimeout(() => { button.textContent = old; button.classList.remove('copied'); }, 1400);
    } catch {
      button.textContent = 'Copy failed';
      setTimeout(() => { button.textContent = 'Copy'; }, 1400);
    }
  }

  function paintBlocks(body, result) {
    body.replaceChildren();
    const blocks = result && Array.isArray(result.blocks) ? result.blocks : [];
    if (!blocks.length) {
      const empty = el('div', 'mt-cmd-empty');
      empty.append(
        el('div', 'mt-cmd-empty-title', 'No command blocks found'),
        el('p', '', 'Ask Mavis to put the suggested command in a fenced code block, then open Commands again.'),
      );
      body.appendChild(empty);
      return;
    }
    blocks.forEach((block, index) => {
      const card = el('section', 'mt-cmd-card');
      const head = el('div', 'mt-cmd-card-head');
      const meta = el('div', 'mt-cmd-meta');
      meta.append(el('span', 'mt-cmd-language', block.language || 'text'));
      if (block.messageIndex > 0) meta.append(el('span', 'mt-cmd-older', 'earlier reply'));
      const copy = el('button', 'mt-cmd-copy', 'Copy');
      copy.type = 'button';
      copy.setAttribute('aria-label', `Copy command block ${index + 1}`);
      copy.addEventListener('click', () => copyBlock(copy, String(block.content || '')));
      head.append(meta, copy);
      const pre = el('pre', 'mt-cmd-code');
      const code = document.createElement('code');
      code.textContent = String(block.content || '');
      pre.appendChild(code);
      card.append(head, pre);
      body.appendChild(card);
    });
  }

  async function open({ ptyId, label, opener } = {}) {
    if (!ptyId) return;
    close();
    returnFocus = opener || document.activeElement;
    const node = el('div', 'mt-cmd-overlay');
    const panel = el('aside', 'mt-cmd-panel');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-label', 'Suggested commands');
    const header = el('div', 'mt-cmd-head');
    const titleWrap = el('div', 'mt-cmd-title-wrap');
    titleWrap.append(el('div', 'mt-cmd-kicker', label || 'Mavis'), el('h2', 'mt-cmd-title', 'Suggested commands'));
    const x = el('button', 'mt-cmd-close');
    x.type = 'button'; x.setAttribute('aria-label', 'Close suggested commands');
    x.innerHTML = window.MT.icons ? window.MT.icons.svg('close', 16) : 'Close';
    x.addEventListener('click', close);
    header.append(titleWrap, x);
    const note = el('p', 'mt-cmd-note', 'Copied from the raw assistant response, preserving exact formatting.');
    const body = el('div', 'mt-cmd-body');
    body.appendChild(el('div', 'mt-cmd-loading', 'Reading recent replies…'));
    panel.append(header, note, body);
    node.appendChild(panel);
    node.addEventListener('pointerdown', (event) => { if (event.target === node) close(); });
    document.body.appendChild(node);
    overlay = node;
    keyHandler = (event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); } };
    document.addEventListener('keydown', keyHandler, true);
    requestAnimationFrame(() => node.classList.add('in'));
    x.focus();
    try {
      const result = await window.mavis.sessionCommands(ptyId);
      if (overlay === node) paintBlocks(body, result);
    } catch {
      if (overlay === node) paintBlocks(body, { blocks: [] });
    }
  }

  window.MT.suggestedCommands = { open, close };
})();
