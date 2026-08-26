---
name: tiktok-slideshow-promo
description: Create story-driven static slideshow campaigns for TikTok, Threads, and Instagram. Use when asked for a TikTok photo slideshow, swipe-story promo, product explainer carousel, voucher or launch campaign, cross-platform slideshow adaptation, rendered social slides, or a before-versus-after content recommendation.
---

# TikTok Slideshow Promo

Build a swipe narrative, not a stack of disconnected posters. Keep the premise legible without audio, make the product the resolution, and adapt the same story deliberately for each platform.

## Low-fi photo mode

When the user asks for the simple creator-style format, do not turn it into an ad carousel. Use two or three full-bleed photographs with one short outlined text overlay per slide. The photograph is the design; avoid cards, device frames, decorative panels, gradients, feature grids, and poster-like brand furniture.

Use this sequence:

1. Slide one: a person, silhouette, or human moment plus a curiosity hook.
2. Slide two: surroundings, a detail, or a product-in-context photograph plus the payoff. A quiet `sound on` cue may be used only when audio adds something real.
3. Optional slide three: one proof point or direct action.

Keep each overlay to one thought, normally 3 to 10 words. Set it in a heavy, highly legible face with a strong contrasting outline so it survives any photograph. Do not embed campaign text in generated imagery; add it deterministically in HTML.

For Malaysian campaigns, localize the casting, venue, clothing, language, props, and social context. Clothing must be modest. If a woman is shown and the brief calls for Muslim Malay representation, she wears a hijab. Avoid generic Western wedding styling unless the user requests it.

## Load companions when relevant

- Read `../social-post/SKILL.md` for Malaysian social copy, captions, and anti-corporate voice.
- Read `../app-promo-shots/SKILL.md` when the slides need real app screens, browser captures, or device framing.
- Read `references/formula.md` before making strategic claims or adapting the formula to Threads.

## Workflow

### 1. Lock the brief

Record the product, audience, campaign goal, offer, eligible packages, dates, redemption mechanics, CTA, platforms, and source of any visual claims. Distinguish the offer window from the event or usage date. Never imply that an event must occur during a promotion month unless the terms say so.

For an existing product, inspect its real brand assets and UI. Prefer exact logos, real screenshots, and first-party product facts. Generate original lifestyle imagery when a suitable owned image is unavailable; do not quietly pull promotional photography from the internet.

### 2. Choose one narrative arc

Explainer arc:

1. Specific tension or unanswered question.
2. Hidden pain or missed outcome.
3. Current friction.
4. Simple product mechanic.
5. Visible payoff.
6. Product reveal and CTA.

Promotion arc:

1. Offer-relevant hook that corrects the audience's likely assumption.
2. Eligible packages and exact value.
3. Voucher code or redemption action.
4. Deadline, essential terms, and CTA.

Do not delay the actual discount until the caption. Do not turn an explainer into a feature dump.

### 3. Draft before and after

Show the user the literal first draft, then the recommended rewrite and a short reason for every material change. Keep the comparison honest: do not invent a weak draft merely to make the recommendation look good.

Draft at least three first-slide hooks. Select the one that is most specific, visually stoppable, and immediately relevant to the intended audience. One slide carries one beat.

### 4. Design a coherent deck

- Keep the logo treatment exact. Do not place a pill or colored plate behind a transparent lockup unless the brand system calls for it.
- Use one visual world: consistent type, color, texture, image treatment, margins, and numbering.
- Use readable display type. Avoid decorative scripts for important words, prices, codes, dates, and CTAs.
- Keep screenshots large enough to understand on a phone.
- Reserve safe areas for platform chrome.
- Use generated images without embedded text; add all campaign typography in HTML or another deterministic layout tool.
- In low-fi photo mode, keep the output intentionally plain: one full-bleed image and one outlined caption. Consistency comes from typography and crop, not extra decoration.

Start from `assets/slides-template.html` when useful. Keep an editable HTML source beside the output PNGs.

### 5. Adapt by platform

TikTok:

- Render 1080 by 1920.
- Treat slide one as the stopping frame and the following slides as paced reveals.
- Write the caption as supporting context; the deck must still make sense without it.
- Suggest an audio mood only when useful. Never make performance promises based on a sound.

Threads or Instagram feed:

- Render 1080 by 1350 unless the user requests another ratio.
- Add concise post text that gives the carousel context.
- For Threads, end with a genuine reply prompt or useful question when it fits.
- Make the post native to the platform instead of uploading a crop with TikTok-only language such as “link in bio.”

### 6. Render and inspect

Use `scripts/render-slides.mjs` with a small manifest, or adapt it to the project. Inspect every output, not only the HTML. Check line breaks, logo contrast, crop, price math, code spelling, terms, screenshot legibility, and both platform ratios.

Recommended folder shape:

```text
campaign/
  assets/
  captures/
  slides.html
  manifest.json
  copy.md
  gallery.html
  tiktok/<campaign>/slide-01.png
  threads/<campaign>/slide-01.png
```

### 7. Test and measure

Change one meaningful variable at a time, usually the first-slide hook. Track business outcomes such as link clicks, completed sign-ups, gallery creations, or voucher redemptions alongside views, saves, swipes, and replies.

Treat creator reports as anecdotal evidence. Never promise views, virality, revenue, or a fixed posting outcome. Do not clone another creator's slides, scrape private material, or publish near-duplicate spam.
