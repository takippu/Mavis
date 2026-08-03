'use strict';

// Claude Code adapter. Pure argument-building and parsing — no process spawning — so it unit-tests
// against fixtures the same way brain-mcp.js does.
//
// Everything here was previously inline in pty-session.js / brain-chat.js / dailyops-agent.js.
// Behaviour is preserved exactly; only the location changed.

const { execSync } = require('child_process');

// 'auto' is deliberately absent: it opens Claude's Agent View, where Esc kills the process and
// leaves a dead pane (the bug 0.2.6 fixed). Unknown values fall back to 'default'.
const PERM_MODES = { default: 1, acceptEdits: 1, plan: 1 };

// Pure selector for the preferred binary from a list of paths. On Windows, `where claude`
// returns an extension-less shim first, but spawning that directly throws error 193
// (ERROR_BAD_EXE_FORMAT), so we prefer .cmd / .exe / .bat over the bare shim. On Unix,
// the first path is authoritative.
function pickBinLine(lines, platform) {
  if (!lines || !lines.length) return null;
  if (platform === 'win32') {
    const byExt = (ext) => lines.find((l) => l.toLowerCase().endsWith(ext));
    return byExt('.cmd') || byExt('.exe') || byExt('.bat') || lines[0];
  }
  return lines[0];
}

function resolveBin() {
  try {
    const cmd = process.platform === 'win32' ? 'where claude' : 'command -v claude';
    const out = execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const lines = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    return pickBinLine(lines, process.platform);
  } catch {
    return null;
  }
}

// Resolve how to spawn binPath. On Windows a .cmd/.bat shim must run via the shell, and an
// extension-less / .ps1 shim is not a spawnable exe either, so let cmd resolve it via PATHEXT.
// Shared by ptyCommand (interactive TUI) and headlessCommand (brain-chat/dailyops) below — the
// shim-wrapping is identical for both, only the flags that follow it differ.
function winShim(binPath) {
  let file = binPath;
  let args = [];
  if (process.platform === 'win32') {
    if (/\.(cmd|bat)$/i.test(binPath)) {
      file = process.env.COMSPEC || 'cmd.exe';
      args = ['/c', binPath];
    } else if (!/\.exe$/i.test(binPath)) {
      file = process.env.COMSPEC || 'cmd.exe';
      args = ['/c', 'claude'];
    }
  }
  return { file, args };
}

// { file, args } for node-pty — the INTERACTIVE TUI path (pty-session.js) only. Always carries a
// --permission-mode (or --dangerously-skip-permissions), which only makes sense where a human is
// at the keyboard to be gated. Do NOT reuse this for a headless spawn — see headlessCommand below.
function ptyCommand({ binPath, hookSettingsPath, permissionMode } = {}) {
  let { file, args } = winShim(binPath);
  if (hookSettingsPath) args = args.concat(['--settings', hookSettingsPath]);
  if (permissionMode === 'yolo') args = args.concat(['--dangerously-skip-permissions']);
  else args = args.concat(['--permission-mode', PERM_MODES[permissionMode] ? permissionMode : 'default']);
  return { file, args };
}

// { file, args } for a HEADLESS spawn (brain-chat.js / dailyops-agent.js) — the binary invocation
// only, no permission/settings flags. Claude's headless calls are `-p` (one-shot, non-interactive)
// and pre-branch never carried a permission flag at all (`cmd.exe /c claude -p --session-id <uuid>
// --output-format json --allowedTools Read,Glob,Grep`). Reusing ptyCommand's `permissionMode: 'plan'`
// for this path was a category error introduced by the harness-adapter refactor: 'plan' mode makes
// Claude research-then-propose-a-plan via ExitPlanMode, which is not in --allowedTools, so a headless
// turn never returns a usable reply. See Finding 1, 2026-07-26 whole-branch review.
function headlessCommand({ binPath } = {}) {
  return winShim(binPath);
}

// Headless (brain-chat / dailyops). Claude takes the prompt on STDIN and emits ONE json object.
function headlessArgs({ prompt, sessionId, resume, allowedTools } = {}) {
  const args = ['-p', resume ? '--resume' : '--session-id', sessionId, '--output-format', 'json'];
  if (allowedTools) args.push('--allowedTools', allowedTools);
  return { args, stdin: prompt, streaming: false };
}

// Claude's -p --output-format json emits a single object, not a stream, so parseEvent is called
// once on the whole stdout. Returns null rather than throwing on unparseable output.
function parseEvent(line) {
  let j = null;
  try { j = JSON.parse(line); } catch { return null; }
  if (!j || typeof j !== 'object') return null;
  return {
    type: 'result',
    text: String(j.result == null ? '' : j.result),
    isError: j.is_error === true,
    sessionId: j.session_id || null,
    usage: j.usage || null,
  };
}

// Claude session ids are CLIENT-supplied (we generate the uuid and pass --session-id), so the
// reply merely echoes ours. Contrast codex.sessionIdFrom, which must capture a server-assigned id.
function sessionIdFrom(parsed, ourId) {
  return (parsed && parsed.sessionId) || ourId || null;
}

module.exports = {
  id: 'claude',
  label: 'Claude Code',
  bin: 'claude',
  // The slash command that loads Mavis in THIS CLI. Claude Code reads ~/.claude/commands/mavis.md
  // and exposes it unnamespaced. Config treats this string as a built-in, never a user preference —
  // see autorunCommandForHarness in ../config.js.
  autorunCommand: '/mavis',
  resolveBin,
  ptyCommand,
  headlessCommand,
  headlessArgs,
  parseEvent,
  sessionIdFrom,
  pickBinLine,
};
