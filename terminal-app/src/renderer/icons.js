'use strict';

// MT.icons — small inline SVG icon set (Lucide-style, stroke=currentColor).
// No external lib; loaded before the views/app so they can use MT.icons.svg(name).
(function () {
  const MT = (window.MT = window.MT || {});

  const P = {
    dashboard: '<rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/>',
    // Projects = a STACK, deliberately not a folder: `folder` (below) is byte-identical to the
    // old projects glyph, so Projects and Files rendered the same icon and were indistinguishable
    // once the sidebar collapsed to the icon rail (where the glyph is the only label).
    projects: '<path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.57 3.91a2 2 0 0 0 1.66 0l8.57-3.9a1 1 0 0 0 0-1.83z"/><path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"/><path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
    settings: '<line x1="4" y1="7" x2="20" y2="7"/><circle cx="10" cy="7" r="2.4"/><line x1="4" y1="17" x2="20" y2="17"/><circle cx="15" cy="17" r="2.4"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 7.6h.01"/>',
    back: '<path d="M15 18l-6-6 6-6"/>',
    external: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M19 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h6"/>',
    square: '<rect x="4" y="4" width="16" height="16" rx="3.5"/>',
    checkSquare: '<rect x="4" y="4" width="16" height="16" rx="3.5"/><path d="m8.5 12 2.3 2.3L16 9.5"/>',
    zoomin: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.35-4.35"/><path d="M11 8v6"/><path d="M8 11h6"/>',
    zoomout: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.35-4.35"/><path d="M8 11h6"/>',
    expand: '<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/>',
    send: '<path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4z"/>',
    play: '<path d="M7 4v16l13-8z"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
    list: '<path d="M8 6h12M8 12h12M8 18h12"/><path d="M4 6h.01M4 12h.01M4 18h.01"/>',
    scroll: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/><path d="M8 13h7M8 17h5"/>',
    pm: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M8 9h8M8 13h5"/>',
    map: '<circle cx="6" cy="7" r="2"/><circle cx="18" cy="9" r="2"/><circle cx="10" cy="18" r="2"/><path d="M7.8 7.6l8.4 1M7.7 8.8l2 7.4"/>',
    dailyops: '<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4a1.5 1.5 0 0 1 1.5-1.5h3A1.5 1.5 0 0 1 15 4"/><path d="M9 11h6M9 15h4"/>',
    journal: '<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18"/><path d="M8 2v4M16 2v4"/>',
    topics: '<path d="M9.5 3 8 21"/><path d="M16 3l-1.5 18"/><path d="M4 8.5h16"/><path d="M3.5 15.5h16"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    // project types
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3c2.5 2.4 4 5.7 4 9s-1.5 6.6-4 9c-2.5-2.4-4-5.7-4-9s1.5-6.6 4-9z"/>',
    smartphone: '<rect x="7" y="2" width="10" height="20" rx="2"/><path d="M11 18h2"/>',
    wrench: '<path d="M14.6 6.4a3.5 3.5 0 0 0-4.7 4.6l-5.4 5.4a1.5 1.5 0 0 0 2.1 2.1l5.4-5.4a3.5 3.5 0 0 0 4.6-4.7l-2.2 2.2-2-2z"/>',
    server: '<rect x="3" y="4" width="18" height="7" rx="1.5"/><rect x="3" y="13" width="18" height="7" rx="1.5"/><path d="M7 7.5h.01M7 16.5h.01"/>',
    box: '<path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="m3 8 9 5 9-5"/><path d="M12 13v8"/>',
    bot: '<rect x="4" y="8" width="16" height="11" rx="2"/><path d="M12 8V4"/><circle cx="9" cy="13" r="1"/><circle cx="15" cy="13" r="1"/>',
    briefcase: '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
    folder: '<path d="M3 7a2 2 0 0 1 2-2h3.6a2 2 0 0 1 1.4.6L11.4 7H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    // split panes
    split: '<rect x="3" y="4" width="18" height="16" rx="2"/><line x1="12" y1="4" x2="12" y2="20"/>',
    plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
    // Changes view (git): the nav/branch chip glyph + the diff mark
    'git-branch': '<line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>',
    changes: '<path d="M12 3v18"/><path d="M5 8h14"/><path d="M5 16h14"/>',
    // tab status icons (session state on the tab dot)
    check: '<polyline points="20 6 9 17 4 12"/>',
    help: '<path d="M9.1 9a3 3 0 0 1 5.82 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
    // sidebar collapse/expand chevrons (VSCode-style icon rail toggle)
    'chevrons-left': '<polyline points="11 17 6 12 11 7"/><polyline points="18 17 13 12 18 7"/>',
    'chevrons-right': '<polyline points="13 17 18 12 13 7"/><polyline points="6 17 11 12 6 7"/>',
    terminal: '<rect x="3" y="4" width="18" height="16" rx="2"/><polyline points="7 9 10 12 7 15"/><line x1="13" y1="15" x2="17" y2="15"/>',
    sparkles: '<path d="M12 4l1.4 3.6L17 9l-3.6 1.4L12 14l-1.4-3.6L7 9z"/><path d="M18 14l.7 1.8L20.5 16.5l-1.8.7L18 19l-.7-1.8L15.5 16.5z"/>',
    arrowUp: '<line x1="12" y1="19" x2="12" y2="5"/><polyline points="6 11 12 5 18 11"/>',
    arrowDown: '<line x1="12" y1="5" x2="12" y2="19"/><polyline points="6 13 12 19 18 13"/>',
    arrowLeft: '<line x1="19" y1="12" x2="5" y2="12"/><polyline points="11 6 5 12 11 18"/>',
    arrowRight: '<line x1="5" y1="12" x2="19" y2="12"/><polyline points="13 6 19 12 13 18"/>',
    // terminal context menu
    copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    clipboard: '<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>',
    image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.8"/><path d="m21 15-5-5L5 21"/>',
    eraser: '<path d="M4 16.5 12.5 8l4.5 4.5L8.5 21H6z"/><path d="M14 21h6"/><path d="m10 10.5 4.5 4.5"/>',
    // window controls
    minimize: '<path d="M5 12h14"/>',
    maximize: '<rect x="5" y="5" width="14" height="14" rx="1.5"/>',
    restore: '<rect x="8" y="8" width="11" height="11" rx="1.5"/><path d="M5 16V6a1 1 0 0 1 1-1h10"/>',
    close: '<path d="M6 6 18 18M18 6 6 18"/>',
  };

  const TYPE_ICON = {
    'web-app': 'globe',
    'mobile-app': 'smartphone',
    tool: 'wrench',
    backend: 'server',
    meta: 'box',
    bot: 'bot',
    prospect: 'briefcase',
  };

  function svg(name, size) {
    const s = size || 18;
    const body = P[name] || P.folder;
    return (
      '<svg width="' + s + '" height="' + s + '" viewBox="0 0 24 24" fill="none" ' +
      'stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      body + '</svg>'
    );
  }

  MT.icons = {
    svg,
    typeIcon(type) { return svg(TYPE_ICON[String(type || '').toLowerCase()] || 'folder'); },
  };
})();
