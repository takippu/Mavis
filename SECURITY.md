# Security

This file exists because Mavis's *normal* operation looks alarming if you only read the
diff. It writes to files outside its own repo, it spawns real CLI agents in a pseudo-terminal,
it stores API tokens, and it runs an HTTP server. Every one of those is deliberate, every one
is scoped, and this document says exactly how — so you can audit the claim instead of trusting
it.

If something here does not match what the code actually does, that is a bug and we want to
hear about it. See [Reporting a vulnerability](#reporting-a-vulnerability).

---

## What this software touches on your machine

### 1. A global git config setting (`core.hooksPath`)

The setup wizard in `SETUP.md` offers to run:

```
git config --global core.hooksPath "<BRAIN_PATH>/scripts/git-hooks"
```

**This is global.** It applies to every git repository on your machine, not just this one.
It is an *offer*, made once, with that consequence stated in the prompt — it is never applied
silently, and the wizard backs off if you say no or if a hooks path is already set.

Why it is worth the blast radius: `scripts/git-hooks/commit-msg` rejects AI-attribution
trailers (`Co-Authored-By: Claude`, `Co-authored-by: Codex`, and the like). The agent harnesses
re-inject an instruction to add those trailers on every turn, so a rule that lives only in a
prompt loses to it eventually. A hook does not care what is in anyone's context window.

What to know before accepting:

- The hook **chains to** a repo's own `.git/hooks/commit-msg` if one exists, so enabling the
  global path does not silently disable hooks you already had.
- A **repo-local** `core.hooksPath` (husky sets one) overrides the global setting. In those
  repos this hook does not run. That is expected.
- To undo it: `git config --global --unset core.hooksPath`.
- If you would rather scope it to one repo: `git config core.hooksPath scripts/git-hooks`
  from inside that repo.

Read the hook before you install it. It is a short POSIX `sh` script and it only ever
inspects and rejects — it never rewrites your commit message.

### 2. Files written into your harness home (`scripts/install-harness.mjs`)

`node scripts/install-harness.mjs --harness claude|codex|both [--global]` writes into your
live agent configuration, which lives **outside this repo**:

| Target | What lands there |
|---|---|
| `~/.claude/CLAUDE.md` | the always-on invariants, only with `--global` |
| `~/.codex/AGENTS.md` | the same, for Codex, only with `--global` |
| `~/.claude/commands/mavis.md` | the `/mavis` prompt |
| `~/.codex/prompts/mavis.md` | the same, for Codex |
| `~/.claude/output-styles/…` | the optional terse output style |

Because those are live config files and not repo files, the installer is built defensively.
The guarantees, all of them enforced in code:

- **Dry run is the default.** Nothing is written without an explicit `--yes`. The dry run
  prints a real unified diff of every target first.
- **Nothing is ever deleted.** Every existing target is copied to `<path>.mavis-bak` before
  it is touched.
- **Writes are atomic.** A temp sibling is written and renamed into place, so an interrupted
  run leaves either the old file or the new one, never a truncated config.
- **Splice, not overwrite.** The always-on files are edited only between
  `<!-- mavis:begin -->` / `<!-- mavis:end -->` markers; anything you wrote outside them
  survives. If the file already contains an unmarked copy of the contract, the installer
  **refuses** rather than appending a second one.
- **Symlinks are followed, not replaced.** If the target is a link into a dotfiles repo, the
  write goes through to the real file, and the dry run names that real destination.
- **`~/.codex/config.toml` is never touched.** It holds trusted-project entries and MCP server
  definitions. The two keys Codex needs are printed for you to paste yourself.

Your name is substituted into the installed copy from `identity/profile.md` at write time —
which is why the committed sources carry `{{USER_NAME}}` placeholders and the name never
enters git.

### 3. The Electron app spawns real CLI agents in a PTY

`terminal-app/` is a desktop shell around the **real `claude` / `codex` CLI binaries**
(`src/pty-session.js`). It does not reimplement them and it does not proxy them through an
SDK — it resolves the binary on your `PATH` and spawns it in a pseudo-terminal with your
environment inherited.

Consequences you should be aware of:

- **Whatever the agent can do, it can do here.** Sessions run with your user's privileges in
  the working directory you pick.
- **There is a permission mode setting, and one of its values is dangerous.** Settings offers
  `default`, `acceptEdits`, `plan`, and `yolo`. `yolo` maps to
  `--dangerously-skip-permissions` (Claude) / `--dangerously-bypass-approvals-and-sandbox`
  (Codex) — the agent then stops asking before it acts. It is labelled as dangerous in the
  UI and it is not the default. Do not leave it on.
- **A per-session hook is registered** so the app can tell when a pane is idle. The
  correlation token is baked into the hook command rather than passed through the
  environment, because environment inheritance by the CLI's own hook children is not
  something this project is willing to assume.
- **Renderer windows are locked down**: `contextIsolation: true`, `nodeIntegration: false`.
  All privileged work goes through the preload bridge.

### 4. Tokens stored on disk

The app stores personal access tokens in Electron's `userData` directory:

| File | Holds |
|---|---|
| `pm-token.json` | a project-management API token |
| `git-github-token.json`, `git-gitlab-token.json` | git host personal access tokens |

The posture, honestly stated:

- **Encrypted at rest via Electron `safeStorage`** (DPAPI on Windows, the OS keychain
  elsewhere) *when it is available*.
- **There is a documented plaintext fallback.** When `safeStorage.isEncryptionAvailable()`
  returns false, the token is written as plain JSON with mode `0600`. This is a real
  limitation, not an oversight — the fallback exists so the feature works on machines with
  no keychain, and mode `0600` is a filesystem permission, not encryption. On Linux without
  a configured keyring, assume plaintext.
- Tokens are **never logged** and the renderer only ever receives
  `{ present, maskedTail }` — the last four characters, never the token.
- MCP server configuration is read from `~/.claude.json` for the dashboard, and **only
  server names are surfaced**. `command`, `args`, and `env` are deliberately never returned,
  because those routinely hold secrets.

Outbound network calls from the app are limited to: your configured project-management host,
`api.github.com` and your GitLab host (only when you ask it to create a repository), and
whatever the agent CLI itself does. There is no telemetry and no auto-update.

### 5. A loopback HTTP server for the graph view

The brain graph (`viz/`) is served to an embedded webview over `http://127.0.0.1:<random
port>` (`src/viz-server.js`) rather than `file://`, because ES modules are CORS-blocked at a
`null` origin and absolute `/assets` paths resolve to the filesystem root under `file://`.

That server hands out a full export of your private brain, so it is hardened accordingly:

- Bound to **`127.0.0.1` only**, on an ephemeral port.
- **`GET` / `HEAD` only.** Everything else is a 405.
- The **`Host` header must exactly match** the loopback host and port that was bound. This
  defeats DNS rebinding: a rebound page in an ordinary browser sends its own hostname.
- A **per-launch random token** (18 bytes) is required on every request, bootstrapped via
  `?k=` on the webview's index URL and then carried by a `SameSite=Strict; HttpOnly` cookie.
  Another local process cannot read the export without that secret.
- **Path traversal guarded** — the resolved path must stay inside `viz/dist`.
- Responses are `Cache-Control: no-store`.

The server starts when you open the graph and stops with the app.

---

## Your memory is not in this repository

The brain's own memory directories are **gitignored by design**, not by accident:

```
/identity/   /projects/   /daily-memories/   /standups/
/preferences/   /rules/    /topics/    /memory/
_backup/     .setup-complete
```

That is the whole point of the split. The repository ships the *scaffold* — the contract, the
seeds, the scripts, the app — and your actual notes, client names, project history, and
personal profile stay on your machine. `scripts/init-brain.mjs` recreates the empty
structure from `seeds/` on a fresh clone.

`.gitignore` also blocks the usual secret shapes (`.env`, `*.pem`, `*.key`, `*.p12`, `*.pfx`,
`*.jks`, `.mcp.json`, `.claude.json`, `service-account*.json`, `google-services.json`).
`.mcp.json` is called out explicitly because following the MCP setup skill *will* create one
holding a real token.

**Before you push a fork or a clone of your own brain, check `git status` anyway.** An
ignore rule protects you from files that land in the expected place; it cannot protect you
from a note you pasted into a tracked file.

---

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Report it privately through GitHub's private vulnerability reporting on this repository:
go to the **Security** tab, then **Report a vulnerability**. That opens a private security
advisory visible only to you and the maintainers.

If private reporting is unavailable to you for any reason, open a public issue that says only
that you have found a security issue and asks for a private channel — no details, no
reproduction steps.

What to include, if you have it:

- The version or commit you were on.
- Which of the surfaces above is involved (git hooks, harness installer, PTY spawn, token
  storage, loopback server) — or a new one.
- A reproduction, and what an attacker gets out of it.

This is a solo-maintained project, so a realistic expectation: an acknowledgement within a
week, and a fix timeline that depends on severity. You will be credited in the advisory
unless you ask not to be.

### Out of scope

- **The agent CLIs themselves.** Report issues in `claude` or `codex` to their vendors.
- **`yolo` permission mode doing what it says.** It is documented, labelled dangerous, and
  opt-in.
- **The plaintext token fallback on a machine with no keychain.** It is documented above.
  A report that the fallback triggers *when a keychain is available* is very much in scope.
- **Anything requiring an attacker who already has your user account.** Every surface here
  runs with your privileges by design.

---

## Supported versions

This project ships from `main`. Fixes land there; there is no maintained backport branch.
