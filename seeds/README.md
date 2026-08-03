# seeds/ — fresh-install seed templates

Generic templates the setup wizard (`SETUP.md`) copies into a new brain on first install.
They carry **no user-specific data** — personal knowledge lives in the gitignored
`preferences/`, `rules/`, `topics/` and is never published.

On a fresh install the wizard copies:

| Seed | → target | contents |
|------|----------|----------|
| `seeds/preferences/_index.md` | `preferences/_index.md` | header only (zero entries) |
| `seeds/rules/_index.md` | `rules/_index.md` | header + the 3 Core-referenced procedural rules |
| `seeds/rules/_details/*.md` | `rules/_details/` | `entry-lifecycle` · `reference-resolution` · `daily-memory-format` |
| `seeds/topics/_index.md` | `topics/_index.md` | header only (zero entries) |

The 3 procedural rule entries ship here because `CLAUDE.md` (Core) hard-references them by path
(`rules/_details/<slug>.md`) — they define the add/edit/supersede lifecycle, project
reference-resolution, and the daily-memory skeleton — so a fresh clone's contract would dangle
without them. Everything else in the categories starts empty and grows as Mavis learns.

Schema: [`docs/brain-schema.md`](../docs/brain-schema.md).
