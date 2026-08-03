# Memory protocols

*How the prose layer of the brain works, and the two protocols that use it.*

Most of this repo is code: linters, repair tools, a contract renderer, an Electron app. This
document is about the part that is not code — the Markdown files the agent reads and then obeys.

A **protocol** here is a rule the agent follows, written in prose, loaded only when it is relevant.
There is no runtime that enforces it. The enforcement is that the file is in context at the moment
the decision gets made, and that it says exactly one thing clearly.

---

## What a rule entry is

A rule is one file: `rules/_details/<slug>.md`. YAML front-matter, then three fixed headings.

```markdown
---
id: decision-log
title: Decision log — append-only record of why a call was made
category: rule
scope: [brain, decisions, project, rationale]
status: active
since: 2026-08-03
updated: 2026-08-03
links: [paired-write-on-meaningful-work, daily-memory-format]
---
## Rule
<the directive — what to do, stated imperatively>
## Why
<the reason, or the incident that established it>
## How to apply
<when it fires, and the concrete action>
```

`## Why` is not decoration. A rule with a stated reason survives contact with a situation its author
did not anticipate, because the agent can reason about whether the reason still applies. A bare
directive can only be obeyed literally or ignored. Field-by-field spec, the other three category
skeletons (`preference`, `topic`, `note`), and the `active` / `superseded` / `archived` lifecycle:
[`brain-schema.md`](brain-schema.md).

---

## Two-tier routing, and why it exists

Everything the agent loads at session start is paid for on **every turn** of that session. A brain
that grows without bound would eventually cost more to load than the work is worth. So entries are
split in two.

**The index** (`rules/_index.md`) is a flat list of stanzas, one per active entry:

```markdown
## decision-log
**Triggers:** decision, why did we, rationale, tradeoff, alternatives, rejected, revisit, adr, ...
**Summary:** Non-obvious calls append to `projects/<slug>/decisions.md` — append-only, never
edited; read on demand, never at boot.
**Detail:** [_details/decision-log.md](_details/decision-log.md)
```

**The detail** is the file above. The index carries triggers and a one-line summary and nothing
else; the detail carries substance and no triggers. Neither duplicates the other, so neither can
drift from the other.

At session start the agent loads `rules/_index.md` whole — it is small, and behavioral rules have to
be scannable before the first prompt is read. `preferences/_index.md` and `topics/_index.md` are
larger and are **not** loaded; they are grepped on disk when a prompt's keywords call for them. A
`_details` file is read only after one of its triggers matches.

Matching is literal keyword matching, not embeddings — a deliberate trade: recall is debuggable and
cheap, and the work moves to writing rich trigger lists. The documented failure mode is a prompt
phrased in words no trigger anticipated, which is why trigger lists carry synonyms, abbreviations,
and competitor names.

Superseded and archived entries keep their `_details` file on disk but lose their index line. They
stop costing anything at boot while the lesson survives. Growth is bounded by the *active* set, not
the all-time set.

---

## The two protocols

### `decision-log` — a queryable record of why

The brain already had two places for history and neither one kept reasoning.
`daily-memories/<date>.md` holds the narrative, but it is recalled by date and is the first thing a
compaction summary discards. `projects/<slug>/progress.md` holds what shipped, in bullets, and it
**rotates** into a yearly archive once it exceeds its size budget. Reasoning written into either one
is on a timer.

So non-obvious decisions get their own file: `projects/<slug>/decisions.md`, one appended section
each, holding the date, the decision, the context that forced it, **the alternatives rejected and
why**, and the condition that would justify revisiting it.

Two properties do the work:

**It is append-only and never edited.** A decision that no longer holds is not rewritten — a new
section supersedes it and the old one stays, wrong and dated. An editable decision log is a
changelog with better formatting: once past entries can be tidied to match current belief, the file
records what is convenient rather than what was thought. The entries that turned out to be wrong are
the valuable ones.

**The bar is high.** Three tests, all of which must hold: a competent person could have chosen
otherwise, the reasoning is not recoverable from the diff, and reversing it later costs real work.
Most work blocks produce no entry. If a project accumulates more than roughly one section per
working day, the bar has slipped and the file has become a second `progress.md`.

It is **never** boot-loaded. It is grepped when someone asks why something was decided, or before
starting work an old decision governs. Unlike `progress.md`, it never rotates and its sections are
never rewritten, which makes it a legal durable link target for other entries.

### `session-briefing` — spending a cost already paid

At session start the agent already reads the projects router and greps today's daily memory for its
section headings, because routing needs them. In the ordinary case that context is loaded and then
silently sat on — the user asks something narrow and the state of their work never surfaces.

The briefing is a read-out of that already-loaded context: at most eight lines, before the first
answer, saying where things stand, what is in flight today, and at most one stale project.

The constraint that defines it is **zero new reads**. The briefing may use the projects router, the
daily-memory headings, and the user's name. It may not open a project's `progress.md`, `notes.md`,
or any `_details` file to build itself. This matters more than it sounds: every individual extra
read looks cheap and justified, and together they raise the session-start floor permanently to make
one opening paragraph sharper. A briefing that reads new files to build itself has made boot more
expensive, not more useful. A vaguer briefing built from free context beats a sharper one that
raised the floor.

The same logic bounds the rule itself. Its boot cost is its index line, whose summary is written to
be operative on its own — the briefing can be emitted without ever opening the detail file, which
loads only when someone is tuning the format.

It is also allowed to say nothing. On a fresh brain, or when one project moved an hour ago and
nothing is stale, the correct briefing is one line or none.

---

## Writing your own

Both protocols ship as seeds in `seeds/rules/`, so `node scripts/init-brain.mjs --write` lays them
into a fresh brain. Adding your own is the same three steps every time:

1. Write `rules/_details/<slug>.md` — front-matter in schema order, then `## Rule` / `## Why` /
   `## How to apply`.
2. Append its stanza to `rules/_index.md` — `## <slug>`, `**Triggers:**`, `**Summary:**`,
   `**Detail:**`, in that order. Make the triggers synonym-rich; they are the entire recall surface.
3. Run `node scripts/lint-brain.mjs` — size budgets, link integrity, and contract sync.

Remember what an entry costs. Its index line is paid on every turn of every session; its detail file
only when a trigger fires. Keep the line short and put the length in the file that loads on demand.
