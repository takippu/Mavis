'use strict';

// Brain chat — a persistent headless Q&A session over the Mavis brain.
// It spawns on the FIRST ask (not at app launch), is multi-turn (context carries), and
// lives until end() is called. Read-only tools (Read/Glob/Grep): the model answers FROM
// the brain, never writes. Same headless mechanics as dailyops-agent, minus the
// control-block protocol. Which harness answers follows the global Settings default
// (decision 5) — the caller passes it in, this module has no opinion of its own.

const { spawn } = require('child_process');
const crypto = require('crypto');
const harnessRegistry = require('./harness');
const { aggregateStreamedTurn } = require('./harness/aggregate-stream');

const active = new Set(); // in-flight children, so a timeout / quit can reclaim the tree
let sessionId = null;
let started = false;  // a turn has succeeded → subsequent turns --resume
let inFlight = false; // single-flight (one question at a time)

function killTree(child) {
  try {
    if (process.platform === 'win32' && child.pid) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    else child.kill();
  } catch { /* already gone */ }
}
function cancelAll() { for (const c of active) killTree(c); active.clear(); }

function endSession() { cancelAll(); sessionId = null; started = false; inFlight = false; }

function firstPrompt(name, q) {
  return [
    `You are Mavis, answering ${name}'s question about their OWN work using only the files in the current directory — the Mavis "brain": projects/<slug>/{index,progress,notes}.md (+ specs/, references/, progress-archive/<year>.md for rotated-out older checkpoints, notes/_details/<slug>.md when notes.md has been sharded into an index), daily-memories/<date>.md, standups/, topics/_index.md (slug + triggers) + topics/_details/*.md (the topic substance), memory/*.md, identity/.`,
    'Do NOT run any auto-load / setup routine — just answer the question directly.',
    'Use Read, Glob, and Grep to find the answer. Good starting points: grep daily-memories/, projects/*/notes.md, projects/*/progress.md, projects/*/progress-archive/, projects/*/notes/_details/, topics/_index.md, and topics/_details/*.md.',
    'Answer concisely in markdown. Cite the file (and date) you found it in. If the brain does not contain it, say so plainly rather than guessing.',
    '',
    'Question: ' + q,
  ].join('\n');
}

function runTurn({ cwd, prompt, resume, harnessId }, timeoutMs = 120000) {
  return new Promise((resolve) => {
    // Which harness answers brain questions follows the global Settings default (decision 5).
    const adapter = harnessRegistry.get(harnessId || harnessRegistry.DEFAULT_ID);
    const binPath = adapter.resolveBin();
    if (!binPath) return resolve({ ok: false, error: adapter.label + ' not found on PATH' });
    const h = adapter.headlessArgs({ prompt, sessionId, resume, allowedTools: 'Read,Glob,Grep' });
    // headlessCommand, NOT ptyCommand: ptyCommand is the interactive-TUI arg builder and
    // unconditionally appends a --permission-mode Claude never carried headlessly pre-branch (it
    // forced plan mode, whose ExitPlanMode tool isn't in --allowedTools, so a headless turn never
    // returned a usable reply). See Finding 1, 2026-07-26 whole-branch review.
    const cmd = adapter.headlessCommand({ binPath, permissionMode: 'plan' });
    const args = cmd.args.concat(h.args);
    let child;
    try { child = spawn(cmd.file, args, { cwd, windowsHide: true }); }
    catch (e) { return resolve({ ok: false, error: e.message }); }
    active.add(child);
    let out = '', err = '', settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(killer);
      try { child.stdout.removeAllListeners('data'); child.stderr.removeAllListeners('data'); if (child.stdin) child.stdin.removeAllListeners('error'); } catch { /* noop */ }
      active.delete(child);
      resolve(v);
    };
    const killer = setTimeout(() => { killTree(child); done({ ok: false, error: 'timed out' }); }, timeoutMs);
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', (e) => done({ ok: false, error: e.message }));
    if (child.stdin) child.stdin.on('error', (e) => done({ ok: false, error: e.message }));
    child.on('close', (code) => {
      if (h.streaming) {
        // codex exec --json: JSONL, reduced by aggregateStreamedTurn. sessionId is the
        // SERVER-assigned id or null — UNCONDITIONAL, never a fallback to our own client uuid.
        // A guarded `if (assigned)` here was the 2026-07-26 bug: on a turn where Codex never
        // announced an id, the old client uuid would survive and get resumed against next time,
        // i.e. `exec resume <uuid codex never created>`, instead of degrading to a fresh run as
        // codex.headlessArgs intends. Claude never reaches this branch (its headlessArgs.streaming
        // is false) and is unaffected either way: claude.sessionIdFrom already falls back to ourId
        // internally on the branch below.
        const agg = aggregateStreamedTurn(adapter, out);
        sessionId = agg.sessionId || null;
        if (agg.error) return done({ ok: false, error: agg.error });
        if (code !== 0) return done({ ok: false, error: 'codex: ' + (err.trim() || 'exited ' + code) });
        return done({ ok: true, result: agg.text });
      }
      const ev = adapter.parseEvent(out);
      if (ev && ev.isError) return done({ ok: false, error: ev.text || 'claude error' });
      if (code !== 0) return done({ ok: false, error: 'claude: ' + ((ev && ev.text) || err.trim() || ('exited ' + code)) });
      if (!ev) return done({ ok: false, error: 'claude returned unparseable output' });
      done({ ok: true, result: ev.text });
    });
    if (h.stdin != null) {
      try { child.stdin.write(h.stdin); child.stdin.end(); } catch (e) { done({ ok: false, error: e.message }); }
    } else {
      try { child.stdin.end(); } catch { /* noop */ }
    }
  });
}

async function ask(brainRoot, name, question, harnessId) {
  const q = String(question == null ? '' : question).trim();
  if (!q) return { ok: false, error: 'empty question' };
  if (inFlight) return { ok: false, error: 'busy' };
  if (!sessionId) { sessionId = crypto.randomUUID(); started = false; } // spawn the session on first ask
  inFlight = true;
  try {
    const prompt = started ? q : firstPrompt(name || 'the user', q);
    const turn = await runTurn({ cwd: brainRoot, prompt, resume: started, harnessId });
    if (turn.ok) { started = true; return { ok: true, answer: turn.result }; }
    return { ok: false, error: turn.error };
  } finally {
    inFlight = false;
  }
}

module.exports = { ask, endSession, cancelAll, isActive: () => !!sessionId, parseFirstPrompt: firstPrompt };
