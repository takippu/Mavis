'use strict';

// One recursive fs.watch over the brain's data dirs, debounced → onChange({scope, slug?}).
// A coarse "something changed" hint; the renderer re-reads. Read-only; never mutates.

const fs = require('fs');
const path = require('path');

function startBrainWatch(brainRoot, onChange, debounceMs = 300) {
  const watchers = [];
  let timer = null;
  let pending = null;

  const fire = (scope, slug) => {
    pending = { scope, slug: slug || null };
    clearTimeout(timer);
    timer = setTimeout(() => {
      const p = pending;
      pending = null;
      try { onChange(p); } catch { /* ignore */ }
    }, debounceMs);
  };

  const slugFrom = (filename) => {
    if (!filename) return null;
    const first = String(filename).split(/[\\/]/)[0];
    return first && /^[A-Za-z0-9._-]+$/.test(first) ? first : null;
  };

  const add = (dir, scope, opts) => {
    try {
      watchers.push(fs.watch(dir, opts || {}, (_e, filename) => fire(scope, scope === 'projects' ? slugFrom(filename) : null)));
    } catch { /* dir missing / recursive unsupported */ }
  };

  add(path.join(brainRoot, 'projects'), 'projects', { recursive: true });
  add(path.join(brainRoot, 'daily-memories'), 'daily', { recursive: true });
  // identity/* (profile/personality/communication/preferences) — feeds the Mavis config view
  add(path.join(brainRoot, 'identity'), 'identity');
  // New two-tier categories: each holds a <category>/_index.md + <category>/_details/*.md,
  // so a single recursive watch per dir covers both halves. Scopes are reused so the renderer's
  // brain-changed handling needs no change — topics→'topic', preferences→'identity' (feeds the
  // journal's Preferences bag + re-render), rules→'rules' (the contract view).
  // Each is non-'projects', so fire(scope, null); a missing dir on a legacy brain is swallowed by add().
  add(path.join(brainRoot, 'topics'), 'topic', { recursive: true });
  add(path.join(brainRoot, 'preferences'), 'identity', { recursive: true });
  add(path.join(brainRoot, 'rules'), 'rules', { recursive: true });
  // brain root: CLAUDE.md (the rules contract shown in the config view)
  try {
    watchers.push(fs.watch(brainRoot, {}, (_e, filename) => {
      if (filename === 'CLAUDE.md') fire('rules', null);
    }));
  } catch { /* ignore */ }

  return {
    close() {
      for (const w of watchers) { try { w.close(); } catch { /* ignore */ } }
      clearTimeout(timer);
    },
  };
}

module.exports = { startBrainWatch };
