// Pure helpers for installing Mavis into a harness home. Zero deps, no I/O except the
// injectable PATH probe.
import { execFileSync } from 'node:child_process';
import path from 'node:path';

export const BEGIN = '<!-- mavis:begin -->';
export const END = '<!-- mavis:end -->';

const norm = (text) => String(text == null ? '' : text).replace(/\r\n?/g, '\n');

// MARKERS ARE LINE-ANCHORED. A marker is a line whose TRIMMED content is exactly the marker
// string; anything else - the same string quoted mid-sentence in the user's own prose, in a
// code span, or in a doc that explains this installer - is ordinary content and must never be
// treated as a delimiter.
//
// This is not a refinement, it is a data-loss fix. Substring matching deleted user content in
// two reproduced ways: a stray BEGIN mentioned in prose ABOVE the real block made slice(0, i)
// truncate at the mention, so everything from there to the end of the block vanished; and two
// real blocks in one file collapsed into one, deleting whatever sat between them. The trigger
// was live rather than theoretical - when the installer refuses a file that already holds an
// unmarked contract, its own message tells the user to type these exact marker strings into
// that exact file by hand.
//
// The splicer only ever WRITES markers on their own line (see `block` below), so line
// anchoring loses nothing it needs to find, and it removes the need for the old lastIndexOf
// heuristic entirely: an inline mention is no longer a candidate at all.
function findMarkerLines(src) {
  const begins = [];
  const ends = [];
  const lines = src.split('\n');
  let offset = 0;
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n];
    const trimmed = line.trim();
    // start/stop are character offsets of the whole line, so a splice replaces the marker
    // line including any indentation, exactly as it would have with a bare marker.
    if (trimmed === BEGIN) begins.push({ no: n + 1, start: offset, stop: offset + line.length });
    else if (trimmed === END) ends.push({ no: n + 1, start: offset, stop: offset + line.length });
    offset += line.length + 1; // + the '\n' that split consumed
  }
  return { begins, ends };
}

const FIX_BY_HAND =
  ' Fix the file by hand; this installer will not guess which markers are its own.';

// Character offsets of the one real block, or null when the text has no marker lines at all.
// Every ambiguous shape throws with a specific message rather than picking a candidate -
// silently picking one is precisely how the substring version destroyed content.
function locateBlock(src) {
  const { begins, ends } = findMarkerLines(src);
  if (begins.length === 0 && ends.length === 0) return null;
  if (begins.length > 1) {
    throw new Error(
      `malformed mavis markers in target file: ${begins.length} "${BEGIN}" lines ` +
      `(lines ${begins.map(b => b.no).join(', ')}), expected exactly one. Two marker blocks ` +
      `in one file are ambiguous, and merging them would delete whatever sits between them.` +
      FIX_BY_HAND
    );
  }
  if (ends.length > 1) {
    throw new Error(
      `malformed mavis markers in target file: ${ends.length} "${END}" lines ` +
      `(lines ${ends.map(e => e.no).join(', ')}), expected exactly one.` + FIX_BY_HAND
    );
  }
  if (begins.length === 0) {
    throw new Error(
      `malformed mavis markers in target file: an unclosed "${END}" line (line ${ends[0].no}) ` +
      `with no matching "${BEGIN}" line.` + FIX_BY_HAND
    );
  }
  if (ends.length === 0) {
    throw new Error(
      `malformed mavis markers in target file: an unclosed "${BEGIN}" line ` +
      `(line ${begins[0].no}) with no matching "${END}" line.` + FIX_BY_HAND
    );
  }
  if (ends[0].start < begins[0].start) {
    throw new Error(
      `malformed mavis markers in target file: the "${END}" line (line ${ends[0].no}) comes ` +
      `before the "${BEGIN}" line (line ${begins[0].no}), so they enclose nothing.` + FIX_BY_HAND
    );
  }
  return { start: begins[0].start, stop: ends[0].stop };
}

// A payload carrying a whole-line marker would produce a file with two BEGIN lines, which the
// NEXT run can only refuse. Fail now, at the source we control, rather than after the write.
function assertPayloadHasNoMarkerLine(payload) {
  const { begins, ends } = findMarkerLines(payload);
  if (begins.length || ends.length) {
    throw new Error(
      'malformed payload: it contains a mavis marker on a line of its own, which would ' +
      'produce a target file with two marker blocks. Mention the markers inline in prose ' +
      'instead - inline text is never treated as a delimiter.'
    );
  }
}

// Replace the content between the markers, preserving everything outside them. A file with
// no markers gets the block appended. Anything ambiguous throws rather than appending a
// second block or guessing at a pair, which would leave two contracts in one file or delete
// content between them.
export function spliceMarkers(existing, payload) {
  const src = norm(existing);
  const body = norm(payload);
  assertPayloadHasNoMarkerLine(body);
  const block = `${BEGIN}\n${body}\n${END}`;
  const at = locateBlock(src);
  if (!at) {
    const sep = src.length === 0 || src.endsWith('\n\n') ? '' : src.endsWith('\n') ? '\n' : '\n\n';
    return `${src}${sep}${block}\n`;
  }
  return `${src.slice(0, at.start)}${block}${src.slice(at.stop)}`;
}

function pathProbe(bin) {
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const out = execFileSync(cmd, [bin], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const first = out.split(/\r?\n/).map(s => s.trim()).filter(Boolean)[0];
    return first || null;
  } catch {
    return null;
  }
}

export function detectHarnesses(opts = {}) {
  const probe = opts.probe || pathProbe;
  return { claude: Boolean(probe('claude')), codex: Boolean(probe('codex')) };
}

// --- placeholder resolution ---------------------------------------------------------------
// The committed payload is portable: it carries {{USER_NAME}} / {{BRAIN_ROOT}} rather than one
// user's name and machine paths. The brain gitignores identity/ for exactly that reason, and
// this repo is meant to be clonable. Resolution happens at write time, on the payload, before
// splicing - so the committed source is generic and the INSTALLED copy is personal.
//
// An unresolved placeholder must never reach a written file: "{{USER_NAME}}" sitting in
// someone's live global instructions is worse than a failed install, because it reads as
// contract text. So this throws rather than passing anything through.

export const PLACEHOLDER_RE = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

export function resolvePlaceholders(text, values = {}) {
  const src = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
  const missing = new Set();
  const out = src.replace(PLACEHOLDER_RE, (whole, key) => {
    const v = values[key];
    if (v == null || String(v).trim() === '') {
      missing.add(key);
      return whole;
    }
    return String(v);
  });
  if (missing.size) {
    throw new Error(
      `unresolved placeholder(s): ${[...missing].map(k => `{{${k}}}`).join(', ')}`
    );
  }
  // Belt and braces: catch anything brace-shaped the regex above would not have matched
  // (a typo like {{ USER-NAME }}, or a value that itself contained a placeholder).
  const leftover = out.match(/\{\{[^{}]*\}\}/g);
  if (leftover) {
    throw new Error(
      `unresolved placeholder(s) left in payload: ${[...new Set(leftover)].join(', ')}`
    );
  }
  // Both sweeps above need a BALANCED pair, so a half-open placeholder - one mistyped brace
  // while editing mavis/global-invariants.md - passed straight through and landed verbatim in
  // the user's live operating contract. Nothing legitimate in these payloads doubles a brace,
  // so any surviving "{{" or "}}" is a typo and stops the install.
  const dangling = out.match(/^.*(\{\{|\}\}).*$/m);
  if (dangling) {
    throw new Error(
      'unbalanced braces left in payload (a mistyped placeholder): ' +
      `${JSON.stringify(dangling[0].trim().slice(0, 120))}`
    );
  }
  return out;
}

// --- duplicate-contract guard ------------------------------------------------------------
// Splicing into a file that already holds an unmarked copy of the contract APPENDS, leaving
// two copies of the operating contract in one file. That is the silent-wrong-contract failure
// this whole layer exists to prevent, and a printed warning is exactly what a user scrolls
// past. So the installer refuses instead. It never edits the existing text to "adopt" it -
// that would be a silent rewrite of live config.

// Everything outside the marker block. Used so the guard looks only at text the installer
// does NOT own; a block it wrote itself is replaced in place and cannot duplicate.
export function stripMarkerBlock(text) {
  const src = norm(text);
  let at;
  try {
    // Same line-anchored rule as spliceMarkers: an inline mention of a marker is prose, not a
    // delimiter. With substring matching this function had a false NEGATIVE - a marker string
    // quoted below the block swallowed the unmarked contract copy along with the block, and
    // the duplicate guard then reported the file clean.
    at = locateBlock(src);
  } catch {
    // Ambiguous markers: treat the WHOLE file as content the installer does not own. This is
    // the conservative direction for a guard - it can only cause a refusal, never a write.
    // (The CLI splices first, so an ambiguous file has already errored out by this point.)
    return src;
  }
  if (!at) return src;
  return `${src.slice(0, at.start)}${src.slice(at.stop)}`;
}

const HEADING_RE = /^#{1,6}[ \t]+(.+?)[ \t]*$/;

// Markdown headings are the robust overlap signal: whole-file equality misses a copy that has
// drifted by a word, and substring search on prose gives false hits. (Simplification: a "#"
// line inside a fenced code block counts as a heading. Neither side of this comparison has
// one, and a false positive only costs a refusal that explains itself.)
function headingList(text) {
  const out = [];
  for (const line of String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n')) {
    const m = line.match(HEADING_RE);
    if (m) out.push({ raw: line.trim(), key: m[1].replace(/\s+/g, ' ').trim().toLowerCase() });
  }
  return out;
}

// Does the target already carry this contract, unmarked? Refuse when the payload's own title
// appears outside the block, or when two or more of its headings do. One shared heading is
// tolerated so an incidental collision ("## No emojis anywhere" in someone's own notes) does
// not block an install; two is no longer a coincidence.
export function isDuplicateContract(existing, payload) {
  const have = new Set(headingList(stripMarkerBlock(existing)).map(h => h.key));
  const want = headingList(payload);
  const hits = [];
  const seen = new Set();
  for (const h of want) {
    if (have.has(h.key) && !seen.has(h.key)) { seen.add(h.key); hits.push(h.raw); }
  }
  const titleDuplicated = want.length > 0 && have.has(want[0].key);
  return { duplicate: titleDuplicated || hits.length >= 2, headings: hits };
}

// --- target planning -------------------------------------------------------------------
// Everything below is still pure: it maps (harness, homes, source text) to the list of files
// the CLI would touch. The CLI owns all reads, writes and printing.

// Codex prompts carry frontmatter with `description` and `argument-hint`, matching the
// installed opsx-* prompts. The description is lifted from the /mavis source so there is one
// source of truth for it; only the hint is Codex-specific.
export const CODEX_ARGUMENT_HINT = 'optional project name or question';

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?/;

// Split a leading YAML frontmatter block off a markdown file. Returns the raw block text
// (without the fences), the body, and the shallow single-line key/value pairs.
export function parseFrontmatter(text) {
  const src = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
  const m = src.match(FRONTMATTER_RE);
  if (!m) return { raw: null, body: src, fields: {} };
  const fields = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (kv) fields[kv[1]] = kv[2].trim();
  }
  return { raw: m[1], body: src.slice(m[0].length).replace(/^\n+/, ''), fields };
}

// The /mavis body as Codex wants it: its own frontmatter, then the shared body.
export function codexPrompt(slashSource, argumentHint = CODEX_ARGUMENT_HINT) {
  const { body, fields } = parseFrontmatter(slashSource);
  const description = fields.description || 'Load Mavis - long-term memory + project collaborator.';
  return `---\ndescription: ${description}\nargument-hint: ${argumentHint}\n---\n\n${body}`;
}

function posix(p) {
  return p.split(path.sep).join('/');
}

// homes: { claudeHome, codexHome, invariants, slash, outputStyle }
//   claudeHome / codexHome - absolute paths to ~/.claude and ~/.codex
//   invariants             - text of mavis/global-invariants.md (spliced between markers)
//   slash                  - text of mavis/slash-mavis.md (whole-file targets)
//   outputStyle            - text of mavis/output-style-terse.md (whole-file, Claude ONLY:
//                            Codex has no output-style concept, so its branch omits it)
// Each target: { kind, mode, label, path, payload }
//   kind 'global' targets are gated behind --global; 'prompt' targets always install.
//   mode 'splice' preserves non-Mavis content; mode 'whole' replaces the file.
export function targetsFor(harness, homes) {
  const { claudeHome, codexHome, invariants = '', slash = '', outputStyle = '' } = homes || {};
  if (harness === 'claude') {
    if (!claudeHome) throw new Error('targetsFor("claude") needs homes.claudeHome');
    const claudeTargets = [
      {
        kind: 'global',
        mode: 'splice',
        label: '~/.claude/CLAUDE.md',
        path: posix(path.join(claudeHome, 'CLAUDE.md')),
        payload: invariants.replace(/\r\n?/g, '\n').replace(/\n+$/, ''),
      },
      {
        kind: 'prompt',
        mode: 'whole',
        label: '~/.claude/commands/mavis.md',
        path: posix(path.join(claudeHome, 'commands', 'mavis.md')),
        payload: String(slash).replace(/\r\n?/g, '\n'),
      },
    ];
    // Guarded, not unconditional: an empty payload would install a zero-byte output
    // style, which Claude Code loads as a valid-but-empty instruction. That fails
    // silently - the style appears installed and enabled while saying nothing.
    if (outputStyle) {
      claudeTargets.push({
        kind: 'prompt',
        mode: 'whole',
        label: '~/.claude/output-styles/mavis-terse.md',
        path: posix(path.join(claudeHome, 'output-styles', 'mavis-terse.md')),
        payload: String(outputStyle).replace(/\r\n?/g, '\n'),
      });
    }
    return claudeTargets;
  }
  if (harness === 'codex') {
    if (!codexHome) throw new Error('targetsFor("codex") needs homes.codexHome');
    return [
      {
        kind: 'global',
        mode: 'splice',
        label: '~/.codex/AGENTS.md',
        path: posix(path.join(codexHome, 'AGENTS.md')),
        payload: invariants.replace(/\r\n?/g, '\n').replace(/\n+$/, ''),
      },
      {
        kind: 'prompt',
        mode: 'whole',
        label: '~/.codex/prompts/mavis.md',
        path: posix(path.join(codexHome, 'prompts', 'mavis.md')),
        payload: codexPrompt(slash),
      },
    ];
  }
  throw new Error(`unknown harness "${harness}" (expected "claude" or "codex")`);
}
