'use strict';

// OpenAI Codex adapter. Same interface as ./claude, Codex's vocabulary.
//
// Permission flags were re-verified against codex-cli 0.146.0 via the installed CLI parser and
// current OpenAI Codex manual on 2026-08-04. The exec --json event names were observed live from a
// probe run on 2026-07-25. Both are version-dependent facts, not guarantees — re-verify on upgrade.

const { execSync } = require('child_process');
const { pickBinLine } = require('./claude');

// Claude gates on WHAT KIND of action it is; Codex combines a sandbox boundary with an approval
// policy. There is no exact acceptEdits equivalent in Codex 0.146: the old on-failure value was
// removed, so acceptEdits falls back to the safest remaining interactive policy, on-request.
const PERM_MAP = {
  default: ['--sandbox', 'workspace-write', '--ask-for-approval', 'on-request'],
  acceptEdits: ['--sandbox', 'workspace-write', '--ask-for-approval', 'on-request'],
  plan: ['--sandbox', 'read-only', '--ask-for-approval', 'untrusted'],
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
  // Codex 0.146 uses the same PascalCase event names and three-level matcher-group shape as
  // hooks.json. The old lowercase hooks.<event>.command keys are accepted as generic config but
  // ignored by the hook loader, which left every session sidecar empty with no startup error.
  const group = `[{hooks=[{type="command",command=${JSON.stringify(hookCommand)}}]}]`;
  // This hook is generated and vetted by Mavis-Terminal itself. Its command includes a per-pane
  // token, so its hash changes on every spawn and cannot use Codex's persisted one-time trust.
  // The bypass is intentionally hook-only: sandbox and command approval policy remain unchanged.
  const out = ['--dangerously-bypass-hook-trust'];
  for (const ev of ['Stop', 'PermissionRequest', 'PreToolUse']) {
    out.push('-c', `hooks.${ev}=${group}`);
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
// approval flags — ptyCommand's mapping is reused here UNCHANGED. Do not fold this into
// Claude's headlessCommand or otherwise touch the plan -> sandbox read-only + approval untrusted
// mapping: whether headless 'plan' should instead map to --ask-for-approval never (no TTY exists to
// answer an approval prompt) is an open question already with the user — see Finding 1, 2026-07-26
// whole-branch review. This function exists only so brain-chat/dailyops can call the SAME method
// name (`adapter.headlessCommand`) on both adapters without a harness-specific branch.
function headlessCommand({ binPath, hookCommand, permissionMode } = {}) {
  return ptyCommand({ binPath, hookCommand, permissionMode });
}

// codex exec takes the prompt POSITIONALLY (not on stdin) and streams JSONL, so callers parse line
// by line rather than once over the whole stdout.
function headlessArgs({ prompt, sessionId, resume, skipGitRepoCheck, addDir, promptOnStdin } = {}) {
  // Resume needs a server-assigned id. Without one we fall back to a fresh single-turn run rather
  // than crashing — losing context is recoverable, a hard failure mid-conversation is not.
  const args = resume && sessionId
    ? ['exec', 'resume', sessionId, '--json']
    : ['exec', '--json'];
  // DailyOps runs Codex from an app-owned directory so the brain's project AGENTS.md cannot
  // intercept its private ASK/DONE wire protocol. That directory is deliberately not a git repo;
  // the app embeds the selected memory sources in the prompt instead of exposing the brain root.
  if (skipGitRepoCheck) args.push('--skip-git-repo-check');
  if (addDir && !(resume && sessionId)) args.push('--add-dir', String(addDir));
  const value = String(prompt == null ? '' : prompt);
  // Large application-owned prompts (DailyOps embeds the selected memory contents) use stdin.
  // Besides avoiding Windows' command-line length ceiling, the explicit '-' keeps parsing
  // unambiguous when the prompt itself contains paths, quotes, or control markers.
  args.push(promptOnStdin ? '-' : value);
  return { args, stdin: promptOnStdin ? value : null, streaming: true };
}

function parseEvent(line) {
  const s = String(line == null ? '' : line).trim();
  if (!s) return null;
  let j = null;
  try { j = JSON.parse(s); } catch { return null; }
  if (!j || typeof j !== 'object') return null;
  const type = String(j.type || '');
  const isError = type === 'turn.failed' || type === 'error';
  // Codex 0.146 emits assistant output as:
  // { type: 'item.completed', item: { type: 'agent_message', text: '...' } }
  // Older probes exposed text at the top level, so keep both shapes. Dropping the nested shape
  // made every successful 0.146 headless turn resolve with an empty string.
  const itemText = type === 'item.completed' && j.item && j.item.type === 'agent_message'
    ? j.item.text
    : null;
  const text = isError
    ? String((j.error && j.error.message) || j.message || 'codex error')
    : String(itemText || j.text || j.message || '');
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
