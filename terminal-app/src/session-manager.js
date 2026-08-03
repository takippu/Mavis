'use strict';

// Manages multiple claude PTY sessions keyed by id. Generalizes v0's single
// `term` into a map so the app can hold several project sessions at once.
//
// `spawn` is injectable so the bookkeeping can be unit-tested without node-pty
// (see test/session-manager.test.js). It defaults to the real PTY spawner.

const crypto = require('crypto');
const { startAgentPty, startShellPty } = require('./pty-session');
const harnessRegistry = require('./harness');

class SessionManager {
  constructor({ onData, onExit, spawn, spawnShell } = {}) {
    this.sessions = new Map(); // id -> { term, label, cwd, kind, harness, token, autorunDone, autorunTimer }
    this.onData = onData || (() => {});
    this.onExit = onExit || (() => {});
    this._spawn = spawn || startAgentPty;
    this._spawnShell = spawnShell || startShellPty;
    this._seq = 0;
  }

  // create({ cwd, cols, rows, label, kind, harness, autorun:{command,delayMs} }) →
  //   { ok, id, label, cwd, kind, harness } | { ok:false, reason }
  // kind 'shell' spawns a plain shell (no autorun, no harness, no sidecar token); anything else
  // spawns the agent CLI for `harness` ('claude' | 'codex', defaulted/normalized by the registry).
  create({ cwd, cols, rows, label, autorun, kind, harness } = {}) {
    const id = 's' + ++this._seq;
    const isShell = kind === 'shell';
    // Shell panes run a plain shell — no agent, so no harness and no status sidecar.
    const harnessId = isShell ? null : harnessRegistry.normalizeId(harness);
    const token = isShell ? null : crypto.randomUUID();
    const rec = {
      term: null,
      label: label || cwd || 'session',
      cwd: cwd || null,
      kind: isShell ? 'shell' : 'mavis',
      harness: harnessId,
      token,
      autorunDone: false,
      autorunTimer: null,
      enterTimer: null,
    };

    const spawner = isShell ? this._spawnShell : this._spawn;
    const res = spawner({
      cwd,
      cols,
      rows,
      harness: harnessId,
      sessionToken: token,
      onData: (data) => {
        this.onData(id, data);
        // Auto-run (e.g. /mavis) once, after the CLI's first output + a settle delay.
        if (autorun && autorun.command && !rec.autorunDone && !rec.autorunTimer) {
          rec.autorunTimer = setTimeout(() => {
            rec.autorunDone = true;
            rec.autorunTimer = null;
            const s = this.sessions.get(id);
            if (!s || !s.term) return;
            s.term.write(autorun.command);
            // Send Enter as a SEPARATE keystroke a beat later. Writing
            // `command\r` in one chunk lets the CLI's TUI swallow the submit
            // (it renders the typed/pasted text and misses the \r in the same
            // tick); a standalone \r afterward reliably submits the line.
            s.enterTimer = setTimeout(() => {
              const s2 = this.sessions.get(id);
              if (s2 && s2.term) s2.term.write('\r');
              if (s2) s2.enterTimer = null;
            }, autorun.enterDelayMs || 300);
          }, autorun.delayMs || 1500);
        }
      },
      onExit: (code) => {
        const s = this.sessions.get(id);
        if (s && s.autorunTimer) clearTimeout(s.autorunTimer);
        if (s && s.enterTimer) clearTimeout(s.enterTimer);
        this.sessions.delete(id);
        this.onExit(id, code);
      },
    });

    if (!res.ok) return { ok: false, reason: res.reason };

    rec.term = res.term;
    this.sessions.set(id, rec);
    return { ok: true, id, label: rec.label, cwd: rec.cwd, kind: rec.kind, harness: harnessId };
  }

  write(id, data) {
    const s = this.sessions.get(id);
    if (s && s.term) s.term.write(data);
  }

  resize(id, cols, rows) {
    const s = this.sessions.get(id);
    if (s && s.term) {
      try { s.term.resize(cols, rows); } catch { /* size race on close */ }
    }
  }

  close(id) {
    const s = this.sessions.get(id);
    if (!s) return;
    if (s.autorunTimer) clearTimeout(s.autorunTimer);
    if (s.enterTimer) clearTimeout(s.enterTimer);
    try { s.term.kill(); } catch { /* already gone */ }
    // A closed pane's sidecar file (and, for Claude, its per-token settings file) would otherwise sit
    // in userData forever — sweep() only catches leftovers from a CRASH, not a normal close. Best-effort:
    // notification plumbing must never be why a session fails to close.
    if (s.token) {
      try { require('./session-events').cleanup(process.env.MAVIS_USER_DATA, s.token); }
      catch { /* best-effort */ }
    }
    this.sessions.delete(id);
  }

  closeAll() {
    for (const id of [...this.sessions.keys()]) this.close(id);
  }

  // non-null cwds of all live sessions — the trusted Files-view root allowlist (see main.js).
  liveCwds() {
    const out = [];
    for (const s of this.sessions.values()) if (s && s.cwd) out.push(s.cwd);
    return out;
  }

  has(id) { return this.sessions.has(id); }
  get size() { return this.sessions.size; }

  // Session id -> its sidecar token; the inverse of idForToken. No production caller — close()
  // reads `s.token` off the record directly rather than going through this — but it is NOT dead
  // code: it is the only way tests can observe the token a session actually minted without reaching
  // into the private `sessions` map, and test/session-manager.test.js relies on it to verify token
  // minting, the idForToken round-trip, and close()'s sidecar cleanup. Kept deliberately, comment
  // corrected — the previous one ("for cleanup on close") was inaccurate. See Finding 4, 2026-07-26
  // whole-branch review.
  tokenFor(id) {
    const s = this.sessions.get(id);
    return (s && s.token) || null;
  }

  // Sidecar reader: map a token from a filename back to the session that owns it. Linear scan is
  // fine — at most one live session per open tab, so this is a handful of entries, not a hot path.
  idForToken(token) {
    if (!token) return null;
    for (const [id, s] of this.sessions) if (s && s.token === token) return id;
    return null;
  }
}

module.exports = { SessionManager };
