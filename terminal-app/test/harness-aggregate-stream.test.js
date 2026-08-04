'use strict';

// Covers aggregateStreamedTurn — the pure JSONL-reduction extracted out of brain-chat.js's and
// dailyops-agent.js's close handlers during the 2026-07-26 session-id-leak review. Both callers
// used to carry their own copy of this loop and each drifted into a different wrong answer to
// "what session id do we resolve when Codex never announces one" (brain-chat.js kept the stale
// client uuid via a guarded `if (assigned)`; dailyops-agent.js explicitly fell back to it via
// `assigned || sessionId || null`). This function structurally forecloses that class of bug: it
// is never handed a caller-supplied id at all, so there is nothing to leak.

const test = require('node:test');
const assert = require('node:assert');
const codex = require('../src/harness/codex');
const { aggregateStreamedTurn } = require('../src/harness/aggregate-stream');

function jsonl(...events) {
  return events.map((e) => JSON.stringify(e)).join('\n');
}

test('captures the server-assigned id from thread.started and the completion text', () => {
  const out = jsonl(
    { type: 'thread.started', thread_id: 'thr_42' },
    { type: 'turn.completed', text: 'the answer' },
  );
  const agg = aggregateStreamedTurn(codex, out);
  assert.strictEqual(agg.sessionId, 'thr_42');
  assert.strictEqual(agg.text, 'the answer');
  assert.strictEqual(agg.error, null);
});

test('captures Codex 0.146 nested item.completed agent text', () => {
  const out = jsonl(
    { type: 'thread.started', thread_id: 'thr_146' },
    { type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'nested answer' } },
    { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } },
  );
  const agg = aggregateStreamedTurn(codex, out);
  assert.deepStrictEqual(agg, { sessionId: 'thr_146', text: 'nested answer', error: null });
});

test('no thread.started anywhere in the stream resolves sessionId to null, not a leaked caller id', () => {
  // Only turn.started + a normal completion — the exact stream shape behind the 2026-07-26 bug.
  // A caller that mixed its own uuid into this aggregation would have surfaced it here instead
  // of null; this function never receives a caller id in the first place, so that leak is not
  // just avoided, it is unreachable through this code path.
  const out = jsonl(
    { type: 'turn.started' },
    { type: 'turn.completed', text: 'the answer' },
  );
  const agg = aggregateStreamedTurn(codex, out);
  assert.strictEqual(agg.sessionId, null, 'no thread.started observed -> null, never a caller-supplied fallback');
  assert.strictEqual(agg.text, 'the answer');
});

test('an error event is captured as .error and its own (non-)text does not clobber a real answer', () => {
  const out = jsonl(
    { type: 'thread.started', thread_id: 'thr_7' },
    { type: 'turn.failed', error: { message: 'boom' } },
  );
  const agg = aggregateStreamedTurn(codex, out);
  assert.strictEqual(agg.sessionId, 'thr_7');
  assert.strictEqual(agg.error, 'boom');
});

test('the LAST non-error text wins when multiple text-bearing events appear', () => {
  const out = jsonl(
    { type: 'thread.started', thread_id: 'thr_1' },
    { type: 'turn.completed', text: 'first draft' },
    { type: 'turn.completed', text: 'final answer' },
  );
  const agg = aggregateStreamedTurn(codex, out);
  assert.strictEqual(agg.text, 'final answer');
});

test('junk and blank lines are ignored without throwing', () => {
  const out = ['not json', '', JSON.stringify({ type: 'thread.started', thread_id: 'thr_1' }), '   '].join('\n');
  assert.doesNotThrow(() => aggregateStreamedTurn(codex, out));
  const agg = aggregateStreamedTurn(codex, out);
  assert.strictEqual(agg.sessionId, 'thr_1');
});

test('handles empty/null output without throwing', () => {
  assert.deepStrictEqual(aggregateStreamedTurn(codex, ''), { sessionId: null, text: '', error: null });
  assert.deepStrictEqual(aggregateStreamedTurn(codex, null), { sessionId: null, text: '', error: null });
});
