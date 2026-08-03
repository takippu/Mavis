'use strict';

// User settings persisted to userData/settings.json. SCHEMA is the single source
// of truth for the renderer form + the config.js merge (keys, defaults, validation,
// and whether a change applies live or needs a restart).

const fs = require('fs');
const path = require('path');

const SCHEMA = {
  brainRoot: { type: 'string', label: 'Brain folder', applies: 'restart', default: '' },
  // Blank is the RIGHT value here, not a missing one: config.js then picks each pane's own built-in
  // (/mavis for Claude, /prompts:mavis for Codex). Pinning either literal made the other harness's
  // panes autorun a command their CLI does not have, so config.js now ignores a value that matches
  // any harness built-in — only a genuinely custom command survives, and it applies to both.
  autorunCommand: {
    type: 'string', label: 'Autorun command', applies: 'restart', default: '',
    placeholder: 'blank = per-agent default (/mavis, Codex /prompts:mavis)',
  },
  autorunDelayMs: { type: 'number', label: 'Autorun delay (ms)', applies: 'restart', default: 1500, clamp: [0, 10000] },
  // How embedded Mavis sessions run re: permissions. 'yolo' maps to --dangerously-skip-permissions in
  // pty-session; the rest map to --permission-mode. 'auto' is intentionally NOT offered (it opens Claude's
  // Agent View where Esc kills the process → a dead pane, the bug 0.2.6 fixed). Applies to NEW sessions.
  permissionMode: {
    type: 'string', label: 'How Mavis runs (permissions)', applies: 'restart', default: 'default',
    enum: ['default', 'acceptEdits', 'plan', 'yolo'],
    enumLabels: {
      default: 'Ask before edits & commands (default)',
      acceptEdits: 'Auto-accept file edits — still ask for commands',
      plan: 'Plan mode — read-only, proposes a plan',
      yolo: 'YOLO — skip ALL permission prompts (dangerous)',
    },
  },
  // Which agent CLI new sessions spawn by default. Per-session choice overrides it in the launcher.
  // The renderer filters these options by harness.available(), so a machine without Codex installed
  // never sees the option at all.
  harness: {
    type: 'string', label: 'Default agent', applies: 'restart', default: 'claude',
    enum: ['claude', 'codex'],
    enumLabels: { claude: 'Claude Code', codex: 'Codex' },
  },
  appTheme: {
    type: 'string', label: 'App theme', applies: 'live', default: 'light',
    enum: ['light', 'sepia', 'slate', 'pine', 'morflax', 'ink', 'nocturne', 'xai', 'resend'],
    enumLabels: {
      light: 'Steep Light', sepia: 'Sepia', slate: 'Slate', pine: 'Pine', morflax: 'Morflax',
      ink: 'Ink — dark', nocturne: 'Nocturne — dark', xai: 'xAI Void — dark', resend: 'Resend Obsidian — dark',
    },
  },
  terminalFontSize: { type: 'number', label: 'Terminal font size', applies: 'live', default: 13, clamp: [8, 32] },
  notifyOnComplete: {
    type: 'string', label: 'Notify when a request finishes', applies: 'live', default: 'always',
    enum: ['always', 'off'],
    enumLabels: { always: 'On — sound + popup + tab blink when you\'re away', off: 'Off' },
  },
  notifySound: {
    type: 'string', label: 'Completion sound', applies: 'live', default: 'chime',
    enum: ['chime', 'ping', 'marimba', 'none'],
    enumLabels: { chime: 'Chime', ping: 'Ping', marimba: 'Marimba', none: 'None' },
  },
  notifyVolume: { type: 'number', label: 'Sound volume', applies: 'live', default: 60, clamp: [0, 100] },
  // DailyOps off-days: CSV of JS getDay() indices (0=Sun … 6=Sat). Default Sat+Sun. The standup
  // generator treats these as non-working days when building "Previous Work Day".
  dailyOpsOffDays: { type: 'weekdays', label: 'DailyOps off-days', applies: 'live', default: '6,0' },
  // default parent folder for "New project → create folder"; empty = config default (brain's parent).
  projectsRoot: { type: 'string', label: 'Projects root (for new project folders)', applies: 'live', default: '' },
  // The Project Board tab is an OPTIONAL integration and ships OFF. It talks to an external
  // project-management service; a fresh clone has no account there, so mounting the tab for
  // everyone would be a dead affordance pointing at a stranger's server. app.js only builds the
  // nav item + the Settings card when this is 'on' — hence applies: 'restart', because the
  // sidebar is built once at boot (see mountPmFeature in renderer/app.js).
  //
  // Spelled as an on/off enum rather than a raw boolean on purpose: settings-view.js renders
  // `enum` keys as a dropdown and has no boolean widget, and notifyOnComplete already
  // establishes on/off-as-enum as how this schema expresses a two-state switch. config.js
  // converts it to a real boolean (PM_ENABLED) for the code that actually gates on it.
  pmEnabled: {
    type: 'string', label: 'Project board tab', applies: 'restart', default: 'off',
    enum: ['off', 'on'],
    enumLabels: { off: 'Hidden', on: 'Show the Project Board tab' },
  },
  // Where that board lives. The default is the public hosted instance this client was written
  // against (open registration); point it at your own deployment instead — the API shape it
  // expects is documented at the top of pm-client.js.
  pmBaseUrl: {
    // A public product with open registration, and this is only a default the user can repoint at
    // their own instance. The PM tab ships disabled, so a stranger never reaches this URL unless
    // they deliberately turn the feature on.
    type: 'string', label: 'Project board API base URL', applies: 'restart', default: 'https://pm.trlabs.my', // leak-guard-allow
    placeholder: 'https://pm.example.com',
  },
};

function file(userDataDir) {
  return path.join(userDataDir, 'settings.json');
}

function read(userDataDir) {
  try {
    const o = JSON.parse(fs.readFileSync(file(userDataDir), 'utf8'));
    return o && typeof o === 'object' ? o : {};
  } catch {
    return {};
  }
}

function coerce(key, value) {
  const s = SCHEMA[key];
  if (!s) return undefined;
  if (s.type === 'number') {
    let v = Number(value);
    if (Number.isNaN(v)) return undefined;
    if (s.clamp) v = Math.max(s.clamp[0], Math.min(s.clamp[1], v));
    return v;
  }
  if (s.type === 'weekdays') {
    // normalize to a sorted, de-duped CSV of valid 0–6 indices; empty input → the schema default
    const set = Array.from(new Set(String(value)
      .split(',').map((x) => parseInt(x, 10)).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6)))
      .sort((a, b) => a - b);
    return set.length ? set.join(',') : s.default;
  }
  let v = String(value);
  if (s.enum && !s.enum.includes(v)) return undefined;
  return v;
}

function write(userDataDir, patch) {
  const next = read(userDataDir);
  for (const k in (patch || {})) {
    const v = coerce(k, patch[k]);
    if (v !== undefined) next[k] = v;
  }
  next.version = 1;
  try {
    const dest = file(userDataDir);
    const tmp = dest + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
    fs.renameSync(tmp, dest);
  } catch { /* best-effort */ }
  return next;
}

module.exports = { SCHEMA, read, write, coerce };
