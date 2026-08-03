# Mavis

A persistent-memory scaffold for coding agents, plus the tooling to keep it honest.

Most AI coding agents start every session as strangers. Mavis doesn't. She loads who you are, what
you've shipped, what you've decided, and how you like to work — before saying a word.

Under the hood this repo is four things that fit together:

1. **A Markdown contract** (`AGENTS.md`) that turns Claude Code or Codex into Mavis.
2. **A desktop app** (`terminal-app/`) that launches an agent CLI with the brain already loaded,
   and gives the Markdown brain a real UI.
3. **Skills** (`skills/`) — domain-specific protocols the agent loads only when a trigger fires.
4. **A toolchain** (`scripts/`) that lints the brain for rot, repairs it, seeds it, keeps the
   generated contract in sync, and stops your private notes from leaking into a public commit.

Your actual memories are **not** in this repo and never will be. See
[What ships vs. what stays on your machine](#what-ships-vs-what-stays-on-your-machine).

---

## Quick start

```bash
git clone https://github.com/takippu/Mavis.git
cd Mavis
```

Open the folder in Claude Code (or Codex — the contract is written to drive both). On the first
session the contract's Step 0 looks for `identity/profile.md`; a fresh clone has none, because
`identity/` is gitignored. That absence *is* the "never set up" signal, so the setup wizard runs:
seven short questions, about two minutes.

The wizard seeds your identity files, then lays down the empty memory scaffold with one command:

```bash
node scripts/init-brain.mjs --write
```

Run it yourself if you'd rather do it by hand — it's idempotent, it never overwrites an existing
`_index.md`, and it verifies that every link it wrote actually resolves before exiting 0. Drop
`--write` for a dry run, or use `--check` to ask whether seeding is still needed (exit 1 = yes).

The wizard also offers to install a global `/mavis` command so you can load the brain from any
directory, and to wire up the git hooks. Both are opt-in and both are explained before anything is
written.

---

## What's in the box

```
Mavis/
├── AGENTS.md          ◀── THE CONTRACT. Canonical, hand-edited.
├── CLAUDE.md              generated from AGENTS.md — never hand-edit
├── SETUP.md               the setup / reset / recalibrate protocols
├── seeds/                 empty scaffold copied into a new brain on first install
├── skills/                on-demand protocols (spec-driven, client-deck, ...)
├── scripts/               lint, repair, contract-sync, brain-init, leak guard
│   ├── lint-brain.mjs         size budgets, link integrity, contract drift
│   ├── brain-repair.mjs       rotate a bloated progress.md, shard a bloated notes.md
│   ├── sync-contract.mjs      render CLAUDE.md from AGENTS.md
│   ├── init-brain.mjs         seed a fresh brain from seeds/
│   ├── check-leaks.mjs        find personal content in files that would be published
│   ├── install-harness.mjs    write the invariants + /mavis into ~/.claude or ~/.codex
│   ├── git-hooks/             commit-msg (attribution) + pre-commit (leak guard)
│   ├── hooks/                 the write-time leak guard, run by Claude Code
│   └── test/                  the toolchain test suite
├── terminal-app/          the Electron app (the bulk of the code in this repo)
├── viz/                   brain-viz: interactive graph of your brain
├── mavis/                 payloads install-harness.mjs writes OUTSIDE the repo
└── docs/brain-schema.md   the canonical entry / index / lifecycle schema
```

And, once you've run setup, on **your machine only**: `identity/`, `preferences/`, `rules/`,
`topics/`, `memory/`, `projects/`, `daily-memories/`, `standups/`.

---

## 1. The contract

**`AGENTS.md` is canonical.** It defines the auto-load order, the always-on invariants, the save
rules, the trigger routers, and what Mavis is and isn't. It is the file you edit.

**`CLAUDE.md` is generated.** `scripts/sync-contract.mjs` renders it from `AGENTS.md` with the
harness-specific blocks resolved, so the same source drives Claude Code and Codex without either
one reading instructions meant for the other:

```bash
node scripts/sync-contract.mjs --check   # exit 0 in sync, 1 on drift
node scripts/sync-contract.mjs --write   # regenerate CLAUDE.md
```

Drift is a lint failure, not a warning. If you edit `AGENTS.md` and forget to regenerate,
`scripts/lint-brain.mjs` fails and tells you so.

### How memory actually works

**Paired writes.** When meaningful work happens — a feature ships, a decision lands, a non-trivial
change goes in — Mavis writes to **two** places: today's `daily-memories/<date>.md` (the narrative)
and the project's `progress.md` (a bullets-only checkpoint that backlinks the daily memory). The
two files point at each other. Skip one and the system breaks.

**Two-tier recall.** Distilled knowledge lives in three categories — `preferences/`, `rules/`,
`topics/` — each a lean `_index.md` of trigger keywords plus one `_details/<slug>.md` per entry.
Only `rules/_index.md` loads at boot. The other two are *grepped on disk* when a prompt's keywords
match, then the matching detail file is read into context. That's what keeps session startup cheap
while the brain grows past anything you could paste into a prompt. Full spec:
[`docs/brain-schema.md`](docs/brain-schema.md).

**Feedback capture.** When you give an in-flight signal — "nice", "no, don't", "shorter", or just
accepting a non-default call without pushback — Mavis resolves what triggered it and saves it as a
`preferences/` entry, not a loose bullet.

**The rot problem, and the answer to it.** A memory system that only appends eventually collapses
under its own weight. `scripts/lint-brain.mjs` is the detector: per-file size budgets by
read-pattern, link integrity across every relative `.md` link, a rule that durable entries may never
point at rotating files, one-line-per-project enforcement on the projects router, and contract sync.
`scripts/brain-repair.mjs` is the fixer — it rotates an oversized `progress.md` into a yearly
archive, or shards a flat `notes.md` into a two-tier index. It always previews first, and always
copies originals to `_backup/` before writing. There is no auto-apply path; approval is the caller's
job.

---

## 2. The leak guard

Mavis holds your private working life — clients, unreleased projects, your name — in gitignored
directories inside a git repository. `.gitignore` protects those *directories*. It has no opinion
about file *contents*, and that is where personal data actually escapes: into a test fixture that
wanted a realistic project name, a skill whose worked example came from a real engagement, a UI
string with your name hardcoded during development.

Most of that is not typed by you. It is written by an assistant that has your real brain loaded and
reaches for the nearest concrete example.

So the guard runs in three places:

| Layer | Mechanism | Catches |
|-------|-----------|---------|
| Write-time | a Claude Code `PostToolUse` hook, wired in `.claude/settings.json` | the assistant writing your client's name into a fixture, in the same turn |
| Commit-time | `scripts/git-hooks/pre-commit` | anything that got past the first layer |
| Audit | `node scripts/check-leaks.mjs --all` | what is already in the tree, and any contributor's PR |

**The term list is derived, never shipped.** A hardcoded list of someone else's clients would be
useless to you — but your gitignored brain already enumerates what is personal: every directory
under `projects/`, each project's display name, `identity/profile.md`, your git config, your OS
username and home path. On top of that sit generic patterns that work with no brain at all (email
addresses, home paths, private-key blocks, API-key prefixes), so a fresh contributor is covered too.

```bash
node scripts/check-leaks.mjs --explain   # every derived term and where it came from
node scripts/check-leaks.mjs --all       # audit the whole tracked tree
```

**Tuning matters more than detection.** A guard that fires on ordinary words gets switched off, and
a switched-off guard protects nothing. If one of your project slugs is also a normal word, three
escape hatches exist, in order of preference: `allow:` / `allowpath:` in `.mavis-private` (copy
`.mavis-private.example`), a `leak-guard-allow` comment on the single line that needs it, or
`git commit --no-verify` for a one-off. Every finding names *why* a term is personal ("project
slug", "identity/profile.md name") so you can tell a real leak from a collision at a glance.

Writing to your own gitignored brain is never flagged. The guard only looks at files that could
actually reach a public repository.

---

## 3. The desktop app

`terminal-app/` is an Electron shell that launches Claude Code or Codex with the Mavis command
already auto-run, in tabs, one per project — plus a UI over the Markdown brain: a project dashboard,
a daily-memory journal, a topic browser, an entry editor, a file browser, a git changes view, and a
Brain Health card that surfaces the linter's flags where you'll actually see them.

It drives the **real CLI** on purpose: that is the only thing licensed to use a Claude subscription
login. The Agent SDK needs a pay-per-token API key.

```bash
cd terminal-app
npm install
npm start
```

Details, configuration, and the empty-sidebar-on-first-clone explanation:
[`terminal-app/README.md`](terminal-app/README.md).

`viz/` is a separate, lighter thing: a cytoscape graph of the whole brain, launched with
`start.bat` / `start.sh`. See [`viz/README.md`](viz/README.md).

---

## 4. Skills

Skills are protocols the agent loads **on demand**, only when a trigger phrase fires — they cost
nothing until used, which is why a dozen can ship without bloating every session. Each is a
`skills/<name>/SKILL.md`.

| Skill | What it's for |
|-------|---------------|
| `spec-driven` | A 4-artifact spec workflow (proposal, requirements, design, tasks) for non-trivial changes |
| `daily-standup` | A concise one-line-per-project morning report |
| `client-deck` | Single-file HTML reference docs in a spec/terminal aesthetic, meant to be screenshotted |
| `smoke-guide` | Turns a change request into human test steps |
| `dev-update` | Plain-voice release notes and changelogs |
| `social-post` | Promo copy — the deliberate opposite of `dev-update` |
| `security-headers` | CSP / HSTS hardening, including the A+-vs-100 gap and the nonce tradeoff |
| `logo-viz`, `app-promo-shots`, `portrait-cutout`, `promo-video` | Visual asset generation |
| `connect-pm-mcp` | Wiring a project-management MCP server to your agent |
| `app-store-submission` | App Store and Play submission, with a blocking signing-ownership gate before anything is scanned |

The authoritative list, with the exact trigger phrases for each, is the Skills table in `AGENTS.md`
— that table is what the agent actually reads, so treat it, not this one, as the source of truth.

Add your own under `skills/<name>/SKILL.md`: define when to invoke it, what the protocol is, and
what artifacts it writes. Skills are tools, not state — they survive a brain reset.

---

## 5. The toolchain, and its tests

Everything in `scripts/` is zero-dependency Node. So are both test suites — the Node built-in
runner, no framework.

```bash
# toolchain: lint, repair, contract-sync, brain-init, leak guard, harness-install, the hooks
node --test "scripts/test/*.test.mjs"

# the Electron app
cd terminal-app && node --test "test/*.test.js"

# brain hygiene, against your actual brain
node scripts/lint-brain.mjs
```

**Use the quoted glob form.** `node --test <directory>` fails on Windows, which is this repo's
primary development platform, and the failure looks like a broken suite rather than a bad argument.

`lint-brain.mjs` exits 1 on any FAIL-severity flag and 0 on warnings alone. The intended discipline:
**FAIL means fix now, WARN means burn down lazily the next time you touch that file.**

### Git hooks

Two hooks ship in `scripts/git-hooks/`, installed together by pointing git at the directory:

```bash
git config --global core.hooksPath "/path/to/Mavis/scripts/git-hooks"
```

`commit-msg` rejects AI co-authorship trailers, so commits stay authored by you. `pre-commit` runs
the leak guard. Both no-op instantly outside a Mavis brain, which matters because `core.hooksPath`
is global and applies to every repository on the machine.

Note that a repo-local `core.hooksPath` — husky sets one — overrides the global setting, so neither
hook runs in those repositories.

---

## Lifecycle

| Trigger phrase | Action |
|----------------|--------|
| `setup mavis` / `run setup` | Run the setup wizard. If the brain is already set up, confirms before overwriting identity files. |
| `reset mavis` / `reset brain` | Move `identity/`, `projects/`, `daily-memories/`, `preferences/`, `rules/`, `topics/` to `_backup/<timestamp>/` and re-seed an empty skeleton. Requires typing `CONFIRM RESET` exactly. |
| `recalibrate mavis` / `upgrade brain` | Migrate an older brain onto the current format, backup first, legacy files kept as an inert fallback. |
| `install mavis slash` | Install the global `/mavis` command and the compaction-proof invariants into `~/.claude/` and/or `~/.codex/`. |

Reset never deletes — it moves to a timestamped backup folder. Restore is manual, on purpose:
auto-restore is too easy a way to clobber the wrong thing.

Full protocols: [`SETUP.md`](SETUP.md).

---

## What ships vs. what stays on your machine

**Ships (this repo):** the contract, the setup protocols, the empty seed scaffold, the skills, the
Electron app, the visualizer, and the toolchain. Nothing about any particular user.

**Stays local, gitignored, never committed:**

| Path | What's in it |
|------|--------------|
| `identity/` | Your name, pronouns, personality and communication files |
| `preferences/` | Everything Mavis has learned about how you work |
| `rules/` | Your behavioral invariants |
| `topics/` | Your cross-project knowledge index |
| `memory/` | Long-form recall files |
| `projects/` | Every project's index, progress, and notes |
| `daily-memories/` | Your dated work narratives |
| `standups/` | Generated standups |
| `.mavis-private` | Your leak-guard tuning — it names your clients, so it is itself private |
| `_backup/`, `_local/`, `.setup-complete` | Backups, machine-local keeps, the install marker |

Plus the usual: secrets (`.env*`, `*.pem`, `.mcp.json`, `service-account*.json`), build artifacts,
and editor state. `.gitignore` is commented block by block explaining why each entry is there —
**read it before you edit it.** Getting it wrong is how a private brain becomes a public one on the
next `git add .`, which is exactly the failure the leak guard exists to catch.

The `preferences/` / `rules/` / `topics/` directories are the ones people miss. They hold your
learned working style, and they are excluded exactly as hard as `identity/` is. What the repo ships
is the *empty* version of them, under `seeds/`.

One exception worth knowing: `.claude/settings.json` **is** committed, because it wires the
write-time leak guard and that is worthless if every user has to install it by hand. Your personal
Claude Code permissions belong in `.claude/settings.local.json`, which is not.

---

## Contributing

Forks and PRs welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for scope, workflow, the test
commands, and the commit-message rules — including the one that will reject your commit if your AI
assistant appends its own co-authorship trailer.

## Security

The setup wizard can set a global git config value, write to `~/.claude/` and `~/.codex/`, and the
app stores personal access tokens and spawns terminal sessions. All of that is normal operation and
all of it is explained in [SECURITY.md](SECURITY.md), along with how to report a vulnerability
privately.

## License

[MIT](LICENSE) — fork it, use it, modify it, ship your own. Keep the copyright line.

`skills/app-store-submission/references/` vendors three other projects, each MIT and each keeping
its own `LICENSE`. They are attributed in [NOTICE](NOTICE), with provenance and a refresh procedure
in [`skills/app-store-submission/references/README.md`](skills/app-store-submission/references/README.md).

## Not affiliated

This is an independent project. It is not affiliated with, sponsored by, or endorsed by Anthropic or
OpenAI; Claude and Claude Code are trademarks of Anthropic, and Codex is a product of OpenAI.
