// Core for the leak guard: decide what counts as "personal" for THIS user, then find it in
// content that is about to become public.
//
// WHY THIS EXISTS
// ---------------
// `.gitignore` protects known personal DIRECTORIES. Every real leak this repo suffered arrived by
// a different route: a tracked file that absorbed personal CONTENT. A migration script dumped 58
// real preference entries into its own data file; test fixtures used a real client's production
// board because a realistic fixture was wanted; skills used real engagements as worked examples;
// a dashboard string hardcoded the author's name. `.gitignore` has no opinion about file contents
// and was structurally blind to all of it.
//
// Most of that content was not typed by the user. It was written by an AI assistant that had the
// real brain loaded and reached for the nearest concrete example. A written rule does not stop
// this -- the same repo carries a no-AI-attribution invariant in three files and still accumulated
// 17 commits with attribution trailers. Only a mechanical check that the assistant cannot talk
// itself out of does.
//
// THE KEY IDEA
// ------------
// A shipped list of "personal terms" is useless: my clients are not your clients. But the thing
// the guard must protect ALREADY KNOWS what is personal. The gitignored brain enumerates it --
// `projects/*/` is every project slug, `identity/profile.md` is the user's name, git config is
// their email. So the identifier set is DERIVED per-machine and never hardcoded. That is what
// makes this work for a stranger who clones the repo.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Terms shorter than this are skipped unless the user lists them explicitly in `.mavis-private`.
// A derived slug is often short and ordinary -- `api`, `web`, `team` -- and would fire inside
// unrelated words; a guard that cries wolf gets disabled, and a disabled guard protects nothing.
export const MIN_TERM_LENGTH = 4;

// Binaries are scanned for embedded strings (a tracked .pyc carried the author's absolute source
// path in its bytecode). Past this size the cost stops being worth it -- large binaries in a
// source repo are their own problem.
export const MAX_BINARY_SCAN_BYTES = 5 * 1024 * 1024;

// Patterns that are personal for EVERY user, so they work with no brain at all -- a fresh
// contributor with no `projects/` still gets covered, and so does CI.
export const GENERIC_PATTERNS = [
  { kind: 'email', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, label: 'email address' },
  { kind: 'winhome', re: /\b[A-Za-z]:[\\/]+Users[\\/]+([A-Za-z0-9._-]+)/gi, label: 'Windows home path' },
  { kind: 'nixhome', re: /\/home\/([a-z0-9._-]+)\//gi, label: 'Linux home path' },
  { kind: 'machome', re: /\/Users\/([A-Za-z0-9._-]+)\//g, label: 'macOS home path' },
  { kind: 'privkey', re: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/g, label: 'private key block' },
  { kind: 'apikey', re: /\b(?:sk-ant-|sk-|ghp_|gho_|github_pat_|AKIA|AIza|xox[baprs]-)[A-Za-z0-9_-]{8,}/g, label: 'API key' },
];

// Generic patterns that describe a SHAPE rather than a secret, and legitimately appear in the
// repo's own documentation and tests. `/Users/` and `C:\Users\` show up in prose explaining path
// handling and in deliberately-fake fixtures, so those two are advisory rather than blocking
// unless the captured username matches the real one (checked separately in scanText).
const ADVISORY_KINDS = new Set(['winhome', 'nixhome', 'machome']);

// Addresses that cannot identify a person, so flagging them is pure noise. Two classes:
//
//   1. no-reply vendor addresses. `noreply@anthropic.com` and `noreply@openai.com` are the exact
//      strings the commit-msg hook exists to REJECT — they appear in the hook, in its tests, and
//      in the contract that documents the rule. Blocking them would make the leak guard fire on
//      the anti-attribution machinery forever, which is the fastest way to teach someone to stop
//      reading its output.
//   2. RFC 2606 reserved documentation domains. `example.com` exists precisely so that examples
//      and fixtures can carry an address that is guaranteed to belong to nobody.
const NON_PERSONAL_EMAIL = /^(?:no-?reply|donotreply|noreply)@|@(?:example\.(?:com|org|net)|test|invalid|localhost)$/i;

function readIfPresent(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null;
    throw err;
  }
}

// Minimal frontmatter reader. Deliberately not a YAML dependency: this runs in a git hook on
// every commit, so it must start fast and never fail on a malformed brain file.
function frontmatterValue(text, key) {
  if (!text || !text.startsWith('---')) return null;
  const end = text.indexOf('\n---', 3);
  if (end === -1) return null;
  const block = text.slice(3, end);
  const m = block.match(new RegExp(`^\\s*${key}\\s*:\\s*(.+)$`, 'mi'));
  if (!m) return null;
  return m[1].trim().replace(/^["']|["']$/g, '') || null;
}

/**
 * Is `dir` a Mavis brain?
 *
 * This matters more than it looks. The commit-msg hook is wired through GLOBAL `core.hooksPath`,
 * so a sibling pre-commit hook fires in EVERY repo on the machine. A guard that scanned the
 * user's client repositories for the user's own client names would be worse than useless -- it
 * would fire constantly, on the one place those names legitimately belong, and get switched off
 * within a day. So the hook no-ops immediately unless the repo it is running in is a brain.
 */
export function isBrainRoot(dir) {
  const hasContract = fs.existsSync(path.join(dir, 'AGENTS.md')) || fs.existsSync(path.join(dir, 'CLAUDE.md'));
  const hasBrainShape =
    fs.existsSync(path.join(dir, 'SETUP.md')) ||
    fs.existsSync(path.join(dir, 'seeds')) ||
    fs.existsSync(path.join(dir, 'identity'));
  return hasContract && hasBrainShape;
}

/**
 * Read the user's private term list.
 *
 * `.mavis-private` is gitignored and holds what the brain cannot infer: client names that never
 * became a project directory, live discount codes, internal hostnames -- plus the `allow` list
 * that silences a derived term which is also an ordinary word.
 *
 * Format is deliberately trivial (no YAML, no JSON) so it can be edited in a hurry when the guard
 * blocks a commit:
 *
 *   # comments and blank lines ignored
 *   deny: acme-corp
 *   deny: LAUNCH25
 *   allow: team
 *   allowpath: LICENSE
 *
 * `allowpath` exempts a whole file. It exists because some files legitimately CONTAIN a derived
 * term: LICENSE must name the copyright holder, and .gitignore describes the very directories the
 * terms come from. Without a path-level exemption those fire on every commit forever, which is
 * precisely how a guard trains its owner to reach for --no-verify by reflex.
 */
export function loadPrivateConfig(brainRoot) {
  const text = readIfPresent(path.join(brainRoot, '.mavis-private'));
  const deny = [];
  const allow = [];
  const allowPaths = [];
  if (!text) return { deny, allow, allowPaths };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(deny|allow|allowpath)\s*:\s*(.+)$/i);
    if (!m) continue;
    const kind = m[1].toLowerCase();
    const value = m[2].trim();
    if (kind === 'deny') deny.push(value);
    else if (kind === 'allow') allow.push(value);
    else allowPaths.push(value);
  }
  return { deny, allow, allowPaths };
}

/**
 * Is this repo-relative path exempt?
 *
 * Matching is deliberately simple -- exact match, directory prefix, or a trailing `*` glob. A full
 * glob engine would be a dependency in a git hook for no real gain, and the failure mode of a
 * too-clever matcher (silently exempting more than intended) is worse here than the failure mode
 * of a dumb one.
 */
export function pathAllowed(relPath, allowPaths) {
  const p = String(relPath).split('\\').join('/');
  return allowPaths.some((raw) => {
    const a = String(raw).split('\\').join('/').replace(/^\.\//, '');
    if (a.endsWith('*')) return p.startsWith(a.slice(0, -1));
    if (a.endsWith('/')) return p.startsWith(a);
    return p === a || p.startsWith(a + '/');
  });
}

/**
 * Derive every identifier that is personal to this machine, from the brain itself.
 *
 * Returns { terms, allow, realUsernames } where each term is { term, source } and `source`
 * explains WHY it is considered personal. Surfacing the source is not decoration: when the guard
 * blocks a commit over an ordinary word like `team`, "project slug" tells the user in one glance
 * whether to fix the file or to allow the term, which is the difference between a guard that gets
 * tuned and a guard that gets deleted.
 */
export function deriveIdentifiers(brainRoot, opts = {}) {
  const seen = new Map(); // lowercased term -> { term, source }
  const add = (term, source) => {
    if (!term) return;
    const t = String(term).trim();
    if (t.length < MIN_TERM_LENGTH) return;
    const key = t.toLowerCase();
    if (!seen.has(key)) seen.set(key, { term: t, source });
  };

  // 1. Project slugs and display names. `projects/` is gitignored, so its directory listing is
  //    exactly the set of things this user works on that must not appear in shipped code.
  const projectsDir = path.join(brainRoot, 'projects');
  let entries = [];
  try {
    entries = fs.readdirSync(projectsDir, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch {
    entries = []; // no brain yet -- generic patterns still apply
  }
  for (const e of entries) {
    add(e.name, 'project slug');
    // The display name often differs from the slug in exactly the way that matters: a directory
    // called `acmeportal` whose product is named `AcmePortal` -- or something else entirely --
    // and it is the product name that ends up in a worked example or a test fixture. A slug-only
    // sweep would walk straight past it.
    const idx = readIfPresent(path.join(projectsDir, e.name, 'index.md'));
    const name = frontmatterValue(idx, 'name');
    if (name && name.toLowerCase() !== e.name.toLowerCase()) add(name, `project name (${e.name})`);
  }

  // 2. The user's own name, from the file the contract treats as source-of-truth.
  const profile = readIfPresent(path.join(brainRoot, 'identity', 'profile.md'));
  add(frontmatterValue(profile, 'name'), 'identity/profile.md name');

  // 3. Git identity. Injected by the caller rather than shelling out, so this stays fast and
  //    testable; the CLI passes real values from `git config`.
  add(opts.gitUserName, 'git config user.name');
  add(opts.gitUserEmail, 'git config user.email');

  // 4. Machine identity.
  let username = null;
  try {
    username = os.userInfo().username;
  } catch {
    username = null;
  }
  add(username, 'OS username');
  const home = opts.homedir || os.homedir();
  if (home) add(path.basename(home), 'home directory name');

  // 5. Anything the user listed by hand. No MIN_TERM_LENGTH floor here -- an explicit `deny:` is
  //    a deliberate statement, so a 3-character client code is honoured. This is also the escape
  //    hatch for a client that never became a project directory, and for the sub-MIN_TERM_LENGTH
  //    slugs the derivation deliberately skips.
  const { deny, allow, allowPaths } = loadPrivateConfig(brainRoot);
  for (const d of deny) {
    const key = d.toLowerCase();
    if (!seen.has(key)) seen.set(key, { term: d, source: '.mavis-private deny' });
  }

  const allowSet = new Set(allow.map((a) => a.toLowerCase()));
  const terms = [...seen.values()].filter((t) => !allowSet.has(t.term.toLowerCase()));

  // Longest first, so a report attributes a hit to the most specific term that matched.
  terms.sort((a, b) => b.term.length - a.term.length);

  return {
    terms,
    allow: allowSet,
    allowPaths,
    realUsernames: new Set([username, home && path.basename(home)].filter(Boolean).map((s) => s.toLowerCase())),
  };
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Word-ish boundaries. Plain \b fails on the shapes that actually occur here: a slug inside
// `projects/<slug>/index.md` is delimited by slashes, and a ticket id like `PROJ-4` by a hyphen.
// Anything that is not a letter, digit or underscore counts as a boundary, so a slug like `team`
// does not fire inside `teamwork` but does fire in `team-app`, `team/`, and `"team"`.
function termRegex(term) {
  return new RegExp(`(^|[^A-Za-z0-9_])(${escapeRe(term)})(?=[^A-Za-z0-9_]|$)`, 'gi');
}

/**
 * Scan text for personal identifiers and generic patterns.
 *
 * Returns [{ line, term, source, kind, severity, excerpt }]. `severity` is 'block' or 'advisory'.
 * A home-path pattern is only blocking when the captured username is actually this user's -- the
 * repo legitimately documents path handling and ships deliberately-fake Windows fixtures, and
 * flagging those every time is how a guard earns itself a `--no-verify` habit.
 */
export function scanText(text, identifiers, opts = {}) {
  const findings = [];
  if (!text) return findings;
  const lines = text.split(/\r?\n/);
  const skipRe = opts.skipLineRe || /leak-guard-allow/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // An inline `leak-guard-allow` escape, for the case where a term genuinely belongs on that
    // line -- documentation OF the guard, mainly. Deliberately per-line and visible in review.
    if (skipRe.test(line)) continue;

    for (const { term, source } of identifiers.terms) {
      const re = termRegex(term);
      let m;
      while ((m = re.exec(line)) !== null) {
        findings.push({
          line: i + 1,
          term,
          source,
          kind: 'derived',
          severity: 'block',
          excerpt: line.trim().slice(0, 160),
        });
        break; // one finding per term per line is enough to act on
      }
    }

    for (const p of GENERIC_PATTERNS) {
      const re = new RegExp(p.re.source, p.re.flags);
      let m;
      while ((m = re.exec(line)) !== null) {
        // An address that cannot belong to a person is not a finding. See NON_PERSONAL_EMAIL.
        if (p.kind === 'email' && NON_PERSONAL_EMAIL.test(m[0])) continue;
        let severity = ADVISORY_KINDS.has(p.kind) ? 'advisory' : 'block';
        // A home path naming THIS user is not advisory -- that is the C:\Users\<you> class.
        if (ADVISORY_KINDS.has(p.kind) && m[1] && identifiers.realUsernames.has(String(m[1]).toLowerCase())) {
          severity = 'block';
        }
        findings.push({
          line: i + 1,
          term: p.label,
          source: `generic pattern (${p.kind})`,
          kind: p.kind,
          severity,
          excerpt: line.trim().slice(0, 160),
        });
        break;
      }
    }
  }
  return findings;
}

/**
 * Pull printable strings out of a binary and scan those.
 *
 * The motivating case: a tracked `__pycache__/*.pyc` embedded
 * `C:\Users\<user>\...\cutout.py` in its bytecode. Nothing text-based would ever have seen it.
 * Both ASCII and UTF-16LE runs are extracted, since Windows toolchains emit the latter.
 */
export function scanBinary(buf, identifiers) {
  if (!buf || buf.length === 0) return [];
  if (buf.length > MAX_BINARY_SCAN_BYTES) return [];

  const runs = [];
  let cur = [];
  const flush = () => {
    if (cur.length >= 4) runs.push(Buffer.from(cur).toString('latin1'));
    cur = [];
  };
  for (const byte of buf) {
    if (byte >= 0x20 && byte <= 0x7e) cur.push(byte);
    else flush();
  }
  flush();

  // UTF-16LE: printable ASCII interleaved with NUL.
  let wide = [];
  const flushWide = () => {
    if (wide.length >= 4) runs.push(Buffer.from(wide).toString('latin1'));
    wide = [];
  };
  for (let i = 0; i + 1 < buf.length; i += 2) {
    const lo = buf[i];
    const hi = buf[i + 1];
    if (hi === 0 && lo >= 0x20 && lo <= 0x7e) wide.push(lo);
    else flushWide();
  }
  flushWide();

  // Line numbers are meaningless in a binary, so every finding reports as line 0 and the caller
  // renders it as "(binary)".
  return scanText(runs.join('\n'), identifiers).map((f) => ({ ...f, line: 0, binary: true }));
}

/** Heuristic: does this buffer look binary? A NUL byte in the first 8KB is the usual test. */
export function looksBinary(buf) {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/**
 * Scan one file, choosing the text or binary path automatically.
 * `content` may be passed directly (the pre-commit hook reads staged blobs, not the working tree).
 */
export function scanFile(filePath, identifiers, content = null) {
  if (identifiers.allowPaths && pathAllowed(filePath, identifiers.allowPaths)) return [];
  let buf;
  if (content !== null) {
    buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
  } else {
    try {
      buf = fs.readFileSync(filePath);
    } catch {
      return [];
    }
  }
  const findings = looksBinary(buf) ? scanBinary(buf, identifiers) : scanText(buf.toString('utf8'), identifiers);
  return findings.map((f) => ({ ...f, file: filePath }));
}
