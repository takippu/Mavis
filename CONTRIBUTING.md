# Contributing to Mavis

Mavis is the brain scaffold; you're the brain. This guide explains what kinds of contributions land, how to send them, and what stays local on your machine.

---

## Scope

**Wanted:**
- New skills under `skills/<name>/` (domain-specific protocols Mavis loads on demand — see existing `spec-driven` and `client-deck` for the shape)
- Features and fixes in `terminal-app/` (the Electron shell), with tests
- Fixes and checks in `scripts/` — the lint / repair / contract-sync / brain-init toolchain, also with tests
- Improvements to `viz/` (the brain graph viewer), including better parsing in `viz/scripts/build-data.ts` — e.g. markdown links for richer cross-cutting edges, tag extraction
- Bug fixes / clarity improvements to `AGENTS.md`, `SETUP.md`, `README.md`
- Wizard refinements in `SETUP.md` (better defaults, more useful initial questions)

**Not wanted:**
- Direct edits to `CLAUDE.md`. It is **generated** from `AGENTS.md` by `scripts/sync-contract.mjs`; edit the source and regenerate (see Testing)
- Pre-filled identity / personality / preferences that lock cloners into a specific tone or workflow — those files are *seeded* by the wizard from the user's answers, not shipped with opinions
- Hardcoded user names anywhere in core (the contract is name-agnostic — `identity/profile.md` is the runtime source-of-truth). The same goes for real client names, real ticket IDs, and absolute paths off your own machine, including in tests and fixtures: use synthetic ones (`acme-portal`, `TICKET-1`, `os.tmpdir()`)
- Heavy dependencies anywhere. The toolchain and both test suites run on stock Node with zero test deps, and `viz/` must keep its zero-config 1-click launch via `start.bat` / `start.sh`
- New top-level directories without a clear purpose
- Emojis, in code, comments, docs, or commit messages. Project-wide rule; use plain text or an SVG/lucide icon

If you're not sure whether something fits, open an issue first.

---

## Workflow

Standard fork-and-pull-request flow:

```bash
# 1. Fork takippu/Mavis on github.com to your own account
# 2. Clone your fork
git clone https://github.com/<your-username>/Mavis.git
cd Mavis

# 3. Branch
git checkout -b add-<short-feature-name>

# 4. Make changes, test locally (see Testing below)

# 5. Commit + push to your fork
git push origin add-<short-feature-name>

# 6. Open a Pull Request against takippu/Mavis main
```

Direct push access to `takippu/Mavis` is reserved for trusted maintainers. First-time contributors go through the PR flow.

---

## What stays local

`.gitignore` excludes everything personal. **Don't edit `.gitignore` carelessly — it's load-bearing infrastructure.** Editing it wrong can leak your name, work history, and decisions to the public repo on your next `git add .`.

What's excluded (and why):

| Path | Why local |
|------|-----------|
| `identity/` | Your name, pronouns, personality file, communication preferences |
| `preferences/` | Everything Mavis has learned about how *you* work |
| `rules/` | Your behavioral invariants, including the ones relocated out of the contract |
| `topics/` | Your cross-project knowledge index |
| `memory/` | Long-form recall files |
| `projects/` | Your project tracking — every project's index, progress, notes |
| `daily-memories/` | Your work history, dated narratives |
| `standups/` | Generated daily standups |
| `_backup/` | Reset- and repair-protocol backups (unanchored: `_backup/` anywhere) |
| `_local/` | Anything kept on the machine but deliberately not published |
| `.setup-complete` | Per-install marker — different per machine |
| `workspace/`, `.claude/`, `.superpowers/` | Per-machine tool state |
| `.env*`, `*.pem`, `*.key`, `.mcp.json`, `service-account*.json`, … | Secrets and machine-local tool config |
| `node_modules/`, `viz/dist/`, `viz/.vite/`, `Mavis-Terminal.exe` | Build artifacts |
| `viz/public/data.json` | Generated per-user from your brain |
| `__pycache__/`, `*.pyc` | Python bytecode — a tracked `.pyc` once embedded an absolute home-directory path |
| `.obsidian/`, `.vscode/`, `.idea/` | Editor / vault metadata |

The important half of that list is the first block: **the three two-tier category directories
(`preferences/`, `rules/`, `topics/`), plus `memory/`, are gitignored exactly as hard as
`identity/` is.** Everything Mavis learns about you stays on your machine. What ships is the empty scaffold
under `seeds/`, never your entries.

If your contribution introduces a new pattern that needs to stay local (e.g. a generated file, a per-user config), add it to `.gitignore` in the same PR. Read the comments in `.gitignore` before editing it — each block says why it exists.

---

## Testing

There is a real test suite — two of them, actually, both on the Node built-in runner with zero
test dependencies. Run whichever covers what you touched; run both if you're not sure.

```bash
# Toolchain: lint, repair, contract-sync, brain-init, harness-install, the commit-msg hook
node --test "scripts/test/*.test.mjs"

# Electron app: config, harness adapters, parsers, session state, git + brain services
cd terminal-app && node --test "test/*.test.js"

# Brain hygiene: size budgets, link integrity, the Refs rule, projects/_index line rules,
# and contract sync (CLAUDE.md must still match what AGENTS.md renders to).
node scripts/lint-brain.mjs
```

**Use the quoted glob form.** `node --test <directory>` fails on Windows, and Windows is the
primary development platform for this repo — a bare directory argument will look like the suite
is broken when it isn't.

If you edit `AGENTS.md`, regenerate the derived contract with
`node scripts/sync-contract.mjs --write` before committing. `AGENTS.md` is canonical and
`CLAUDE.md` is generated from it; the lint fails on drift, so an unregenerated `CLAUDE.md` will
block your PR.

Some things still need a human:

- **Contract / wizard changes (`AGENTS.md`, `SETUP.md`, `skills/`)** — open the brain folder in Claude Code, exercise the relevant lifecycle command (`setup mavis`, `propose <feature>`, etc.). For wizard changes, run `setup mavis` in a fresh install (or after backing up your `identity/`) to walk through the full flow. No automated test can tell you whether an instruction reads clearly to a model.
- **`viz/` changes** — run `start.bat` / `start.sh`, verify the dev server starts cleanly at http://localhost:5174, exercise the affected interactions in your browser. For TypeScript changes: `cd viz && npx tsc --noEmit --skipLibCheck` should be clean.

New behaviour in `scripts/` or `terminal-app/src/` should arrive with a test. For UI/UX changes, include a before/after screenshot in the PR description. For new skills, include a brief usage example.

---

## Commit messages

The convention used in this repo:

- Subject line ≤72 chars, imperative mood ("add", "fix", "remove" — not "added")
- Body wrapped at ~72 chars, explains *why* the change matters (not just what)
- Footer for a human co-author: `Co-Authored-By: <Their Name> <their@email>`
- For bug fixes, link the issue: `Fixes #123`

**No AI attribution trailers.** Do not add `Co-Authored-By: Claude`,
`Co-authored-by: Codex`, or a "Generated with ..." tool footer, even if the assistant you
used inserts one by default — several of them do, every turn. This is a standing invariant of
the project, and `scripts/git-hooks/commit-msg` enforces it mechanically: a commit carrying one
of those trailers is rejected outright, so letting your assistant append its default here means
the commit simply won't be created. Use the assistant freely; ship the commit under your own name.

To get that hook running locally (it is not automatic — git hooks never are):

```bash
git config --global core.hooksPath "<path-to-your-clone>/scripts/git-hooks"
```

That is a **global** setting affecting every repo on your machine, which is why nothing sets it
for you. A repo-local `core.hooksPath` (husky, for one) overrides it, so the hook won't fire in
those repos.

Example:

```
viz: hide cross-cutting edges by default

The mentions edges (daily memory -> project) clutter the resting
graph at scale. Hide them by default; reveal only on node hover.
Connections still accessible via hover focus, but the at-rest
view stays clean as the brain grows past 50 nodes.

Co-Authored-By: Jane Doe <jane@example.com>
```

---

## Reporting bugs / asking questions

- **Bug** — open a GitHub issue with: steps to reproduce, expected vs actual, your OS + Node version (for `viz/` issues), and a screenshot if relevant.
- **Feature idea** — open an issue first to discuss before writing code, so effort isn't wasted on something that doesn't fit scope.

---

## Licensing of contributions

By opening a pull request you agree that your contribution is licensed under the repo's [MIT licence](LICENSE), the same terms as everything already here.

---

That's it. Keep contributions small, focused, and reviewable. The scaffold stays opinionated and stable so every cloner gets the same predictable starting point.
