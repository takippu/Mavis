# Context injectors

A few lines of live state, re-stated to the model on **every turn**.

## Why this exists

`AGENTS.md` opens with a warning: a rule loaded once at session boot loses to a harness default
that is re-injected every turn. Compaction rewrites the transcript and summarises the rules away;
the harness's own defaults live outside the transcript and survive untouched. This project did not
theorise about that failure — it shipped 17 commits carrying an AI attribution trailer while the
rule forbidding it sat in three separate files the whole time.

An injector is the general form of the fix. A `UserPromptSubmit` hook's output is attached to the
user's message, so there is no summariser between it and the model. It cannot be compacted away,
because it simply arrives again on the next turn.

That makes it the right home for **volatile** state — the current working register, what the user
is deep in right now — and the wrong home for durable knowledge. Durable knowledge belongs in the
brain, where it is read once and costs nothing per turn.

## The cost, stated up front

Per-turn context is the most expensive real estate in the system: it is paid on every turn of
every session, forever. The whole feature is capped at **400 characters (~100 tokens) per turn**,
enforced when the hook reads rather than when the CLI writes — so a state file edited by hand
cannot blow the budget either. Over the cap, the block is truncated and says so.

A measured three-injector set (`TONE` + `MOOD` + `FOCUS`, the examples below) emits 100 characters
— about 25 tokens a turn, or ~1,000 tokens across a 40-turn session. Check yours:

```
node scripts/inject.mjs cost
```

## How it works

State lives in `.mavis-inject/<name>.txt` at the brain root — **one line each**, gitignored,
per-user. The hook reads that directory and emits one `NAME: value` line per non-empty file,
alphabetically, and nothing else. No header, no framing sentence: framing is a fixed cost paid on
every turn forever, so it lives here in the README instead, at zero per-turn cost.

Everything fails open. A missing directory, a missing file, an empty file, an unreadable file, a
hostile filename, garbage on stdin — every one of them exits 0 and emits nothing. A hook that can
break a session gets uninstalled, and an uninstalled hook protects nothing.

Names are letters, digits, `_` and `-`, 32 characters maximum, case-folded. Anything else is
rejected rather than sanitised into something — these names become filenames, so a state file
called `../../etc/passwd` must not escape in either direction.

## The CLI

```
node scripts/inject.mjs list                 show every injector and its current value
node scripts/inject.mjs set <name> <text>    write a state file
node scripts/inject.mjs clear <name>         remove one
node scripts/inject.mjs cost                 measured per-turn token cost of what is set
```

Everything after the name is the value, so shell quoting is optional:

```
node scripts/inject.mjs set focus shipping the payments migration
node scripts/inject.mjs set tone "terse, no preamble"
node scripts/inject.mjs clear tone
```

## Injectors worth having

The framework is generic — nothing is hardcoded, and a name is whatever you make a file called.
These three are the ones that earn their per-turn cost most often:

| Name | Holds | Example |
|------|-------|---------|
| `TONE` | the register to write in | `terse, no preamble, no trailing summary` |
| `MOOD` | how much scaffolding to show | `heads-down, skip the explanations` |
| `FOCUS` | what is actually being worked on right now | `the acme-portal payments migration, branch feat/psp` |

The test for whether something belongs here: **would a compaction destroy it, and would losing it
change the next answer?** If it would survive in a brain file, put it in the brain file. `FOCUS`
passes because it changes hourly and steers every reply; a project's architecture does not.

## Wiring it up

One hook script, two thin config files. Claude Code declares hooks inside `settings.json`; Codex
declares them in `hooks.json` (`$CODEX_HOME/hooks/hooks.json`, or `./hooks.json`). The event
names, the config fields and the `hook_event_name` payload key are the same in both.

Replace `/path/to/mavis` with your brain root. A project-level Claude Code config can use the
relative form (`node scripts/hooks/inject-context.mjs`) since it runs with the project as cwd; a
global config must use an absolute path.

### Claude Code — `.claude/settings.json` (project) or `~/.claude/settings.json` (global)

Merge this into the existing `hooks` object rather than replacing it — this repo already ships a
`PostToolUse` entry for the leak guard.

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node /path/to/mavis/scripts/hooks/inject-context.mjs",
            "timeout": 5
          }
        ]
      }
    ]
  }
}
```

### Codex — `$CODEX_HOME/hooks/hooks.json`

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node",
            "args": ["/path/to/mavis/scripts/hooks/inject-context.mjs"],
            "timeout": 5
          }
        ]
      }
    ]
  }
}
```

**Caveat, stated plainly.** Codex's hook support was established by **inspecting the shipped
binary** — it carries the same event names (`UserPromptSubmit` among them), the same config fields
(`command`, `args`, `env`, `cwd`, `url`, `http_headers`) and the same `hook_event_name` key as
Claude Code. No live Codex hook run has been observed, so the exact nesting of the Codex config
file is expected-to-be-right rather than proven. Under Claude Code this is verified working.

The cost of being wrong is bounded by the fail-open design: nothing gets injected, which is
exactly the behaviour before installing it. Verify by setting an injector, starting a session, and
asking the model what its `FOCUS` is.

## Checking what is actually emitted

The hook is a plain script — run it by hand and read the JSON:

```
echo '{"hook_event_name":"UserPromptSubmit"}' | node scripts/hooks/inject-context.mjs
```

Empty output means nothing is set. Otherwise you get the hook contract's
`hookSpecificOutput.additionalContext`, which is the exact text the model will see.
