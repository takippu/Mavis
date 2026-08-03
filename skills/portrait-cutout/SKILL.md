---
name: portrait-cutout
description: Use when the user asks to make an image or PNG transparent, remove/knock out a background, produce cutouts from a portrait or asset set, check which files "have no true transparency", or when delivered cutouts look jagged, haloed, or have a checkerboard baked into the pixels.
---

# Portrait cutout — transparency repair for delivered asset sets

## Overview

Turning photos into transparent cutouts, and **auditing a delivered set for fake
transparency**. Files handed over as "transparent PNGs" are routinely flat RGB with
the editor's transparency checkerboard painted into the pixels — they look right in a
viewer and composite as a grey grid.

Core principle: **the naive quality check is blind to the defect that actually
shows.** Measure the edge sub-pixel, and compare against a known-good set from
the same batch rather than an absolute number.

Scope: this skill covers the **delivered-asset-set repair** case — a folder of files
someone else produced, some fraction of which are silently broken. Cutting a single
line-art or solid-colour subject from scratch is a plain PIL job and does not need
any of the machinery below.

## Trigger phrases

"make this png transparent", "make this transparent", "remove the background",
"background removal", "knock out the background", "cut this out", "make cutouts",
"which ones have no true transparency", "check the transparency", "these aren't
actually transparent", "there's a checkerboard in it", "the edges aren't smooth",
"jagged/rough edges", "white halo", "transparent webp".

## The three laws

**1. NEVER `alpha_matting=True` on a checkerboard or compressed background.**
This is the whole skill. Closed-form matting solves a Laplacian that assumes a
locally smooth background; a checkerboard is the maximal violation, so the solver
oscillates along the boundary. Measured on a real delivered set (identical on both
models, so it is not a model problem):

| | sub-pixel roughness | edge width |
|---|---|---|
| isnet raw | 0.133 | 3.61 |
| isnet + matting | **0.508** | **6.42** |
| birefnet raw | 0.121 | 3.02 |
| birefnet + matting | **0.518** | **6.34** |

Matting is *meant* to improve edges. Here it quadruples roughness.

**2. Measure the edge SUB-PIXEL.** A hard `alpha>128` threshold measures pixel
quantisation, not smoothness. On that set it scored the broken output as equal to
the accepted files (0.499 vs 0.510) when it was 3-5x rougher — a human spotted the
jaggedness instantly in a file the check had just passed. Interpolate where alpha
crosses 128, then take mean `|2nd derivative|` of that path.

**3. Compare against the known-good files in the same batch**, not an absolute
target. A delivered set has its own house style; `qa --ref` reads the ceiling off
the files already accepted.

## Workflow

```bash
S=<brain>/skills/portrait-cutout/cutout.py

python $S audit "<webp dir>"                    # what's broken, and why
python $S cut   "<webp dir>" --src "<originals dir>" --out "<dir>_v2"
python $S qa    "<dir>_v2" --ref "<webp dir>"   # gate before deploying
```

Then eyeball a contact sheet composited on **magenta** (not white — halos hide on
white), and only then copy into place, backing up what you overwrite.

`cut` defaults: `birefnet-portrait`, `--gain 1.15` (~2px edge), 1080x1080, WebP
q82/method6, resumable, writes only to `--out`. Add `--autocrop` for scraped
single-subject sources; leave it off for a fixed-canvas set where the subject
bleeds off the bottom edge.

## Reading the numbers

| metric | healthy | meaning |
|---|---|---|
| sub-pixel roughness | at or below the ref set's median | edge path smoothness |
| edge width | ~1.7-2.4 px | crisp but anti-aliased; >5 = mushy |
| transparent % | 40-60 for a 1080 portrait | sanity check the subject wasn't eaten |

`gain` trades the two off: raising it tightens the edge but *raises* roughness
(less sub-pixel information). 1.15 is the balance point found empirically on a
1080x1080 portrait set; re-derive it if the canvas size changes a lot.

## Common mistakes

- **Trusting a whole-set pass on a blunt metric.** Verify against the accepted
  files and look at the worst 5 by name, not just the median.
- **Re-cutting from the exported webp** when the original PNG/JPG is on disk —
  `--src` avoids double compression.
- **Overwriting in place.** Always `--out` a review folder; back up before
  promoting. Sources being intact is not a backup.
- **Assuming a flat file means a white background.** Sample the corner: mid-grey
  and near-neutral (e.g. `rgb(188,184,181)`) = checkerboard; `rgb(255,255,255)` =
  a real studio white.
- **Calling a re-export a fix.** If the alpha never existed in the source file,
  re-encoding it cannot invent one — the defect has to be repaired upstream or
  re-cut here, and every future batch from the same pipeline arrives the same way.
  Name the stage the defect entered at, so the fix lands there.

## Worked example (numbers from a real run, set anonymised)

A 103-file delivered set: 30 files had no true alpha — 24 with the checkerboard
baked into the pixels, 6 flat white. The defect was in the source PNG/JPGs, not in
the WebP conversion step everyone initially suspected. The first repair pass ran
with `alpha_matting=True` and was rejected on sight for visibly ragged edges.
Rebuilt with matting off: worst-case sub-pixel roughness fell 0.508 -> 0.135, and
every file landed inside the accepted set's band.

That shape is the thing to expect: a minority of files broken, the blame one stage
earlier than assumed, and the "smarter" option making it worse.
