---
name: dev-update
description: >
  Write a plain, factual "what's new" update for USERS after a deploy or release —
  release notes, patch notes, changelog-for-humans, in-app announcement, "update kecil",
  "what's new", "tell users what we shipped". Use when the user asks to "write a dev
  update", "update for users", "release notes", "changelog", "announce the deploy",
  "patch notes", or wants to tell players/customers what changed. NOT for promo or launch
  hype — that is the social-post skill. Bakes in the platform-split ledger that stops an
  update claiming things the reader's platform did not actually receive.
---

# Dev Update Skill — plain release notes for users

Standard voice. Not marketing, not bahasa rojak, not a social post. The reader wants to
know what changed and whether it affects them. Answer that and stop.

**Route first:** promo / launch / "buatkan post" / hype for a Malaysian audience →
**social-post skill instead**. This skill is for "we shipped, here's what changed."

## STEP 1 IS REQUIRED — build the shipping ledger before writing a word

Deploys are almost never uniform. A backend fix reaches everyone the moment it deploys; a
frontend feature only reaches whoever got the new client. Writing one undifferentiated
"what's new" is how an update promises a screen the reader cannot open.

Fill this in before drafting. It is not optional and it is not something to infer:

| Change | Where it actually landed | Who has it right now |
|---|---|---|
| e.g. review 404 fix | backend, deployed | everyone, incl. installed app |
| e.g. Prize History screen | web build only | web users only |
| e.g. same screen on mobile | AAB not uploaded | nobody yet |

**The ledger decides how many versions of the update you write.** If the rows disagree on
audience, produce a version per audience. Never one draft that silently mixes them.

## Structure

```
What's new — <date>

Fixed
- <what broke, who felt it, that it now works>

Improved
- <what got better, in user terms>

New
- <what exists now that did not before>

<one-line note if the reader must act, e.g. refresh>
```

Omit any section with nothing in it. Three empty headings read worse than one honest line.

**This structure holds on EVERY surface, including a store "what's new" field.** Do not
flatten it into prose because the surface feels formal or capped — it fits: the worked
example below runs 490 chars against Play's 500 limit with the date header and all three
sections intact. It only fits because every line was trimmed to earn its place, so count
it (`$note.Length`) rather than assuming either way.

**"Fixed" means what the READER newly experiences as fixed, not what changed in this
binary.** A server-side fix that reached them last week still belongs under Fixed in the
update they are reading now — they hit the bug, nobody told them it went away, and a
version note is where people look. Do not omit an item on the technicality that it shipped
in a different layer. The ledger governs *which audience gets which draft*; it does not
narrow what counts as news to one artifact's diff.

## The laws

1. **Lead with what users felt, not what cost the most work.** A bug that made people
   stare at a spinner outranks an architectural improvement every time. Order by reader
   pain, not by engineering effort.
2. **Name who was affected, specifically.** "This affected entries submitted before 1 March"
   lands as *they fixed my problem*. "Fixed various issues" lands as nothing.
3. **Describe what the feature renders TODAY, not what it will render.** A history screen
   holding one row is "shows the current pool and will build up each month", never "browse
   past prizes". Check the real data before writing the line.
4. **Web deploys carry a refresh instruction.** Service workers serve the cached shell, so
   users sit on the old build until they reload. Always include it.
5. **Plain sentences.** No "Introducing", "Elevate", "Seamlessly", "Say goodbye to". No
   em-dashes as connectors. No emoji. Sentence case, ordinary punctuation.
6. **Say the mechanism only when the user feels it.** "Loads in a single request instead of
   two" is fine because it explains the speed. Refactors nobody can perceive do not belong.

## Worked example (synthetic — `example-app`, a points-and-prizes app)

Ledger said: backend fix = everyone; leaderboard + new screen = web only; the Android build
was never uploaded. So the full note went to web, and app users got the Fixed line alone.

```
What's new — 4 March 2026

Fixed
- My Points: tapping your own entry could hang on a spinner and never
  open the review. This affected entries submitted before 1 March. It
  now opens correctly.

Improved
- Top 20 leaderboard loads in a single request instead of two, so the
  prize, period and rankings arrive together.

New
- Prize History: a screen listing prize pools by month. It shows the
  current pool and builds up each month.

On the web? Refresh once to pick up the new version.
```

Why it works: bug first because users felt it, the affected entries named outright, the new
screen described honestly as one pool, the refresh line present, zero marketing verbs.

## Common mistakes

| Mistake | Fix |
|---|---|
| One draft for all platforms | Build the ledger, split by audience |
| "Various bug fixes and improvements" | Name the bug and who hit it |
| Announcing a feature that ships thin | Describe today's actual content |
| Omitting the refresh line on a web deploy | Users stay on the cached build |
| Marketing voice creeping in | Cut every verb you would not say aloud |
| Listing invisible refactors | Only what the user can perceive |

## Presenting the draft

Show each version in a **fenced code block**, never a blockquote (terminals render a bar
down the margin). Label each cut on its own line ("Web:", "App users:"). If the ledger
forced a split, say which audience each block is for and why in one sentence.
