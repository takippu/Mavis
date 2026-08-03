# Smoke Guide — Skill

Generate a manual QA smoke-test guide for a code change (a CR / PM task / bugfix),
rendered as aligned plain-ASCII boxes for pasting into chat. One box per test:
STEPS / ROUTE / EXPECTED. Built for verifying uncommitted branch work before commit —
the user runs the steps by hand in the app.

Grew out of CR smoke testing on a legacy Laravel web app, so Laravel conventions are the
worked example throughout; the box format itself is stack-agnostic.

## When to invoke
Load this file when the user says any of:
- "smoke guide for <CR>", "smoke test guide", "make a smoke guide"
- "steps to test <CR/feature>", "test guide for <TICKET-1>", "how do i test <CR>"

If ambiguous ("test X" could mean automated tests), confirm once:
"Manual smoke-test guide (boxes), or automated tests?"

## Scope (binding)
**ONE task/CR per guide.** Even when a whole batch awaits smoke, guide only the
task at hand; settle it, then the next. Never render a combined multi-CR box-set
(preference `smoke-per-task-one-at-a-time` — corrected twice on a batch of
consecutive tickets that all looked "close enough" to merge into one guide).
**Within a task, hand over one test at a time** when tests are sequential or
need Mavis verification between steps — present TEST A, wait for the result,
then give the next.

## Inputs
- **The change** — the CR/task id + its diff. Sources in order: uncommitted `git diff`
  on the current branch → the project's investigation/reference doc under
  `projects/<project>/references/` → the touched code.
- **Routes** — for Laravel, resolve from `routes/web.php` (grep controller@method).
  Never guess a URL.
- **(optional) Concrete test data** — read-only DB query for the specific record IDs
  that exercise the change + their expected values.

## The format (locked)
Header box, then one box per test, then a NOTES box. Rendered by render.py.

- Header box  — title bar `<CR-ID> . <Title>`; body = one-line "Fix: ..." + PREREQUISITES
                (branch, cache-clear/build step, login/tenant).
- Test box    — title bar `TEST <A/B/C> . <screen>`; body groups = STEPS (numbered),
                ROUTE (exact URL + verb), EXPECTED. **EXPECTED default = explanatory +
                a Targets line:** first 1-2 sentences stating the rule / what makes it
                pass (in words), THEN a compact `Targets:  <label> -> <new>, ...` line
                of the real records from the read-only query (omit the Targets line if
                no query is available). See Concrete test data.
- NOTES box   — REGRESSION (what must stay unchanged), by-design caveats, BASELINE note
                if old-vs-new isn't visible side-by-side.

## Protocol
1. Scope the change — read the diff; list each distinct user-visible behavior that
   changed. Each becomes ONE test.
2. Resolve routes — grep routes/web.php for each controller method; capture URL + verb.
3. **Concrete test data — do this by default** (read-only). Query for the ACTUAL
   records that exercise the change + their expected values so each test reads
   "open #X, expect N" instead of "find an item that...". See the section below.
   **The target must be what the DEV SEES ON SCREEN** — the label/column shown in
   the app's list + how to reach it (menu → row → action), NEVER an internal PK,
   `batch_id`, encrypted URL key, or FK the user would have to look up in the DB.
   If the changed metric is keyed by an internal id, resolve that id to its
   on-screen label in the SAME probe and hand over the label. Skip only if
   there's no DB reachable or the user declines.
4. Assemble the box data as guide.json and render via render.py (guarantees alignment).
5. Print inline in a ``` code block. Offer to save to
   `projects/<project>/references/smoke-guides/<CR>.md`.

## Rendering
`skills/smoke-guide/render.py` reads a JSON spec and prints the boxes:
- `python render.py guide.json`         → plain boxes (default; safe to paste in chat)
- `python render.py guide.json --ansi`  → colored (green titles / cyan ROUTE /
                                          amber EXPECTED / red REGRESSION) for the
                                          user's OWN terminal
guide.json = { "width": 72, "boxes": [ {"title": "...", "groups": [["line",...],...]} ] }

**Color caveat (learned):** ANSI color does NOT survive in a chat message — markdown
strips it, and the tool-output pane renders it but folds long output behind Ctrl+O.
So DEFAULT to plain boxes inline; only produce --ansi when the user runs it themselves.

## Concrete test data (the "open #X, expect N" upgrade)
The single biggest usability win: don't make the user hunt for a qualifying record —
query for the real ones + their expected numbers and bake them into each EXPECTED block
(keep the OLD value in parens so the delta is visible).

Pattern:
1. From the diff, identify the metric that changed + the table/column it reads.
2. Compute OLD vs NEW per record in ONE read-only query; filter to rows where they
   differ (`HAVING old <> new`); order by biggest delta; `LIMIT ~8`.
3. Join to what the LIST actually DISPLAYS (name / period / outlet) so the target is
   findable in the UI — NOT a bare PK the user can't navigate to.
4. Emit as a compact `Targets:  <label> -> <new>, ...` line placed directly under the
   explanatory EXPECTED sentence(s) — not as a replacement for them.

### Navigable targets (binding — the "name it the way the screen names it" rule)
The Target line and the STEPS must name the record the way it appears **in the app**,
plus the click-path to open it. The dev should never have to touch the DB to find it.

- **Resolve every internal id to its on-screen label in the probe.** If the diff/route
  keys off `batch_id` / an encrypted key / a PK, `SELECT` that id's human column
  (batch_name, ticket_no, customer name, period) alongside it and hand over the label.
- **STEPS = a click-path**, e.g. `Sorting Jobs → row "alpha" (processed) → Sell Records`,
  not "open /sell-records/<key>". A raw URL may be given as a SECONDARY line, never the
  primary way to reach the record.
- **Say why the OTHER visible rows won't qualify** when the list shows several (e.g.
  "bravo"/"charlie" are pending, "delta" is sold → only "alpha" is processed) so the dev
  picks the right one at a glance.
- **Learned the hard way:** a probe returned `batch_id=b7Qk2Xm4v9`, the guide shipped
  that raw key, and the dev — looking at a list that only renders Batch Name — had no
  "b7Qk2Xm4v9" anywhere on screen and had to re-map it against the DB by hand. One extra
  `batch_name` column in the SELECT would have avoided the whole round-trip. Always
  hand over the on-screen name.

Legacy Laravel apps: bootstrap the app in a standalone PHP probe and use `\DB::select`
(invoke the PHP binary the app actually runs on — an old app may need an old `php` — and
hardcode the tenant if the app is multi-tenant). **SELECT only.** Assume any shared or
client-owned database forbids test writes without explicit sign-off; the probe exists to
read the current values, not to manufacture a qualifying record.

## What this skill does NOT do
- Does not run the app or write to the DB. Read-only only (grep, diff, SELECT). The
  manual smoke itself is the user's. (Default assumption: no test/DB writes without an
  explicit go from whoever owns the database.)
- Does not commit, merge, or tick PM items.
- Does not write a paired daily-memory/progress entry — a smoke guide is a test aid.
  (The smoke RESULTS, once reported, may warrant a checkpoint.)

## Edge cases
- No diff / already committed → diff against the base branch (e.g. qa) or read the
  investigation doc.
- Non-Laravel project → skip routes/web.php; get the URL/screen from that stack's router.
- Data-layer-only change (no UI) → still give a test; EXPECTED = the observable
  number/label, best paired with concrete IDs from step 3.
