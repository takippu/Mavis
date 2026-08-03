'use strict';

const { app, BrowserWindow, ipcMain, shell, Notification, dialog, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const { fileURLToPath } = require('url');

const config = require('./config');
const harnessRegistry = require('./harness');
const { SessionManager } = require('./session-manager');
const { listProjectsWithDirs, getDashboardData, getProjectDetail, searchBrain, listDailyMemories, getDailyMemory, listTopics, getMavisConfig, getIdentityFacets, mavisFilePath, readCategoryIndex, listCategoryEntries, listMcpServers, listSkills, invalidate: invalidateBrainStats } = require('./brain-stats');
const { startBrainWatch } = require('./brain-watch');
const { createHealthMonitor, createRepairGate } = require('./brain-health');
const sessionState = require('./session-state');
const fsBrowser = require('./fs-browser');
const settingsStore = require('./settings-store');
const mavisWriter = require('./mavis-config-writer');
const tokenStore = require('./token-store');
const gitTokenStore = require('./git-token-store');
const projectWriter = require('./project-writer');
const pmClient = require('./pm-client');
const dailyops = require('./dailyops');
const dailyopsAgent = require('./dailyops-agent');
const brainChat = require('./brain-chat');
const vizBuild = require('./viz-build');
const vizServer = require('./viz-server');
const toastWindow = require('./toast-window');
const sessionEvents = require('./session-events');

let win = null;
let sessions = null;
let userDataDir = null;
let cfg = config; // default export until app is ready, then config.load(userData)
let brainWatch = null;
let sessionReader = null; // status sidecar: token -> session id -> 'session:state' push
let brainHealth = null; // lint report cache; survives view nav because it lives in main, not a view
let repairGate = null;  // preview -> approve -> apply gate; holds previewed plans (see brain-health.js)
let terminalFocused = false; // a terminal pane has DOM focus → keep Ctrl+R for the CLI's reverse search
const notifiedSessions = new Set(); // sessions already alerted this attention episode

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// ---- brain root resolution ----
// A Mavis brain is a checkout of this repo. Detect it by the CONTRACT file at the root plus one
// more marker, because requiring the data dirs alone would reject a fresh clone (identity/,
// projects/, daily-memories/ are gitignored and only appear after the setup wizard runs), and
// accepting a lone CLAUDE.md would let ANY Claude Code project pass as a brain.
function isBrainRoot(dir) {
  if (!dir) return false;
  const has = (...parts) => { try { return fs.existsSync(path.join(dir, ...parts)); } catch { return false; } };
  const contract = has('AGENTS.md') || has('CLAUDE.md');
  const brainish = has('SETUP.md') || has('identity') || has('projects') || has('daily-memories');
  return contract && brainish;
}

// Where a packaged build looks for the brain when nothing is configured. Packaged __dirname lives
// inside app.asar, so config.js's __dirname-relative default would point INSIDE the bundle — we
// have to name real directories. These are guesses by design: the first one that actually IS a
// brain wins, and if none is, the first is returned anyway so the user is told about a plausible
// path rather than about the bundle's insides.
function defaultBrainRoot(home) {
  // `Mavis` first, since that is the repository's name and what a fresh `git clone` produces.
  // The older `MavisCode` names are kept behind it so an existing install keeps resolving after
  // the rename -- dropping them would silently break every machine that cloned before it.
  const candidates = [
    path.join(home, 'Mavis'),
    path.join(home, 'Projects', 'Mavis'),
    path.join(home, 'Documents', 'Mavis'),
    path.join(home, 'Documents', 'Projects', 'Mavis'),
    path.join(home, 'MavisCode'),
    path.join(home, 'Projects', 'MavisCode'),
    path.join(home, 'Documents', 'MavisCode'),
    path.join(home, 'Documents', 'Projects', 'MavisCode'),
  ];
  return candidates.find(isBrainRoot) || candidates[0];
}

// An unusable brain root must SAY so. Before this existed, a release build pointed at one
// hardcoded absolute path; on any machine where that folder was missing every view rendered
// empty — no error, no hint, nothing to click. So: tell the user, and let them fix it in place.
// The choice is persisted through settings-store (the `brainRoot` key, which config.load's merge
// already prefers over the env), so the prompt appears at most once.
function promptForBrainRoot(current) {
  const choice = dialog.showMessageBoxSync({
    type: 'warning',
    title: 'Mavis brain not found',
    message: 'No Mavis brain at:\n' + current,
    detail: 'Mavis-Terminal reads a brain folder — your clone of the Mavis repo (the one holding AGENTS.md and SETUP.md).\n\n'
      + 'Pick that folder now, or continue and set it later in Settings → Brain folder. Until it points at a real brain, the brain views will be empty.',
    buttons: ['Choose folder...', 'Continue anyway'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });
  if (choice !== 0) return null;
  const picked = dialog.showOpenDialogSync({
    title: 'Select your Mavis brain folder',
    properties: ['openDirectory'],
    defaultPath: fs.existsSync(current) ? current : app.getPath('home'),
  });
  const dir = picked && picked[0];
  if (!dir) return null;
  // Persist even when it doesn't look like a brain either — the user may be pointing at a clone
  // that is mid-checkout, and re-prompting on the next boot is a gentler correction than refusing.
  settingsStore.write(userDataDir, { brainRoot: dir });
  return dir;
}

function settingsValues() {
  return {
    brainRoot: cfg.BRAIN_ROOT,
    autorunCommand: cfg.AUTORUN_COMMAND,
    autorunDelayMs: cfg.AUTORUN_DELAY_MS,
    terminalFontSize: cfg.TERMINAL_FONT_SIZE,
    appTheme: cfg.APP_THEME,
    notifyOnComplete: cfg.NOTIFY_ON_COMPLETE,
    notifySound: cfg.NOTIFY_SOUND,
    notifyVolume: cfg.NOTIFY_VOLUME,
    dailyOpsOffDays: cfg.DAILYOPS_OFF_DAYS,
    projectsRoot: cfg.PROJECTS_ROOT,
    harness: cfg.HARNESS,
  };
}

function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 560,
    frame: false,
    show: false,
    backgroundColor: '#f7f7f8',
    title: 'Mavis-Terminal',
    icon: path.join(__dirname, 'renderer', 'assets', 'mavis-logo.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true, // Map view embeds the local viz/dist graph (guarded below)
      // The completion chime is Web Audio fired from a timer, not a user gesture — Chromium's
      // default autoplay policy keeps the AudioContext suspended there, so no sound. This is a
      // desktop app the user owns; lift the gesture requirement so the chime always plays.
      autoplayPolicy: 'no-user-gesture-required',
      // Keep the renderer running at full speed while the window is in the BACKGROUND / minimized.
      // Chromium throttles (and can freeze) a backgrounded window's timers + audio, so the completion
      // chime wouldn't actually PLAY until you came back to the app — it queued and fired on focus
      // ("only fires when I go back to the terminal"). Disabling throttling lets the chime + toast fire
      // the moment a turn ends, even while you're in another app. (Slight idle CPU when minimized —
      // an acceptable cost for a notifier.)
      backgroundThrottling: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => { win.maximize(); win.show(); });
  // Chromium's default Ctrl+R / Ctrl+Shift+R / F5 reload accelerators are live even with no
  // app menu bar shown (frameless window) — an accidental hit nukes the whole renderer (every
  // open tab, in-progress Ask-Mavis turn) with zero warning. Intercept and hand off to the
  // renderer's themed MT.confirm dialog (native dialog.showMessageBoxSync clashed with the
  // Steep in-app design) before actually reloading.
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const key = (input.key || '').toLowerCase();
    const ctrlR = key === 'r' && (input.control || input.meta);
    const isReloadCombo = ctrlR || key === 'f5';
    if (!isReloadCombo) return;
    // Plain Ctrl/Cmd+R while a terminal pane is focused is the CLI's reverse history
    // search (command search) — let the pty have it, don't hijack it as a reload. The
    // hard-reload combos (Shift+R, F5) are never terminal shortcuts, so they always
    // fall through to the reload guard and stay reachable even inside a terminal.
    if (ctrlR && !input.shift && terminalFocused) return;
    event.preventDefault();
    send('reload:confirm-request', { hardReload: input.shift });
  });
  win.on('maximize', () => send('win:state', { maximized: true }));
  win.on('unmaximize', () => send('win:state', { maximized: false }));
  // attending the window clears the taskbar flash + the per-session alert dedupe
  win.on('focus', () => { try { win.flashFrame(false); } catch { /* noop */ } notifiedSessions.clear(); });
  win.on('closed', () => { win = null; toastWindow.destroy(); if (sessions) sessions.closeAll(); dailyopsAgent.cancelAll(); brainChat.cancelAll(); });
}

app.whenReady().then(() => {
  // Windows ties native toasts to a registered AppUserModelID — without this the
  // Notification is created but silently never shown (the sound + taskbar flash still work).
  // MUST stay byte-identical to `build.appId` in package.json: the installer registers the
  // shortcut under that id, and a toast raised under any other id is dropped by the OS.
  try { app.setAppUserModelId('com.mavis.mavisterminal'); } catch { /* non-Windows */ }
  // diagnostics: when MT_DIAG is set, start each run with a fresh log so a single repro is clean.
  if (process.env.MT_DIAG) { try { const f = path.join(app.getPath('temp'), 'mt-diag.log'); fs.writeFileSync(f, ''); console.log('[mt-diag] logging to', f); } catch { /* noop */ } }
  // clicking a toast → bring the main window forward + jump to that session
  toastWindow.setHandlers({ onActivate: (id) => { try { if (win && !win.isDestroyed()) { win.show(); win.focus(); } } catch { /* noop */ } if (id) send('activate-session', { id }); } });
  userDataDir = app.getPath('userData');
  // Status sidecar: write the emitter, clear any crash leftovers, and start the reader. Each agent
  // spawn bakes its own token into its hook command (pty-session), so a line landing in
  // <userData>/session-events/<token>.jsonl identifies the pane that produced it. MAVIS_USER_DATA
  // must be set before any session is created — pty-session's hookSpawnConfig call resolves it from
  // this env var, not from an argument. Best-effort throughout: on any failure here a session still
  // spawns fine, it just doesn't report status (see session-events.js's file-level comment).
  process.env.MAVIS_USER_DATA = userDataDir;
  sessionEvents.ensure(userDataDir);
  sessionEvents.sweep(userDataDir);
  // Packaged: __dirname lives inside app.asar, so config's __dirname-relative brain/viz defaults
  // would point inside the bundle. Resolve a real directory instead, in this order:
  //   1. settings.json `brainRoot` (settings-store's key) — read here rather than left to
  //      config.load so the VIZ default below is derived from the SAME root. Previously viz was
  //      pinned to the home-dir guess while the brain came from settings, so a user who moved
  //      their brain got a Map view pointed at a folder that no longer had a viz build.
  //   2. MAVIS_BRAIN_ROOT from the environment.
  //   3. the first plausible home-dir location that actually contains a brain.
  // Dev is untouched: config.js keeps resolving relative to the repo.
  if (app.isPackaged) {
    const configured = String(settingsStore.read(userDataDir).brainRoot || '').trim();
    const brain = configured || process.env.MAVIS_BRAIN_ROOT || defaultBrainRoot(app.getPath('home'));
    process.env.MAVIS_BRAIN_ROOT = brain;
    if (!process.env.MAVIS_VIZ_ROOT) process.env.MAVIS_VIZ_ROOT = path.join(brain, 'viz');
  }
  cfg = config.load(userDataDir);
  // Whatever the resolution path, the root may still not be a brain (never configured, folder
  // moved or renamed, brainRoot typo'd by hand). Everything downstream — dashboard, projects,
  // search, the health lint — reads that directory, so a wrong root is indistinguishable from an
  // empty brain unless we say so. Ask once, then carry on with whatever we ended up with.
  if (!isBrainRoot(cfg.BRAIN_ROOT)) {
    console.error('[brain] not a Mavis brain:', cfg.BRAIN_ROOT);
    const picked = promptForBrainRoot(cfg.BRAIN_ROOT);
    if (picked) {
      process.env.MAVIS_BRAIN_ROOT = picked;
      process.env.MAVIS_VIZ_ROOT = path.join(picked, 'viz'); // unconditional: the old value named the old brain
      cfg = config.load(userDataDir); // settings.json now carries brainRoot, so this re-merge picks it up
    }
  }
  process.env.MAVIS_PERMISSION_MODE = cfg.PERMISSION_MODE; // permission mode for claude spawns (pty-session)
  sessions = new SessionManager({
    onData: (id, data) => send('pty-data', { id, data }),
    onExit: (id, code) => send('pty-exit', { id, code }),
  });
  // token -> session id, resolved per event. Cheap: the map is at most one entry per open tab. A
  // token with no live session (pane already closed, or a leftover from before this boot) is
  // silently dropped rather than pushed — the renderer has nothing to attach it to.
  sessionReader = sessionEvents.createReader({
    userDataDir,
    onState: ({ token, state }) => {
      const id = sessions.idForToken(token);
      if (id) send('session:state', { id, state });
    },
  });
  sessionReader.start();
  createWindow();
  // Brain rot monitor: re-lints (debounced) on every brain write and pushes the report to the
  // renderer. It shells out to the brain's own scripts/lint-brain.mjs -- the app never edits brain
  // files. Bound to cfg.BRAIN_ROOT at boot, same lifecycle as brainWatch above.
  brainHealth = createHealthMonitor({
    brainRoot: cfg.BRAIN_ROOT,
    onUpdate: (report) => send('brain:health-changed', report), // send() already guards a destroyed win
    // A lint that cannot run (missing script, exit 2) must not vanish silently -- the card would
    // just sit on a stale report with no clue why. Keep the last good report, but say so.
    onError: (e) => console.error('[brain-health] lint failed:', e && e.message),
  });
  // The gated Fix flow. Bound to the same cfg.BRAIN_ROOT as the monitor, so a preview and its
  // apply can never disagree about which brain they mean.
  repairGate = createRepairGate({ brainRoot: cfg.BRAIN_ROOT });
  brainWatch = startBrainWatch(cfg.BRAIN_ROOT, (p) => {
    invalidateBrainStats();
    send('brain-changed', p);
    brainHealth.schedule(); // debounced; a burst of writes collapses into one lint
  });
  // Warm the cache once at boot. If this lands before the renderer subscribes, nothing is lost:
  // the card calls brain:health on mount and gets the cached report back.
  brainHealth.run();
});

// Lock down <webview>: only the local loopback viz server, no node, no remote/new-window.
app.on('web-contents-created', (_e, contents) => {
  contents.on('will-attach-webview', (event, webPreferences, params) => {
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    const base = vizServer.getBaseUrl();
    const src = String(params.src || '');
    // exact loopback-base prefix (incl. the random port) — nothing else may attach
    if (!base || !src.startsWith(base)) event.preventDefault();
  });
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
});

// ---- window controls ----
ipcMain.on('win:minimize', () => win && win.minimize());
ipcMain.on('win:maximize', () => { if (!win) return; win.isMaximized() ? win.unmaximize() : win.maximize(); });
ipcMain.on('win:close', () => win && win.close());
// The renderer reports terminal focus so the reload guard can let Ctrl+R (reverse search)
// through to the CLI while a terminal is focused (see before-input-event above).
ipcMain.on('ui:terminal-focused', (_e, v) => { terminalFocused = !!v; });
ipcMain.on('reload:confirm-response', (_e, { ok, hardReload } = {}) => {
  if (!ok || !win || win.isDestroyed()) return;
  if (hardReload) win.webContents.reloadIgnoringCache();
  else win.webContents.reload();
});

// ---- sessions ----
ipcMain.handle('create-session', async (_e, opts = {}) => {
  const cwd = opts.cwd || cfg.PTY_CWD;
  const kind = opts.kind === 'shell' ? 'shell' : 'mavis';
  const label = opts.label || (kind === 'shell' ? 'Shell' : 'Mavis');
  // Mavis panes auto-run the selected harness's Mavis command (project-scoped when a project
  // label is given); shell panes don't.
  // The RENDERER now drives the autorun (it waits for the CLI's input prompt to be interactive via
  // tui-detect before typing, then verifies the Enter actually submitted) — far more reliable than a
  // blind fixed-delay timer here, which could type into a not-yet-ready CLI / a "trust this folder?"
  // prompt, or have its lone \r swallowed by the TUI repaint. So we return the resolved command for
  // the renderer to run, and do NOT pass `autorun` to sessions.create (no main-side typing).
  // The renderer may omit `harness` (older callers, shell panes) or pass one explicitly (the
  // per-session picker, or a restored tab's persisted value). Default HERE, server-side, to
  // cfg.HARNESS rather than trusting the renderer to always know it — session-manager's own
  // fallback is a hardcoded 'claude', which would silently ignore a user who set Codex as their
  // default agent. resolveInstalled (not normalizeId) so a configured/restored id that is no
  // longer on PATH degrades to an installed harness instead of failing every session with no
  // visible control to fix it — see Finding 2, 2026-07-26 review. This reconciles BOTH the
  // no-override default (cfg.HARNESS) and an explicit/restored request (opts.harness) the same
  // way, a deliberate choice: a restored Codex tab on a machine that lost Codex would otherwise be
  // a permanently broken pane, which the "claude-only machine behaves exactly as before" invariant
  // does not carve out an exception for.
  const harness = kind === 'shell' ? undefined : harnessRegistry.resolveInstalled(opts.harness || cfg.HARNESS);
  const autorunCommand = kind === 'shell' ? null : cfg.autorunCommandForHarness(harness);
  const command = opts.cwd && opts.label ? autorunCommand + ' ' + opts.label : autorunCommand;
  const autorun = kind === 'shell' ? null : { command, enterDelayMs: cfg.AUTORUN_ENTER_DELAY_MS };
  try {
    const res = sessions.create({ cwd, cols: opts.cols, rows: opts.rows, label, kind, harness });
    if (!res.ok) return { ok: false, reason: res.reason };
    return { ok: true, id: res.id, label, cwd, kind, harness: res.harness, autorun };
  } catch (e) {
    console.error('[create-session] spawn failed:', e.message);
    return { ok: false, reason: e.message };
  }
});
ipcMain.on('pty-input', (_e, msg) => { if (msg && typeof msg === 'object') sessions.write(msg.id, msg.data); });
ipcMain.on('pty-resize', (_e, msg) => { if (msg && typeof msg === 'object') sessions.resize(msg.id, msg.cols, msg.rows); });
ipcMain.on('close-session', (_e, msg) => { if (msg && typeof msg === 'object') sessions.close(msg.id); });
// ids of harnesses actually installed on this machine — the single source of truth Settings, the
// per-session picker, and the tab badge all filter against (see src/harness/index.js available()).
ipcMain.handle('harness:available', async () => {
  try { return harnessRegistry.available(); } catch { return ['claude']; }
});

// ---- data ----
ipcMain.handle('list-projects', async () => {
  try { return listProjectsWithDirs(cfg.BRAIN_ROOT); } catch { return []; }
});
ipcMain.handle('get-dashboard-data', async () => {
  try { return getDashboardData(cfg.BRAIN_ROOT); }
  catch (e) { console.error('[get-dashboard-data] failed:', e.message); return { counts: {}, recent: [], activity: [], specs: [] }; }
});
ipcMain.handle('get-project-detail', async (_e, slug) => {
  try { return getProjectDetail(cfg.BRAIN_ROOT, slug); } catch { return null; }
});
ipcMain.handle('search-brain', async (_e, q) => {
  try { return searchBrain(cfg.BRAIN_ROOT, q); } catch { return []; }
});
ipcMain.handle('daily-memories:list', async () => {
  try { return listDailyMemories(cfg.BRAIN_ROOT); } catch { return []; }
});
ipcMain.handle('daily-memory:get', async (_e, date) => {
  try { return getDailyMemory(cfg.BRAIN_ROOT, date); } catch { return null; }
});
ipcMain.handle('topics:list', async () => {
  try { return listTopics(cfg.BRAIN_ROOT); } catch { return []; }
});
ipcMain.handle('brain:cat-entries', async (_e, category) => {
  try { return listCategoryEntries(cfg.BRAIN_ROOT, category); } catch { return []; }
});
ipcMain.handle('brain:cat-index', async (_e, category) => {
  try { return readCategoryIndex(cfg.BRAIN_ROOT, category); } catch { return []; }
});
ipcMain.handle('brain:mcp-servers', async () => {
  try { return listMcpServers(cfg.BRAIN_ROOT); } catch { return []; }
});
ipcMain.handle('brain:skills', async () => {
  try { return listSkills(cfg.BRAIN_ROOT); } catch { return []; }
});
// Last cached lint report, or null before the first run lands (the card renders a pending state).
// Push updates arrive separately on the 'brain:health-changed' channel.
ipcMain.handle('brain:health', async () => {
  try { return brainHealth ? brainHealth.last() : null; } catch { return null; }
});
// ---- brain repair (the gated Fix flow) ----
// THE TRUST BOUNDARY: the renderer names a repair ({command, project}) and NOTHING ELSE -- no
// paths, no content. Main derives every path from cfg.BRAIN_ROOT and validates command+project
// (allowlist + regex + must be a real dir under projects/) BEFORE any process is spawned. Same
// posture as git:*: a renderer can never point the repairer at a directory main didn't choose.
//
// The split is the whole point: preview writes nothing, apply writes only a plan the user has
// already seen. There is deliberately no combined "just fix it" call for a caller to reach for.
const repairArgs = (payload) => {
  const p = payload && typeof payload === 'object' ? payload : {};
  return { command: String(p.command == null ? '' : p.command), project: String(p.project == null ? '' : p.project) };
};
ipcMain.handle('brain:repair-preview', async (_e, payload) => {
  if (!repairGate) return { error: 'EINIT: repair is not ready yet' };
  try { return await repairGate.preview(repairArgs(payload)); }
  catch (e) { return { error: e && e.message ? e.message : String(e) }; }
});
ipcMain.handle('brain:repair-apply', async (_e, payload) => {
  if (!repairGate) return { error: 'EINIT: repair is not ready yet' };
  try {
    const res = await repairGate.apply(repairArgs(payload));
    // A successful repair changes the very files the linter grades -- re-lint now rather than
    // waiting on the watcher, so the card reflects the fix immediately.
    if (res && res.applied) { invalidateBrainStats(); if (brainHealth) brainHealth.run(); }
    return res;
  } catch (e) { return { error: e && e.message ? e.message : String(e) }; }
});

ipcMain.handle('brain:identity-facets', async () => {
  try { return getIdentityFacets(cfg.BRAIN_ROOT); }
  catch { return { profile: { name: '', pronouns: '' }, personality: [], communication: [], coreOaths: [] }; }
});
ipcMain.handle('mavis-config:get', async () => {
  try { return getMavisConfig(cfg.BRAIN_ROOT); } catch { return {}; }
});
ipcMain.handle('mavis-config:open', async (_e, key) => {
  try {
    const p = mavisFilePath(cfg.BRAIN_ROOT, key); // whitelist-resolved only
    if (p && fs.existsSync(p)) { await shell.openPath(p); return { ok: true }; }
  } catch { /* noop */ }
  return { ok: false };
});
// Compose-only (no write) — returns { ok, before, after, changed } for the Review diff.
ipcMain.handle('mavis-config:preview', async (_e, payload) => {
  const p = payload && typeof payload === 'object' ? payload : {};
  try { return mavisWriter.preview(cfg.BRAIN_ROOT, p.key, p.op); } catch (e) { return { ok: false, error: e.message }; }
});
// Surgical section/frontmatter/preference write, guarded (aborts if a ## heading would be
// lost) + atomic. Only profile/personality/communication/preferences are writable.
ipcMain.handle('mavis-config:save', async (_e, payload) => {
  const p = payload && typeof payload === 'object' ? payload : {};
  try { const r = mavisWriter.save(cfg.BRAIN_ROOT, p.key, p.op); if (r && r.ok) invalidateBrainStats(); return r; }
  catch (e) { return { ok: false, error: e.message }; }
});
// Two-tier entry writes (Phase 2.4) — add/edit/supersede a preferences / rules / topics entry,
// guarded + atomic (mavis-config-writer). prefs+rules use a Rule/Why/How body, topics Did/Refs/Pre-empt.
const ENTRY_EDITABLE = new Set(['preferences', 'rules', 'topics']);
function entryOp(p, write) {
  if (!ENTRY_EDITABLE.has(p.category)) return { ok: false, error: 'category not editable' };
  if (p.op === 'add') return write ? mavisWriter.addEntry(cfg.BRAIN_ROOT, p.category, p.entry) : mavisWriter.previewAddEntry(cfg.BRAIN_ROOT, p.category, p.entry);
  if (p.op === 'edit') return write ? mavisWriter.editEntry(cfg.BRAIN_ROOT, p.category, p.slug, p.patch) : mavisWriter.previewEditEntry(cfg.BRAIN_ROOT, p.category, p.slug, p.patch);
  if (p.op === 'supersede') return write ? mavisWriter.supersedeEntry(cfg.BRAIN_ROOT, p.category, p.slug, p.opts) : mavisWriter.previewSupersedeEntry(cfg.BRAIN_ROOT, p.category, p.slug, p.opts);
  return { ok: false, error: 'unknown op' };
}
ipcMain.handle('mavis-entry:preview', async (_e, payload) => {
  const p = payload && typeof payload === 'object' ? payload : {};
  try { return entryOp(p, false); } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('mavis-entry:save', async (_e, payload) => {
  const p = payload && typeof payload === 'object' ? payload : {};
  try { const r = entryOp(p, true); if (r && r.ok) invalidateBrainStats(); return r; }
  catch (e) { return { ok: false, error: e.message }; }
});
// Set/clear a project's color (frontmatter `color:` in projects/<slug>/index.md), guarded + atomic.
ipcMain.handle('project:set-color', async (_e, payload) => {
  const p = payload && typeof payload === 'object' ? payload : {};
  try { const r = mavisWriter.saveProjectColor(cfg.BRAIN_ROOT, p.slug, p.color); if (r && r.ok) invalidateBrainStats(); return r; }
  catch (e) { return { ok: false, error: e.message }; }
});

// ---- integrations: PM (read-only), dailyops (standups/), map ----
ipcMain.handle('pm:list', async () => {
  try { return await pmClient.listMyWork(cfg.PM_BASE_URL, tokenStore.getToken(userDataDir)); }
  catch { return { ok: false, reason: 'network' }; }
});
ipcMain.handle('pm:projects', async () => {
  try { return await pmClient.listProjects(cfg.PM_BASE_URL, tokenStore.getToken(userDataDir)); }
  catch { return { ok: false, reason: 'network' }; }
});
ipcMain.handle('pm:project-tasks', async (_e, payload) => {
  const p = payload && typeof payload === 'object' ? payload : {};
  try { return await pmClient.listProjectTasks(cfg.PM_BASE_URL, tokenStore.getToken(userDataDir), p.projectId, { assigneeId: p.assigneeId }); }
  catch { return { ok: false, reason: 'network' }; }
});
ipcMain.handle('pm:task', async (_e, ref) => {
  try { return await pmClient.getTask(cfg.PM_BASE_URL, tokenStore.getToken(userDataDir), ref); }
  catch { return { ok: false, reason: 'network' }; }
});
ipcMain.handle('pm:image', async (_e, key) => {
  try { return await pmClient.getImage(cfg.PM_BASE_URL, tokenStore.getToken(userDataDir), key); }
  catch { return { ok: false, reason: 'network' }; }
});
// terminal context-menu clipboard helpers (image paste): the renderer can't reach the OS image
// clipboard or write a temp file, so main does it. paste-image writes the clipboard image to a
// temp PNG and returns its path for the renderer to feed into the pty (Claude can read the file).
ipcMain.handle('clipboard:has-image', () => {
  try { return !clipboard.readImage().isEmpty(); } catch { return false; }
});
ipcMain.handle('clipboard:paste-image', () => {
  try {
    const img = clipboard.readImage();
    if (img.isEmpty()) return null;
    const file = path.join(app.getPath('temp'), 'mavis-paste-' + Date.now() + '.png');
    fs.writeFileSync(file, img.toPNG());
    // a small thumbnail data URL so the renderer can show a preview chip without
    // touching the filesystem again (the lightbox opens the full-res file:// path).
    const size = img.getSize();
    const thumbW = Math.min(220, size.width || 220);
    const thumb = (size.width ? img.resize({ width: thumbW }) : img).toDataURL();
    return { path: file, thumb, width: size.width, height: size.height };
  } catch { return null; }
});

// app/build version for the sidebar footer (tooltip carries the runtime versions)
ipcMain.handle('app:version', () => ({
  app: app.getVersion(),
  electron: process.versions.electron,
  node: process.versions.node,
  chrome: process.versions.chrome,
}));

ipcMain.handle('pm:set-token', async (_e, t) => tokenStore.setToken(userDataDir, t));
ipcMain.handle('pm:clear-token', async () => tokenStore.clearToken(userDataDir));
ipcMain.handle('pm:token-status', async () => tokenStore.tokenStatus(userDataDir));
ipcMain.handle('dailyops:list', async () => { try { return dailyops.listStandups(cfg.BRAIN_ROOT); } catch { return []; } });
ipcMain.handle('dailyops:context', async () => { try { return dailyops.getContext(cfg.BRAIN_ROOT); } catch { return null; } });
ipcMain.handle('dailyops:save', async (_e, input) => {
  if (!input || typeof input !== 'object') return { ok: false, reason: 'bad-input' };
  try { return dailyops.saveStandup(cfg.BRAIN_ROOT, input); } catch (e) { return { ok: false, reason: e.message }; }
});
// Agent-driven generation (headless CLI, read-only; harness follows cfg.HARNESS) — returns ask/done/message/error.
ipcMain.handle('dailyops:gen-start', async (_e, date) => {
  try { return await dailyopsAgent.genStart(cfg.BRAIN_ROOT, typeof date === 'string' ? date : undefined, cfg.DAILYOPS_OFF_DAYS, cfg.HARNESS); }
  catch (e) { return { kind: 'error', error: e.message }; }
});
ipcMain.handle('dailyops:gen-continue', async (_e, payload) => {
  if (!payload || typeof payload !== 'object') return { kind: 'error', error: 'bad-input' };
  try { return await dailyopsAgent.genContinue(cfg.BRAIN_ROOT, payload.date, payload.sessionId, payload.answers || {}, cfg.HARNESS); }
  catch (e) { return { kind: 'error', error: e.message }; }
});

// ---- create/add project (brain entry always; optional folder/git/remote behind a confirmed plan) ----
ipcMain.handle('projects:root', async () => cfg.PROJECTS_ROOT);
ipcMain.handle('projects:pick-folder', async (_e, opts) => {
  if (!win || win.isDestroyed()) return { canceled: true };
  const o = opts || {};
  try {
    const r = await dialog.showOpenDialog(win, {
      title: o.title || 'Choose a folder',
      defaultPath: o.defaultPath || cfg.PROJECTS_ROOT,
      properties: o.create ? ['openDirectory', 'createDirectory'] : ['openDirectory'],
    });
    return { canceled: r.canceled, path: (r.filePaths && r.filePaths[0]) || null };
  } catch (e) { return { canceled: true, error: e.message }; }
});
ipcMain.handle('projects:plan', async (_e, opts) => {
  try { return { ok: true, lines: projectWriter.planLines(opts || {}) }; }
  catch (e) { return { ok: false, reason: e.message }; }
});
ipcMain.handle('projects:create', async (_e, opts) => {
  const o = opts || {};
  // resolve a saved provider token if the renderer didn't pass one inline
  if (o.remote && o.remote.provider && !o.remote.token) {
    o.remote.token = gitTokenStore.getToken(userDataDir, o.remote.provider);
  }
  try { return await projectWriter.createProject(cfg.BRAIN_ROOT, o); }
  catch (e) { return { ok: false, reason: e.message }; }
});
ipcMain.handle('git-token:status', async (_e, provider) => gitTokenStore.tokenStatus(userDataDir, provider));
ipcMain.handle('git-token:set', async (_e, p) => gitTokenStore.setToken(userDataDir, p && p.provider, p && p.token));
ipcMain.handle('git-token:clear', async (_e, provider) => gitTokenStore.clearToken(userDataDir, provider));
ipcMain.handle('map:status', async () => {
  try {
    const st = vizBuild.mapStatus(cfg.VIZ_ROOT);
    if (st && st.ready) {
      const base = await vizServer.startVizServer(cfg.VIZ_ROOT);
      const url = base ? vizServer.getIndexUrl() : null;
      // built but the loopback preview server couldn't bind — distinct from "not built"
      return url ? { ...st, url } : { ...st, serverError: true };
    }
    return st;
  } catch { return { ready: false }; }
});
ipcMain.handle('map:rebuild', async () => { try { return await vizBuild.rebuild(cfg.VIZ_ROOT); } catch (e) { return { ok: false, reason: e.message }; } });
ipcMain.handle('open-external', async (_e, url) => {
  try { if (typeof url === 'string' && /^https?:\/\//i.test(url)) { await shell.openExternal(url); return { ok: true }; } } catch { /* noop */ }
  return { ok: false };
});
// Open a clickable target detected in the terminal: a URL (external browser) or an existing
// file/folder path (default app / explorer). openPath never executes — it hands the target to the
// OS default handler — and we only open a path that actually exists, so a false-positive match
// (a word that looks path-shaped) silently no-ops instead of doing anything.
ipcMain.handle('terminal:open-target', async (_e, payload) => {
  const p = payload && typeof payload === 'object' ? payload : {};
  const kind = p.kind, value = typeof p.value === 'string' ? p.value.trim() : '';
  if (!value) return { ok: false };
  try {
    if (kind === 'url') {
      if (/^(https?|mailto):/i.test(value)) { await shell.openExternal(value); return { ok: true }; }
      if (/^file:\/\//i.test(value)) { const fp = fileURLToPath(value); if (fs.existsSync(fp)) { await shell.openPath(fp); return { ok: true }; } }
      return { ok: false };
    }
    if (kind === 'path') {
      // strip surrounding quotes and a trailing :line[:col] (compiler/stack-trace style) before probing
      const clean = value.replace(/^["'`]+|["'`]+$/g, '').replace(/:\d+(?::\d+)?$/, '');
      if (fs.existsSync(clean)) { const err = await shell.openPath(clean); return { ok: !err, reason: err || undefined }; }
      if (clean !== value && fs.existsSync(value)) { const err = await shell.openPath(value); return { ok: !err, reason: err || undefined }; }
      return { ok: false };
    }
  } catch { /* noop */ }
  return { ok: false };
});

// ---- brain chat (headless Q&A over the brain, read-only; harness follows cfg.HARNESS) ----
ipcMain.handle('brain-chat:ask', async (_e, q) => {
  try { return await brainChat.ask(cfg.BRAIN_ROOT, dailyops.readName(cfg.BRAIN_ROOT), q, cfg.HARNESS); }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('brain-chat:end', async () => { try { brainChat.endSession(); } catch { /* noop */ } return { ok: true }; });

// ---- session attention → our own always-on-top toast + taskbar flash (only when unfocused) ----
ipcMain.on('session:attention', (_e, msg) => {
  if (!win || win.isDestroyed() || win.isFocused()) return;
  if (!msg || typeof msg !== 'object') return;
  const id = String(msg.id || '');
  if (!id || notifiedSessions.has(id)) return; // one alert per attention episode
  notifiedSessions.add(id);
  try { win.flashFrame(true); } catch { /* noop */ }
  toastWindow.show({ title: 'Mavis', body: (msg.label ? msg.label + ' — ' : '') + 'session needs you', id });
});

// ---- request-complete toast (the app plays its own configurable sound; this is the visual). The
// renderer decides WHETHER to fire (it knows focus/active view/active tab) and only calls this when
// the window is NOT focused, so we always show our own top-right toast window (reliable regardless
// of Windows toast registration / Focus Assist) + flash the taskbar + activate the session on click. ----
ipcMain.on('session:complete', (_e, msg) => {
  if (!win || win.isDestroyed() || !msg || typeof msg !== 'object') return;
  const id = String(msg.id || '');
  try { if (!win.isFocused()) win.flashFrame(true); } catch { /* noop */ }
  toastWindow.show({ title: String(msg.title || 'Mavis finished'), body: String(msg.body || ''), id, theme: (msg.theme && typeof msg.theme === 'object') ? msg.theme : null });
});

// ---- diagnostics: env-gated (MT_DIAG=1). The renderer streams detection + fit events here and we
// append them as JSONL to <temp>/mt-diag.log, so the notification + cutoff chain can be inspected
// from a REAL run (exact TUI strings, state transitions, fit geometry) instead of guessed. Zero
// effect when MT_DIAG is unset. ----
ipcMain.on('diag:log', (_e, o) => {
  if (!process.env.MT_DIAG || !o || typeof o !== 'object') return;
  try { fs.appendFileSync(path.join(app.getPath('temp'), 'mt-diag.log'), JSON.stringify(Object.assign({ ts: new Date().toISOString() }, o)) + '\n'); } catch { /* noop */ }
});

// ---- session-ux: persisted state, settings, path check ----
ipcMain.handle('get-session-state', async () => {
  try { return userDataDir ? sessionState.read(userDataDir) : null; } catch { return null; }
});
ipcMain.handle('set-session-state', async (_e, state) => {
  if (!userDataDir || !state || typeof state !== 'object') return { ok: false };
  return sessionState.write(userDataDir, state);
});
ipcMain.handle('get-settings', async () => ({ schema: settingsStore.SCHEMA, values: settingsValues() }));
ipcMain.handle('set-settings', async (_e, patch) => {
  if (!userDataDir || !patch || typeof patch !== 'object') return { ok: false, values: settingsValues() };
  settingsStore.write(userDataDir, patch);
  cfg = config.load(userDataDir);
  process.env.MAVIS_PERMISSION_MODE = cfg.PERMISSION_MODE; // new sessions pick up the changed permission mode
  invalidateBrainStats(); // brainRoot may have changed; drop stale cached reads
  return { ok: true, values: settingsValues() };
});
ipcMain.handle('path-exists', async (_e, p) => {
  try { return typeof p === 'string' && fs.existsSync(p); } catch { return false; }
});

// ---- file browser (Files view): read/write strictly confined to an absolute `root` (the active
// session cwd or the brain-root fallback). fs-browser.safeResolve rejects any path that escapes root;
// list/read enforce the ignore denylist, entry cap, size cap + NUL-byte binary sniff. Errors surface
// to the renderer as { error } (list/read) or { ok:false, error } (write) rather than throwing across IPC. ----
// Bind the Files-view root to a TRUSTED absolute path main-side. The renderer NAMES a root, but
// we only honour it when it exactly matches one the main process already trusts — the brain root,
// the default pty cwd, or any live session's cwd. fs-browser confines every op to `root`, so a
// compromised/buggy renderer that passed root='/' or 'C:\\' would otherwise read/write anywhere;
// this makes the "root is never the whole filesystem" invariant enforced here, not renderer-side.
// Returns the resolved absolute root, or null when the request isn't trusted.
function trustedFilesRoot(requested) {
  const allowed = [cfg.BRAIN_ROOT, cfg.PTY_CWD];
  try { if (sessions) for (const c of sessions.liveCwds()) allowed.push(c); } catch { /* noop */ }
  const norm = (x) => { const r = path.resolve(String(x == null ? '' : x)); return process.platform === 'win32' ? r.toLowerCase() : r; };
  if (requested == null || requested === '') return cfg.BRAIN_ROOT; // no root named → brain-root fallback
  const want = norm(requested);
  for (const a of allowed) { if (a && norm(a) === want) return path.resolve(String(requested)); }
  return null;
}

// ---- climbing above the session's folder (the Files view's `..` row) ----
// The Files view is path-CONFINED to `root`, so "go up" can never be a listDir('../') — that
// would breach the very confinement fs-browser exists to enforce. Instead the view RE-ROOTS,
// and main decides whether the new root is allowed. This set is that decision, remembered.
//
// CEILING = PROJECTS_ROOT (config; defaults to the brain root's parent, i.e. the folder holding
// the user's projects). You can climb terminal-app -> the brain root -> Projects and stop. Never
// above, never to a drive root, never to the home directory itself. That bound is the security
// property; membership in this Set is just cached bookkeeping.
const ascendedFileRoots = new Set();
const normPath = (x) => { const r = path.resolve(String(x == null ? '' : x)); return process.platform === 'win32' ? r.toLowerCase() : r; };
function filesCeiling() { return path.resolve(String(cfg.PROJECTS_ROOT || path.dirname(cfg.BRAIN_ROOT))); }
function withinFilesCeiling(p) {
  const c = normPath(filesCeiling());
  const n = normPath(p);
  return n === c || n.startsWith(c + path.sep);
}
// A root the Files view may act on: one of the strict allowlist, OR one we previously approved
// an ascent to. Deliberately SEPARATE from trustedFilesRoot so this widening stays scoped to
// files:* and never reaches git:* (which keeps the strict seed-only rule).
function filesRootOrAscended(requested) {
  const strict = trustedFilesRoot(requested);
  if (strict) return strict;
  if (requested == null || requested === '') return null;
  if (!ascendedFileRoots.has(normPath(requested))) return null;
  // re-check the ceiling on every use: the set is a cache, the ceiling is the rule
  const abs = path.resolve(String(requested));
  return withinFilesCeiling(abs) ? abs : null;
}
// Resolve the parent of a currently-usable root, or an { error } sentinel. Also used as the
// probe that decides whether the view shows a `..` row at all.
ipcMain.handle('files:parent', async (_e, payload) => {
  const p = payload && typeof payload === 'object' ? payload : {};
  const cur = filesRootOrAscended(p.root);
  if (!cur) return { error: 'EROOT: root is not a trusted path' };
  const parent = path.dirname(cur);
  if (!parent || normPath(parent) === normPath(cur)) return { error: 'ETOP: already at the top' };
  if (!withinFilesCeiling(parent)) return { error: 'ETOP: cannot browse above ' + filesCeiling() };
  ascendedFileRoots.add(normPath(parent));
  return { root: parent };
});
ipcMain.handle('files:list', async (_e, payload) => {
  const p = payload && typeof payload === 'object' ? payload : {};
  const root = filesRootOrAscended(p.root);
  if (!root) return { error: 'EROOT: root is not a trusted path' };
  try { return await fsBrowser.listDir(root, p.rel); }
  catch (e) { return { error: e && e.message ? e.message : String(e) }; }
});
ipcMain.handle('files:read', async (_e, payload) => {
  const p = payload && typeof payload === 'object' ? payload : {};
  const root = filesRootOrAscended(p.root);
  if (!root) return { error: 'EROOT: root is not a trusted path' };
  try { return await fsBrowser.readFile(root, p.rel); }
  catch (e) { return { error: e && e.message ? e.message : String(e) }; }
});
ipcMain.handle('files:write', async (_e, payload) => {
  const p = payload && typeof payload === 'object' ? payload : {};
  const root = filesRootOrAscended(p.root);
  if (!root) return { ok: false, error: 'EROOT: root is not a trusted path' };
  try { return await fsBrowser.writeFile(root, p.rel, p.text); }
  catch (e) { return { ok: false, error: e && e.message ? e.message : String(e) }; }
});
// brain-root fallback root when no session is open (already an absolute path in config)
ipcMain.handle('files:root', async () => cfg.BRAIN_ROOT);

// ---- git (Changes view) ----
// THE TRUST BOUNDARY: the renderer sends a session CWD (validated against the same
// allowlist as files:*), and MAIN derives the repo root itself. Every later call must
// name a root main already resolved — `resolvedRepoRoots` is that memory. A renderer
// can therefore never point git at a directory main didn't choose.
const gitRepo = require('./git-repo');
const resolvedRepoRoots = new Set();
const normRoot = (x) => { const r = path.resolve(String(x == null ? '' : x)); return process.platform === 'win32' ? r.toLowerCase() : r; };
function trustedRepoRoot(requested) {
  if (requested == null || requested === '') return null;
  return resolvedRepoRoots.has(normRoot(requested)) ? path.resolve(String(requested)) : null;
}

ipcMain.handle('git:resolve', async (_e, payload) => {
  const p = payload && typeof payload === 'object' ? payload : {};
  const cwd = trustedFilesRoot(p.cwd);          // reuse the files:* allowlist
  if (!cwd) return { error: 'EROOT: cwd is not a trusted path' };
  try {
    const info = await gitRepo.resolveRepo(cwd);
    if (info && info.root) resolvedRepoRoots.add(normRoot(info.root));
    return info;
  } catch (e) { return { error: e && e.message ? e.message : String(e) }; }
});

const gitCall = (fn) => async (_e, payload) => {
  const p = payload && typeof payload === 'object' ? payload : {};
  const root = trustedRepoRoot(p.root);
  if (!root) return { error: 'EROOT: root is not a resolved repo' };
  try { return await fn(root, p); }
  catch (e) { return { error: e && e.message ? e.message : String(e) }; }
};

ipcMain.handle('git:status', gitCall((root) => gitRepo.status(root)));
ipcMain.handle('git:diff', gitCall((root, p) => gitRepo.diffFile(root, p.rel, !!p.staged)));
ipcMain.handle('git:stage', gitCall((root, p) => gitRepo.stage(root, p.rels)));
ipcMain.handle('git:unstage', gitCall((root, p) => gitRepo.unstage(root, p.rels)));
ipcMain.handle('git:discard', gitCall((root, p) => gitRepo.discard(root, p.rels)));
ipcMain.handle('git:commit', gitCall((root, p) => gitRepo.commit(root, p.message)));
ipcMain.handle('git:push', gitCall((root) => gitRepo.push(root)));
ipcMain.handle('git:branches', gitCall((root) => gitRepo.branches(root)));
ipcMain.handle('git:checkout', gitCall((root, p) => gitRepo.checkout(root, p.name)));

app.on('will-quit', () => { if (brainWatch) brainWatch.close(); if (sessionReader) sessionReader.stop(); vizServer.stopVizServer(); dailyopsAgent.cancelAll(); brainChat.cancelAll(); toastWindow.destroy(); });
app.on('window-all-closed', () => {
  if (sessions) sessions.closeAll();
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
