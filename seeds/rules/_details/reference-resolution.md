---
id: reference-resolution
title: Reference resolution — loading and seeding a project when it's named
category: rule
scope: [brain, projects, workflow]
status: active
since: 2026-07-01
updated: 2026-07-01
links: [read-identity-and-index-at-session-start, daily-memory-format]
---
## Rule
When the user names a project, resolve it before answering:
1. Look in `projects/<name>/`. If it exists, load `index.md` + `notes.md` (a flat file — project notes are NOT two-tier) + `progress.md`.
2. If he asks about a specific past day, follow the daily-memory backlink in `progress.md` and read that day's `daily-memories/YYYY-MM-DD.md`.
3. If `projects/<name>/` does not exist, ASK before creating it — confirm the project type, an external path if any, and a one-line description.

To create a new project, seed `projects/<name>/` with:
- `index.md` — frontmatter (`name`, `type`, `status: active`, `path`, `created`, `last_accessed`, `tags`) plus a description and any tech-stack / goals sections.
- `progress.md` — empty, ready for the first checkpoint.
- `notes.md` — empty flat file for persistent gotchas/snippets/links (project notes are flat, NOT a two-tier `notes/_index.md` + `notes/_details/` store).
- `references/` — empty folder for user-provided artifacts (text, images, snippets).

Then update `projects/_index.md` (add the project) and keep its `index.md` frontmatter `last_accessed` current.
## Why
Projects are chronological + note-scoped, recalled by name not by boot-time keyword scan, so their files are pulled in only when the user references them. Asking before creating avoids inventing a project structure he didn't want.
## How to apply
Fires the moment a project is named or a new project is requested. Do not preload individual project files at boot — `projects/_index.md` is the only project file read at session start.
