---
id: entry-lifecycle
title: Entry lifecycle — add / edit / supersede a two-tier entry + links + durable Refs
category: rule
scope: [brain, two-tier, topics, preferences, rules, notes]
status: active
since: 2026-07-01
updated: 2026-07-01
links: [keyword-recall-load-details-on-trigger, paired-write-on-meaningful-work]
---
## Rule
Distilled knowledge lives as one entry = one `<category>/_details/<slug>.md` file (`id` = slug = filename), listed by an `_index.md` line. To record or change a fact:

- **ADD** — create `<category>/_details/<slug>.md` with schema front-matter (`id, title, category, scope, status: active, since, updated, links`) + the category body skeleton (preference/rule: Rule/Why/How to apply · topic: Did/Refs/Pre-empt), then append its `## <slug>` / `**Triggers:**` / `**Summary:**` / `**Detail:**` block to `<category>/_index.md`. (Project notes are the flat exception — see below.)
- **EDIT** — surgically replace the affected `_details` section, bump `updated`, and refresh the `_index` Triggers/Summary only if scope changed.
- **SUPERSEDE** — set `status: superseded`, add `superseded_by: <new-slug>`, bump `updated`, and REMOVE the entry's line from `_index.md` (keep the `_details` file on disk). `archived` is the same drop-from-index / retain-on-disk move for entries with no successor. Reviving = flip back to `active`, clear `superseded_by`, re-add the `_index` line.

**New-topic authoring:** research synonyms + adjacent concepts + competitor/alternative names FIRST, so the Triggers line is synonym-rich (e.g. a PayEx topic still triggers on stripe / paypal / razorpay / billplz / ipay88). The `## Pre-empt` body admits the honest scope when triggers are broader than what was actually built.

**Links:** the front-matter `links: [slug, ...]` array cross-references related entries by id (cross-category allowed); it replaces the old `**Topics:**` pointer lines. A link to a superseded entry still resolves.

**Durable Refs (topics only):** `## Refs` must point only at durable targets — `projects/<name>/notes.md` (whole file or `#section-anchor`), `projects/<name>/index.md`, `projects/<name>/specs/<change>/*.md`, `daily-memories/YYYY-MM-DD.md`, repo path + symbol name (never raw line numbers), `memory/*.md`, or another `topics/_details/<slug>.md`. NEVER Ref `progress.md`, `progress-archive/*.md`, or `standups/*.md` — those rotate.

**Auto-shard:** if any `_index.md` exceeds ~200KB, split it into `<category>/_index/<range>.md` shards (alphabetical by slug) + a thin manifest, and Read every shard at boot.

**Project notes are the flat exception.** The ADD/EDIT/SUPERSEDE two-tier mechanics above apply to `preferences/`, `rules/`, `topics/` only. Project gotchas stay in a **flat** `projects/<name>/notes.md` — one `## <title>` section per gotcha, NOT a `notes/_details/<slug>.md` entry and NOT listed in any `_index`. Each section carries `**Discovered:** [YYYY-MM-DD](../../daily-memories/YYYY-MM-DD.md)` under its heading; once patched/superseded, add `**Resolved:** [YYYY-MM-DD](../../daily-memories/YYYY-MM-DD.md) — one-line summary of the fix` and keep the section for the lesson rather than deleting it.

**No topic pointer on `progress.md` checkpoints (intentional).** In the legacy graph, `progress.md` checkpoints carried a `**Topics:**` pointer line; under this format that reverse pointer is deliberately dropped — `progress.md` is a chronological log (and is a forbidden Ref target above), so topic traversal runs through the corresponding `_details` entry's `links:` array and the daily-memory section's pointers instead. Its absence on a checkpoint is not a defect.
## Why
Two-tier keeps session-start cost to Core + Identity + every `_index`; substance loads only on a keyword hit. Supersede-not-delete bounds growth while keeping the lesson on disk. Durable Refs and synonym-rich triggers are what make recall survive renames and fire on adjacent prompts.
## How to apply
Fires whenever a reusable fact is introduced or changed (the save side of paired-write for topics/preferences/rules/notes). Triggers live only in `_index`; substance only in `_details` — never duplicate, never drift.

**Backfill is lazy-on-touch.** When you edit an existing entry or notes section, bring it up to the current schema (front-matter, `links:` array, pointer lines) in the same write. Do bulk sweeps ONLY on explicit ask (e.g. "sweep a project"). The protocol is forward-only: pre-migration untagged sections and the legacy flat fallback files (`identity/preferences.md`, `topic_index.md`, `topic_details/`) still function and are NOT defects — they simply don't participate in link/keyword traversal until touched.
