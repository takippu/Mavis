# Mavis-Terminal

A desktop app that **loads Mavis on launch**. It embeds a real coding-agent CLI
(Claude Code or Codex) in a terminal, auto-runs that harness's Mavis command, and
shows a sidebar of your projects. **Click a project** to open a Mavis session
`cd`'d into its directory — each runs in its own **tab**, several at once.

It uses the real CLI on purpose — that's the only thing licensed to use your
Claude **subscription** login. The Agent SDK can't; it needs a pay-per-token API
key.

## Where the sidebar gets its projects

From `<brain root>/projects/_index.md` — one line per project, with each project's
own directory under `projects/<name>/`.

**That whole directory is gitignored, so a fresh clone does not have it**, and the
sidebar will be empty on first launch. That is the expected state, not a bug: your
projects, memories and preferences are yours and never ship with the repo. Run the
setup wizard first (open the brain folder in Claude Code and say `setup mavis` —
see the repo root `README.md`), which seeds `projects/_index.md`. After that the
sidebar fills in, and Mavis adds a row every time you start tracking a new project.

The app only ever **reads** the index to build the sidebar; it does not invent
projects to fill the empty state.

## Prerequisites

- **Node.js** (18+)
- **At least one harness installed and logged in** — Claude Code (`claude login`,
  subscription) and/or Codex. Whichever is on your PATH is what you can select.
- **No C++ build tools needed** — `node-pty` 1.1.0 ships N-API prebuilds that load
  directly in Electron (verified under Electron 33). Visual Studio is *not* required.

## Run (dev)

```sh
cd terminal-app
npm install
npm start
```

Open a project from Projects or Open Folder to create a workspace and start the
selected agent in its directory. The terminal runs the project-aware Mavis skill
command once the CLI is ready. Reopening a project reuses its live agent terminal;
switching tabs preserves files and terminals. Restored workspaces wait for an
explicit open/start before launching an agent.

## Configuration

Effective config is `defaults` <- `MAVIS_*` env vars <- `settings.json` in the
app's userData dir (the file wins, so anything you change in Settings sticks).

| Var | Default | Purpose |
|-----|---------|---------|
| `MAVIS_BRAIN_ROOT` | the parent repo | Brain root; `projects/_index.md` is read from here |
| `MAVIS_HARNESS` | `claude` | Which CLI new sessions launch (`claude` / `codex`) |
| `MAVIS_CWD` | brain root | Working dir the CLI is spawned in |
| `MAVIS_AUTORUN_COMMAND` | per-harness | Command auto-typed on launch; each harness has its own built-in default, so leave it unset unless you genuinely want a custom one |
| `MAVIS_AUTORUN_DELAY` | `1500` | ms to wait after the CLI's first output before auto-typing |
| `MAVIS_PROJECTS_ROOT` | brain root's parent | Where "New project -> create folder" puts new folders |
| `MAVIS_APP_THEME` | `light` | `light` / `dark` |

## Test

```sh
npm test
```

On Windows, `node --test <directory>` does not work; if you invoke the runner
directly, use the quoted glob form: `node --test "test/*.test.js"`.

## Package

```sh
npm run dist       # Windows installer and portable executable in dist/
npm run dist:mac   # Apple Silicon Mac DMG + ZIP, then install and pin to Dock
```

On macOS, `dist:mac` installs the app at `~/Applications/Mavis-Terminal.app` and
adds it to the Dock on first installation. Later builds replace the same app and
keep the existing Dock shortcut. Close Mavis before updating; if installation
finds it running, close it and run `npm run install:mac` to install the completed
build. These are local, unsigned builds, not notarized distribution releases.

Dock launches recover your login-shell PATH so Homebrew, Node version managers,
Claude and Codex are available. The app reads the registered code and memory
roots from Mavis brain-sync configuration, including split-root installations.

## Coding workspace (0.8)

Open folders as project tabs with a Mavis agent terminal. Each project owns its open
Monaco documents, editor groups, file/search/Git views and terminal sessions.
Use Cmd+P for files, Cmd+Shift+P for commands, Cmd+S to save and the terminal +
button to choose Shell, Claude or Codex. Terminal splits can sit below or beside
the editor. The full Mavis navigation remains available.

Unsaved edits are backed up locally. Saves detect disk changes instead of silently
overwriting an agent's edits. Workspace state migrates existing session tabs and
retains their launch directories. Restored terminal definitions wait for an
explicit start; restarting the app does not resume an old live process.

Project tabs match saved Projects colours. File, folder and project menus provide
Reveal in Finder and Copy Full Path; file menus also offer Copy Relative Path,
Rename and Move to Trash. Projects without a local folder ask you to choose one.

Run `node_modules/.bin/electron scripts/workspace-smoke.js` for an isolated
two-project editor/real-PTY/render check. Set MAVIS_SMOKE_MAIN to the packaged
app.asar/src/main.js path to check packaged assets. Generated screenshots are in
design-proposals/build-verification. These checks do not modify user projects. Use `MAVIS_WORKSPACE_PERF=1
MAVIS_SMOKE_QUIT=1 node_modules/.bin/electron scripts/workspace-smoke.js` on one
line for five projects, fifty documents, ten real terminals, twenty project
open/close cycles and the normal quit path.

The Mac installer retains the previous bundle at the printed backup path for
rollback, keeps the same bundle identity and preserves one Dock shortcut.

## Notes / known rough edges

- **First launch in a new folder**: the CLI may show a "trust this folder?"
  prompt. Autorun waits for a ready CLI prompt; answer the trust question
  before continuing.
- A project with no local folder opens a folder picker and remembers the choice
  on this machine.
- The Mac workspace uses bundled editor workers and supports offline startup.
  Windows retains its path/shortcut adapters; its packaged build needs a separate
  platform walkthrough before claiming Windows visual parity.
