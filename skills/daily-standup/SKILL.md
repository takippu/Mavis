# Daily Standup — Skill

Generate a morning standup block summarizing yesterday's work + today's plan + any issues. Output is plain text in a fixed shape — designed to be pasted into a chat app (Teams / Slack / WhatsApp).

The user picks which projects to include. The skill condenses the daily-memory sections into short verb-phrase bullets.

## When to invoke

Load this file when the user says any of:
- `daily`
- `daily ops`
- `daily standup` / `standup`
- `morning report`

If the trigger fires mid-conversation and is ambiguous (the word "daily" can also be casual), confirm once: "Run the daily standup skill?" before executing.

## Inputs

- **Yesterday** — literal calendar yesterday. Today minus 1 day. Do NOT skip weekends; if Monday, yesterday is Sunday and the file probably won't exist (warn and proceed).
- **Today** — the current date.
- **Name** — read from `identity/profile.md` frontmatter (`name:` field).

## The format (locked)

```
DD/MM/YYYY - <TodayDayOfWeek> - <Name>

Previous Work Day - <YesterdayDayOfWeek>
    
    - <Project> : <Headline>
            - <bullet>
            - <bullet>
           <Continuation Headline>
            - <bullet>
    

Issues Faced
  - <None or one bullet per issue>

Today    
    
    - <Project> : <Headline>
            - <bullet>
            - <bullet>
```

Whitespace quirks (preserve exactly):
- Project line: **4 spaces** + `- ` + `<Project> : <Headline>`
- Bullet line: **12 spaces** + `- ` + `<text>`
- Continuation headline (same project, additional work block): **11 spaces** (no dash) + `<Headline>`
- Blank lines bracketing each block: **4 spaces** then newline (not empty)
- `Today    ` has **4 trailing spaces** after the word
- `Issues Faced` is flush-left; each issue is `  - ` (2 spaces + dash)
- Date format is `DD/MM/YYYY` (Malaysian convention, matches the user)

These look quirky because they are — they come from the user's chat-app template. Don't normalize them.

## Protocol

### 1. Compute dates and read identity

- Today: e.g. `2026-05-07` → `07/05/2026`, day-of-week `Thursday`
- Yesterday: e.g. `2026-05-06` → day-of-week `Wednesday`
- Read `identity/profile.md` frontmatter → `name`

### 2. Read daily memories

- Read `daily-memories/<yesterday>.md`. If it doesn't exist, tell the user "No daily memory for <date> — type yesterday's work manually?" and accept free-form input.
- Read `daily-memories/<today>.md` if it exists. May be empty or only-completed-work; today's plan often isn't pre-written.

### 3. Parse sections

Each daily memory uses `## <project> — <headline>` H2 sections (em-dash separator). Extract:
- `project` — the slug before the em-dash (e.g. `acme-portal`, `bluebird`).
- `headline` — the text after the em-dash.
- `body` — section content until the next `## ` heading.

Skip `## Notes (no project) — ...` sections from the project list (they have no project to pick), but offer them as a single "Notes" group the user can include or skip.

### 4. Show the project picker

Show the user every distinct project found across **yesterday's** sections. Format:

```
Yesterday (2026-05-06 / Wednesday):
  [ ] acme-portal — 2 sections
       · Checkout retry queue ...
       · Delivery webhook observability logs ...
  [ ] bluebird — 4 sections
       · Dev-phase cleanup sweep
       · ...
  [ ] mavis-brain — 1 section
       · client-deck skill registered
```

**Never carry a client name, a vulnerability class, and a date into the same line.**
Headlines land in a standup that gets pasted into a group chat, so a section titled
"<client> — <unpatched flaw> (2026-05-06)" leaks a live exposure to everyone in the
room. Summarize the work ("hardening pass on registration"), not the hole.

Ask: "Which projects to include for yesterday?" Multi-select. Use `AskUserQuestion` with `multiSelect: true` if ≤4 options; otherwise list inline and accept comma-separated names.

### 5. Draft yesterday's block

For each picked project, group its sections in original order. Render:

```
    - <project_display> : <first_headline>
            - <bullet>
            - <bullet>
```

Then for each subsequent section under the same project:

```
           <headline>
            - <bullet>
            - <bullet>
```

**Project display name**: capitalize cleanly — `acme-portal` → `Acme Portal`, `bluebird` → `Bluebird`, `mavis-brain` → `Mavis Brain`. Match the project's `index.md` name field first if it exists — slugs flatten deliberate casing (a product written `iFoo` title-cases to the wrong `Ifoo`), and the `name` field is the only place the real spelling survives. Otherwise title-case the slug.

**Headline cleanup**: trim, drop trailing context like `(branch: f/...)`. Keep it readable in one line (~60 chars).

**Bullet drafting**: 2–4 short verb-phrase bullets per section, drawn from the section content. Style:
- Present-tense or gerund ("Build core APIs", "Testing WhatsApp message")
- Strip technical detail — this is for a colleague glance, not a PR description
- Drop file names, commit SHAs, line numbers
- One concrete deliverable or action per bullet
- ≤ 80 chars each

If a section has H3 subheadings, prefer summarizing the H3 themes. Otherwise pull from the lede paragraph.

### 6. Prompt for "Issues Faced"

Ask: "Any issues to flag? (Enter blank for None)"
- Blank → render `  - None`
- Non-blank → split on lines or commas → render each as `  - <issue>`

### 7. Draft today's block

Check `daily-memories/<today>.md`:
- **If sections exist**, show today's project picker (same format as step 4) and draft bullets the same way.
- **If empty or missing**, ask: "What's on the plate for today? (project — headline; bullet; bullet)" and accept free-form input. Allow multiple project blocks separated by blank lines.

### 8. Render and output

Assemble the output exactly per the locked format. Then do **both**:

1. **Print in chat** inside a triple-backtick block so the user can copy with one click.
2. **Save to `standups/<today>.md`** (create the `standups/` folder if it doesn't exist). File contents = the same plain-text block, no frontmatter, no extra wrapping.

End with: "Saved to `standups/<today>.md`. Copy from above to send."

## What this skill does NOT do

- It does not write to the daily memory. The standup is a *view* over the daily memory, not a new entry.
- It does not modify `progress.md`. No bidirectional rule applies — standups are ephemeral chat output, not project work.
- It does not auto-send. The user copies and pastes into their chat app.
- It does not pull from `progress.md` or `notes.md`. Yesterday's daily memory is the only source of truth for "what did I do yesterday."
- It does not skip weekends in date math. If Monday's standup is empty because Sunday had no work, that's correct; the user can paste from Friday manually.

## Edge cases

- **Yesterday's file missing** (e.g. holiday, sick day) → ask the user to type yesterday's items manually, or to point at a different date ("use Friday instead").
- **No projects in yesterday's file** (only `## Notes (no project)`) → render those notes as bullets under a generic `- General : <first headline>` entry, or ask the user to name a project.
- **Same headline appears yesterday and today** (e.g. continuing work) → that's fine, render naturally; today's bullets typically read "Continue X" or "Testing Y".
- **User wants to edit a bullet inline** → accept it and re-render the full block. Don't try to patch in place.
