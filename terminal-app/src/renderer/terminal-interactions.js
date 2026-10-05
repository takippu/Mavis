'use strict';

// Tiny UMD helper so the xterm interaction contracts can be unit-tested under Node while the
// renderer consumes the same implementation without a bundler.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) { root.MT = root.MT || {}; root.MT.terminalInteractions = api; }
})(typeof window !== 'undefined' ? window : null, function () {
  function createOscLinkHandler(openUrl) {
    return {
      activate(_event, uri) {
        const value = String(uri || '').trim();
        if (!/^https?:\/\//i.test(value)) return;
        try { openUrl(value); } catch { /* noop */ }
      },
    };
  }

  function handlePlainSpace(event, send) {
    if (!event || event.type !== 'keydown') return false;
    const isSpace = event.key === ' ' || event.key === 'Spacebar' || event.code === 'Space';
    if (!isSpace || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return false;
    event.preventDefault();
    send(' ');
    return true;
  }

  function handleCodexAltArrow(event, send) {
    if (!event || event.type !== 'keydown' || !event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false;
    const arrow = { ArrowUp: 'A', ArrowDown: 'B', ArrowRight: 'C', ArrowLeft: 'D' }[event.key];
    if (!arrow || typeof arrow !== 'string') return false;
    // xterm maps plain Alt+arrow to Ctrl+arrow on Windows. Codex binds the actual Alt key.
    event.preventDefault();
    send('\x1b[1;3' + arrow);
    return true;
  }

  return { createOscLinkHandler, handlePlainSpace, handleCodexAltArrow };
});
