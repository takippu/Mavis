'use strict';

// Harness registry. A harness id ('claude' | 'codex') is the single concept threaded through the
// app: a field on a session record, a Settings default, and the key an adapter is resolved by.
// Nothing else in the codebase branches on a vendor name.
//
// available() is what keeps a Codex-less machine looking exactly like it does today: the id is
// simply absent from the list, so Settings, the session picker and the tab badge never offer it.

const claude = require('./claude');
const codex = require('./codex');

const ADAPTERS = { claude, codex };
const DEFAULT_ID = 'claude';

// A restored session record predating this feature has no `harness` field. It MUST come back as
// 'claude' or every persisted tab breaks on the first launch after upgrade.
function normalizeId(v) {
  const s = String(v == null ? '' : v).toLowerCase();
  return ADAPTERS[s] ? s : DEFAULT_ID;
}

function get(id) {
  const a = ADAPTERS[String(id || '').toLowerCase()];
  if (!a) throw new Error('unknown harness: ' + id);
  return a;
}

let cache = null;

// resolve is injectable so tests never depend on what is actually installed on the box.
function available(resolve) {
  if (cache) return cache;
  const r = resolve || ((id) => ADAPTERS[id].resolveBin());
  cache = Object.keys(ADAPTERS).filter((id) => !!r(id));
  return cache;
}

function _resetCache() { cache = null; }

// Reconciles a configured/requested harness id against what is ACTUALLY installed. normalizeId
// only checks that an id is KNOWN ('claude' | 'codex') — it says nothing about whether that CLI is
// still on PATH. Without this, a machine that once had both CLIs and configured Codex as its
// default (or persisted a Codex tab) keeps defaulting every new AND restored session to Codex
// forever after Codex leaves PATH, with no visible control to fix it (Settings hides the harness
// row once available().length < 2). Falls back to DEFAULT_ID when it is installed, else the first
// installed id, else — the pathological case where NOTHING resolves — the requested id itself, so
// the caller still gets a clear "not found on PATH" error rather than a silently wrong substitution.
// See Finding 2, 2026-07-26 whole-branch review.
function resolveInstalled(id, resolve) {
  const wanted = normalizeId(id);
  const installed = available(resolve);
  if (installed.includes(wanted)) return wanted;
  if (installed.includes(DEFAULT_ID)) return DEFAULT_ID;
  return installed[0] || wanted;
}

module.exports = { get, available, normalizeId, resolveInstalled, DEFAULT_ID, ids: Object.keys(ADAPTERS), _resetCache };
