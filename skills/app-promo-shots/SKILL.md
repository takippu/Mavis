---
name: app-promo-shots
description: >
  Generate App Store / Play Store-style promo image sets — phone-frame mockups
  wrapping REAL app screenshots, plus short marketing copy — to post on social
  (Threads / IG carousel). Use when the user asks to "make promo images/screenshots
  for <app>", "app store style pictures", "phone mockups for a post", "buatkan
  gambar promo / poster app", "screenshots for threads", or wants a social
  carousel showing an app in device frames. Captures real screens headless
  (public URLs + auth-gated dashboards via CDP), builds a branded HTML slide
  deck, and renders 4:5 PNGs. Pairs with the social-post skill for the copy.
---

# App Promo Shots — App-Store-style promo carousels

Turn a running app into a set of polished, on-brand promo images: a phone mockup
holding a REAL screenshot of the app, a short benefit headline, the app's own
brand chrome. Output is N PNG slides (4:5 by default) + a caption, ready to post.

The reference run was a 5-slide Threads carousel for a link-in-bio style web app.
Every gotcha below is from that run; the deliverables lived (uncommitted) at
`<app>/promo/threads/`, which is where this skill still writes.

## When to use / not
- USE for social promo image sets, "app store screenshots", device-framed posts.
- NOT for a hosted landing/deck page (that's `client-deck`) or a logo mock
  (`logo-viz`). The copy itself comes from **`social-post`** — load it too.

## Lock these first (one `AskUserQuestion`, don't guess)
1. **Screenshot source** — real live captures (best, authentic) · stylised
   recreations (pixel control) · mix. Default: real.
2. **How many slides + the angles.** App Store standard 4–5. A good default arc:
   hook → the mechanic/payoff → make-it-yours (themes) → honest differentiator →
   free/CTA.
3. **Aspect ratio.** 4:5 `1080×1350` (Threads/IG-native, best default) · 9:16
   `1080×1920` (story feel) · 1:1.

## Step 1 — Ground it in the app's OWN brand
Pull the real tokens so slides can't drift from the product:
- **Colours + fonts** from the app's `globals.css` / font module (e.g. bg,
  accent, display + body + mono faces).
- **The EXACT logo lockup** — copy it from the app's `assets/logo` (`lockup.css`
  + `Logo` component) or wherever it's defined. NEVER hand-rebuild a "mark +
  wordmark" — the owner of the brand always spots it. The reference app's lockup
  was a wordmark with the brand mark substituted for one of its own letters at a
  locked negative-em kerning; a rebuilt-from-memory version got caught on sight.
  Reproduce the real markup + CSS verbatim.
- Find a **signature** grounded in the subject, not a generic accent — e.g. for a
  developer-facing app, `//` code-comment eyebrows set in the app's mono face.

## Step 2 — Capture REAL app screens (headless Chrome → PNG FILES)
The site almost certainly sends `X-Frame-Options: DENY`, so you CANNOT iframe it
into a mockup — you must screenshot to files. Find Chrome:
`"/c/Program Files/Google/Chrome/Application/chrome.exe"`.

**Capture at a REAL phone aspect** (e.g. `460×1000`, DPR 2) so the phone frame
can show it 1:1 with no zoom-crop (see the framing gotcha). `--force-device-scale-factor=2` for crisp text.

### 2a. Public / URL-addressable screens — one-shot CLI
```bash
chrome --headless=new --hide-scrollbars --force-device-scale-factor=2 \
  --window-size=460,1000 --virtual-time-budget=5000 \
  --screenshot="out.png" "https://.../<real-page>"
```
Prefer a REAL data-filled page (a seeded creator's storefront, a real product
URL) over a client-only demo whose state lives in React (no URL to hit). Check
the seed for handles/routes with good content.

### 2b. Auth-gated screens (dashboard, analytics) — CDP
Headless `--screenshot` can't log in. Log in via the app's API to mint the
session cookie, then drive a debug Chrome over CDP. **Node 22+ has a global
`WebSocket`, so no puppeteer needed.** Full script: `capture.mjs` in this skill
dir — it logs in, sets the cookie, sets device metrics, strips dev artifacts, and
screenshots. Run it against a Chrome started with `--remote-debugging-port`.

### 2c. ALWAYS, before the screenshot (via CDP `Runtime.evaluate`)
- **Strip the dev badge:** `document.querySelectorAll('nextjs-portal').forEach(e=>e.remove())`
  (the Next dev-tools "N" overlay ruins an otherwise clean shot).
- **DOM-patch display-only values** that are wrong in dev — e.g. a URL pill that
  falls back to the internal dev host when `PUBLIC_HOST` is unset, so the shot
  would advertise a hostname users cannot reach. Swap it for the real production
  host in the rendered text (`...replace(/dev\.internal/g, 'example.com')`).
  This is display-only, so patching the DOM is honest and non-disruptive — it
  shows what production actually renders, and beats restarting the user's dev
  server just to fix a pill. Never DOM-patch anything a user could act on
  (prices, counts, availability); that would be faking the product.

## Step 3 — Copy (load `social-post`)
- **On-slide headlines are SHORT** benefit lines, not full posts. One key word in
  the accent colour. Malay bahasa-rojak per social-post's voice.
- The **app's UI language stays as-is** in the screenshot (English UI stays
  English); only the marketing copy is in the target language.
- Write ONE post caption via social-post (char-count it against the platform cap)
  + a shorter alt.

## Step 4 — Build the slide deck (ONE HTML, `?s=N` per slide)
- Brand bg + fonts via Google Fonts `<link>` (fine — you screenshot locally, no
  CSP), the exact logo lockup, the signature eyebrow.
- **Phone frame = CSS mockup** (dark rounded bezel + speaker pill) with the real
  screenshot as an `<img>` inside a `.screen`. The phone **bleeds off the bottom
  edge** (App Store style); `.slide{overflow:hidden}` crops it.
- **THE SCREEN'S `aspect-ratio` MUST MATCH THE CAPTURE'S** (e.g. `460/1000`), or
  `object-fit:cover` zoom-crops and the shot reads as off-centre — that was the
  first thing the reviewer flagged. With matched aspect, `cover` = a clean 1:1 fit.
- `.stage{align-items:flex-start}` so a tall phone hangs from the top and bleeds
  down — NOT `flex-end`, which shoves a tall phone's top up into the copy.
- Reference layout/skeleton: `slides-template.html` in this skill dir.

## Step 5 — Render each slide → PNG
```bash
for n in 1 2 3 4 5; do
  chrome --headless=new --hide-scrollbars --force-device-scale-factor=2 \
    --window-size=1080,1350 --virtual-time-budget=6000 \
    --screenshot="slide-$n.png" "file:///.../slides.html?s=$n"; done
```
DPR 2 → crisp `2160×2700` (still 4:5; platforms downscale). **Review each render
as an image** — a green build says nothing about a visual; iterate.

## Step 6 — Gallery + deliver
- Build a `gallery.html` (responsive grid of the PNGs, click-to-open-full) so the
  user sees all slides at once instead of flipping `?s=`.
- Save everything to `<app>/promo/<platform>/` (uncommitted; flag it's not in git).
- Hand over the caption in a fenced code block (social-post presentation rule).

### ALWAYS hand over the direct HTML path — never "open gallery.html"
A bare filename makes the user go and hunt for it; give the **full absolute path
as a `file:///` URL** so it is one click:

```
file:///C:/Users/you/Projects/<app>/promo/<platform>/gallery.html
```

Forward slashes, no backslashes — on Windows a backslashed path gets eaten by the
shell before the command runs. Give the gallery path every time the slides change,
not just on the first render, and give `slides.html?s=N` too when the user is
iterating on one specific slide. Same rule for any other HTML this skill produces.

## Gotchas (each cost a round-trip — heed them)
- **`X-Frame-Options: DENY`** → no iframing the live site; screenshot to files.
- **git-bash MSYS mangles a leading-slash arg** (`/app/analytics` → a Windows
  path) → hardcode paths inside the `.mjs`, or `MSYS_NO_PATHCONV=1`.
- **Two `next dev` share `.next`** and conflict → do NOT spin a second dev to
  change an env; DOM-patch the display value instead (Step 2c).
- **Phone-frame aspect ≠ capture aspect → zoom-crop.** Match them.
- **`--window-size` + `--force-device-scale-factor=2` can render at DESKTOP width
  and then CROP** (2026-07-20). The PNG comes out the right dimensions —
  920x2000 for `460,1000` at DPR 2 — so it looks correct, but the page laid out
  at ~1700px and the shot kept only the left 460. Symptom: buttons and
  right-aligned columns sliced off at the edge, and it is plausible enough to
  nearly get framed. A fresh `--user-data-dir` does NOT fix it. **Use CDP
  (`capture.mjs`) for public pages too, not just auth-gated ones** — its
  `Emulation.setDeviceMetricsOverride` is deterministic. Step 2a's one-shot CLI
  is the fallback, and verify the right edge of anything it produces.
- **Node 22 global `WebSocket`** = CDP screenshots of auth pages without puppeteer.
- Changing a creator's template/colours for a shot **mutates the shared dev DB** —
  it persists for the user's own dev; tell them and offer to revert.

## Refs
- Companion skills: `skills/social-post/SKILL.md` (copy), `skills/logo-viz/SKILL.md`
- `capture.mjs`, `slides-template.html` (this dir)
