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

  return { createOscLinkHandler, handlePlainSpace };
});

