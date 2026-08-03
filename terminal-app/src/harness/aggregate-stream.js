'use strict';

// Reduces a streaming headless adapter's raw stdout (JSONL, one event per line) into a single
// turn result: the LAST non-error text as the answer, and the id the SERVER assigned (if any).
//
// Shared by brain-chat.js and dailyops-agent.js so this logic lives in exactly ONE place — the
// two callers previously each carried their own copy of this loop and drifted into two
// different wrong answers to the same question (2026-07-26 review: brain-chat.js only updated
// its session id when one was assigned, silently keeping the old one otherwise; dailyops-agent.js
// fell back to the CALLER'S OWN uuid when none was assigned). Both bugs let the caller's
// client-generated uuid survive as if Codex had assigned it.
//
// That id then round-trips into the next turn with resume:true. codex.headlessArgs' guard is
// `resume && sessionId` — a truthy-but-bogus id defeats it, producing `exec resume <uuid codex
// never created> --json` (a resume against a nonexistent thread) instead of the intended
// degrade-to-fresh-run.
//
// This function structurally forecloses that leak rather than relying on caller discipline: it
// never receives a caller-supplied id at all, so there is nothing for the aggregation to fall
// back to. `sessionId` on the returned object is the adapter's own `thread.started` value, or
// null if the adapter never announced one — always, no exceptions.
function aggregateStreamedTurn(adapter, out) {
  let assigned = null, text = '', failed = null;
  for (const line of String(out == null ? '' : out).split('\n')) {
    const ev = adapter.parseEvent(line);
    if (!ev) continue;
    assigned = adapter.sessionIdFrom(ev) || assigned;
    if (ev.isError) failed = ev.text;
    else if (ev.text) text = ev.text;
  }
  return { sessionId: assigned, text, error: failed };
}

module.exports = { aggregateStreamedTurn };
