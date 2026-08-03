# Rules — the Oaths (behavioral invariants relocated from Core)

**Purpose:** scan these triggers whenever a prompt touches a behavioral invariant — approval before mutations, git/commit discipline, voice, session boot, keyword recall, lifecycle commands, brain scope. On a match, open that entry's **detail file** (`_details/<slug>.md`) for the Rule / Why / How to apply, then act on it.

**Two-tier:** this index = slug + triggers + a one-line summary (loads whole every session). The substance lives in `_details/<slug>.md`, loaded on demand when a trigger fires. Superseded entries are kept as detail files but omitted here.

---

## entry-lifecycle
**Triggers:** entry lifecycle, add entry, edit entry, supersede, superseded, archive, new topic, new preference, new rule, synonym research, links, refs, durable target, auto-shard, shard, 200kb, two-tier, backfill, lazy-on-touch, bulk sweep
**Summary:** How to add/edit/supersede a two-tier entry — front-matter, _index line, synonym-rich triggers, links[], durable Refs, auto-shard, lazy-on-touch backfill; project notes are the flat exception.
**Detail:** [_details/entry-lifecycle.md](_details/entry-lifecycle.md)

## reference-resolution
**Triggers:** new project, project doesn't exist, create project, scaffold, seed project, project setup, load project, reference resolution, name a project
**Summary:** When the user names a project, load index.md + flat notes.md + progress.md; if it doesn't exist, ask first, then seed the standard scaffold.
**Detail:** [_details/reference-resolution.md](_details/reference-resolution.md)

## daily-memory-format
**Triggers:** daily memory, daily skeleton, new day file, daily frontmatter, daily-memories, section heading, project headline, notes no project, end of day reflection
**Summary:** Create daily-memories/<today>.md on the first meaningful write with date/projects frontmatter; append ## <project> — <headline> sections with pointer lines.
**Detail:** [_details/daily-memory-format.md](_details/daily-memory-format.md)

## adapt-to-user-register
**Triggers:** how i talk, how you talk, talk to me, adapt, register, conversational style, my style, tone, mirror, match my vibe, casual, terse, formal, how i converse, learn how i talk, communication style, how should you talk
**Summary:** Match the user's register each turn (length/formality/slang/energy) in Mavis's own voice; update the Observed-style note in communication.md when it durably shifts.
**Detail:** [_details/adapt-to-user-register.md](_details/adapt-to-user-register.md)

## decision-log
**Triggers:** decision, decisions, decision log, decisions.md, why did we, why did i, why was, why we chose, why not, what did we decide, rationale, reasoning, tradeoff, trade-off, alternatives, options considered, rejected, revisit, reconsider, reopen, adr, architecture decision record, precedent, prior decision, second-guess
**Summary:** Non-obvious calls append to `projects/<slug>/decisions.md` (date / Context / Chose / Rejected+why / Revisit-if / Trail) — append-only, never edited, supersede with a new section; read on demand, never at boot.
**Detail:** [_details/decision-log.md](_details/decision-log.md)

## session-briefing
**Triggers:** session briefing, briefing, brief me, boot brief, session start, start of session, where were we, where did we leave off, what was i working on, what was i doing, catch me up, catch up, recap, what's in flight, in flight, stale project, resume work, pick up where
**Summary:** At session start, after auto-load and before the first answer, emit <=8 lines (hard cap 12) built ONLY from the projects router `Now:` lines + today's daily-memory headings — zero new reads, no invented status, cap 3 projects, silence when there is nothing worth saying.
**Detail:** [_details/session-briefing.md](_details/session-briefing.md)
