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

The window opens with a default tab — the selected harness, launched in the brain
folder, with its Mavis command auto-run. Click any project in the sidebar to open
it in a new tab (the CLI spawned in that project's directory, with a project-aware
Mavis command). Re-clicking an open project focuses its tab; the `x` on a tab
closes the session.

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
npm run dist   # electron-builder -> Windows installer in dist/
```

## Notes / known rough edges

- **First launch in a new folder**: the CLI may show a "trust this folder?"
  prompt. The autorun could land on that prompt the first time — answer it
  once, then relaunch and autorun works cleanly. (Tune `MAVIS_AUTORUN_DELAY` if
  needed.)
- A project with no `path:` in its `index.md` frontmatter isn't clickable (the
  path line is just omitted; the row still lists it).
- Windows is the tested platform. Nothing is deliberately Windows-only, but the
  packaging target and the manual testing both assume it.
