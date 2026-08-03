# Client Deck — Skill

A protocol for creating client-facing HTML reference documents in a spec/terminal aesthetic. Single-file HTML, embedded CSS + ASCII diagrams. Designed to be screenshotted and sent.

Use when the user wants a visual deliverable they can paste into a client message — not a polished marketing page, not a designerly dashboard, not a spec for engineers.

## When to invoke

Load this file when the user says any of:
- "make a client deck for <topic>"
- "create client deck for <topic>"
- "explain <X> to client in html"
- "build a reference html for <X>"
- "create option decks for <X>"
- "client deck for <X>"
- "make a multi-section brief for <topic>"
- "build a client brief covering <X / Y / Z>"

Don't load it when:
- The output is for engineers (use `spec-driven` instead).
- The output is plain prose (just write the message inline).
- The user wants a polished web page or designerly UI (this skill is intentionally spartan).

## The four parts of a deck

Every deck has these four sections in this order:

1. **Header** — small uppercase label + h1 title + 1–2 sentence subtitle
2. **Diagram** — ASCII art inside `<pre>`, the centerpiece visual
3. **Pros / Cons** — two columns, bullet lists (4–6 items each)
4. **Best-for callout** — single paragraph, left-bordered, names the recommended use

Nothing else. No long narrative. No FAQ. No "how it works" bullets that duplicate the diagram. The diagram does the heavy lifting; everything else labels and qualifies it.

## Style baseline

Use `skills/client-deck/templates/template.html` verbatim. Do not modify the CSS. The visual identity is the point — every deck must read as part of the same series.

Key rules locked in by the template:
- Monospace font stack (`JetBrains Mono`, `Cascadia Code`, `Consolas`, `Menlo`, monospace)
- `#f7f7f4` background, `#111` text, `#999` borders, `#fff` for the best-for callout
- Max content width 1080px, single-column layout
- No shadows, no rounded cards, no gradients, no external fonts
- One built-in JS feature: `[Copy as image]` button in the top-right + `html-to-image` CDN. No other JS.
- No emojis anywhere — use Unicode glyphs only (`✓ ✗ ▶ ◀ ▼ ▲ → ← · ─ ▓ ║ ╔ ╗ ╚ ╝`)

## ASCII primitives

| Shape | Use for | Chars |
|-------|---------|-------|
| Single-line box | Default card / step | `┌ ─ ┐ │ └ ┘` |
| Double-line box | Emphasis (security gate, QR, key element) | `╔ ═ ╗ ║ ╚ ╝` |
| Shading | Texture (QR pattern, fill area) | `▓ ▒ ░` |
| Arrows | Flow direction | `▶ ◀ ▼ ▲ → ← ─▶ ──▶` |
| Bullets | Inline list | `· ► •` |
| Separator | Inline rule | `──── ─────────────` |

Box header convention: `┌─ STEP N · <label> ──────┐` — the step number and label live in the top border, not on a separate line above. Saves vertical space and keeps the diagram dense.

Annotation convention: place inline annotations to the right of a box with `◀── <note>` or above an arrow with `← <note>`. Keep annotations short — diagrams should be self-explanatory.

## Constraints

- **Single-viewport target** — content height ≤ 750px so the deck reads in one screenshot.
- **No emojis** — they look childish in a spec context and render inconsistently across OS.
- **Only the built-in copy-image script is allowed** — see "Copy as image" below. Don't add any other JS.
- **Pros and cons are factual** — no marketing language. "Cheaper than SMS" not "Massive cost savings!"
- **Best-for callout is opinionated** — name a specific scenario, not "any case."

## Copy as image

Every deck has a `[Copy as image]` button in the top-right corner of `.page` (already wired up in the template). On click:

1. The button hides itself during capture so it doesn't appear in the screenshot.
2. `html-to-image` (~25 KB, loaded via unpkg CDN) renders `.page` to a PNG blob at 2× pixel ratio with `#f7f7f4` background.
3. The library is passed explicit `width` / `height` from `getBoundingClientRect()` plus `style: { margin: '0', maxWidth: 'none', transform: 'none', transformOrigin: '0 0' }` to prevent the clone's auto-centering from clipping the right edge.
4. `navigator.clipboard.write([ new ClipboardItem({ 'image/png': blob }) ])` puts the PNG on the clipboard.
5. The button briefly flashes `Copied!` (black) on success or `Failed — see console` (red) on error.

Requirements:
- Browser with `ClipboardItem` support — Chrome/Edge 76+, Safari 13.1+, Firefox 127+.
- The HTML must be loaded over HTTPS, `localhost`, or `file://`. Chrome/Edge allow `file://`; Safari historically blocks the clipboard image API on `file://` — open via VS Code's Live Server extension in that case.

Don't change the position, style, or behavior of the button — every deck must read as part of the same series. If a particular deck truly shouldn't have it (e.g. an ultra-minimal compliance reference), delete the button HTML and the two `<script>` tags from the file. Don't strip just one.

## Deck modes

**Multi-option** (comparing N alternatives):
- One file per option: `option-N-<slug>.html`
- Header label: `OPTION N OF M — <TOPIC>` (uppercase)
- Identical CSS across all files so they read as a series
- Numbered in the order the user wants the client to consider them — not alphabetical

**Single-doc** (one proposal / explainer / reference):
- File name: `<slug>.html`
- Header label: `REFERENCE — <TOPIC>` or `PROPOSAL — <TOPIC>` (uppercase)
- No "of M" suffix

**Multi-section brief** (one cohesive presentation split across decks for readability, not for comparison):
- Multiple HTML decks each following the standard 4-section structure
- File naming: `NN-<slug>.html` (zero-padded), where order matches presentation order
- Header label on each: `SECTION N OF M — <TOPIC>` (uppercase)
- Sits under `references/client/` (free-standing) or `specs/<topic>/client-brief/` (spec-tied) — same as single-doc
- Add `index.html` next to the decks — a navigation hub (described in the *Index hub* section below)

The four-section structure (header → diagram → pros/cons → best-for) is identical across all three modes.

## File location

Decks live inside the project they belong to.

If the deck is tied to a spec:
```
projects/<project>/specs/<topic>/client-options/
├── option-1-<slug>.html
├── option-2-<slug>.html
└── option-3-<slug>.html
```

If the deck is free-standing (not tied to a spec):
```
projects/<project>/references/client/
└── <slug>.html
```

If the deck is a multi-section brief:
```
projects/<project>/references/client/
├── index.html              ← nav hub
├── 01-<slug>.html
├── 02-<slug>.html
└── 03-<slug>.html
```

Never put decks at the repo root or in a project-agnostic folder. The project owns its client deliverables.

## Index hub (multi-section briefs only)

When you ship a multi-section brief, also produce `index.html` alongside the decks. It is a single-file navigation hub so the user opens *one* link and can flip through the whole brief — but each deck remains standalone-viewable.

Required behaviour:
- **iframe-based.** `index.html` holds nav chrome only; an `<iframe id="deck">` loads the current section's standalone HTML file. The deck's own `[Copy as image]` button still works inside the iframe.
- **Hash routing.** The URL hash drives which section is active — `index.html#02-packages` deep-links to section 2. Listen on `hashchange`.
- **Section model.** The script holds a `sections` array of `{ id, src }` objects — the `src` may be a sibling deck (`01-flow.html`) or a relative path to an auxiliary artifact (`../calc/index.html`). Tabs render dynamically from this array; prev/next walks it.
- **Tab strip** below or beside the header: `01 · FLOW  /  02 · PACKAGES  /  03 · QUESTIONS` (or analogous). The active tab gets an `.active` class (white background, dark border, dark text).
- **Prev/next arrows** top-right: `[‹ PREV]  [NEXT ›]`. Disabled at boundaries.
- **Visual identity matches the decks** — same monospace stack, `#f7f7f4` background, `#999` borders, `#111` text. The hub reads as one document with the decks.
- No external JS dependencies. Vanilla only.

### Auxiliary artifacts (demos, prototypes, reference assets)

If the brief includes a related artifact that isn't a deck — a working demo, prototype, supplementary calculator, presentation file — append it to the *same* `sections` array so the hub navigates to it on the same prev/next chain. Surface it differently in the tab strip so the user can tell it's not section N of M:

- Drop the `NN · NAME` numbered label. Use a verb-y label like `DEMO ▶` / `PROTOTYPE ▶` / `PLAYGROUND ▶`.
- Separate it from the section tabs with a `<span class="sep">·</span>` (or a vertical pipe).
- Give the link an `aux` class. Accent the active state with the auxiliary artifact's own brand colour (e.g. `--primary` from the demo), so it visually signals "different content type."
- The path in `sections[].src` can be relative (`../calc/index.html`) — the iframe handles it; no router needed.

Example tab markup:
```html
<a data-section="01-flow" href="#01-flow">01 · FLOW</a>
<a data-section="02-packages" href="#02-packages">02 · PACKAGES</a>
<a data-section="03-questions" href="#03-questions">03 · QUESTIONS</a>
<span class="sep">·</span>
<a data-section="demo" class="aux" href="#demo">DEMO ▶</a>
```

Auxiliary artifacts participate in the prev/next chain as the last item(s). Don't insert them in the middle — the visual order should always read "main sections first, then supporting material."

Reference shape for a 3-deck brief with one demo appended:

```
projects/<project>/references/client/
├── index.html          ← hub; sections = [01-flow, 02-packages, 03-questions, demo]
├── 01-flow.html
├── 02-packages.html
└── 03-questions.html
projects/<project>/references/calc/
└── index.html          ← the demo, referenced as ../calc/index.html
```

## `client deck <topic>` — exact steps

1. **Confirm project context.** Use the most recently active project. If unclear, ask which project this is for.
2. **Confirm format.** Multi-option (and how many) vs single-doc. If the user said "options" or named more than one alternative, default to multi-option.
3. **Sanitize topic to kebab-case.** "Portal Registration OTP" → `portal-registration-otp`.
4. **Create the folder** if it doesn't exist (e.g. `projects/<project>/specs/<topic>/client-options/`).
5. **Copy `template.html`** into the destination, renamed per the file-naming rules above. One copy per option in multi-option mode.
6. **Fill in each file:**
   - `<title>` — short, descriptive
   - `<div class="label">` — `OPTION N OF M — <TOPIC>` or `REFERENCE — <TOPIC>`
   - `<h1>` — clear, plain-English title (no engineering jargon)
   - `<p class="subtitle">` — 1–2 sentences capturing the essence
   - `<pre class="diagram">` — the centerpiece ASCII art
   - Pros + Cons lists — 4–6 items each, factual, parallel structure
   - Best-for callout — 1–2 sentences naming the scenario
7. **Verify single-viewport fit.** Diagram + sections should not exceed ~750px content height. If they do, compress the diagram (single-line boxes, fewer annotation rows, drop redundant content).
8. **Brain hook.** Generating client deliverables counts as meaningful work — add a section in today's daily memory and a checkpoint in `projects/<project>/progress.md` per the bidirectional rule in the root `CLAUDE.md`. Note the file paths and what each option / doc covers.

## Iteration etiquette

When the user asks for changes, edit the existing file in place rather than starting over. Common iterations:
- "make it less vibe-coded" / "more spec-y" → strip color, soften borders, drop ornament
- "fits in one view" → compress diagram, single-line boxes, drop subtitle to 1 sentence
- "add another option" → copy an existing file, renumber, update headers across the series
- "swap option order" → rename files + update the `OPTION N OF M` labels across the series

Don't rebuild the CSS — the template is locked.

## What this skill does NOT do

- It does not generate the ASCII diagram for you. You design the diagram for the specific topic. The skill enforces the wrapper, not the content.
- It does not auto-send. The built-in `[Copy as image]` button puts a PNG on the user's clipboard — the user still pastes it into chat/email themselves.
- It does not run on every client question. Most client questions get answered in chat — only invoke this skill when a visual reference adds something prose can't.
- It does not produce designerly HTML. If the brief is "make this look beautiful for marketing," this skill is the wrong tool.
- It does not auto-update if the underlying spec changes. Decks are point-in-time snapshots; if the spec evolves, regenerate the deck explicitly.
