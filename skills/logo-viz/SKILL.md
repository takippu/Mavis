# Logo Viz — Skill

A protocol for drafting and iterating logo marks, wordmarks, and icons in the browser Visual Companion. Every mark is shown on the surfaces it actually lives on (accent plate, dark, white, lockup, favicon strip) and every option states its own downside. Iteration happens through live controls in the mock, not through new rounds.

Distilled from a real branding round for a link-in-bio style web app. The two things that
worked were the favicon-strip screen (which is what settles an argument about a mark) and the
live kerning panel (which replaced five rounds of guessed spacing numbers with one).
The worked examples below use a **synthetic** brand, `northwind`.

## When to invoke

Load this file when the user says any of:
- "visualize logo" / "mock logo" / "can i see logo"
- "draft a logo" / "draft N logos" / "logo options" / "show me logos"
- "brand mark", "wordmark", "lockup", "favicon", "app icon"
- "kerning", "tuck it in", "tighten the wordmark", "make X closer to Y"
- any request to iterate on a mark they have already picked

Don't load it when:
- They want a full product UI mocked (that's the plain brainstorming Visual Companion).
- They want a chart or dashboard (`dataviz` skill).
- The logo work is a one-line CSS tweak in a real repo (just do it).

## Hard rules

- **Visual Companion, never an Artifact.** "mock" / "visualize" maps to the local companion server, full stop. Only an explicit "artifact" uses the Artifact tool. (Logo rounds are throwaway and iterate fast; publishing each one to a shareable URL is the wrong shape.)
- **Full `<!DOCTYPE html>` documents**, not fragments — you need total control of the type and the plates.
- **New filename every screen** (`logos.html`, `logos-v2.html`, `logos-v3-braces.html`, …). Never overwrite.
- **No emojis** anywhere, including as placeholder marks. SVG only.
- **Never redraw a mark that has already been approved.** See *Don't redraw approved marks* below — this is the one that burns you.

## The core pattern: define each mark ONCE

Hand-copying an SVG into nine slots per card is how the round-1 file shipped with a broken `</div>`. Define the mark **once as a function of stroke weight**, then render every size from it:

```js
const MARKS=[
  { id:"canopy", n:"Canopy", tag:"solid",
    svg:w=>`<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="${w}"
              stroke-linecap="round" stroke-linejoin="round">
      <path d="M16 29V17"/>
      <circle cx="10.5" cy="13" r="6" fill="currentColor" stroke="none"/>
      <circle cx="21.5" cy="13" r="6" fill="currentColor" stroke="none"/>
      <circle cx="16" cy="8" r="6.4" fill="currentColor" stroke="none"/></svg>`,
    why:"<b>What it means.</b> One sentence on why it's good.",
    risk:"Risk: the honest downside." }
];
const card=m=>`... ${m.svg(2.4)} ... ${m.svg(3)} ... ${m.svg(4)} ...`;
grid.innerHTML = MARKS.map(card).join("");
```

Weight goes **up** as size goes **down** (2.4 at 88px → 3 at 32px → 4 at 16px), or thin strokes vanish in the favicon. Use `currentColor` throughout so one definition themes for every plate.

Use a **32×32 viewBox** as the house grid.

## Screen anatomy

Every logo card shows, in this order:

1. **Plates** — the mark at ~56px on three surfaces: brand accent, dark panel, white. A mark that only works on one background isn't done.
2. **Lockup** — mark + wordmark, on dark *and* on light, at real size.
3. **Favicon strip** — 32 / 24 / 16px, in a bordered chip. **This is the honest test.** Tell the user to squint at this row before looking at the big plate; it's the browser tab, and it's where thin forks collapse to a smudge while solid shapes survive.
4. **Why + Risk** — one bold sentence on what it means, then a muted `Risk:` line naming its actual weakness. Never present an option without its downside.

Plus a shared note at the top naming the strategic tension — usually that an incumbent already owns the obvious metaphor for this category, so the literal version of it risks reading as a clone. Name the incumbent by name; it is the thing that stops a whole direction being wasted.

## The kerning panel — "tuck it in"

Once a mark is picked, **never guess spacing numbers**. Ship live sliders, let the user dial it, then ask for the values they landed on. One round instead of six — the same reason to build a high-fidelity mock with the switchers live inside it rather than shipping variants one at a time.

Drive everything off CSS custom properties on `:root` so one slider updates every rendered size at once:

```css
:root{--ml:-.20em;--mr:-.20em;--tsz:1.02em}
.w{font-family:'Space Grotesk';font-weight:700;letter-spacing:-.035em;
   display:inline-flex;align-items:flex-end;white-space:nowrap;line-height:1}
.w .tg{display:inline-flex;align-items:flex-end;color:var(--accent);flex:none;
   width:var(--tsz);height:calc(var(--tsz)*1.16);
   margin-left:var(--ml);margin-right:var(--mr)}   /* negative = tuck */
```

```js
// synthetic example: the wordmark "northwind" with the mark standing in for its "w"
const wm=(size,light)=>`<span class="w ${light?"lt":""}" style="font-size:${size}px">north<span class="tg">${MARK(2.5)}</span>ind</span>`;
// render at 58px, 24px dark, 24px light, and 14px nav — all at once
function apply(){ R.style.setProperty("--ml",(S.ml/100).toFixed(2)+"em"); /* … */ }
```

The panel must have:
- **One slider per gap** (left tuck, right tuck) plus **tree/mark size**.
- **Named presets** — None / Subtle / Snug / Tight / Overlapping — so the user can jump.
- **A live value readout** in mono (`margin-left: -0.20em · margin-right: -0.20em · size: 1.02em`) and an explicit ask: *"read me the numbers you land on"*.
- **Every size rendered simultaneously** — big, nav, light, dark. A tuck that works at 58px often fails at 14px.
- **Slider range past the limit**, so the user can find where it breaks rather than being capped early.

**Why the overlap works** (explain it — people engage with the reasoning and dial better numbers for it): lowercase letters sit at x-height, a crown/canopy sits high. They occupy different vertical bands, so they overlap horizontally and never collide — the word closes up and the mark appears to grow out of it. The only part at letter height (the trunk/stem) is the stopping point.

## Don't redraw approved marks

**The mistake, from the reference round:** the user picked marks 4 and 2 and asked for them inside a new lockup — and the next screen shipped *newly drawn* foliage instead. They caught it immediately: *"where is the previous tree?"*. A redrawn mark is worse than no mark, because it silently discards a decision that was already made.

When reusing an approved mark, copy the paths **verbatim** and prove it:

```js
const geo=s=>(s.match(/(?:\sd|cx|cy|r)="[^"]*"/g)||[]).filter(x=>!/\$\{/.test(x)).join(" | ");
console.log("identical:", geo(oldFile)===geo(newFile) ? "OK" : "DIFFERS");
```

If a variant *must* modify an approved mark, change exactly one thing, say so in the card tag ("4 + one crossbar"), and assert it: `newPathCount === oldPathCount + 1`.

## Verification — run before showing the user

The companion can't be screenshotted from here (the Chrome extension usually lacks site permission for `127.0.0.1`), so **check the served bytes, not your source file**:

```bash
curl -s -c j.txt "http://127.0.0.1:<port>/?key=<key>" -o /dev/null
curl -s -b j.txt "http://127.0.0.1:<port>/" -o frame.html
```

Then assert:
- **Scripts parse** — `new vm.Script(block)` on every `<script>` in the served frame.
- **No `${` leaks into markup** — strip `<script>` blocks first, then test the remainder.
- **Marks render clean at every weight** — no `NaN`/`undefined`, exactly one `<svg>`, viewBox present.
- **Bounds fit the 32×32 box** — and **honour relative path commands**: `c0-5-4-8-9-8` are *deltas*, not coordinates. A naive number scan reports false failures. Walk the path tracking the pen position.
- **Optical size comparability** — all marks should span a similar height (~20–27 in a 32 box). A mark spanning y[12→29] against others at y[5→28] renders visibly small and bottom-heavy next to the rest of the grid. This check caught exactly that on one option in the reference round, before it was shown.
- **Symmetry about the trunk** where the mark is meant to be symmetric.

State honestly that you haven't seen it render, and that the 16px judgement is the user's.

## Voice for the cards

- One bold clause, then plain prose. No marketing.
- Every option gets a `Risk:` line. If you can't name a downside, you haven't thought about it.
- Name the strategic risk once at the top (competitor owns the metaphor, the glyph doesn't read as the letter, etc.).
- Recommend one, with the reason, then defer — it is the user's brand, and one stated opinion is help while two is pressure (the `disagree-once-then-defer` invariant in `AGENTS.md`).

## Refs

- **Companion mechanics are NOT in this repo.** The Visual Companion is a local preview server that ships with the third-party `superpowers` plugin (start-server, `--project-dir`, Windows `run_in_background`, `$STATE_DIR/server-info`). If it is not installed, everything above still applies — write the same standalone `<!DOCTYPE html>` files to a scratch directory and hand over an absolute `file:///` path instead.
- Style rule: match the project's own visual language when it has one; on a greenfield brand, propose distinct options rather than picking a house style silently.
- **Screen sequence that works**: `logos.html` (5-up grid) → `logos-v2.html` (mark-as-a-function-of-stroke-weight, split into keep/new) → `logos-v6-kerning.html` (the tuck-it-in panel). Each is a new file, never an overwrite, so any earlier round can be reopened.
- Real brand marks (for competitor plates): simple-icons via `https://cdn.jsdelivr.net/npm/simple-icons@latest/icons/<slug>.svg` — inline the path, don't hotlink. Not every brand is in the set; fall back to an official asset and say which one you used.
