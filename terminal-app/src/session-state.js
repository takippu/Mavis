'use strict';

// Persists the open session tabs to userData/session-state.json (atomic write).
// Brain stays read-only; this is per-install UI state. Pure-ish: takes the dir.
//
// v2 adds per-tab `color` (tints the activity dot) and a `layout` tile-tree (split panes).
// Old v1 files (just cwd+label) still load — a missing/invalid layout defaults to one Mavis pane.
// A Mavis leaf may also carry a `cwd`/`label`/`color` when that pane is scoped to a DIFFERENT
// project than the tab (a cross-project split pane); those are preserved so restore reopens it there.

const fs = require('fs');
const path = require('path');
const harnessRegistry = require('./harness');

function file(userDataDir) {
  return path.join(userDataDir, 'session-state.json');
}

// Validate + normalize a persisted layout tree; null for a fully-invalid subtree (callers
// default the top level to a single Mavis leaf). Collapses single-child splits.
function sanitizeLayout(lay) {
  if (!lay || typeof lay !== 'object') return null;
  if (lay.leaf && typeof lay.leaf === 'object') {
    const kind = lay.leaf.kind === 'shell' ? 'shell' : 'mavis';
    const out = { kind };
    // a cross-project Mavis pane carries its own target dir (+ label/colour) — keep them
    if (kind === 'mavis' && typeof lay.leaf.cwd === 'string' && lay.leaf.cwd) {
      out.cwd = lay.leaf.cwd;
      out.label = typeof lay.leaf.label === 'string' && lay.leaf.label ? lay.leaf.label : lay.leaf.cwd;
      if (typeof lay.leaf.color === 'string' && lay.leaf.color) out.color = lay.leaf.color;
    }
    return { leaf: out };
  }
  if (!Array.isArray(lay.children) || lay.children.length !== 2) return null;
  const a = sanitizeLayout(lay.children[0]);
  const b = sanitizeLayout(lay.children[1]);
  if (!a && !b) return null;
  if (!a) return b;
  if (!b) return a;
  const dir = lay.dir === 'col' ? 'col' : 'row';
  const ok = Array.isArray(lay.sizes) && lay.sizes.length === 2 && lay.sizes.every((x) => typeof x === 'number' && x > 0);
  return { dir, sizes: ok ? [lay.sizes[0], lay.sizes[1]] : [0.5, 0.5], children: [a, b] };
}

function normSession(s) {
  if (!s || typeof s.cwd !== 'string' || !s.cwd) return null; // project tabs only (cwd required)
  return {
    cwd: s.cwd,
    label: String(s.label || s.cwd),
    color: typeof s.color === 'string' && s.color ? s.color : null,
    // Absent on every record written before the harness feature existed. normalizeId turns
    // undefined into 'claude', which is what keeps those tabs working after the upgrade.
    harness: harnessRegistry.normalizeId(s.harness),
    layout: sanitizeLayout(s.layout) || { leaf: { kind: 'mavis' } },
  };
}

function read(userDataDir) {
  try {
    const o = JSON.parse(fs.readFileSync(file(userDataDir), 'utf8'));
    if (!o || !Array.isArray(o.sessions)) return null;
    const sessions = o.sessions.map(normSession).filter(Boolean);
    // sidebarCollapsed is live UI state (the icon-rail toggle); absent in old files → expanded (false).
    return { version: 2, sessions, activeCwd: typeof o.activeCwd === 'string' ? o.activeCwd : null, sidebarCollapsed: o.sidebarCollapsed === true };
  } catch {
    return null;
  }
}

function write(userDataDir, state) {
  try {
    // Two writers touch this file: session-view persists { sessions, activeCwd } (no sidebarCollapsed),
    // and the sidebar toggle persists sidebarCollapsed. Preserve the on-disk collapse flag unless THIS
    // write explicitly carries a boolean, so a session persist never resets the icon-rail state.
    const prev = read(userDataDir);
    let collapsed = prev ? prev.sidebarCollapsed === true : false;
    if (state && typeof state.sidebarCollapsed === 'boolean') collapsed = state.sidebarCollapsed;
    const payload = {
      version: 2,
      sessions: (state && Array.isArray(state.sessions) ? state.sessions : []).map(normSession).filter(Boolean),
      activeCwd: (state && state.activeCwd) || null,
      sidebarCollapsed: collapsed,
    };
    const dest = file(userDataDir);
    const tmp = dest + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
    fs.renameSync(tmp, dest);
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

module.exports = { read, write, sanitizeLayout };
