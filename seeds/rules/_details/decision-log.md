---
id: decision-log
title: Decision log — append-only record of why a call was made
category: rule
scope: [brain, decisions, project, rationale]
status: active
since: 2026-08-03
updated: 2026-08-03
links: [paired-write-on-meaningful-work, daily-memory-format, entry-lifecycle]
---
## Rule
A non-obvious decision gets one appended section in `projects/<slug>/decisions.md` — project-scoped, gitignored with the rest of `projects/`, and **never boot-loaded**. Create the file on the first decision worth recording; do not scaffold it empty.

```markdown
## YYYY-MM-DD — <the decision, stated as a decision, not as a task>
**Context:** <what forced the call — the constraint, the failure, the deadline, the thing that broke>
**Chose:** <what was actually decided, concretely enough to act on>
**Rejected:** <alternative> — <why not>. <alternative> — <why not>.
**Revisit if:** <the specific condition that would reopen this>
**Trail:** [YYYY-MM-DD](../../daily-memories/YYYY-MM-DD.md)
```

Sections append to the **end** of the file, oldest first. That ordering is not cosmetic: it makes "append-only" literal — a correct write never touches a byte that is already there, so a diff on this file is always pure addition and any in-place edit shows up as tampering.

**Append-only, never edited.** A decision that no longer holds is not rewritten, softened, or deleted. Write a NEW section for the new decision and open it with a `**Supersedes:** the YYYY-MM-DD decision on <topic>` line. Reference the old one by date and subject in **plain text, not a markdown anchor link** — the lint's heading slugger strips the em-dash and turns each space into a dash, so `## 2026-08-03 — Ship it` anchors as `#2026-08-03--ship-it` with a double dash, and a hand-written anchor will be wrong more often than right (it is a `warn`, not a `fail`, which is worse — it rots quietly). The old section stays exactly as written, wrong and dated, because the record of a decision you later reversed is the most useful thing in the file.

**The bar is high, and it is deliberately hard to clear.** Write a section only when all three hold:

1. **A competent person could have chosen otherwise.** There was a real alternative, not a single viable path.
2. **The reasoning is not recoverable from the artifact.** The diff, the config, and the code comments do not explain it. If a WHY comment in the source already carries it, that is the right home and this file is duplication.
3. **Reversing it later costs more than a few minutes.** Rework, a migration, a re-negotiation, an outage.

Explicit non-entries: routine implementation choices, naming, formatting, "we used X because it is the only option", anything already stated in a commit message, and — the failure mode this file exists to avoid — a dated line for every unit of work. **Volume is the tell.** If a project is accumulating more than roughly one section per working day over a sustained stretch, the bar has slipped and `decisions.md` has become a second `progress.md`. Stop and re-read the three tests above before appending again.

**Not boot-loaded. Read on demand only.** Nothing in the auto-load sequence touches this file, and it carries no `_index` line of its own. It is read in exactly two situations: (a) the user asks why something was decided, what the alternatives were, or whether a past call can be revisited; (b) work is about to start in an area a past decision plausibly governs — then `Grep` the file for the subject before writing code, and read only the matching section. Never read it whole as background.

`decisions.md` **is** a legal durable Ref target for a topic or preference entry — unlike `progress.md`, `progress-archive/`, and `standups/`, it never rotates and its sections are never rewritten, which is exactly the property the Refs rule is protecting.
## Why
The brain already had narrative and it already had checkpoints. It had no queryable record of WHY.

`daily-memories/<date>.md` holds reasoning, but as prose inside a day's story — recalled by date, and the first thing a compaction summary throws away. `projects/<slug>/progress.md` holds what shipped, in bullets, and it **rotates** into `progress-archive/<YYYY>.md` once it passes its size budget. So the reasoning behind a call had two homes and both of them were designed to lose it: one to compaction, one to rotation. A single working day of a real project produced roughly eight genuine decisions — which remediation strategy, which files to keep, what not to disclose — and six months later every one of them was either archived or summarized into "did the remediation".

The cost of losing them is not nostalgia. It is re-litigation: the same alternative gets re-proposed, re-argued, and sometimes re-adopted, because the reason it was rejected went with the prose. `**Rejected:**` is the field that pays for the file. `**Revisit if:**` is the one that keeps it from becoming dogma — a decision with a stated expiry condition can be reopened on evidence instead of on mood.

Append-only is what makes it trustworthy. An editable decision log is just a changelog with better formatting: the moment a past entry can be tidied to match what is currently believed, the file stops recording what was actually thought at the time and starts recording what is convenient now. The value is in the entries that turned out to be wrong.

And it is deliberately outside the boot path. A record of every decision ever made is precisely the kind of file that would eat the session-start budget for no return — the answer to "why did we do it this way" is worth a targeted read at the moment it is asked, and worth nothing paid every turn.
## How to apply
Fires on two separate occasions, one write and one read.

**Writing.** During a meaningful work block, after the paired write (daily memory + `progress.md`), ask whether the block contained a decision that clears all three tests. Usually it did not — most work blocks are execution, and the correct action is to write nothing here. When one did, append the section, set `**Trail:**` to the daily memory that carries the full narrative, and leave the narrative there rather than restating it. The section is a record, not a retelling: five lines, one screen, no paragraphs. If `**Context:**` is running past two sentences the detail belongs in the daily memory.

`**Revisit if:**` must name a condition an observer could check — "if the vendor ships a first-party SDK", "if the table passes ~5M rows", "if we need this on mobile". Never "if it becomes a problem".

**Reading.** On a why/rationale/alternatives prompt, or before starting work an old call governs, `Grep` `projects/<slug>/decisions.md` for the subject and read the matching sections only. Report what the log actually says, including when it contradicts current practice — a decision recorded and then quietly abandoned is a finding worth surfacing, not an embarrassment to smooth over. If the file does not exist or has no matching section, say so plainly rather than reconstructing a plausible rationale from the code; a fabricated why is worse than an admitted gap, because it will be believed and then cited.
