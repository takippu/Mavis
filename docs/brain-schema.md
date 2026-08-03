# Brain Schema

*Canonical source of truth for the unified Mavis brain structure.*
*Every migration converter, the app parser (`brain-stats.js`), and the app writer (`mavis-config-writer.js`) conform to this document. If code and this doc disagree, this doc is right — fix the code.*

The brain has **one entry schema**, **one index-line format**, **four category body skeletons**, **one status lifecycle**, and **three load tiers**. Everything below specifies them exactly.

---

## 1. Load tiers (the mental model)

Every file in the brain lives in exactly one of three tiers. The tier decides *when* it loads and *whether* it carries triggers.

| Tier | Files | Loads | Triggers? |
|------|-------|-------|-----------|
| **Always-on** | `CLAUDE.md` (Core) · `identity/{profile,personality,communication}.md` | Whole, every session start | **Never.** Always-on files are never trigger-gated; if one accidentally carries a `Triggers:` line it is ignored. |
| **Two-tier (trigger-routed)** | `preferences/` · `rules/` · `topics/` · `projects/<p>/notes/` | `_index.md` loads whole at session start; `_details/<slug>.md` loads only on a keyword hit | **Yes** — triggers live in `_index`, substance in `_details`. |
| **Chronological** | `daily-memories/<date>.md` · `standups/<date>.md` · `projects/<p>/{index,progress}.md` | Recalled by **date or project**, not by keyword; standardized section template; better render only | **No** — wrong access pattern for keyword routing. |

Rules of the tier map:

- **Core is the floor, not the library.** Behavioral invariants (approval-before-mutations, never-commit-unbidden, no-emojis, paired-write, verify-before-claim) + the auto-load/save procedure + the category/skill trigger router stay in Core. Situational procedure (how to write a daily memory, a skill's protocol, setup/reset detail) moves out to `rules/_details/` and is pulled in by trigger.
- **Identity is always-on** because it shapes every reply; it is never reduced to a trigger.
- **Two-tier is the default for distilled knowledge.** If a fact is keyword-recallable and reusable, it is a `preference`, `rule`, `topic`, or project `note`.
- **Chronological is for the log.** Dailies, standups, and `progress.md` are time-ordered narrative recalled by *when* or *which project*, not by *what keyword*. They get a standardized section template and a nicer render, but never an `_index` of triggers.

A `_details` substance file is loaded into context **only** after a trigger keyword in its `_index` line matches the current prompt. That is the entire economy of the design: session-start cost is Core + Identity + every `_index`, and nothing else until a keyword fires.

---

## 2. The canonical entry — `<category>/_details/<slug>.md`

Every distilled entry is one file: `<category>/_details/<slug>.md`. It is YAML front-matter followed by a category-appropriate prose body. The body is readable LLM prose under fixed headings — structured enough to parse, loose enough to hold a story.

```markdown
---
id: standup-previous-work-day
title: Standup — "Previous Work Day" = last working day
category: preference
scope: [standup, daily-ops, workflow]
status: active
since: 2026-06-18
updated: 2026-06-18
links: [standup-format, standup-today-from-user]
# superseded_by: <slug>   # only when status != active
---
## Rule
<the directive>
## Why
<the reason / the incident that set it>
## How to apply
<when it fires, what to do>
```

### 2.1 Front-matter field spec

Fields appear in the order below. All nine keys are part of the schema; `superseded_by` is the only conditional one. The parser reads every field; the writer emits them in this order for byte-stable round-trips.

| Field | Required | Type | Meaning | Allowed values / format |
|-------|----------|------|---------|--------------------------|
| `id` | yes | string | Stable identifier for the entry. **Must equal the slug** (the filename without `.md`). Never changes once assigned — renaming a title does not rename the id. | kebab-case `[a-z0-9-]+`; unique within its category. |
| `title` | yes | string | Human-readable one-line label shown in the app slot and detail header. | Free text; may contain quotes, em-dashes, punctuation. Keep to one line. |
| `category` | yes | enum | Which category this entry belongs to. Decides the body skeleton **and** which `_index.md` lists it. | `preference` \| `rule` \| `topic` \| `note` |
| `scope` | yes | string[] | Filter/grouping tags. Drives the app's scope filter (e.g. Traits tab) and human browsing. Not used for keyword recall (that's `Triggers`). | Array of lowercase kebab tags, e.g. `[standup, daily-ops, workflow]`. May be empty `[]` but prefer at least one. |
| `status` | yes | enum | Lifecycle state. Controls whether the entry appears in `_index` and whether it loads at boot. | `active` \| `superseded` \| `archived` (see §5) |
| `since` | yes | date | When the entry was first established (the originating date / incident date). Equivalent to the old "Discovered" date. Does not change on later edits. | `YYYY-MM-DD` |
| `updated` | yes | date | Date of the last substantive edit to the body or fields. Equals `since` on creation; bumped on every meaningful edit. | `YYYY-MM-DD` |
| `links` | yes | string[] | Related entries, by `id` (slug). Cross-category links are allowed (a preference may link a topic). Powers the "related" graph in the app and graph traversal headless. | Array of slugs; may be empty `[]`. A link to a superseded entry still resolves but is rendered as superseded. |
| `superseded_by` | conditional | string | The `id` of the entry that replaces this one. **Present only when `status` is `superseded`** (and optionally on an `archived` entry that has a named successor). Kept commented-out (`# superseded_by:`) while the entry is active. | A single slug. For `archived` entries with no successor, omit it; record the retirement reason in the body's `## Resolved`/`## Why` instead. |

Authoring/parsing notes:

- **`id` is the slug is the filename.** All three are the same string. The writer derives the path from `id`; the parser cross-checks them and flags a mismatch.
- Dates are bare ISO `YYYY-MM-DD` (no time, no quotes).
- Arrays use inline flow style `[a, b, c]`. An empty array is `[]`, never blank.
- Unknown extra keys are preserved on round-trip but ignored by the renderer — do not rely on them.

### 2.2 Per-category body skeletons

The `category` field selects the body skeleton. Headings are fixed (exact text, `##` level, this order). Prose under each heading is free.

**`preference` and `rule` — identical skeleton:**

```markdown
## Rule
<the directive — what to do or not do, stated imperatively>
## Why
<the reason, or the incident that established it>
## How to apply
<when it fires and the concrete action to take>
```

A `preference` is a learned way the user likes to work (voice, defaults, habits). A `rule` is situational procedure relocated out of Core (how to perform some operation when its trigger fires). They share the skeleton because both answer *what to do / why / when*. The difference is category + which `_index` and app tab (Traits vs Oaths) they surface in.

**`topic` — cross-project knowledge:**

```markdown
## Did
<what we actually built/learned, in one or two sentences>
## Refs
<durable pointers to where the work lives — see allowlist below>
## Pre-empt
<the honest scope: what this covers and, when triggers are synonym-broad,
 what we have NOT actually done so future-Mavis adapts rather than overclaims>
```

`## Refs` **must** point only at durable targets:

- `projects/<name>/notes/_details/<slug>.md` (or a `#section-anchor`)
- `projects/<name>/index.md`
- `projects/<name>/specs/<change>/*.md`
- `daily-memories/YYYY-MM-DD.md` (or `#section-anchor`)
- repo file paths **+ a symbol name** (function / class / file role) — never raw line numbers, which rot on the next edit
- `memory/*.md` (auto-memory)
- another `topics/_details/<slug>.md` (cross-link topics)

`## Refs` must **never** point at `projects/<name>/progress.md`, `progress-archive/*.md`, or `standups/*.md` — those are chronological logs subject to rotation. If a checkpoint surfaces a topic-worthy fact, the fact lives in a `note` and the topic Ref points there.

**`note` — a project-scoped gotcha or persistent fact:**

```markdown
## Gotcha
<the persistent fact, trap, snippet, or quirk — the thing worth remembering>
## Discovered
[YYYY-MM-DD](../../../daily-memories/YYYY-MM-DD.md)
## Resolved
[YYYY-MM-DD](../../../daily-memories/YYYY-MM-DD.md) — one-line summary of the fix/supersession
```

For a `note`, `## Discovered` is **required** and carries the dated daily-memory backlink for when the gotcha first surfaced (this is the durable anchor; `since` front-matter mirrors the date). `## Resolved` is **optional** — present only once the gotcha is patched, superseded, or no longer applies; keep the section (and the entry) for the lesson rather than deleting. When `## Resolved` is filled, set `status: superseded` (or `archived`) accordingly.

---

## 3. The index line — `<category>/_index.md`

Each two-tier category has one `_index.md` that lists **only its active entries**. It is the file loaded whole at session start; its job is to carry every trigger so a keyword scan can fire. It holds **no substance** — substance is in `_details`, never duplicated here (the topics invariant, generalized to the whole brain).

One section per active entry, exactly:

```markdown
## standup-previous-work-day
**Triggers:** standup, daily ops, daily, morning report, previous work day, last working day, yesterday's work
**Summary:** Ask which day was the last working day — don't compute it; leave is ad-hoc.
**Detail:** [_details/standup-previous-work-day.md](_details/standup-previous-work-day.md)
```

Format rules:

- **Heading** `## <slug>` — the entry's `id`, matching its `_details` filename. This is the parser's section key.
- **`**Triggers:**`** — a comma-separated keyword list (see §4). The only thing the keyword scan reads.
- **`**Summary:**`** — one line, the gist, so a human (and Mavis at a glance) knows what's inside without opening `_details`. Not a duplicate of the body — a teaser.
- **`**Detail:**`** — a relative markdown link to the `_details/<slug>.md` file. Always `[_details/<slug>.md](_details/<slug>.md)`.
- The three `**…:**` lines appear in this order directly under the heading, one per line.
- Sections are separated by a blank line. Ordering across sections is not semantically meaningful (the parser is order-independent), but keep a stable order (alphabetical by slug, or by `since`) to minimize diffs.
- An `_index.md` may begin with an optional `# <Category>` H1 + a one-line note; the parser ignores everything above the first `## <slug>`.
- **Superseded/archived entries have no index line.** Their `_details` file stays on disk; they simply do not appear here, so they never load at boot (see §5).
- A `**Detail:**` pointing at a missing `_details` file is a broken entry: the app renders "entry missing" and flags the line; headless Mavis notes the gap rather than erroring.

---

## 4. Trigger authoring (recall is explicit keyword match)

Recall is **deterministic keyword matching, not fuzzy/semantic similarity.** On each prompt, Mavis scans the loaded `_index` trigger lists for a keyword (or an obvious stem) that appears in the prompt, and loads the matching `_details` before answering. There is no embedding, no similarity score, nothing inspectable-only-by-the-model. This is a deliberate design choice: the work moves to *authoring good trigger lists*, and recall stays debuggable.

Because matching is literal, the trigger list is the entire recall surface. Author it richly:

- **Be synonym-rich and adjacency-rich.** List the obvious term, its synonyms, abbreviations, competitor/alternative product names, and adjacent concepts. Example: a `payment-gateway` topic built only on PayEx should still trigger on `stripe, paypal, razorpay, billplz, ipay88, checkout, payment, gateway` — so a future prompt about Stripe surfaces the PayEx analog.
- **Include stems and word-forms** the prompt might use: `deploy, deploys, deployment, ship, push, release, vps`.
- **When a synonym-trigger fires for something we haven't actually built**, the `## Pre-empt` body must admit the narrow scope honestly — surface the analog work we *do* have and offer to adapt, rather than overclaiming.
- **Lowercase, comma-separated.** Multi-word phrases are fine (`previous work day`, `last working day`). Match is case-insensitive substring/stem against the prompt.
- **Two entries may share a trigger word** — both are eligible; Mavis loads the most relevant, or both.
- **Cost is paid once, at authoring time.** A missed recall (prompt contains no listed trigger) is the documented failure mode; mitigate it by exhaustive triggers and by Mavis re-reading the `_index` each turn — not by switching to fuzzy matching.

`scope` (front-matter) is for filtering/grouping in the app; `Triggers` (`_index`) is for recall. Keep them distinct — do not collapse one into the other.

---

## 5. Status lifecycle

Every entry carries `status: active | superseded | archived`. The status governs both context loading and app visibility, and it is how growth is bounded brain-wide.

| Status | In `_index`? | Loads at boot? | `_details` on disk? | Meaning |
|--------|--------------|----------------|---------------------|---------|
| `active` | yes | yes (its `_index` line) | yes | Current, in force. The default for a new entry. |
| `superseded` | **no** | no | **yes**, retained | Replaced by a better/newer entry. Carries `superseded_by: <slug>`. The lesson is kept; it just stops costing context. |
| `archived` | **no** | no | **yes**, retained | No longer applies (obsolete, resolved, retired) with no direct successor. Reason recorded in the body (`## Resolved` / `## Why`). |

Lifecycle mechanics:

- **Supersede = flip + drop, never delete.** To supersede, set `status: superseded`, add `superseded_by: <new-slug>`, bump `updated`, and **remove the entry's section from `_index.md`**. The `_details` file stays. Next session it no longer loads; the lesson survives on disk.
- **Archive** is the same drop-from-`_index`, retain-on-disk move for entries with no successor (obsolete rather than replaced).
- **The app** hides superseded/archived entries by default and reveals them via a "show superseded" toggle, rendering them visibly retired.
- **Links survive supersession.** If a still-active entry's `links[]` references a superseded entry, the link resolves but is marked as superseded in the render. Do not scrub back-links on supersede.
- **Reviving** an archived/superseded entry = set `status: active`, clear `superseded_by`, bump `updated`, and re-add its `_index` line.

This is the brain-wide bound: anything not `active` falls out of the session-start load automatically, so context cost tracks the *active* set, not the *all-time* set — while nothing is ever lost from disk.

---

## 6. Directory layout summary

```
CLAUDE.md                              # Core — always-on, no triggers
identity/{profile,personality,communication}.md   # always-on, no triggers

preferences/_index.md                  # active preference index lines
preferences/_details/<slug>.md         # preference entries (Rule/Why/How to apply)
rules/_index.md                        # active rule index lines
rules/_details/<slug>.md               # rule entries (Rule/Why/How to apply)
topics/_index.md                       # active topic index lines  (was topic_index.md)
topics/_details/<slug>.md              # topic entries (Did/Refs/Pre-empt)  (was topic_details/)
projects/<p>/notes/_index.md           # active project-note index lines
projects/<p>/notes/_details/<slug>.md  # note entries (Gotcha/Discovered/Resolved)

daily-memories/<date>.md               # chronological — standardized sections, no triggers
standups/<date>.md                     # chronological — Quest Log render
projects/<p>/{index,progress}.md       # chronological — progress is time-ordered

_backup/<timestamp>/                   # pre-migration snapshot (backup-first, reversible)
```

Invariants for parser/writer/migration:

- **One entry = one `_details` file.** `id` = slug = filename.
- **Triggers only in `_index`; substance only in `_details`.** No duplication, no drift.
- **`_index` lists active entries only.** Status `superseded`/`archived` ⇒ absent from `_index`, present in `_details`.
- **Byte-safe round-trip.** An unchanged save re-emits the file byte-identical (field order per §2.1, inline arrays, blank-line conventions per §3). This preserves the existing writer guarantee.
- **Legacy fallback during transition.** Readers fall back to the pre-migration format until the new structure is verified; drop the fallback only after rollout.
