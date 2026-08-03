# Spec-Driven — Skill

A 4-artifact spec workflow for non-trivial changes. Use when a feature, refactor, migration, or piece of infrastructure deserves to be designed before it's coded.

## When to invoke

Load this file when the user says any of:
- "propose <feature>"
- "spec out <change>" / "let's spec this"
- "create a spec for <X>"

Don't load it for trivial work (single-file edits, typo fixes, one-off tweaks). The four artifacts are overhead — they pay off when the change is big enough to forget the why.

## The four artifacts

| Artifact | Question it answers | Lives at |
|----------|--------------------|----|
| `proposal.md` | **Why** are we doing this? | `projects/<project>/specs/<change>/proposal.md` |
| `requirements.md` | **What** must work when we're done? | same folder |
| `design.md` | **How** are we going to build it? | same folder |
| `tasks.md` | **In what order** are we going to ship it? | same folder |

All four exist from the moment the spec is created. They evolve in parallel — there are no phase gates. Adding a task may mean updating the design; clarifying a requirement may shift the proposal's scope. That's fine. The point is alignment between them, not a waterfall.

## Where specs live (the v1 fix)

Specs live **inside the project they belong to**:

```
projects/<project>/
└── specs/
    └── <change-name>/
        ├── proposal.md
        ├── requirements.md
        ├── design.md
        └── tasks.md
```

Not at the repo root. Not in a global `openspec/`. The project owns its specs. If the project is renamed or archived, its specs travel with it.

## Command reference

All commands are natural language. The `<change>` argument is whatever the user typed — sanitize to kebab-case for the folder name (`"Dark Mode Toggle"` → `dark-mode-toggle`).

| Command | Action |
|---------|--------|
| `propose <change>` | Create `projects/<current-project>/specs/<change>/`. Copy the four templates into it. Initialize `proposal.md` frontmatter. Add an "Active specs" entry to the project's `index.md`. Then ask the user to describe the problem. |
| `show proposal` / `show requirements` / `show design` / `show tasks` | Read and display that artifact for the active spec. |
| `update proposal` (or any artifact) | Modify the artifact based on the next instruction. Don't rewrite silently — describe the change you're about to make first. |
| `add requirement <text>` | Append a new `FR-N` (or `NFR-N` if explicitly non-functional) to `requirements.md`. |
| `add task <text>` | Append a checkbox item to the appropriate phase in `tasks.md`. Renumber if needed. |
| `start implementation` | Begin working through `tasks.md` top-to-bottom. Mark tasks complete as you go. |
| `mark task <n> complete` (or `done`) | Tick the checkbox for that task number. Update the Progress Summary block. |
| `show progress` | Display the Progress Summary from `tasks.md`. |
| `archive change` | Move the spec folder to `projects/<project>/specs/_archive/<change>/`. Update the project's `index.md` to remove the spec from the Active list. |
| `list changes` | Show all active specs (subfolders of `projects/<project>/specs/` excluding `_archive/`) and archived ones. |

## `propose <change>` — exact steps

1. **Confirm project context.** The current project is the one most recently mentioned in this session, or the one whose folder the user was last working in. If neither is clear, ask: "Which project does this spec belong to?"
2. **Create the folder.** `projects/<project>/specs/<kebab-name>/`. If a spec by that name already exists, ask whether to load it instead of creating a duplicate.
3. **Copy templates.** Copy each of the four files from `skills/spec-driven/templates/` into the new spec folder.
4. **Initialize `proposal.md` frontmatter:**
   ```yaml
   ---
   change: <kebab-name>
   project: <project>
   status: proposed
   created: YYYY-MM-DD
   ---
   ```
5. **Update the project's `index.md`** — add (or extend) an `## Active specs` section listing the new spec with a relative link.
6. **Daily-memory write.** Add a `## <project> — spec:<change> created` section to today's daily memory with a brief note. Add a checkpoint in the project's `progress.md` per the bidirectional rule in the root `CLAUDE.md`.
7. **Prompt for content.** Reply: "Spec created at `projects/<project>/specs/<change>/`. Let's start with the proposal — what problem does this change solve?"

## Status field

`proposal.md` carries a `status:` in frontmatter. Valid values:
- `proposed` — created, discussion ongoing
- `in-progress` — `start implementation` has fired; tasks are being checked off
- `review` — implementation done, verifying against requirements
- `complete` — all requirements met, ready to archive
- `archived` — moved to `_archive/`

Don't invent intermediate statuses. Don't track velocity, story points, or anything else not in this list.

## What this skill does NOT do

- It does not auto-commit code.
- It does not generate code from the design — designs describe an approach; the engineer writes the code.
- It does not enforce that all artifacts are filled in. The user can stop after the proposal if they decide the change isn't worth doing.
- It does not run on every change. Most edits don't need a spec. Use judgment.
