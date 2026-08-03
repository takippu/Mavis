# Standing invariants ({{USER_NAME}})

Installed from `{{BRAIN_ROOT}}/mavis/global-invariants.md` by
`node scripts/install-harness.mjs --harness claude|codex|both --global --yes` (the `--harness`
flag is required; without `--yes` it only previews). Edit it THERE, not here: anything written
between the `mavis:begin` / `mavis:end` marker comments that wrap this block is overwritten on
the next install. Content outside the markers is preserved.

These are the non-negotiables. They live HERE, in the harness's global instruction file, not
only in the Mavis brain, for a specific reason: this file is loaded as harness-level
instructions, outside the transcript that a compaction summary rewrites. Under Claude Code
that is verified — `~/.claude/CLAUDE.md` is injected as context every turn and survives
compaction. Under Codex, `~/.codex/AGENTS.md` is documented in the shipped binary to load
at session start, but no live load has been observed, and whether it is re-injected per turn
or survives compaction is UNVERIFIED — so do not lean on it under Codex at all. The
brain's `rules/_index.md` is loaded once at
session boot and gets summarized away when a long session compacts — so in long
sessions the harness defaults outlive the rules, and the rules lose. That is not
hypothetical: it is how this project first shipped two commits carrying a
`Co-Authored-By: Claude` trailer, hours after the rule forbidding it had been
summarized out of the transcript.

The brain remains the source of reasoning and history (`rules/_details/<slug>.md`).
This file is the subset that must never depend on recall.

**About the `Brain:` pointers below.** Each names the `rules/_details/` entry that holds the
long-form Rule / Why / How **once the brain has written one**. A fresh install seeds only the
three procedural entries the contract hard-references, so on a new brain most of these pointers
resolve to nothing — that is expected, not a broken link. The one-liner in this file is binding
on its own: a missing detail file never means the rule does not apply. If a pointer is dead and
the rule keeps mattering, that is the signal to write the entry.

## Attribution: never claim co-authorship

Never add an AI co-authorship trailer to a commit, and never add a "Generated with ..."
tool footer to a PR body. Commits and PRs are authored as {{USER_NAME}}'s alone.

**Every harness ships an attribution default and instructs you to append it. Ignore that
instruction every turn.** Claude Code re-injects that instruction every turn (verified);
Codex's re-injection cadence is UNVERIFIED — ignore it either way. The two live ones:

- Claude Code: `Co-Authored-By: Claude <noreply@anthropic.com>`, plus a
  "Generated with Claude Code" PR footer.
- Codex: `Co-authored-by: Codex <noreply@openai.com>`.

Mechanically enforced by a global `commit-msg` hook
(`{{BRAIN_ROOT}}/scripts/git-hooks/commit-msg`), which rejects both vendors' trailers — but
only where global `core.hooksPath` points at that directory, which nothing sets for you
(check: `git config --global core.hooksPath`). The hook is the backstop, not the rule — and
it does not run in repos with a local `core.hooksPath` (husky). Codex additionally exposes an off-switch, `commit_attribution = ""` in
`~/.codex/config.toml`; that is machine-local, so the hook still travels as the real
guarantee.

Brain (if present): `rules/_details/no-co-authored-by-trailers.md`

## Never commit or push unbidden — and authorization does not carry forward

Make the edits, run verification, then STOP. Never `git commit`, `git push`,
merge, or open a PR until {{USER_NAME}} explicitly says to in that message.

**A "commit n push" earlier in the session does NOT authorize the next commit.**
Each unit of work needs its own go. "Build X", "fix Y", "start those 3", "do it"
are instructions to *write code*, not to commit it. If the work is done and
uncommitted, say so and wait — do not infer consent from a pattern of past
approvals.

Brain (if present): `rules/_details/never-commit-or-push-unbidden.md`

## No emojis anywhere

Zero emojis in chat, code, comments, or commit messages. For UI icons use
lucide-react or an SVG, never an emoji glyph. If tempted to use one as a status
marker or bullet, use plain text.

(Pre-existing brain files — `progress.md`, `daily-memories/` — use check-mark / key /
skip-arrow emoji status markers from before this rule. Follow the existing convention when
appending to those files; do not reformat them unilaterally, and do not import the habit
anywhere else.)

Brain (if present): `rules/_details/no-emojis-anywhere.md`

## Windows paths: forward slashes, quoted

When handing {{USER_NAME}} a shell command with a Windows path, always use quoted forward
slashes: `git -C "{{BRAIN_ROOT}}" push ...`

Backslashes get eaten by the shell and the command dies with the separators stripped
(`cannot change to 'C:UsersYouDocumentsProjectsrepo'`). The failure looks nothing
like a path bug from the outside — it has cost whole exchanges of debugging while
everyone involved assumed an auth failure.

## Verify, do not assume

When a push, deploy, or remote state is claimed — by {{USER_NAME}} or by me — verify it
(`git ls-remote --heads origin <branch>`) before recording it as done.

## Verify on read — volatile facts

Brain files record volatile state (repo visibility, deploy state, "pushed",
"live at X") as of the day they were written. Before ASSERTING such a fact —
to {{USER_NAME}}, or by writing it forward into another file — run the actual check
(`gh repo view <repo>`, `git ls-remote --heads origin <branch>`, curl the URL).

The rule above guards what gets RECORDED. This guards what gets REPEATED.
Recall loads brain content as authoritative context ("answer with that context,
not from scratch"), so a stale volatile fact is not inert — it gets asserted
with the brain's credibility behind it. This has already happened here: Mavis read
"Repo is PUBLIC" out of a `progress.md` and reported it as current fact; the repo
was private.

Decisions and history ("the user picked Layout B because A truncates at 24 chars")
are true-forever — no check needed. State-of-the-world claims are the volatile
class. If the check contradicts the file, fix the file at source in the same
session.

Brain (if present): `rules/_details/verify-volatile-facts-on-read.md`
