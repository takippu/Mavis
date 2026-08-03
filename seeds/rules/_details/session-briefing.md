---
id: session-briefing
title: Session briefing — read out the state boot already paid for
category: rule
scope: [session, boot, briefing, voice]
status: active
since: 2026-08-03
updated: 2026-08-03
links: [read-identity-and-index-at-session-start, lead-with-the-answer, daily-memory-format]
---
## Rule
At session start — after the auto-load sequence completes, before answering the user's first request — emit a short briefing, then answer the request in the same reply.

**Line budget: 8 lines of body. Hard ceiling 12, never exceeded for any reason.** A ninth line has to earn its place by displacing one of the first eight, not by being appended.

**Sources — and this list is exhaustive.** The briefing may draw ONLY on what auto-load already read:

- `projects/_index.md` — the one line per project, its `Now:` clause and trailing date.
- The `## <project> — <headline>` headings grepped out of `daily-memories/<today>.md`.
- `identity/profile.md` for the user's name.

That is the whole input set. **The briefing adds ZERO new reads.** It does not open a project's `index.md`, `progress.md`, `notes.md`, `decisions.md`, or any `_details` file to build itself. If the loaded context does not support a line, the line does not get written — the missing detail is not worth a read the user did not ask for.

Shape:

```
Where things stand
- <project> — <the router's Now: clause, compressed to a clause, not copied whole>
- <project> — <today's daily-memory headline>
- Stale: <project>, last moved <YYYY-MM-DD>
```

Then a blank line, then the answer to whatever they actually asked.

**Must not:**

- **Invent status.** No "blocked", "at risk", "nearly done", "needs attention" unless those words are in a line that was actually read. Every clause traces to a specific line in the router or a daily-memory heading. This is the honest-about-limits invariant applied to a summary.
- **Re-list everything.** Cap at three projects — the three with the most recent router dates. A brain with fourteen active projects still gets three lines.
- **Flag more than one stale project**, and only when its router date is more than fourteen days old and its status is still `active`. Name the single oldest, once. Staleness is an observation, never a nag, and never repeated later in the session.
- **Pad to fill the budget.** Eight lines is a ceiling, not a target.
- **Speak when there is nothing to say.** A fresh brain, a single project touched an hour ago, or nothing in flight: emit one line or none and go straight to the request. Silence is a valid briefing and the correct one more often than not.
- **Delay a lifecycle command or a trivial turn.** `setup mavis` / `reset mavis` / `recalibrate mavis` take priority — run the protocol, no briefing. A one-word opener ("hey", "thanks", "yes") gets a normal reply, no briefing; brief on the first substantive turn instead.

The briefing is emitted **once per session**. It is not repeated after a compaction, and it is never re-emitted on request as a status report — that is a different question with a different answer.
## Why
The reads are already paid for. Auto-load opens `projects/_index.md` and greps today's daily memory for its headings on every single session, because the routing needs them. Then, in the ordinary case, that context is loaded and silently sat on: the user opens a session, asks for something narrow, and the state of their work never surfaces. The cost was incurred and the value was left on the table.

The briefing is not a new feature with a new cost. It is a read-out of a cost that already exists — which is the entire design, and the reason the zero-new-reads rule is not a nice-to-have but the load-bearing constraint.

**A briefing that reads new files to build itself has made boot more expensive, not more useful.** That is the failure mode, and it is a seductive one, because every individual extra read looks cheap and justified: open `progress.md` for a sharper last-checkpoint line, open `notes.md` to check for an open gotcha, open a `_details` file to name the decision that is pending. Each is a few hundred tokens; together they are a boot floor that grew by a third to make the opening paragraph nicer, paid on every session forever, including the many sessions where the user glanced past it. The value of the briefing is in the *reporting*, not in the *research*. A vaguer briefing built from free context beats a sharper one that raised the floor.

The same logic bounds this rule's own footprint. What it costs at boot is its `_index` line — the triggers plus a summary written to be operative on its own, so the briefing can be emitted without ever opening this file. This detail file loads only when someone is questioning or tuning the format, which is rare and is exactly the trigger-routed pattern the rest of the brain uses.

The line budget exists for the same reason as the read budget. A long briefing is a wall of text between the user and the thing they came to do, and a wall of text is skipped — after which the briefing costs tokens and delivers nothing at all.
## How to apply
Fires once, on the first substantive turn of a session, after auto-load and before the answer.

Build it in this order. From `projects/_index.md`, take the three project lines with the most recent trailing dates and compress each `Now:` clause to a clause — the router line is already one sentence, so this is trimming, not summarizing, and nothing may be added to it. From today's daily-memory headings (if the file exists at all — on the first session of a day it does not, and that is normal, not a gap to fill with a read), take what is in flight today; where a heading covers a project already listed, merge them into one line instead of writing two. Check the oldest active router date for the single staleness line. Stop at eight lines.

Then answer the request. The briefing is a preamble to the reply, not a reply of its own — it never stands alone waiting for acknowledgement, and it never pushes the actual answer below the fold.

When the loaded context is thin, the briefing is thin. One honest line ("Only bluebird moved this week — the northwind migration is where you left it") beats six lines of hedged filler, and beats a fabricated summary every time.
