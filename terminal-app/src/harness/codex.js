'use strict';

// OpenAI Codex adapter. Same interface as ./claude, Codex's vocabulary.
//
// All flags verified against codex-cli 0.128.0 by string inspection of the shipped binary; the
// exec --json event names were observed live from a probe run on 2026-07-25. Both are
// version-dependent facts, not guarantees — re-verify on upgrade.

const { execSync } = require('child_process');
const { pickBinLine } = require('./claude');

// Claude gates on WHAT KIND of action it is; Codex gates on WHETHER THE SANDBOX REFUSED it. There
// is no exact correspondence, so acceptEdits -> on-failure is a judgement call: edits inside the
// workspace proceed without prompting, anything the sandbox blocks still escalates. This is the one
// mapping where a Codex session will feel materially different from a Claude one.
const PERM_MAP = {
  default: ['--sandbox', 'workspace-write', '--approval-policy', 'on-request'],
  acceptEdits: ['--sandbox', 'workspace-write', '--approval-policy', 'on-failure'],
  plan: ['--sandbox', 'read-only', '--approval-policy', 'untrusted'],
  yolo: ['--dangerously-bypass-approvals-and-sandbox'],
};

function resolveBin() {
  try {
    const cmd = process.platform === 'win32' ? 'where codex' : 'command -v codex';
    const out = execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const lines = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    return pickBinLine(lines, process.platform);
  } catch {
    return null;
  }
}

function permissionArgs(mode) {
  return (PERM_MAP[mode] || PERM_MAP.default).slice();
}

// Hook config goes in via -c CLI OVERRIDES rather than a project-local .codex/config.toml, because
// Codex refuses project-local config/hooks/exec-policies from a directory not marked trusted, and
// the brain root is not in ~/.codex/config.toml's [projects] list. User-supplied -c overrides are
// not subject to that gate, so sessions work in any directory with no trust dance.
function hookOverrides(hookCommand) {
  if (!hookCommand) return [];
  const out = [];
  for (const ev of ['stop', 'permission_request', 'pre_tool_use']) {
    out.push('-c', `hooks.${ev}.command=${JSON.stringify(hookCommand)}`);
  }
  return out;
}

function ptyCommand({ binPath, hookCommand, permissionMode } = {}) {
  let file = binPath;
  let args = [];
  if (process.platform === 'win32') {
    if (/\.(cmd|bat)$/i.test(binPath)) {
      file = process.env.COMSPEC || 'cmd.exe';
      args = ['/c', binPath];
    } else if (!/\.exe$/i.test(binPath)) {
      file = process.env.COMSPEC || 'cmd.exe';
      args = ['/c', 'codex'];
    }
  }
  args = args.concat(hookOverrides(hookCommand)).concat(permissionArgs(permissionMode));
  return { file, args };
}

// Headless spawn (brain-chat.js / dailyops-agent.js). Unlike Claude, `codex exec` has no TTY to
// approve anything even outside the interactive TUI path, so it still needs explicit sandbox +
// approval-policy flags — ptyCommand's mapping is reused here UNCHANGED. Do not fold this into
// Claude's headlessCommand or otherwise touch the plan -> sandbox read-only + approval untrusted
// mapping: whether headless 'plan' should instead map to --approval-policy never (no TTY exists to
// answer an approval prompt) is an open question already with the user — see Finding 1, 2026-07-26
// whole-branch review. This function exists only so brain-chat/dailyops can call the SAME method
// name (`adapter.headlessCommand`) on both adapters without a harness-specific branch.
function headlessCommand({ binPath, hookCommand, permissionMode } = {}) {
  return ptyCommand({ binPath, hookCommand, permissionMode });
}

// codex exec takes the prompt POSITIONALLY (not on stdin) and streams JSONL, so callers parse line
// by line rather than once over the whole stdout.
function headlessArgs({ prompt, sessionId, resume } = {}) {
  // Resume needs a server-assigned id. Without one we fall back to a fresh single-turn run rather
  // than crashing — losing context is recoverable, a hard failure mid-conversation is not.
  const args = resume && sessionId
    ? ['exec', 'resume', sessionId, '--json']
    : ['exec', '--json'];
  args.push(String(prompt == null ? '' : prompt));
  return { args, stdin: null, streaming: true };
}

function parseEvent(line) {
  const s = String(line == null ? '' : line).trim();
  if (!s) return null;
  let j = null;
  try { j = JSON.parse(s); } catch { return null; }
  if (!j || typeof j !== 'object') return null;
  const type = String(j.type || '');
  const isError = type === 'turn.failed' || type === 'error';
  const text = isError
    ? String((j.error && j.error.message) || j.message || 'codex error')
    : String(j.text || j.message || '');
  return {
    type,
    text,
    isError,
    sessionId: type === 'thread.started' ? (j.thread_id || null) : null,
    usage: j.usage || null,
  };
}

// Codex assigns the id SERVER-side and announces it on thread.started; unlike Claude, the
// caller's ourId is ignored. This is the one interface member whose two implementations differ
// in meaning rather than in spelling.
function sessionIdFrom(parsed, ourId) {
  return (parsed && parsed.sessionId) || null;
}

module.exports = {
  id: 'codex',
  label: 'Codex',
  bin: 'codex',
  // Codex reads ~/.codex/prompts/mavis.md but NAMESPACES user prompts, so the command is
  // /prompts:mavis and typing it at a Claude pane yields "Unknown command". Counterpart to
  // claude.autorunCommand; config.js treats both as built-ins rather than preferences.
  autorunCommand: '/prompts:mavis',
  resolveBin,
  ptyCommand,
  headlessCommand,
  permissionArgs,
  hookOverrides,
  headlessArgs,
  parseEvent,
  sessionIdFrom,
};
