---
name: promo-video
description: >
  Build a short promo VIDEO for an app with Remotion (programmatic video in
  React) — MP4 for Threads/IG/TikTok, animated from the app's own brand tokens
  and real screenshots. Use when the user asks to "make a promo video", "video
  version of the carousel", "animate the promo", "buatkan video promo", or wants
  motion rather than static slides. Pairs with app-promo-shots (captures + the
  slide deck it animates) and social-post (the caption).
---

# Promo Video — Remotion

Turn the static promo carousel into a short MP4. Same brand, same real
screenshots, same copy — moving.

Written off the back of a static promo carousel produced by `app-promo-shots`.
**Not yet used for a shipped video — treat the first run as the shakedown and fix
this file as you go.**

## STOP — the licence gate, before you install anything

**Remotion is not MIT.** It is free only under a Free License with eligibility
criteria; otherwise a paid **Company License** is required. Whether the user
qualifies depends on how they are set up — an individual and a person working
through a company are not the same case, and this skill must not assume either.
From v5.0 telemetry is mandatory on the render-based tier.

**The exact company-size threshold is NOT recorded here on purpose** — the
licensing page is a table-of-contents shell, the number lives a level deeper, and
a number cached in a skill file goes stale silently while still reading as
authoritative. Read it fresh. So the FIRST action on any Remotion task is:

1. Read <https://www.remotion.dev/docs/licensing> and its sub-pages properly.
2. Tell the user in plain terms: which licence applies to them, whether it costs
   money, and what triggers the paid tier.
3. Get their explicit go BEFORE `npm install`.

Do not hand-wave this and do not guess the threshold. A promo video is not worth
a licensing surprise, and "it's on npm" is not the same as "it's free".

If the answer is no, the fallback is real: the existing carousel PNGs plus a
crossfade in any editor, or an animated HTML page captured frame-by-frame with
headless Chrome — which is what `app-promo-shots` already does, one frame at a
time.

## What Remotion actually is (verified against the docs, 2026-07-20)

"A video is a function of images over time." React renders each frame.

- **`useCurrentFrame()`** — the current frame number. Animate by returning
  different content per frame. First frame is `0`, last is `durationInFrames - 1`.
- **`useVideoConfig()`** — `width`, `height`, `fps`, `durationInFrames`.
- **`<Composition>`** — registered in `src/Root.tsx` with `id`, `component`,
  `durationInFrames`, `fps`, `width`, `height`. Multiple compositions go in a
  Fragment.
- **`<AbsoluteFill>`** — fills the canvas; the default layout primitive.

**Not yet verified — confirm on first run rather than trusting this file:** the
scaffold / studio / render CLI (expected to be `npx create-video@latest`,
`npx remotion studio`, `npx remotion render`) and the sequencing and animation
helpers (expected `<Sequence>`, `interpolate`, `spring`). Run `npx remotion --help`
and check the docs before quoting any of them to the user. **Correct this section
the moment you know.**

## Do NOT start from scratch — inherit from the carousel

If `app-promo-shots` has already run for this app, most of the expensive assets
exist. Look in `<app>/promo/<platform>/` before generating anything:

- **Real app captures** — `*-460.png` alongside the slide deck. Capture more with
  `app-promo-shots`'s `capture.mjs` (CDP, real device metrics, dev badge
  stripped). **Never re-screenshot what is already on disk.**
- **Generated OG cards**, if the app renders its own (e.g. a Next `ImageResponse`
  route) — those are the real artefact rather than a mock of it.
- **The slide deck** `slides.html` — brand tokens, the exact locked lockup, the
  mono eyebrow signature, the phone frame CSS. Port its CSS into Remotion
  components rather than re-deriving the look.
- **Brand tokens** from the app's `globals.css`; the lockup from wherever it is
  defined (e.g. `src/components/logo/lockup.css`) — reproduce it verbatim, never
  rebuild a wordmark from memory. Owners spot a rebuilt lockup instantly.

## Shape that works

Roughly 15-25s, 1080x1350 (4:5) or 1080x1920, 30fps:

1. Hook — the lockup and one line.
2. Per feature, one beat each: the phone slides up, the headline sets, hold
   long enough to READ (a beat that reads on a desktop preview is too fast in a
   feed — hold ~2.5-3s per screen minimum).
3. CTA — the domain, held still.

Motion rules: move ONE thing at a time; ease everything (nothing linear); the
app screenshot itself never moves faster than the copy explaining it. Silence by
default — most feed video is watched muted, so nothing may depend on audio.

## Gotchas (thin — extend as they bite)

- **The licence, above.** It is the only one that can cost money.
- **Rendering needs a headless Chrome** and real CPU; a long render on a laptop
  is minutes, not seconds. Say so up front rather than appearing hung.
- **Frame-exact, not time-exact.** Durations are frames; at 30fps a "2 second"
  hold is 60 frames. Off-by-one at the end (`durationInFrames - 1`) is the
  classic.
- **Reuse the captures.** The screenshots are the expensive part and they exist.
- **Hand over the `file:///` path** to any output or preview HTML, per
  `app-promo-shots` — absolute, forward slashes.

## Refs
- <https://www.remotion.dev/docs/the-fundamentals> — concepts, verified
- <https://www.remotion.dev/docs/licensing> — READ BEFORE INSTALLING
- Companion skills: `skills/app-promo-shots/SKILL.md` (captures, deck, brand),
  `skills/social-post/SKILL.md` (caption)
