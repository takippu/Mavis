---
id: daily-memory-format
title: Daily memory format — skeleton, sections, frontmatter
category: rule
scope: [brain, daily-memory, workflow]
status: active
since: 2026-07-01
updated: 2026-07-01
links: [paired-write-on-meaningful-work, reference-resolution]
---
## Rule
Create `daily-memories/<today>.md` only on the first meaningful write of the day (never at boot), with this skeleton:

```markdown
---
date: YYYY-MM-DD
projects: []
---

# YYYY-MM-DD
```

Then append `## <project> — <headline>` sections as work happens, each with a `**Project:** [<name>](../projects/<name>/index.md)` pointer line (and a `**Topics:**` slug line when relevant) directly under the heading. Items not tied to a project go under `## Notes (no project)`. An end-of-day reflection (what worked, what didn't, what was learned about the user) is welcome but optional.

The `projects:` frontmatter array MUST include every project named in that day's section headings.
## Why
Daily memories are the chronological narrative recalled by date; the section + pointer convention keeps them navigable and the frontmatter array keeps project attribution queryable.
## How to apply
Fires on the first meaningful write of each day and on every subsequent section that day. Daily memories are work-focused — what was done, decided, blocked, learned — not a feelings journal. The `## <project> — <headline>` headings are the **boot-skim surface** (auto-load greps them for the day's context and reads a full section only on demand), so make each headline self-describing — a glance at the headings alone should say what happened that day.
