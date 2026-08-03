# Vendored reference material

The three directories here are **other people's work**, redistributed under their
own MIT licences. They are not part of this repository's original code, and the
root `LICENSE` does not govern them — each keeps its own `LICENSE` file, which is
the one that applies.

The root [`NOTICE`](../../../NOTICE) is the canonical attribution record. This file
is the operational detail: where each came from, why it is here, and how to update
it without losing the attribution.

| Directory | Upstream | Copyright | Licence |
|-----------|----------|-----------|---------|
| `app-store-preflight-skills/` | [truongduy2611/app-store-preflight-skills](https://github.com/truongduy2611/app-store-preflight-skills) | 2026 truongduy2611 | MIT |
| `appstore-review-skill/` | [devsemih/appstore-review-skill](https://github.com/devsemih/appstore-review-skill) | 2026 devsemih | MIT |
| `aso-skills/` | [eronred/aso-skills](https://github.com/eronred/aso-skills) | 2026 Erencan | MIT |

## Why they are vendored rather than linked

`skills/app-store-submission/SKILL.md` is a routing and sequencing layer over
store-submission knowledge that already exists in these three projects. It reads
them directly, so a broken network or a moved upstream would silently degrade the
skill into prose with no substance behind it. Vendoring keeps it deterministic.

The tradeoff is the usual one: they do not update themselves, and they can drift
from upstream without any signal.

## Known gap: no recorded commit SHA

These were copied rather than cloned, so no upstream commit is recorded and there
is no way to diff them against upstream at the version they were taken from. That
is a real provenance gap, stated rather than hidden.

If you refresh one, fix the gap for that directory while you are in there:

```bash
cd skills/app-store-submission/references
rm -rf <dir>
git clone --depth 1 https://github.com/<owner>/<repo>.git <dir>
git -C <dir> rev-parse HEAD    # record this SHA in the table above
rm -rf <dir>/.git              # do not nest a git repo inside this one
```

Then confirm the upstream `LICENSE` still exists and still says MIT. If a project
has relicensed, it cannot stay here unchanged — update `NOTICE`, or remove the
directory and the parts of `SKILL.md` that depend on it.

## If you are one of these authors

The attribution above is best-effort from each repository's `LICENSE` file and
owner. `appstore-review-skill`'s copyright line carries no name, so its holder is
inferred from the GitHub account. If any of it is wrong, or you would rather not be
vendored here at all, open an issue and it will be corrected or removed.
