'use strict';

// Effective config = defaults ◄ env (MAVIS_*) ◄ settings.json (file wins).
// `config.load(userDataDir)` builds the merged config after app is ready;
// the default export (env/defaults, no userData) keeps top-level importers working.

const path = require('path');
const fs = require('fs');
const harnessRegistry = require('./harness');

function compute(userDataDir) {
  let file = {};
  if (userDataDir) {
    try {
      const o = JSON.parse(fs.readFileSync(path.join(userDataDir, 'settings.json'), 'utf8'));
      if (o && typeof o === 'object') file = o;
    } catch { file = {}; }
  }
  const pick = (fileKey, envKey, def) => {
    const fv = file[fileKey];
    if (fv !== undefined && fv !== null && fv !== '') return fv;
    if (envKey && process.env[envKey] !== undefined) return process.env[envKey];
    return def;
  };

  const BRAIN_ROOT = pick('brainRoot', 'MAVIS_BRAIN_ROOT', path.resolve(__dirname, '..', '..'));
  const HARNESS = harnessRegistry.normalizeId(pick('harness', 'MAVIS_HARNESS', 'claude'));
  // Each adapter owns the slash command that loads Mavis in ITS OWN CLI (claude: /mavis,
  // codex: /prompts:mavis). A configured override still wins — but only when it is GENUINELY
  // custom. A configured value that IS some harness's built-in command is not a preference, it is a
  // leftover from when that harness owned the pane, so it is ignored in favour of the built-in for
  // the harness actually being launched. Passing it through instead types a command the CLI does not
  // have: on 2026-07-30 settings.json held autorunCommand '/prompts:mavis' with harness 'claude',
  // and every Claude pane autoran it, answering "Unknown command: /prompts:mavis" plus a stray
  // "Args from unknown skill: <project>" from the label main.js appends.
  const builtinAutorun = new Set(harnessRegistry.ids.map((id) => harnessRegistry.get(id).autorunCommand));
  const autorunCommandForHarness = (harness) => {
    const builtin = harnessRegistry.get(harnessRegistry.normalizeId(harness)).autorunCommand;
    const configured = pick('autorunCommand', 'MAVIS_AUTORUN_COMMAND', null);
    if (configured === null) return builtin;
    const s = String(configured);
    return builtinAutorun.has(s) ? builtin : s;
  };
  return {
    BRAIN_ROOT,
    PROJECTS_INDEX: path.join(BRAIN_ROOT, 'projects', '_index.md'),
    PTY_CWD: pick('cwd', 'MAVIS_CWD', BRAIN_ROOT),
    AUTORUN_COMMAND: autorunCommandForHarness(HARNESS),
    autorunCommandForHarness,
    AUTORUN_DELAY_MS: Number(pick('autorunDelayMs', 'MAVIS_AUTORUN_DELAY', 1500)),
    AUTORUN_ENTER_DELAY_MS: Number(pick('autorunEnterDelayMs', 'MAVIS_AUTORUN_ENTER_DELAY', 300)),
    TERMINAL_FONT_SIZE: Number(pick('terminalFontSize', 'MAVIS_TERMINAL_FONT_SIZE', 13)),
    APP_THEME: pick('appTheme', 'MAVIS_APP_THEME', 'light'),
    // On/Off now (was unwatched/always/off) — coerce any legacy non-'off' value to 'always'
    NOTIFY_ON_COMPLETE: pick('notifyOnComplete', 'MAVIS_NOTIFY_ON_COMPLETE', 'always') === 'off' ? 'off' : 'always',
    NOTIFY_SOUND: pick('notifySound', 'MAVIS_NOTIFY_SOUND', 'chime'),
    NOTIFY_VOLUME: Number(pick('notifyVolume', 'MAVIS_NOTIFY_VOLUME', 60)),
    DAILYOPS_OFF_DAYS: pick('dailyOpsOffDays', 'MAVIS_DAILYOPS_OFF_DAYS', '6,0'),
    // where "New project → create folder" puts new folders; defaults to the brain's parent dir
    // (e.g. C:\Users\…\Documents\Projects), which is where the real project code already lives.
    PROJECTS_ROOT: pick('projectsRoot', 'MAVIS_PROJECTS_ROOT', path.dirname(BRAIN_ROOT)),
    VIZ_ROOT: pick('vizRoot', 'MAVIS_VIZ_ROOT', path.resolve(__dirname, '..', '..', 'viz')),
    // Optional Project Board integration, OFF unless the user turns it on (settings-store:
    // pmEnabled). Stored as the 'on'/'off' string that the settings dropdown produces, but every
    // consumer wants a boolean, so the conversion happens exactly once, here. The env override is
    // deliberately lenient (1/true/yes/on) — an env var is hand-typed, a dropdown is not.
    PM_ENABLED: /^(on|1|true|yes)$/i.test(String(pick('pmEnabled', 'MAVIS_PM_ENABLED', 'off'))),
    // Base URL of that board's API. The default is the public hosted instance pm-client.js was
    // written against; Settings ("Project board API base URL") or MAVIS_PM_BASE repoints it at
    // your own deployment.
    PM_BASE_URL: pick('pmBaseUrl', 'MAVIS_PM_BASE', 'https://pm.trlabs.my'), // leak-guard-allow: public product, and the value is a user-changeable default
    // permission mode for embedded claude sessions (Settings → "How Mavis runs"):
    // default | acceptEdits | plan | yolo. 'yolo' → --dangerously-skip-permissions. See pty-session.
    PERMISSION_MODE: pick('permissionMode', 'MAVIS_PERMISSION_MODE', 'default'),
    // Global default harness for new sessions. normalizeId guarantees a valid id even if
    // settings.json was hand-edited to something that no longer exists.
    HARNESS,
  };
}

const defaults = compute(null);
module.exports = Object.assign({}, defaults, { load: compute, defaults });
