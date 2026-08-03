// Core for the context injectors: turn a directory of one-line state files into the handful of
// characters that get re-stated to the model on EVERY turn.
//
// WHY THIS EXISTS
// ---------------
// `AGENTS.md` opens with a warning that is the whole reason this file is here: a rule loaded once
// at session boot loses to a harness default that is re-injected every turn. Compaction rewrites
// the transcript, the rules get summarised away, and the defaults -- which live outside the
// transcript -- do not. This repo did not theorise about that failure, it suffered it: 17 commits
// carrying an AI attribution trailer while the rule forbidding it sat in three separate files.
//
// An injector is the general form of the fix. Anything emitted on `UserPromptSubmit` is attached
// to the user's message, so it arrives fresh every single turn and there is no summariser between
// it and the model. That makes it the right home for VOLATILE state -- what register to write in,
// what the user is deep in right now -- which is exactly the class of context a compaction
// destroys and a boot-time read cannot restore.
//
// THE CONSTRAINT THAT SHAPES EVERYTHING BELOW
// -------------------------------------------
// Per-turn context is the most expensive real estate in the system: it is paid on every turn of
// every session, forever. The brain's boot floor is already ~16k tokens. So an injector that
// "just" adds a paragraph is not a small cost, it is a permanent tax multiplied by turn count.
// Hence the hard character cap, the one-line-per-file rule, and the refusal to add a header or
// any framing prose. The entire feature is designed to cost tens of tokens, not hundreds, and the
// cap is enforced at READ time rather than write time so that a hand-edited state file -- which
// never went through the CLI -- cannot blow the budget either.
//
// FAIL-OPEN, ALWAYS
// -----------------
// This code runs inside a hook on the user's prompt path. A hook that can break a session gets
// uninstalled, and an uninstalled hook protects nothing. So every read here returns a benign
// empty value on any error rather than throwing: missing directory, missing file, empty file,
// unreadable file, a directory where a file was expected, a 400MB file. The only functions
// allowed to throw are the ones the CLI calls, where a human is watching and a clear error is
// more useful than silence.
import fs from 'node:fs';
import path from 'node:path';

// Per-user state, gitignored. Lives at the brain root rather than under `scripts/` so it sits
// next to the other per-machine files (`.mavis-private`, `.setup-complete`) and is obvious to
// anyone poking around their own brain.
export const INJECT_DIR = '.mavis-inject';

// The hard ceiling on everything the hook emits, combined. 400 characters is roughly 100 tokens
// per turn -- about 0.6% of the current boot floor, and small enough that a 200-turn session pays
// under 20k tokens total for it. Past this the feature stops being cheap enough to justify, so
// the cap truncates rather than growing.
export const MAX_CONTEXT_CHARS = 400;

// Never read more than this from a single state file. These are meant to be one short line; a
// bigger file is either a mistake or something pathological, and reading it whole to then throw
// 99.9% of it away is pure waste on the prompt path. Bounded reads also mean a state file that
// somehow became a multi-gigabyte log cannot stall the user's turn.
export const MAX_STATE_BYTES = 4096;

// Appended when the cap bites. Emitting a silently-shortened value would be worse than emitting
// nothing: the model would act on half a sentence with no signal that it was half. The notice is
// counted INSIDE the cap, so the emitted total never exceeds MAX_CONTEXT_CHARS.
export const TRUNCATION_NOTICE = ' [mavis-inject: truncated]';

// Names are filenames, so this is a security boundary, not a style rule. Without it
// `inject set ../../etc/passwd x` writes outside the brain, and a state file literally named
// `../../../.ssh/authorized_keys.txt` would be read back and emitted. Anchored, no dots, no
// separators, no leading dash (which would be read as a flag by anything downstream), and
// bounded in length so a name cannot itself consume the character budget.
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;

// Every C0 control character plus DEL. Built from a string of \u escapes rather than written as a
// regex literal on purpose: a literal control character in source is invisible in a diff and in
// review, so the one time someone deletes it by accident nobody sees the deletion. This class is
// what enforces the "ONE LINE each" contract -- CR and LF are in it, so a multi-line value
// collapses to spaces instead of being cut at the first newline (silent truncation is exactly the
// failure mode this module exists to avoid) or smuggling a newline into the emitted block.
const CONTROL_RE = new RegExp('[\\u0000-\\u001f\\u007f]', 'g');

/**
 * Normalise an injector name, or return null when it is not usable as one.
 *
 * Returns the lowercased name -- state files are lowercase on disk so that `TONE`, `Tone` and
 * `tone` are one injector rather than three, which matters on case-insensitive filesystems where
 * they would silently collide anyway. Emission uppercases it again.
 */
export function sanitizeName(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!NAME_RE.test(s)) return null;
  return s.toLowerCase();
}

/** Absolute path to this brain's injector directory. Does not create it. */
export function injectDir(brainRoot) {
  return path.join(brainRoot, INJECT_DIR);
}

/**
 * Absolute path of one injector's state file, or null when the name is unusable.
 *
 * The containment re-check after the join is deliberate belt-and-braces. `sanitizeName` already
 * makes traversal impossible, but this is the function every caller uses to turn user input into
 * a path they will then WRITE to, and a single future edit loosening NAME_RE should not silently
 * become an arbitrary-file-write. The check costs a string compare.
 */
export function stateFile(brainRoot, name) {
  const clean = sanitizeName(name);
  if (!clean) return null;
  const dir = injectDir(brainRoot);
  const file = path.join(dir, `${clean}.txt`);
  if (path.dirname(path.resolve(file)) !== path.resolve(dir)) return null;
  return file;
}

/**
 * Collapse a raw state value to the one line it is contractually meant to be.
 *
 * Newlines become spaces rather than being cut at the first one: a value pasted from a wrapped
 * editor would otherwise lose its tail silently, and silent truncation is the failure mode this
 * whole module works to avoid. Control characters are stripped because this text is spliced into
 * a JSON hook payload and then into a prompt -- an embedded ESC or NUL has no business in either.
 */
export function normalizeValue(raw) {
  if (raw == null) return '';
  return String(raw)
    .replace(CONTROL_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Read one state file. Returns '' for anything that is not a readable non-empty file.
 *
 * The read is bounded (see MAX_STATE_BYTES) and every failure path is swallowed, because this is
 * called from the prompt hook. A missing file is the NORMAL case -- most brains will have one or
 * two injectors set out of however many are documented -- so it is not an error condition at all.
 */
export function readState(brainRoot, name) {
  const file = stateFile(brainRoot, name);
  if (!file) return '';
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(MAX_STATE_BYTES);
    const read = fs.readSync(fd, buf, 0, MAX_STATE_BYTES, 0);
    return normalizeValue(buf.subarray(0, read).toString('utf8'));
  } catch {
    return '';
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* nothing useful to do about a failed close on a read-only fd */
      }
    }
  }
}

/**
 * Every injector that currently has a value, as [{ name, value, file }].
 *
 * Sorted by name so the emitted context is byte-identical from turn to turn when nothing changed.
 * That stability is not cosmetic: an unstable prefix on every user message is a prompt-cache miss
 * and a noisy diff for anyone auditing what the hook actually said.
 *
 * Files whose name fails sanitisation are skipped rather than repaired -- a file called
 * `..\evil.txt` dropped into the directory by hand is not an injector, and the safe reading of an
 * unrecognised name is "not mine".
 */
export function listInjectors(brainRoot) {
  const dir = injectDir(brainRoot);
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return []; // no directory yet is the normal state of a fresh brain
  }
  const out = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    if (!e.name.toLowerCase().endsWith('.txt')) continue;
    const name = sanitizeName(e.name.slice(0, -4));
    if (!name) continue;
    const value = readState(brainRoot, name);
    if (!value) continue; // an empty file means "unset", not "inject a blank line"
    out.push({ name, value, file: path.join(dir, `${name}.txt`) });
  }
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

/**
 * Render the injector entries into the exact text the hook emits.
 *
 * Format is `NAME: value`, one per line, and nothing else. No header, no framing sentence, no
 * "the following is your current state" preamble -- every one of those is a fixed cost paid on
 * every turn forever, and the names are self-describing enough to carry their own meaning. The
 * README is where the framing lives, once, at zero per-turn cost.
 *
 * Returns { text, chars, tokens, truncated, dropped }.
 */
export function buildContext(entries, max = MAX_CONTEXT_CHARS) {
  const lines = (entries || [])
    .map((e) => {
      const name = sanitizeName(e && e.name);
      const value = normalizeValue(e && e.value);
      if (!name || !value) return null;
      return `${name.toUpperCase()}: ${value}`;
    })
    .filter(Boolean);

  const full = lines.join('\n');
  if (full.length <= max) {
    return { text: full, chars: full.length, tokens: estimateTokens(full.length), truncated: false, dropped: 0 };
  }

  // Over budget. Cut to exactly `max` INCLUDING the notice, so the cap is a real ceiling on what
  // reaches the prompt rather than an approximate one. A cap so small it cannot even hold the
  // notice degrades to a plain hard cut rather than emitting a mangled marker.
  const room = max - TRUNCATION_NOTICE.length;
  const text = room > 0 ? full.slice(0, room) + TRUNCATION_NOTICE : full.slice(0, max);
  const kept = text.split('\n').length;
  return {
    text,
    chars: text.length,
    tokens: estimateTokens(text.length),
    truncated: true,
    dropped: Math.max(0, lines.length - kept),
  };
}

/**
 * Characters to tokens, the crude way.
 *
 * Four characters per token is the standard rough figure for English prose and is close enough
 * for a budget this small -- being wrong by 20% here is being wrong by 20 tokens. The point of
 * reporting a number at all is to keep the per-turn cost VISIBLE, so it stays a decision rather
 * than a drift.
 */
export function estimateTokens(chars) {
  return Math.ceil(Number(chars || 0) / 4);
}

/**
 * Set one injector. Throws on a bad name -- this is the CLI path, where a human typed the name
 * and telling them it was rejected is far more useful than silently doing nothing.
 */
export function writeState(brainRoot, name, value) {
  const clean = sanitizeName(name);
  if (!clean) {
    throw new Error(
      `invalid injector name ${JSON.stringify(String(name))}: use letters, digits, "_" or "-", ` +
      'starting with a letter or digit, 32 characters max.'
    );
  }
  const text = normalizeValue(value);
  if (!text) throw new Error('an injector value cannot be empty -- use `clear` to remove one.');
  // Clamped at write time as well as read time. The read-time cap is the one that protects the
  // budget (a hand-edited file never passes through here), but storing a bounded value keeps
  // `list` readable and makes what is on disk match what will actually be emitted.
  const stored = text.length > MAX_CONTEXT_CHARS ? text.slice(0, MAX_CONTEXT_CHARS) : text;
  const dir = injectDir(brainRoot);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${clean}.txt`);
  fs.writeFileSync(file, `${stored}\n`, 'utf8');
  return { name: clean, value: stored, file, clamped: stored !== text };
}

/** Remove one injector. Returns true if a file was actually deleted. Never throws on absence. */
export function clearState(brainRoot, name) {
  const file = stateFile(brainRoot, name);
  if (!file) {
    throw new Error(`invalid injector name ${JSON.stringify(String(name))}.`);
  }
  try {
    fs.unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}
