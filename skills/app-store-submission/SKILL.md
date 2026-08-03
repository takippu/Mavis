# Store Submission — Skill

Take an app from feature-complete to submitted on **either store**, in the order
that stops rejections rather than the order that feels natural. **Phase 0 is a
gate: nothing else runs until it passes.**

The phase order comes from a published first-try App Store approval writeup from
2026, whose author walked every trap in sequence and named them. That post
is iOS-only; the Play track beside it is assembled from the Play sources below and
from what this brain has already paid for. **Where the two stores genuinely
differ, they are shown differing — a false symmetry would be worse than a gap.**

## When to invoke

Load this file when the user says any of:
- "submit to the app store", "upload to play", "publish the app", "ship it to the store"
- "is the app ready to submit", "check before I submit", "preflight", "readiness"
- "rejected", "why was it rejected", "policy violation", "app suspended", "resubmit"
- "aso", "store keywords", "store listing", "metadata for the store", "screenshots"
- "testflight", "internal testing", "closed testing", "beta testers"
- or names a store console, `asc`, `eas credentials`, `eas submit`, a bundle
  identifier or an `applicationId` in a shipping context.

## The thesis, stated once

**Every trap in the source post is the same trap: a thing that had to be true
BEFORE the step that reveals it.** Credentials before the build. A store record
before the submission. Metadata before the first index. Preflight before review.
The tools are interchangeable; the ORDER is the product.

So this skill refuses to run out of order. If the user says "just submit", the answer
is Phase 0 first — the check costs a minute and the failure it catches costs days
of review turnaround, or on Play, an account-level enforcement action.

## Phase 0 — READINESS GATE (blocking, both stores)

Print a table with a verdict per row. Do NOT proceed on a partial pass.

### 0a. Signing — one owner, and it is not the one you built with

**iOS, in the author's words:** Xcode's "automatically manage signing" and EAS
Build each manage credentials, they are *completely separate systems*, and when
they fight, the error names a provisioning-profile mismatch in a way that tells
you nothing. They lost hours to it on a previous project.

```
eas credentials
```

Run it BEFORE any build. It audits state, surfaces the conflict, and generates a
set EAS owns. Do not skip it because the last build succeeded — the conflict
surfaces on the build after the one that changed signing.

**Play's version of this costs hours to diagnose, and it is worse than the iOS
equivalent because nothing errors.** Play App Signing RE-SIGNS the upload, so the certificate
the installed app presents is Google's app-signing key, not the upload key you
built with. Anything keyed to a fingerprint — Google Sign-In, Maps, any OAuth
client — must be registered against the key **Play** uses. Symptom: works
perfectly sideloaded, fails for every Play tester, and the app throws the error
away.

Read the fingerprint off the INSTALLED artifact, never off a console label:

```
adb shell pm path <package>
adb pull <base.apk path> ./base.apk
apksigner verify --print-certs ./base.apk
```

`CN=Android, O=Google Inc.` plus a source stamp in the DN means Play App Signing,
so that SHA-1 is Google's and is the one to register. Full ladder:
`[[skills/android-google-signin/SKILL.md]]`.

### 0b. The systems that have to agree

**iOS, verbatim from the post:** *"you need a product page in app store connect
before you can submit anything. not during submission. before. and that product
page needs a bundle identifier that matches what's in your app config. and that
bundle identifier needs to be registered in the apple developer portal. three
separate systems, all of which need to agree before a single submission command
works."*

| store | the systems that must agree | how to check |
|---|---|---|
| **App Store** | `expo.ios.bundleIdentifier` in app config, the identifier registered in the Apple Developer portal, and a product page in App Store Connect carrying it | `asc init` walks all three in sequence |
| **Play** | `expo.android.package` in app config, an app record in Play Console, and — for anything using a Google API — an OAuth client registered against **Play's** app-signing SHA-1 | Play Console, plus `apksigner` above |

`asc init` creates the product page, verifies the identifier registration, and
flags mismatches before a build exists. The author did not know these were three
distinct systems until the tool checked them one at a time, which is the argument
for running it even when you are sure.

**Play has no `asc init`.** There is no single command that reconciles its three;
check them by hand and say so rather than implying a tool exists.

**Both identifiers are immutable after the first upload.** Getting this wrong is
not a setback, it is a new app record.

## Phase 1 — Metadata, before submission and before the first index

**Why here and not later:** the keyword field affects search ranking from day one.
Submit with placeholder metadata and fix it afterwards and the window is gone.

**The two stores index differently and this is not cosmetic.** App Store has a
dedicated 100-character keyword field that users never see. **Play has no keyword
field at all** — it indexes the title, short description and full description, so
on Play the description IS the keyword strategy and reads as prose to a human at
the same time. Copy written for one store is not metadata for the other.

**Use:** `references/aso-skills/` (Eronred). `aso-router` is the entry point;
this phase needs `metadata-optimization`, `keyword-research`,
`app-icon-optimization`, `screenshot-optimization`. **`android-aso` is the Play
one and is a different skill for the reason above, not a translation.**

## Phase 2 — Preflight, before any tester sees it

A rejection costs days of turnaround; on Play a policy violation can cost the
account. Catching it here costs nothing, and that asymmetry is the whole phase.

**App Store:** `references/app-store-preflight-skills/` (truongduy2611). Identify
the app type first, then load `references/guidelines/by-app-type/all_apps.md` plus
the type-specific checklist. Its automated half wants the `asc` CLI, which ships
for Windows via WinGet as well as Homebrew; some Xcode-integration features are
macOS-only, the rule content is readable anywhere.

**Play, two sources and use both:**
- `references/appstore-review-skill/skills/playstore-review/` (devsemih) — policy
  checklist. That repo carries BOTH stores despite its name.
- The installed `google-playstore-toolkit` plugin — `/review-app` plus eight
  specialist agents (manifest, privacy, billing, security, performance, Material,
  assets/metadata, and an explicit React-Native/Expo reviewer). Its
  `playstore-requirements` skill ranks enforcement by frequency, which is the
  right thing to check first: **spam/minimum-functionality ~25%, privacy and Data
  Safety ~20%, deceptive behaviour ~15%.**

**Play-only gates with no App Store equivalent** — check them or the upload is
refused: the **Data Safety** form must match what the app actually collects, the
**target API level** must meet the current floor, and a **content rating**
questionnaire must be completed.

## Phase 3 — Testers, and the approval trap

**Both stores gate external testers behind a review, and both let you skip it for
your own team. This is the phase most first-timers lose a week to.**

| | skips review | needs review |
|---|---|---|
| **App Store** | internal testers, up to 100 already on the team in App Store Connect | external testers need **Beta App Review** |
| **Play** | internal testing track, up to 100 testers | closed and open testing tracks go through review |

```
asc testflight add --internal
```

Route the first round internally on either store. The distinction is buried in
Apple's documentation and is easy to miss on a first submission.

## Phase 4 — Submit

**App Store.** `asc submit` runs a checklist before the call goes out, and every
item is a rejection if missing:

- privacy policy URL returns **200, not a redirect** (a 301 fails this)
- age rating set
- pricing confirmed
- at least one screenshot per required device size

Version management, TestFlight distribution and metadata upload all run from the
session — no tab-switching into the console.

**Play.** `eas submit --platform android --latest`, or upload the AAB by hand.
The equivalent pre-send checklist, which nothing runs for you:

- privacy policy URL live and a 200
- Data Safety form completed and TRUE
- content rating questionnaire done
- target audience and ads declarations set
- feature graphic plus screenshots at the required sizes
- the release signed by the key Play expects (Phase 0a)

## Scope, and what this skill will not claim

**It does not guarantee approval, and neither do its sources** — devsemih's README
says so outright: it checks publicly available policy. Report findings with
severity; never report "will be approved".

**A Play-only app is not a failing App Store check.** If a project has no iOS
build, no bundle identifier with Apple and no App Store Connect record, Phase 0b's
App Store row is work that has not started rather than a check that fails — mark it
not-applicable and say so, instead of reporting a red row the reader cannot act on.

## References

Vendored under `references/`, cloned 2026-07-31 with `.git` stripped so they do
not nest as repos. **They are a SNAPSHOT** — re-clone before trusting a policy
detail, because store policy moves and a vendored copy silently does not.

| directory | source | store | what it is |
|---|---|---|---|
| `aso-skills/` | Eronred/aso-skills (MIT) | both | ~40 ASO and growth skills; `aso-router` is the entry point, `android-aso` is the Play one |
| `app-store-preflight-skills/` | truongduy2611/app-store-preflight-skills (MIT) | Apple | rejection-pattern scanner, 100+ guidelines by app type |
| `appstore-review-skill/` | devsemih/appstore-review-skill | both | `/appstore-review` and `/playstore-review` |

Not vendored, install separately:
- `asc` CLI — `rorkai/App-Store-Connect-CLI`. Cross-platform (Homebrew, WinGet, script).
- `google-playstore-toolkit` — already installed in this harness as a plugin.
