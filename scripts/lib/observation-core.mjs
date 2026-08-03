// Core for the observation system: turn a tool call into a tiny, non-sensitive fact, append it to
// a local log, and later read those facts back as patterns a human can turn into a preference.
//
// WHY THIS EXISTS
// ---------------
// Mavis currently learns only what the assistant NOTICES and CHOOSES to write down. That is the
// unreliable path, and this repository has the receipts: the same assistant that was supposed to
// be curating memory wrote real client names into shipped test fixtures and did not notice, and
// the repo carries a no-attribution invariant in three separate files while accumulating 17
// commits that violated it. Self-report is filtered through whatever the model believes about the
// session; it records the story, not the session.
//
// Tool-call telemetry has no such bias. It cannot flatter, forget, or narrate. It records that
// `npm test` ran 41 times and that 38 of those followed an Edit -- which is a preference about how
// this user works, discovered rather than remembered.
//
// WHAT IT DELIBERATELY DOES NOT RECORD
// ------------------------------------
// This is the load-bearing design decision, so it is stated before the code rather than after.
//
// The obvious implementation logs the whole hook payload -- it is right there, it is JSON, and it
// would make analysis richer. That implementation is a private-data firehose: `tool_input` for an
// Edit holds the literal new file contents, for a Bash it holds the full command line (tokens,
// hostnames, connection strings, `curl -H "Authorization: ..."`), for a Grep it holds the search
// pattern, which in this brain is frequently a client's name. This project spent a day removing
// exactly that class of thing from tracked files. Adding an append-only log of it would undo that
// work and hand it a timestamp.
//
// So the derivation is an ALLOWLIST, never a copy. `deriveRecord` reads named fields one at a time
// and reduces each to a shape:
//
//   file paths  -> the extension and the FIRST path segment only. `projects/acme-portal/notes.md`
//                  becomes area "projects" -- a category, never the project slug. The first
//                  segment of a brain path is structurally generic; the second is the private bit.
//   commands    -> the FIRST WORD only, reduced to a basename, and only if it looks like a program
//                  name. Everything after the first space is discarded before it is ever examined.
//   patterns,   -> not recorded at all. There is no shape of a Grep pattern or a WebFetch URL that
//   urls,          is both useful and safe, so neither is read.
//   prompts,
//   contents
//
// If you extend this, extend the allowlist. Never add a passthrough field, and never log the raw
// payload "just for debugging" -- a debug flag that writes the firehose to disk is the firehose.
import fs from 'node:fs';
import path from 'node:path';

// Lives at the brain root next to the other machine-local state. One file per day, JSON Lines:
// append-only, crash-safe (a torn final line costs one record and parses as a skip), and
// greppable without a parser.
export const OBSERVATION_DIR = '.mavis-observations';

// Default retention. Every append-only telemetry system that lacks one eventually becomes the
// largest thing in the directory, and nobody notices until it is 400MB. Thirty days is long enough
// that `patterns` has a month of behaviour to work with and short enough that the directory stays
// in the single-digit megabytes even for a heavy user.
export const DEFAULT_RETENTION_DAYS = 30;

/**
 * Resolve where observations are written, refusing an override that is not an absolute path.
 *
 * The override exists so tests can point at a tmpdir and so a user can move the log to an
 * encrypted volume. But an override read from an environment variable is a string, and a caller
 * that passes `undefined` for it gets the LITERAL STRING "undefined" -- which `path.join` happily
 * turns into a relative directory that lands wherever the process happens to be standing. That is
 * not hypothetical: a test did exactly this and created `undefined/lat/2026-08-03.jsonl` in the
 * repository root.
 *
 * Requiring an absolute path makes the whole class impossible: a malformed override is ignored and
 * the caller falls back to the brain's own directory, rather than silently scattering telemetry
 * across the filesystem.
 */
export function resolveObservationDir(brainRoot, override) {
  if (typeof override === 'string' && override && override !== 'undefined' && path.isAbsolute(override)) {
    return override;
  }
  return path.join(brainRoot, OBSERVATION_DIR);
}

// Hard cap per day file. Retention bounds the log across days; this bounds a single runaway day --
// an agent in a retry loop can emit thousands of tool calls an hour. Past the cap the hook silently
// stops appending for that day rather than growing without limit. Losing the tail of a pathological
// day costs nothing; the pattern that day demonstrates is already 20,000 records deep.
export const MAX_DAY_BYTES = 2 * 1024 * 1024;

// Top-level directories of the brain that hold the user's private content. Mirrors the anchored
// personal entries in .gitignore.
//
// Why a hardcoded set rather than asking git: `git check-ignore` costs 20-40ms of process spawn,
// and this runs after EVERY tool call. A hook that adds 30ms to every Edit is a hook the user
// eventually removes, and a removed hook observes nothing. The set is only used to tag a record
// as public/private for analysis -- it is not a security boundary, because the thing being
// recorded is a directory name that is generic either way.
export const PRIVATE_AREAS = new Set([
  'identity',
  'projects',
  'daily-memories',
  'standups',
  'preferences',
  'rules',
  'topics',
  'memory',
  'topic_details',
  '_backup',
  '_local',
  '.claude',
  '.codex',
  'node_modules',
  OBSERVATION_DIR,
]);

// Tools whose input carries a file path worth shaping. Anything not listed still gets a record --
// its name and timestamp -- it just contributes no file shape.
const FILE_TOOLS = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'NotebookRead']);

// Tools whose input is a shell command. Both harnesses use `command`; the PowerShell tool on
// Windows and the Bash tool elsewhere are the same shape from here.
const SHELL_TOOLS = new Set(['Bash', 'PowerShell', 'BashOutput', 'Shell']);

// A program name and nothing else: letters, digits, and the punctuation that appears inside real
// binary names (`npm`, `node`, `git`, `pwsh`, `dotnet`, `python3.11`, `cargo-fmt`). A first word
// that fails this is not a program name -- it is a variable assignment, a redirect, a quoted path
// with spaces, or a heredoc -- and recording it verbatim is exactly the leak this file is built to
// avoid. Those become "(other)".
const VERB_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,23}$/;

// The first token must look like a PATH to a program before it is reduced to a basename. This
// check is not redundant with VERB_RE and its absence was a live leak, caught by the test that
// asserts arguments never survive:
//
//   AWS_SECRET_ACCESS_KEY=wJalrXUtn/K7MDENG git push
//
// Basenaming first splits on the `/` INSIDE the secret and hands VERB_RE the trailing fragment
// `K7MDENG`, which is a perfectly valid-looking program name. The record would then have carried
// a chunk of an AWS secret key as its verb, on disk, timestamped. Validating the whole token as
// path-shaped BEFORE splitting it rejects the assignment outright, because `=` is not a path
// character -- as are `psql://user:pw@host/db` (`:` and `@`), `<<EOF` and `$(...)`.
//
// A Windows drive prefix is the one exception, stripped before the check so `C:/tools/node.exe`
// still reads as `node` while `psql://` still does not (a drive letter is exactly one character).
const PATHY_RE = /^[A-Za-z0-9._+\-/\\]+$/;
const DRIVE_RE = /^[A-Za-z]:[\\/]/;
const QUOTE_RE = /^["'`]/;

const posix = (p) => String(p).split('\\').join('/');

/**
 * Reduce a session identifier to something short and stable.
 *
 * Session ids are opaque harness-generated values (a UUID in both Claude Code and Codex), so they
 * carry nothing personal -- but they are 36 characters repeated on every line, which is most of
 * the record. Eight characters is enough to distinguish sessions within a retention window and
 * costs a twentieth of the disk.
 */
export function shortSession(id) {
  const s = String(id == null ? '' : id).replace(/[^A-Za-z0-9]/g, '');
  return s ? s.slice(0, 8).toLowerCase() : 'unknown';
}

/**
 * Shape a file path: extension, first path segment, and whether that segment is public.
 *
 * The first segment ONLY. This is the whole privacy argument for file paths in one line: in this
 * brain's layout the first segment is a category (`projects`, `scripts`, `skills`) and the second
 * is the identifying part (`projects/<client-slug>/`). Truncating at the first separator keeps
 * everything analysis needs -- "you spend your writes in scripts/, your reads in skills/" -- and
 * discards the part that would name a client.
 *
 * Paths outside the brain are recorded as "(external)" with no publicity flag: sessions routinely
 * edit other repositories, and the directory names in those are not this tool's business.
 */
export function deriveFileShape(filePath, brainRoot) {
  if (!filePath) return null;
  const raw = String(filePath);
  const abs = path.isAbsolute(raw) ? raw : path.resolve(brainRoot || '.', raw);
  const ext = path.extname(abs).toLowerCase().slice(0, 12);

  const rel = brainRoot ? posix(path.relative(brainRoot, abs)) : '';
  if (!brainRoot || !rel || rel.startsWith('../') || rel === '..' || path.isAbsolute(rel)) {
    return { ext, area: '(external)', pub: null };
  }
  const seg = rel.includes('/') ? rel.slice(0, rel.indexOf('/')) : '(root)';
  const area = seg === '(root)' ? '(root)' : seg;
  return { ext, area, pub: PRIVATE_AREAS.has(area) ? 0 : 1 };
}

/**
 * Reduce a shell command to its verb.
 *
 * Everything after the first whitespace run is dropped before anything else happens -- the split
 * is the first operation, so arguments are never inspected, never normalised, never length-checked.
 * The first token is then validated as path-shaped (see PATHY_RE for why that ordering is
 * load-bearing), reduced to a basename so `/usr/local/bin/node` reads as `node`, stripped of a
 * Windows executable suffix, and finally checked against VERB_RE. Anything that fails becomes
 * "(other)" rather than being recorded, because a first token that is not a program name is a
 * fragment of something structured, and fragments of structured things are where secrets live.
 */
export function deriveVerb(command) {
  if (!command) return null;
  const first = String(command).trim().split(/\s+/)[0];
  if (!first) return null;

  // An opening quote with no closing one means the whitespace split landed INSIDE a quoted
  // argument -- `"C:/Program Files/Acme Portal/tool.exe"` yields `"C:/Program`. Basenaming that
  // would record `Program`, or on a different machine `Clients`: a directory name the user never
  // agreed to log. A truncated quoted token is unknowable, so it is "(other)".
  if (QUOTE_RE.test(first) && first[first.length - 1] !== first[0]) return '(other)';

  const unquoted = first.replace(/^["'`]+/, '').replace(/["'`]+$/, '');
  if (!unquoted) return null;

  const noDrive = DRIVE_RE.test(unquoted) ? unquoted.slice(2) : unquoted;
  if (!PATHY_RE.test(noDrive)) return '(other)';

  const base = posix(noDrive).split('/').pop() || '';
  const bare = base.replace(/\.(exe|cmd|bat|ps1)$/i, '');
  return VERB_RE.test(bare) ? bare.toLowerCase() : '(other)';
}

// Did the tool call fail? Useful for pattern detection (a verb that keeps failing is a rule
// candidate: "this command needs the quoted-glob form on Windows"). Harnesses disagree about the
// shape of a failure, so this checks the several forms both are known to emit and gives up
// quietly rather than guessing. It never reads the error TEXT -- a stack trace holds paths.
function deriveError(toolResponse) {
  if (!toolResponse || typeof toolResponse !== 'object') return false;
  if (toolResponse.is_error === true || toolResponse.isError === true) return true;
  if (toolResponse.success === false) return true;
  if (typeof toolResponse.interrupted === 'boolean' && toolResponse.interrupted) return true;
  if (typeof toolResponse.exit_code === 'number' && toolResponse.exit_code !== 0) return true;
  if (typeof toolResponse.exitCode === 'number' && toolResponse.exitCode !== 0) return true;
  return false;
}

/**
 * Build one observation record from a hook payload.
 *
 * Returns null when there is nothing worth recording (no tool name). The output object is
 * constructed field by field from named inputs -- there is no spread of the payload anywhere in
 * this function, and that is deliberate: a spread would silently start logging every new field
 * either harness adds, forever, without anyone reviewing it.
 */
export function deriveRecord(payload, opts = {}) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const tool = typeof p.tool_name === 'string' ? p.tool_name.slice(0, 64) : '';
  if (!tool) return null;

  const now = opts.now instanceof Date ? opts.now : new Date();
  const rec = {
    t: now.toISOString(),
    s: shortSession(p.session_id),
    tool,
  };

  const input = p.tool_input && typeof p.tool_input === 'object' ? p.tool_input : {};

  if (FILE_TOOLS.has(tool)) {
    // tool_response.filePath is the resolved path the harness actually touched; tool_input is the
    // fallback for harnesses (and tool versions) that do not echo it back.
    const fp =
      (p.tool_response && typeof p.tool_response === 'object' && p.tool_response.filePath) ||
      input.file_path ||
      input.notebook_path ||
      null;
    const shape = deriveFileShape(fp, opts.brainRoot);
    if (shape) {
      if (shape.ext) rec.ext = shape.ext;
      rec.area = shape.area;
      if (shape.pub !== null) rec.pub = shape.pub;
    }
  } else if (SHELL_TOOLS.has(tool)) {
    const verb = deriveVerb(input.command);
    if (verb) rec.verb = verb;
  }
  // Every other tool contributes its NAME and nothing else. Grep patterns, WebFetch URLs, Task
  // prompts and MCP arguments are all skipped by construction -- there is no branch that reads
  // them, which is a stronger guarantee than a branch that reads and then redacts them.

  if (deriveError(p.tool_response)) rec.err = 1;
  return rec;
}

/** One record, one line. Stable key order so the file diffs and compresses well. */
export function formatLine(record) {
  return JSON.stringify(record);
}

/** Parse a JSONL body, skipping blank and malformed lines (a torn tail costs one record). */
export function parseLines(text) {
  const out = [];
  for (const line of String(text == null ? '' : text).split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s[0] !== '{') continue;
    try {
      const rec = JSON.parse(s);
      if (rec && typeof rec === 'object' && typeof rec.tool === 'string') out.push(rec);
    } catch {
      // A partially-written final line from a killed process. Skipping is the correct repair.
    }
  }
  return out;
}

const DAY_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

/**
 * Append one record. Never throws, never blocks, always reports rather than raising.
 *
 * Fail-open is not laziness here. The caller is a PostToolUse hook: if it throws, the harness
 * surfaces an error into the user's session for a telemetry write nobody asked about. A safety net
 * that can halt the work it observes gets deleted within a day, and a deleted hook observes
 * nothing. So an unwritable directory, a full disk, or a permission change all resolve to
 * `{ written: false }` and silence.
 *
 * `newDay` in the result is how rotation gets triggered without a scheduler -- see the CLI and the
 * hook. The first append of a calendar day is the natural once-a-day moment to sweep old files.
 */
export function appendObservation(dir, record, opts = {}) {
  const maxBytes = typeof opts.maxDayBytes === 'number' ? opts.maxDayBytes : MAX_DAY_BYTES;
  try {
    const day = String(record.t).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return { written: false, reason: 'bad-timestamp' };
    const file = path.join(dir, `${day}.jsonl`);

    let newDay = false;
    try {
      const st = fs.statSync(file);
      if (st.size >= maxBytes) return { written: false, reason: 'day-file-full', file };
    } catch {
      newDay = true; // no file for today yet
    }

    if (newDay) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(file, formatLine(record) + '\n');
    return { written: true, file, newDay };
  } catch (err) {
    return { written: false, reason: 'error', code: (err && err.code) || 'unknown' };
  }
}

/** List the day files present, newest last. Missing directory reads as empty, not as an error. */
export function listDayFiles(dir) {
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names.filter((n) => DAY_FILE_RE.test(n)).sort();
}

/** Read every record on disk, with the per-file byte sizes the stats command reports. */
export function readObservations(dir) {
  const files = [];
  const records = [];
  for (const name of listDayFiles(dir)) {
    const full = path.join(dir, name);
    let text = '';
    let bytes = 0;
    try {
      const buf = fs.readFileSync(full);
      bytes = buf.length;
      text = buf.toString('utf8');
    } catch {
      continue;
    }
    const recs = parseLines(text);
    files.push({ name, day: name.slice(0, 10), bytes, count: recs.length });
    for (const r of recs) records.push(r);
  }
  return { files, records };
}

/**
 * Which day files are older than the retention window? Pure, so retention is testable without
 * waiting a month or touching mtimes -- the date is in the filename, which is also why a clock
 * skew or a restored backup cannot confuse it the way an mtime check would.
 */
export function filesToPrune(names, opts = {}) {
  const days = typeof opts.days === 'number' ? opts.days : DEFAULT_RETENTION_DAYS;
  const now = opts.now instanceof Date ? opts.now : new Date();
  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const cutoffDay = cutoff.toISOString().slice(0, 10);
  return names.filter((n) => {
    const m = DAY_FILE_RE.exec(n);
    return m ? m[1] < cutoffDay : false;
  });
}

/** Delete the out-of-window day files. Returns what it removed; never throws. */
export function pruneObservations(dir, opts = {}) {
  const doomed = filesToPrune(listDayFiles(dir), opts);
  const removed = [];
  for (const name of doomed) {
    if (opts.dryRun) {
      removed.push(name);
      continue;
    }
    try {
      fs.unlinkSync(path.join(dir, name));
      removed.push(name);
    } catch {
      // A file held open by another process comes back around tomorrow. Nothing to say.
    }
  }
  return removed;
}

const bump = (map, key, by = 1) => map.set(key, (map.get(key) || 0) + by);
const ranked = (map) => [...map.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));

/** Counts by tool, by day, by verb, by area -- the `stats` command's whole model. */
export function computeStats(records, files = []) {
  const byTool = new Map();
  const byDay = new Map();
  const byVerb = new Map();
  const byArea = new Map();
  const byExt = new Map();
  const sessions = new Set();
  let errors = 0;

  for (const r of records) {
    bump(byTool, r.tool);
    bump(byDay, String(r.t).slice(0, 10));
    if (r.verb) bump(byVerb, r.verb);
    if (r.area) bump(byArea, r.area);
    if (r.ext) bump(byExt, r.ext);
    if (r.s) sessions.add(r.s);
    if (r.err) errors += 1;
  }

  return {
    total: records.length,
    sessions: sessions.size,
    days: byDay.size,
    errors,
    bytes: files.reduce((n, f) => n + (f.bytes || 0), 0),
    byTool: ranked(byTool),
    byDay: [...byDay.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    byVerb: ranked(byVerb),
    byArea: ranked(byArea),
    byExt: ranked(byExt),
  };
}

// Group by session, preserving arrival order, so sequence analysis never straddles two sessions.
function bySession(records) {
  const map = new Map();
  for (const r of records) {
    const key = r.s || 'unknown';
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(r);
  }
  return map;
}

/**
 * Find behaviour worth proposing as a preference entry.
 *
 * WHAT THIS IS AND IS NOT ALLOWED TO DO
 * -------------------------------------
 * It returns CANDIDATES. It does not write to `preferences/`, it does not create entries, and the
 * CLI that renders it says so in its output. The reason is the same one that motivates the whole
 * feature: an assistant deciding on its own what the user prefers, and then writing that decision
 * into the file that shapes future sessions, is a feedback loop with no human in it. Telemetry
 * removes the bias from OBSERVATION; it does not earn the right to skip approval. The user reads
 * the candidate, agrees or does not, and the assistant then writes the entry through the existing
 * entry lifecycle like any other memory write.
 *
 * Each candidate carries the raw count and the number of distinct sessions it was seen in, because
 * "42 times in one session" and "42 times across nine sessions" are completely different claims
 * and only the second is a preference.
 */
export function detectPatterns(records, opts = {}) {
  const minCount = typeof opts.minCount === 'number' ? opts.minCount : 5;
  const minShare = typeof opts.minShare === 'number' ? opts.minShare : 0.4;
  const sessionsMap = bySession(records);
  const sessionCount = sessionsMap.size;
  const out = [];

  const pct = (n, d) => (d > 0 ? Math.round((n / d) * 100) : 0);

  // Sessions a given key appeared in -- the guard against a single frantic afternoon looking like
  // a habit.
  const sessionsFor = (predicate) => {
    let n = 0;
    for (const recs of sessionsMap.values()) if (recs.some(predicate)) n += 1;
    return n;
  };

  // --- 1. Shell verbs -------------------------------------------------------------------------
  // The single richest signal available without recording arguments. Which programs a person
  // reaches for, and how often, is most of their working style.
  const verbCounts = new Map();
  let verbTotal = 0;
  for (const r of records) {
    if (!r.verb) continue;
    bump(verbCounts, r.verb);
    verbTotal += 1;
  }
  for (const [verb, count] of ranked(verbCounts)) {
    if (count < minCount) break;
    const share = pct(count, verbTotal);
    const seenIn = sessionsFor((r) => r.verb === verb);
    out.push({
      id: `shell-verb:${verb}`,
      kind: 'shell-verb',
      count,
      sessions: seenIn,
      observation: `Shell tool "${verb}" ran ${count} time(s) -- ${share}% of all shell calls -- across ${seenIn} of ${sessionCount} session(s).`,
      proposal: `prefers-${verb}-for-shell-work`,
      why:
        share >= minShare * 100
          ? 'Dominant enough to be a default worth writing down (which runner, which package manager).'
          : 'A recurring tool; worth an entry only if the user confirms it is a deliberate choice.',
    });
  }

  // --- 2. Failing verbs -----------------------------------------------------------------------
  // A command that fails repeatedly is the strongest rule candidate of all, because the rule
  // writes itself: whatever invocation keeps failing has a correct form the user knows and the
  // assistant does not. (This repo's own example: a bare directory argument to `node --test` fails
  // on Windows and the quoted glob works.)
  const failCounts = new Map();
  for (const r of records) if (r.verb && r.err) bump(failCounts, r.verb);
  for (const [verb, fails] of ranked(failCounts)) {
    if (fails < Math.max(3, Math.floor(minCount / 2))) break;
    const total = verbCounts.get(verb) || fails;
    out.push({
      id: `failing-verb:${verb}`,
      kind: 'failing-verb',
      count: fails,
      sessions: sessionsFor((r) => r.verb === verb && r.err),
      observation: `"${verb}" failed ${fails} of ${total} run(s) (${pct(fails, total)}%).`,
      proposal: `correct-invocation-for-${verb}`,
      why: 'A repeatedly failing command usually means the working invocation is a fact only the user holds.',
    });
  }

  // --- 3. Tool sequences ----------------------------------------------------------------------
  // Adjacent pairs within one session. This is where habits live: Edit->Bash is "verifies every
  // change", Read->Edit is "reads before editing", Edit->Edit runs is "batches edits then tests".
  const bigrams = new Map();
  const bigramSessions = new Map();
  for (const [sid, recs] of sessionsMap) {
    for (let i = 1; i < recs.length; i++) {
      const key = `${recs[i - 1].tool} -> ${recs[i].tool}`;
      bump(bigrams, key);
      if (!bigramSessions.has(key)) bigramSessions.set(key, new Set());
      bigramSessions.get(key).add(sid);
    }
  }
  const bigramTotal = [...bigrams.values()].reduce((a, b) => a + b, 0);
  for (const [pair, count] of ranked(bigrams).slice(0, 5)) {
    if (count < minCount) break;
    const [from, to] = pair.split(' -> ');
    out.push({
      id: `sequence:${pair}`,
      kind: 'sequence',
      count,
      sessions: (bigramSessions.get(pair) || new Set()).size,
      observation: `${from} is followed immediately by ${to} ${count} time(s) (${pct(count, bigramTotal)}% of all transitions).`,
      proposal: `always-${String(to).toLowerCase()}-after-${String(from).toLowerCase()}`,
      why: 'A transition this consistent is a workflow rule the assistant currently has to rediscover each session.',
    });
  }

  // --- 4. Where the work happens --------------------------------------------------------------
  const areaCounts = new Map();
  let areaTotal = 0;
  for (const r of records) {
    if (!r.area) continue;
    bump(areaCounts, r.area);
    areaTotal += 1;
  }
  const topArea = ranked(areaCounts)[0];
  if (topArea && topArea[1] >= minCount && topArea[1] / areaTotal >= minShare) {
    out.push({
      id: `area:${topArea[0]}`,
      kind: 'area',
      count: topArea[1],
      sessions: sessionsFor((r) => r.area === topArea[0]),
      observation: `${pct(topArea[1], areaTotal)}% of file activity is in "${topArea[0]}" (${topArea[1]} of ${areaTotal} file operations).`,
      proposal: `primary-work-area-${topArea[0]}`,
      why: 'Tells a fresh session where to look first, which is otherwise rediscovered by grep every time.',
    });
  }

  const extCounts = new Map();
  let extTotal = 0;
  for (const r of records) {
    if (!r.ext) continue;
    bump(extCounts, r.ext);
    extTotal += 1;
  }
  const topExt = ranked(extCounts)[0];
  if (topExt && topExt[1] >= minCount && topExt[1] / extTotal >= minShare) {
    out.push({
      id: `filetype:${topExt[0]}`,
      kind: 'filetype',
      count: topExt[1],
      sessions: sessionsFor((r) => r.ext === topExt[0]),
      observation: `${pct(topExt[1], extTotal)}% of files touched are "${topExt[0]}" (${topExt[1]} of ${extTotal}).`,
      proposal: `primary-filetype-${String(topExt[0]).replace(/^\./, '')}`,
      why: 'Language and convention defaults follow from this.',
    });
  }

  // --- 5. Memory-write cadence ----------------------------------------------------------------
  // The contract requires a paired write on meaningful work. Whether that actually happens is
  // exactly the kind of claim self-report is worst at and telemetry is best at: writes into the
  // private brain areas are counted, not narrated.
  const memoryWrites = records.filter(
    (r) => (r.tool === 'Write' || r.tool === 'Edit') && r.pub === 0
  ).length;
  const allWrites = records.filter((r) => r.tool === 'Write' || r.tool === 'Edit').length;
  if (allWrites >= minCount) {
    out.push({
      id: 'memory-cadence',
      kind: 'memory-cadence',
      count: memoryWrites,
      sessions: sessionCount,
      observation: `${memoryWrites} of ${allWrites} write/edit operations (${pct(memoryWrites, allWrites)}%) landed in private brain directories across ${sessionCount} session(s).`,
      proposal: memoryWrites === 0 ? 'memory-writes-are-not-happening' : 'memory-write-cadence',
      why:
        memoryWrites === 0
          ? 'Zero memory writes despite real work is the paired-write invariant failing silently -- worth a rule, not a preference.'
          : 'Confirms the paired-write habit is real rather than reported.',
    });
  }

  out.sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
  return { sessionCount, total: records.length, candidates: out };
}
