'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mavis', {
  // sessions
  createSession: (opts) => ipcRenderer.invoke('create-session', opts),
  // ids of harnesses actually installed on this machine (e.g. ['claude'] or ['claude','codex']) —
  // Settings/the launcher/the tab badge all filter against this so a Codex-less machine never
  // offers a dead choice.
  harnessAvailable: () => ipcRenderer.invoke('harness:available'),
  closeSession: (id) => ipcRenderer.send('close-session', { id }),
  sendInput: (id, data) => ipcRenderer.send('pty-input', { id, data }),
  resize: (id, cols, rows) => ipcRenderer.send('pty-resize', { id, cols, rows }),
  onPtyData: (cb) => ipcRenderer.on('pty-data', (_e, p) => cb(p)),
  onPtyExit: (cb) => ipcRenderer.on('pty-exit', (_e, p) => cb(p)),
  // status sidecar: { id, state } where state is 'done' | 'await' | 'busy' | 'error' (see session-events.js)
  onSessionState: (fn) => ipcRenderer.on('session:state', (_e, p) => fn(p)),
  clipboardHasImage: () => ipcRenderer.invoke('clipboard:has-image'),
  clipboardPasteImage: () => ipcRenderer.invoke('clipboard:paste-image'),
  appVersion: () => ipcRenderer.invoke('app:version'),

  // diagnostics: env-gated (MT_DIAG=1) detection/fit tracing → <temp>/mt-diag.log (see main.js).
  diag: (() => { try { return !!process.env.MT_DIAG; } catch { return false; } })(),
  diagLog: (o) => ipcRenderer.send('diag:log', o),

  // data
  listProjects: () => ipcRenderer.invoke('list-projects'),
  getDashboardData: () => ipcRenderer.invoke('get-dashboard-data'),
  getProjectDetail: (slug) => ipcRenderer.invoke('get-project-detail', slug),
  searchBrain: (q) => ipcRenderer.invoke('search-brain', q),
  listDailyMemories: () => ipcRenderer.invoke('daily-memories:list'),
  getDailyMemory: (date) => ipcRenderer.invoke('daily-memory:get', date),
  listTopics: () => ipcRenderer.invoke('topics:list'),
  categoryEntries: (category) => ipcRenderer.invoke('brain:cat-entries', category),
  categoryIndex: (category) => ipcRenderer.invoke('brain:cat-index', category),
  mcpServers: () => ipcRenderer.invoke('brain:mcp-servers'),
  skills: () => ipcRenderer.invoke('brain:skills'),
  identityFacets: () => ipcRenderer.invoke('brain:identity-facets'),
  getMavisConfig: () => ipcRenderer.invoke('mavis-config:get'),
  openMavisFile: (key) => ipcRenderer.invoke('mavis-config:open', key),
  previewMavisConfig: (key, op) => ipcRenderer.invoke('mavis-config:preview', { key, op }),
  saveMavisConfig: (key, op) => ipcRenderer.invoke('mavis-config:save', { key, op }),
  previewEntry: (payload) => ipcRenderer.invoke('mavis-entry:preview', payload),
  saveEntry: (payload) => ipcRenderer.invoke('mavis-entry:save', payload),
  setProjectColor: (slug, color) => ipcRenderer.invoke('project:set-color', { slug, color }),
  onBrainChanged: (cb) => ipcRenderer.on('brain-changed', (_e, p) => cb(p)),

  // brain health (lint report). Grouped rather than flat because the Fix flow adds sibling calls
  // (previewFix/applyFix) that only make sense alongside get/onChange. get() returns the cached
  // report or null before the first lint lands; onChange fires on every re-lint after a brain write.
  //
  // previewFix/applyFix send ONLY {command, project} -- never a path and never file content. Main
  // validates both and derives every path from its own brain root, so this bridge cannot be used
  // to aim the repairer somewhere else. applyFix writes the plan previewFix already returned and
  // the user approved; main refuses an apply that was never previewed.
  brainHealth: {
    get: () => ipcRenderer.invoke('brain:health'),
    onChange: (cb) => ipcRenderer.on('brain:health-changed', (_e, p) => cb(p)),
    previewFix: (command, project) => ipcRenderer.invoke('brain:repair-preview', { command, project }),
    applyFix: (command, project) => ipcRenderer.invoke('brain:repair-apply', { command, project }),
  },

  // create / add project
  projectsRoot: () => ipcRenderer.invoke('projects:root'),
  pickFolder: (opts) => ipcRenderer.invoke('projects:pick-folder', opts),
  planProject: (opts) => ipcRenderer.invoke('projects:plan', opts),
  createProject: (opts) => ipcRenderer.invoke('projects:create', opts),
  gitTokenStatus: (provider) => ipcRenderer.invoke('git-token:status', provider),
  gitTokenSet: (provider, token) => ipcRenderer.invoke('git-token:set', { provider, token }),
  gitTokenClear: (provider) => ipcRenderer.invoke('git-token:clear', provider),

  // integrations: PM, dailyops, map
  pmList: () => ipcRenderer.invoke('pm:list'),
  pmProjects: () => ipcRenderer.invoke('pm:projects'),
  pmProjectTasks: (payload) => ipcRenderer.invoke('pm:project-tasks', payload),
  pmTask: (ref) => ipcRenderer.invoke('pm:task', ref),
  pmImage: (key) => ipcRenderer.invoke('pm:image', key),
  pmSetToken: (t) => ipcRenderer.invoke('pm:set-token', t),
  pmClearToken: () => ipcRenderer.invoke('pm:clear-token'),
  pmTokenStatus: () => ipcRenderer.invoke('pm:token-status'),
  dailyopsList: () => ipcRenderer.invoke('dailyops:list'),
  dailyopsContext: () => ipcRenderer.invoke('dailyops:context'),
  dailyopsSave: (input) => ipcRenderer.invoke('dailyops:save', input),
  dailyopsGenStart: (date) => ipcRenderer.invoke('dailyops:gen-start', date),
  dailyopsGenContinue: (payload) => ipcRenderer.invoke('dailyops:gen-continue', payload),
  mapStatus: () => ipcRenderer.invoke('map:status'),
  mapRebuild: () => ipcRenderer.invoke('map:rebuild'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  openTarget: (kind, value) => ipcRenderer.invoke('terminal:open-target', { kind, value }),

  // brain chat (FAB) + session attention alerts
  brainChatAsk: (q) => ipcRenderer.invoke('brain-chat:ask', q),
  brainChatEnd: () => ipcRenderer.invoke('brain-chat:end'),
  sessionAttention: (msg) => ipcRenderer.send('session:attention', msg),
  notifyComplete: (msg) => ipcRenderer.send('session:complete', msg),
  onActivateSession: (cb) => ipcRenderer.on('activate-session', (_e, p) => cb(p)),

  // file browser (Files view) — scoped read/write confined to an absolute root (fs-browser.js)
  filesList: (root, rel) => ipcRenderer.invoke('files:list', { root, rel }),
  filesRead: (root, rel) => ipcRenderer.invoke('files:read', { root, rel }),
  filesWrite: (root, rel, text) => ipcRenderer.invoke('files:write', { root, rel, text }),
  filesRoot: () => ipcRenderer.invoke('files:root'),
  filesParent: (root) => ipcRenderer.invoke('files:parent', { root }),

  // git (Changes view) — the renderer never names a repo: it sends the active session's
  // cwd to git:resolve and main derives + remembers the root. Every later call passes
  // that main-resolved root back; main rejects any root it didn't resolve itself.
  gitResolve: (cwd) => ipcRenderer.invoke('git:resolve', { cwd }),
  gitStatus: (root) => ipcRenderer.invoke('git:status', { root }),
  gitDiff: (root, rel, staged) => ipcRenderer.invoke('git:diff', { root, rel, staged }),
  gitStage: (root, rels) => ipcRenderer.invoke('git:stage', { root, rels }),
  gitUnstage: (root, rels) => ipcRenderer.invoke('git:unstage', { root, rels }),
  gitDiscard: (root, rels) => ipcRenderer.invoke('git:discard', { root, rels }),
  gitCommit: (root, message) => ipcRenderer.invoke('git:commit', { root, message }),
  gitPush: (root) => ipcRenderer.invoke('git:push', { root }),
  gitBranches: (root) => ipcRenderer.invoke('git:branches', { root }),
  gitCheckout: (root, name) => ipcRenderer.invoke('git:checkout', { root, name }),

  // session-ux: persisted tabs, settings, path check
  getSessionState: () => ipcRenderer.invoke('get-session-state'),
  setSessionState: (state) => ipcRenderer.invoke('set-session-state', state),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  setSettings: (patch) => ipcRenderer.invoke('set-settings', patch),
  pathExists: (p) => ipcRenderer.invoke('path-exists', p),

  // window controls (frameless)
  winMinimize: () => ipcRenderer.send('win:minimize'),
  winMaximize: () => ipcRenderer.send('win:maximize'),
  winClose: () => ipcRenderer.send('win:close'),
  onWinState: (cb) => ipcRenderer.on('win:state', (_e, p) => cb(p)),

  // reload guard: main intercepts Ctrl+R/Ctrl+Shift+R/F5 and asks the renderer to confirm
  // via the themed MT.confirm dialog before actually reloading.
  onReloadConfirmRequest: (cb) => ipcRenderer.on('reload:confirm-request', (_e, p) => cb(p)),
  reloadConfirmResponse: (payload) => ipcRenderer.send('reload:confirm-response', payload),
  // report terminal focus so the reload guard yields Ctrl+R (reverse search) to the CLI
  setTerminalFocused: (v) => ipcRenderer.send('ui:terminal-focused', v),
});
