#!/usr/bin/env node
// PostToolUse hook: record that a tool call happened, and nothing about what it contained.
//
// COST: ZERO TOKENS. This is the entire reason the feature is shaped the way it is.
//
// The hook prints NOTHING to stdout and exits 0 unconditionally. A PostToolUse hook only enters
// the model's context when it emits output -- `decision`, `reason`, `additionalContext`, or a
// non-zero exit whose stderr gets fed back. This one emits none of those, so the transcript is
// byte-for-byte identical to a session without it. Nothing is added to the boot floor either,
// because nothing here is read at session start: the log is a local file, and the analysis CLI is
// run by hand when the user wants it.
//
// That constraint is why the design is "write locally, analyse out of band" rather than the
// obvious "summarise the session and inject it". An injected summary costs its own length on every
// turn forever; a JSONL file costs nothing until someone asks a question of it.
//
// SPEED AND SAFETY
// ----------------
// It runs after every single tool call, so it must be fast and it must never be the reason a
// session stops. No subprocesses (a `git check-ignore` would be 20-40ms of spawn, per tool call,
// forever), no network, no synchronous scans. One stat, one append. Every failure path exits 0
// silently -- an unwritable directory, a full disk, malformed stdin, a harness that changed its
// payload shape. Telemetry that can break the work it observes gets uninstalled, and an
// uninstalled hook observes nothing.
//
// BOTH HARNESSES
// --------------
// Claude Code declares this under the `hooks` key of settings.json; Codex declares it in
// hooks.json (`$CODEX_HOME/hooks/hooks.json`). The event name, payload field names and config
// fields are the same, so one script serves both.
//
// Caveat worth keeping honest: Codex's hook support was established by BINARY INSPECTION of
// codex.exe -- the event list, the config fields and `hook_event_name` are all present in the
// binary -- but it has not been confirmed by an observed live Codex run. Treat the Codex wiring as
// expected-to-work rather than verified.
//
// Input  (stdin JSON): { session_id, tool_name, tool_input: {...}, tool_response: {...} }
// Output: none. Ever.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  OBSERVATION_DIR,
  resolveObservationDir,
  deriveRecord,
  appendObservation,
  pruneObservations,
} from '../lib/observation-core.mjs';

// scripts/hooks/ -> scripts/ -> brain root. Self-located, never from cwd: the harness invokes
// hooks with the cwd of whatever project the session is in, which is frequently not this repo.
const brainRoot = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

// A single exit path. Anything unexpected lands here and the session never notices.
function done() {
  process.exit(0);
}

try {
  let raw = '';
  try {
    raw = fs.readFileSync(0, 'utf8');
  } catch {
    done();
  }

  let payload;
  try {
    payload = JSON.parse(raw || '{}');
  } catch {
    done();
  }

  const record = deriveRecord(payload, { brainRoot, now: new Date() });
  if (!record) done();

  // Overridable so the tests can point at a tmpdir, and so a user who wants the log somewhere
  // else (an encrypted volume, a RAM disk) can move it without editing the script.
  const dir = resolveObservationDir(brainRoot, process.env.MAVIS_OBSERVATIONS_DIR);

  const result = appendObservation(dir, record);

  // Rotation with no scheduler: the first append of a new calendar day is a natural once-a-day
  // moment, and it is the only append that pays for the readdir. Doing it on every call would add
  // a directory listing to every tool call for no benefit; doing it never is how an append-only
  // log becomes the largest thing on the disk.
  if (result.written && result.newDay) {
    try {
      pruneObservations(dir, { now: new Date() });
    } catch {
      // Retention is best-effort. It comes back around tomorrow.
    }
  }
} catch {
  // Nothing above is allowed to surface. See the fail-open note at the top.
}

done();
