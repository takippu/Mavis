'use strict';

// Spawns the REAL agent CLI (claude or codex) inside a pseudo-terminal.
//
// Why the CLI and not an SDK: only the CLI is licensed to use the subscription/browser login. See
// projects/mavis-terminal/notes.md.
//
// Per-harness argument building lives in src/harness/<id>.js; this file owns only process concerns
// (resolution, shell wrapping, the conpty fallback, env).

const pty = require('node-pty');
const harnessRegistry = require('./harness');

// Start an agent PTY for the given harness. Returns { ok, term, binPath, harness } or
// { ok:false, reason:'<id>-not-found' }.
function startAgentPty({ harness, cwd, cols, rows, onData, onExit, sessionToken } = {}) {
  const id = harnessRegistry.normalizeId(harness);
  const adapter = harnessRegistry.get(id);
  const binPath = adapter.resolveBin();
  if (!binPath) return { ok: false, reason: id + '-not-found' };

  // The status sidecar correlates a hook line back to THIS pane by a per-spawn token. It is baked
  // into the hook command (see session-events.buildHookCommand) rather than passed via the
  // environment: env inheritance by the CLI's hook child processes is unverified on both harnesses,
  // and Codex has a shell_environment_policy that could sanitize it. Baking it into the command
  // works on both regardless, so the design does not rest on an unverified assumption.
  //
  // require() is wrapped: session-events.js is notification plumbing added by a later task, and this
  // codebase's rule is that a session is never blocked on notification plumbing. If the module is
  // missing, throws, or hands back a falsy value (hookSpawnConfig has early-return paths), degrade to
  // "spawns fine, no status events" — never crash the spawn.
  let sidecar = {};
  if (sessionToken) {
    try {
      sidecar = require('./session-events').hookSpawnConfig(id, sessionToken) || {};
    } catch {
      sidecar = {};
    }
  }

  const { file, args } = adapter.ptyCommand({
    binPath,
    permissionMode: process.env.MAVIS_PERMISSION_MODE || 'default',
    hookSettingsPath: sidecar.hookSettingsPath,
    hookCommand: sidecar.hookCommand,
  });

  const opts = {
    name: 'xterm-256color',
    cols: cols || 80,
    rows: rows || 30,
    cwd: cwd || process.cwd(),
    env: process.env,
  };

  // node-pty's default Windows backend (conpty) intermittently fails under Electron — e.g. error
  // 267 (ERROR_DIRECTORY) at process creation even with a valid cwd. Retry on winpty before giving up.
  let term;
  try {
    term = pty.spawn(file, args, opts);
  } catch {
    term = pty.spawn(file, args, { ...opts, useConpty: false });
  }

  if (onData) term.onData(onData);
  if (onExit) term.onExit(({ exitCode }) => onExit(exitCode));

  return { ok: true, term, binPath, harness: id };
}

// Start a plain shell PTY (for split "Shell" panes — git / npm / etc. beside Mavis).
// Windows → PowerShell; elsewhere → $SHELL (or bash). Same conpty→winpty fallback.
function startShellPty({ cwd, cols, rows, onData, onExit }) {
  let file, args = [];
  if (process.platform === 'win32') {
    file = 'powershell.exe';
    args = ['-NoLogo'];
  } else {
    file = process.env.SHELL || '/bin/bash';
    args = ['-l'];
  }

  const opts = {
    name: 'xterm-256color',
    cols: cols || 80,
    rows: rows || 30,
    cwd: cwd || process.cwd(),
    env: process.env,
  };

  let term;
  try {
    term = pty.spawn(file, args, opts);
  } catch (e) {
    try { term = pty.spawn(file, args, { ...opts, useConpty: false }); }
    catch (e2) { return { ok: false, reason: e2.message || 'shell-spawn-failed' }; }
  }

  if (onData) term.onData(onData);
  if (onExit) term.onExit(({ exitCode }) => onExit(exitCode));

  return { ok: true, term };
}

module.exports = { startAgentPty, startShellPty };
