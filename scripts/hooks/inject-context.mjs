#!/usr/bin/env node
// UserPromptSubmit hook: re-state a few lines of live state on EVERY turn.
//
// WHY A HOOK AND NOT A MEMORY FILE
// --------------------------------
// Everything the brain knows is loaded once, at session boot, and a long session compacts. The
// summariser keeps the WORK and drops the RULES -- while the harness's own defaults, which live
// outside the transcript entirely, are re-injected every turn and survive untouched. A rule
// loaded once therefore loses to a default injected every turn. `AGENTS.md` opens with that
// warning because this repository lost that exact fight: 17 commits carrying an AI attribution
// trailer, with the rule forbidding it sitting in three separate files the whole time.
//
// A UserPromptSubmit hook is the general fix. Its output is attached to the user's message, so
// there is no summariser between it and the model, and no amount of compaction can remove it: it
// simply arrives again on the next turn. That makes it the correct home for the small set of
// VOLATILE facts a compaction destroys -- current register, current focus -- which is a different
// job from the durable knowledge the brain files hold.
//
// WHY IT IS DELIBERATELY STUPID
// -----------------------------
// It reads a directory of one-line files and prints them. No parsing, no brain reads, no git, no
// network, no state of its own. Two reasons. First, cost: this runs on every prompt, so anything
// clever here is latency the user pays for constantly. Second, blast radius: a hook that can
// break a session gets uninstalled within a day, and an uninstalled hook protects nothing -- so
// every failure path below exits 0 and emits nothing at all. Silence is always an acceptable
// answer here; an error never is.
//
// BOTH HARNESSES
// --------------
// Claude Code and Codex ship the same hook events and the same `hook_event_name` field, so this
// one script serves both. The only difference is where it is declared -- `settings.json` for
// Claude Code, `hooks/hooks.json` for Codex. Both snippets are in mavis/injectors/README.md.
//
// CAVEAT, stated plainly because it matters: Codex's hook support was established by INSPECTING
// THE BINARY, not by observing a live hook fire. Under Claude Code this is verified working.
// Under Codex, treat it as expected-to-work-but-unproven. The fail-open design means the cost of
// being wrong is that nothing is injected, which is exactly the behaviour before installing it.
//
// Input  (stdin JSON): { hook_event_name, prompt, ... } -- ignored entirely; state comes from disk.
// Output (stdout JSON): { hookSpecificOutput: { hookEventName, additionalContext } }, or nothing.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_CONTEXT_CHARS, buildContext, listInjectors } from '../lib/injector-core.mjs';

// scripts/hooks/ -> scripts/ -> brain root. Self-located rather than cwd-derived: a hook's cwd is
// whatever the harness felt like, and resolving state against it would read an empty directory
// and silently inject nothing, which is indistinguishable from the feature not working.
const brainRoot = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

function silent() {
  process.exit(0);
}

// stdin is drained but not used. The payload carries the user's prompt and the harness could one
// day carry more; reading it keeps the pipe from filling if the harness writes a large payload and
// blocks on the write, and costs nothing. Nothing in it is trusted or parsed -- the injected text
// comes only from files the user wrote on their own disk, so a prompt cannot influence what gets
// injected. That is the difference between an injector and a prompt-injection vector.
try {
  fs.readFileSync(0, 'utf8');
} catch {
  // No stdin, a closed pipe, a harness that passes nothing -- none of it changes what we emit.
}

let built;
try {
  built = buildContext(listInjectors(brainRoot), MAX_CONTEXT_CHARS);
} catch {
  silent();
}

// Nothing set is the normal state of a fresh brain, and emitting an empty additionalContext would
// still cost the JSON framing on every turn for no content.
if (!built || !built.text) silent();

// `hookEventName` mirrors the event that fired, exactly as scripts/hooks/leak-guard-write.mjs does
// for PostToolUse. Both harnesses use the same field name.
process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: built.text,
    },
  })
);
process.exit(0);
