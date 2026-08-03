// Detector core for the Mavis brain. Zero deps, read-only (never writes).
// See spec: docs/superpowers/specs/2026-07-17-brain-maintenance-reforms-design.md
//
// Flag shape (frozen):
//   { type: 'size'|'dangling-link'|'anchor'|'ref-rule'|'index-line'|'contract-sync'
//           |'checkpoint-bullet',
//     severity: 'warn'|'fail', file, detail, suggestedAction }
// `file` is always root-relative with forward slashes.
import fs from 'node:fs';
import path from 'node:path';
import { renderClaude } from './contract-sync-core.mjs';

export const BUDGETS = {
  boot: { warnKB: 32, failKB: 64 },
  index: { warnKB: 200, failKB: 256 },
  progress: { warnKB: 48, failKB: 96 },
  notes: { warnKB: 48, failKB: 96 },
};

export function classify(rel) {
  const r = rel.replace(/\\/g, '/');
  if (r === 'CLAUDE.md' || r === 'AGENTS.md' || r === 'rules/_index.md')
    return { cls: 'boot', ...BUDGETS.boot, action: 'trim (manual)' };
  if (r === 'topics/_index.md' || r === 'preferences/_index.md')
    return { cls: 'index', ...BUDGETS.index, action: 'shard per entry-lifecycle (manual)' };
  let m = r.match(/^projects\/([^/]+)\/progress\.md$/);
  if (m) return { cls: 'progress', ...BUDGETS.progress, action: `rotate ${m[1]}` };
  m = r.match(/^projects\/([^/]+)\/notes\.md$/);
  if (m) return { cls: 'notes', ...BUDGETS.notes, action: `shard-notes ${m[1]}` };
  return null;
}

export function walkMd(root, dirs) {
  const out = [];
  const seen = new Set();
  const visit = (abs) => {
    let entries;
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(abs, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) { if (!seen.has(p)) { seen.add(p); visit(p); } }
      else if (e.name.endsWith('.md')) out.push(p);
    }
  };
  for (const d of dirs) visit(path.join(root, d));
  return out;
}

// Module-level on purpose: later checks (links, ref-rules) all use it.
const rel = (root, abs) => path.relative(root, abs).replace(/\\/g, '/');

// A UTF-8 BOM survives readFileSync('utf8') and sits between ^ and the first '#', which makes
// the file's first heading unmatchable and silently drops it from the anchor set. No brain file
// carries one today, but Windows tooling (PowerShell 5.1 Out-File) still emits them and the
// watcher lints files written by any editor - so strip it once, at every read point.
const readMd = (p) => {
  const s = fs.readFileSync(p, 'utf8');
  return s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s;
};

// True only when `p` resolves to something strictly inside `root`.
const within = (root, p) => {
  const r = path.relative(path.resolve(root), p);
  return r !== '' && r !== '..' && !r.startsWith(`..${path.sep}`) && !path.isAbsolute(r);
};

export function checkSizes(root) {
  const flags = [];
  const candidates = [
    path.join(root, 'CLAUDE.md'),
    path.join(root, 'AGENTS.md'),
    path.join(root, 'rules', '_index.md'),
    path.join(root, 'topics', '_index.md'),
    path.join(root, 'preferences', '_index.md'),
    ...walkMd(root, ['projects']),
  ];
  for (const abs of candidates) {
    if (!fs.existsSync(abs)) continue;
    const c = classify(rel(root, abs));
    if (!c) continue;
    const kb = fs.statSync(abs).size / 1024; // bytes on disk, not string length
    if (kb <= c.warnKB) continue;
    flags.push({
      type: 'size',
      severity: kb > c.failKB ? 'fail' : 'warn',
      file: rel(root, abs),
      detail: `${kb.toFixed(1)}KB (warn ${c.warnKB}KB / fail ${c.failKB}KB, class ${c.cls})`,
      suggestedAction: c.action,
    });
  }
  return flags;
}

const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})/;
const CODE_SPAN_RE = /(`+)[^`]*?\1/g;

// Yields only the lines a renderer actually renders, skipping fenced code blocks.
// Content inside a fence renders literally - it is an illustrative template, not the real
// thing: `[<name>](../projects/<name>/index.md)` is not a link that can dangle, and the
// `# YYYY-MM-DD` skeleton in rules/_details/daily-memory-format.md is not a heading that
// produces an anchor. extractLinks and headingSlugs share this so the two stay symmetric.
function* renderedLines(content) {
  const lines = content.split('\n');
  let fence = null; // the marker char run that opened the current fence, or null
  for (let i = 0; i < lines.length; i++) {
    const fenceHit = lines[i].match(FENCE_RE);
    if (fence) {
      if (fenceHit && fenceHit[1][0] === fence[0] && fenceHit[1].length >= fence.length) fence = null;
      continue;
    }
    if (fenceHit) { fence = fenceHit[1]; continue; }
    // Drop the CRLF carriage return here, at the one place lines are split. Consumers match
    // per line with an unanchored-by-/m regex, where '$' will not match before a '\r' (and
    // '.' never consumes one), so a stray CR would silently break every heading on a CRLF file.
    yield { text: lines[i].replace(/\r$/, ''), n: i + 1 };
  }
}

export function extractLinks(content) {
  const out = [];
  const re = /\]\(([^)\s]+)\)/g;
  for (const { text, n } of renderedLines(content)) {
    // Inline code spans render literally too, for the same reason as fences.
    const line = text.replace(CODE_SPAN_RE, '');
    re.lastIndex = 0; // defensive: a `continue` must not carry lastIndex to the next line
    let m;
    while ((m = re.exec(line))) {
      const raw = m[1];
      if (/^(https?:|mailto:|#|\/|[A-Za-z]:)/.test(raw)) continue;
      const [target, anchor] = raw.split('#');
      if (!target.endsWith('.md')) continue;
      out.push({ target, anchor: anchor || null, line: n });
    }
  }
  return out;
}

export function slugifyHeading(text) {
  return text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // markdown link -> its text
    // Backticks and asterisks are code/emphasis markers and are gone by the time GitHub
    // slugs the rendered text. '_' is NOT: it is absent from github-slugger's punctuation
    // class, and intraword '_' does not even open emphasis in CommonMark, so `## foo_bar`
    // anchors as #foo_bar. Stripping it false-flagged 108 identifier-style headings in this
    // brain (NEXT_DIST_DIR, RESERVED_HANDLES, `period_count`).
    .replace(/[`*]/g, '')
    .trim() // also strips the trailing \r on CRLF files
    .toLowerCase()
    // Unicode-aware: \w is ASCII-only, so it ate the accent in 'Café notes' -> 'caf-notes'.
    // GitHub keeps letters/digits of any script and drops punctuation/symbols (— → ≤ emoji).
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-'); // EACH space -> dash (GitHub style; runs produce -- deliberately)
}

// [ \t]+ rather than \s+, and matched per rendered line: a bare '##' line must not let the
// separator swallow the line break and capture the NEXT line as the heading text.
const HEADING_RE = /^#{1,6}[ \t]+(.+)$/;

export function headingSlugs(content) {
  const slugs = new Set();
  for (const { text } of renderedLines(content)) {
    const m = text.match(HEADING_RE);
    if (m) slugs.add(slugifyHeading(m[1]));
  }
  return slugs;
}

const LINK_SCAN_DIRS = ['topics', 'preferences', 'rules', 'projects', 'daily-memories'];

export function checkLinks(root) {
  const flags = [];
  const headingCache = new Map(); // abs target -> Set of slugs
  for (const abs of walkMd(root, LINK_SCAN_DIRS)) {
    const content = readMd(abs);
    for (const { target, anchor, line } of extractLinks(content)) {
      const targetAbs = path.resolve(path.dirname(abs), target);
      // Containment BEFORE any fs call. A link target is the one untrusted input here
      // (daily-memories/ and notes.md carry pasted third-party text). Two escapes, one
      // check: '\\host\share\x.md' matches none of extractLinks' remote/absolute
      // alternatives and would block ~21s on an outbound SMB connect that hands over an
      // NTLMv2 challenge/response; '../../../x.md#a' would read files outside the brain
      // and use flag presence as an oracle for their headings.
      if (!within(root, targetAbs)) {
        flags.push({
          type: 'dangling-link', severity: 'fail', file: rel(root, abs),
          detail: `line ${line}: ${target} escapes brain root`,
          suggestedAction: 'repoint inside the brain (manual)',
        });
        continue;
      }
      if (!fs.existsSync(targetAbs)) {
        flags.push({
          type: 'dangling-link', severity: 'fail', file: rel(root, abs),
          detail: `line ${line}: ${target} does not exist`,
          suggestedAction: 'repoint or restore target (manual)',
        });
        continue;
      }
      if (!anchor) continue;
      if (!headingCache.has(targetAbs)) {
        headingCache.set(targetAbs, headingSlugs(readMd(targetAbs)));
      }
      if (!headingCache.get(targetAbs).has(anchor)) {
        flags.push({
          type: 'anchor', severity: 'warn', file: rel(root, abs),
          detail: `line ${line}: ${target}#${anchor} — no matching heading`,
          suggestedAction: 'fix anchor (manual)',
        });
      }
    }
  }
  return flags;
}

// Contract rule: topics/preferences _details may Ref durable targets only.
// progress.md, progress-archive/ and standups/ rotate, so refs into them go stale (spec 3.1.3).
// Deliberately requires a CONCRETE path (projects/<slug>/... or standups/<file>.md) so that
// prose meta-descriptions ("the paired write goes to progress.md", "standups/<date>.md") pass.
const ROTATING_REF_RE =
  /(?:projects\/[a-z0-9._-]+\/(?:progress\.md|progress-archive\/)|(?:^|[^\w-])standups\/[a-z0-9._-]+\.md)/i;

export function checkRefRules(root) {
  const flags = [];
  for (const abs of walkMd(root, ['topics/_details', 'preferences/_details'])) {
    const lines = readMd(abs).split(/\r?\n/);
    lines.forEach((l, i) => {
      if (!ROTATING_REF_RE.test(l)) return;
      flags.push({
        type: 'ref-rule', severity: 'fail', file: rel(root, abs),
        detail: `line ${i + 1}: refs rotating file (${l.trim().slice(0, 80)}...)`,
        suggestedAction: 'repoint to the daily memory for that date',
      });
    });
  }
  return flags;
}

// Mirrors scripts/lint-index.mjs exactly. Severity is uniformly 'warn' here (plan/spec), whereas
// lint-index.mjs splits these into ERROR/WARN for its own exit code.
//
// The rules TIGHTENED when the `Now:` clause moved out of this file and into each project's own
// index.md under `## Now`. Before that split a project line carried identity AND state, so these
// checks could only catch *excess* state — a SECOND date, a bold milestone, a 600-char paragraph.
// The router is identity-only now, which makes the checks categorical rather than heuristic: ANY
// date is state that has crept back in.
//
// Worth enforcing mechanically because this file is read at every session boot and re-sent every
// turn, so state creeping back is not untidiness, it is a permanent per-turn tax. The old `Now:`
// clauses cost ~2,100 tokens a turn to describe 40 projects in order to answer about one.
const PROJECT_LINE_RE = /^- \[[^\]]+\]\([^)]*index\.md\)/;
const DATE_RE = /\d{4}-\d{2}-\d{2}/g;
// Measured after the split across 44 lines: min 64, median 228, p90 331, max 341. 400 clears
// every real line with headroom and catches one that has started growing a status report.
const MAX_LINE_LEN = 400;

export function checkProjectsIndex(root) {
  const flags = [];
  const abs = path.join(root, 'projects', '_index.md');
  if (!fs.existsSync(abs)) return flags;
  const lines = readMd(abs).split(/\r?\n/);
  lines.forEach((l, i) => {
    if (!PROJECT_LINE_RE.test(l)) return;
    const problems = [];
    // ANY date means per-project state has crept back into the router. It belongs in that
    // project's own index.md under `## Now`, which loads only when the project is named.
    const dates = new Set(l.match(DATE_RE) ?? []);
    if (dates.size) problems.push(`${dates.size} date(s) [${[...dates].join(', ')}] - state belongs in projects/<slug>/index.md ## Now`);
    if (/\*\*/.test(l)) problems.push('bold');
    if (l.length > MAX_LINE_LEN) problems.push(`${l.length} chars (max ${MAX_LINE_LEN})`);
    if (!problems.length) return;
    flags.push({
      type: 'index-line', severity: 'warn', file: 'projects/_index.md',
      detail: `line ${i + 1}: ${problems.join(', ')}`,
      suggestedAction: 'identity only - move state to projects/<slug>/index.md ## Now',
    });
  });
  return flags;
}

// projects/<name>/progress.md is specified as "concise bullets only - a line or two each",
// with an explicit "never let a checkpoint bullet grow into a paragraph-length narrative".
// That rule had no mechanical backing and drifted; this is the backing.
//
// Only the NEWEST block is checked. Older blocks are settled history that rotates out, so
// flagging them would bury the one bullet somebody can still fix under a wall of ones they
// cannot. The newest block is exactly what the last paired write produced.
//
// 400 is ~4 lines at this brain's wrap width. Measured across the newest block of every
// project (443 bullets): median 179, p75 262, p90 378, p95 473, max 1145. So 400 clears a
// normal two-or-three-line bullet and catches only genuine paragraphs - 9% of current
// bullets, which is a burn-down-lazily-on-touch volume rather than a wall.
const MAX_BULLET_LEN = 400;
const BULLET_RE = /^[ \t]*[-*][ \t]+\S/;
const CHECKPOINT_RE = /^## /;
// FENCE_RE is the module-level one declared above for the link checker - reused deliberately
// rather than redeclared, so fence handling cannot drift between the two checks.

export function checkCheckpointBullets(root) {
  const flags = [];
  let entries;
  try {
    entries = fs.readdirSync(path.join(root, 'projects'), { withFileTypes: true });
  } catch {
    return flags; // no projects/ (fresh clone) - same silence as every other check
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const abs = path.join(root, 'projects', e.name, 'progress.md');
    let lines;
    try {
      lines = readMd(abs).split(/\r?\n/);
    } catch {
      continue; // project has no progress.md yet
    }
    // A '## ' inside a fenced block is text, not structure. Treating it as a heading would
    // end the newest block early and silently skip every bullet after it.
    const structural = [];
    let fenced = false;
    for (const l of lines) {
      if (FENCE_RE.test(l)) fenced = !fenced;
      structural.push(!fenced);
    }
    const start = lines.findIndex((l, i) => structural[i] && CHECKPOINT_RE.test(l));
    if (start === -1) continue;
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      if (structural[i] && CHECKPOINT_RE.test(lines[i])) { end = i; break; }
    }
    for (let i = start + 1; i < end; i++) {
      if (!structural[i] || !BULLET_RE.test(lines[i])) continue;
      // Join wrapped continuation lines. A bullet measured by its first line alone would let
      // any paragraph through unflagged just by pressing Enter.
      let text = lines[i].trim();
      let j = i + 1;
      while (
        j < end && structural[j] && lines[j].trim() !== '' &&
        !BULLET_RE.test(lines[j]) && !CHECKPOINT_RE.test(lines[j])
      ) {
        text += ` ${lines[j].trim()}`;
        j++;
      }
      if (text.length > MAX_BULLET_LEN) {
        flags.push({
          type: 'checkpoint-bullet', severity: 'warn', file: rel(root, abs),
          detail: `line ${i + 1}: ${text.length} chars (max ${MAX_BULLET_LEN})`,
          suggestedAction: 'move the narrative to the daily memory; the checkpoint names what shipped',
        });
      }
      i = j - 1;
    }
  }
  return flags;
}

// CLAUDE.md is generated from the canonical AGENTS.md. Drift means one harness is reading a
// different contract from the other - silent, and exactly the failure the generated-twin
// design exists to prevent. Absent AGENTS.md = legacy brain, stay silent.
export function checkContractSync(root) {
  const srcPath = path.join(root, 'AGENTS.md');
  if (!fs.existsSync(srcPath)) return [];
  const flag = (detail) => [{
    type: 'contract-sync',
    severity: 'fail',
    file: 'CLAUDE.md',
    detail,
    suggestedAction: 'node scripts/sync-contract.mjs --write',
  }];
  // Read and render are separate try/catches on purpose: an fs error (permissions, AGENTS.md
  // replaced by a directory) is not a syntax problem, and reporting it as "malformed" sends
  // the reader hunting for a marker/fence defect that does not exist.
  let source;
  try {
    source = fs.readFileSync(srcPath, 'utf8');
  } catch (e) {
    return flag(`AGENTS.md could not be read: ${e.message}`);
  }
  let rendered;
  try {
    rendered = renderClaude(source);
  } catch (e) {
    return flag(`AGENTS.md is malformed: ${e.message}`);
  }
  let current;
  try {
    current = fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8');
  } catch {
    return flag('CLAUDE.md is missing; regenerate it from AGENTS.md');
  }
  // Compare with line endings normalized. renderClaude always emits LF, but Git for Windows
  // ships core.autocrlf=true as a SYSTEM default, so a plain `git checkout` rewrites the
  // working-copy CLAUDE.md to CRLF -- after which a byte comparison reports permanent drift on
  // a contract that is character-for-character correct. That phantom FAIL is worse than useless:
  // it trains the reader to ignore the one check that guards the generated contract, and
  // `sync-contract.mjs --write` does not clear it (the next checkout converts the file straight
  // back). .gitattributes pins the endings so this should not arise; this is the belt to that
  // pair of braces, and it costs nothing -- an EOL difference is not contract drift under any
  // reading, on any platform.
  const eol = (s) => s.replace(/\r\n/g, '\n');
  if (eol(current) !== eol(rendered)) return flag('CLAUDE.md has drifted from AGENTS.md');
  return [];
}

export function lint(root) {
  // Fail closed. Every check below independently degrades to silence on a wrong root
  // (walkMd swallows readdir errors, checkSizes skips missing candidates, the rest return
  // []), so composed they render a confident "brain clean" instead of an error - the exact
  // inversion of what a rot detector must do. Assert the root IS a brain first.
  //
  // Neither contract file is accepted bare, and deliberately symmetric: CLAUDE.md and
  // AGENTS.md are both cross-tool conventions (Claude Code / Codex and others) that show up
  // in repos with zero relation to this brain, so treating either one's mere presence as
  // proof of a brain root would let an arbitrary directory pass here and then fail
  // downstream with a confusing contract-sync flag instead of a clear rejection. Giving one
  // name a corroboration requirement and not the other has no principled basis and just
  // hands the next reader a rule to reverse-engineer.
  // projects/ (and identity/, rules/, topics/, preferences/) are gitignored, so a fresh
  // clone before setup has none of them - what it DOES ship is a contract file (CLAUDE.md
  // and/or AGENTS.md) alongside SETUP.md, the brain's own committed bootstrap file that a
  // generic contract-file-only repo will not have. A pre-rename (legacy) brain has CLAUDE.md
  // + SETUP.md with no AGENTS.md yet and must still lint - SETUP.md's own Recalibrate offer
  // depends on being able to run against exactly that shape.
  const hasProjects = fs.existsSync(path.join(root, 'projects'));
  const hasSetup = fs.existsSync(path.join(root, 'SETUP.md'));
  const hasContract =
    fs.existsSync(path.join(root, 'CLAUDE.md')) || fs.existsSync(path.join(root, 'AGENTS.md'));
  if (!hasProjects && !(hasContract && hasSetup))
    throw new Error(
      `not a brain root: ${root} (no projects/, and no contract file (CLAUDE.md/AGENTS.md) + SETUP.md found)`,
    );
  const flags = [
    ...checkSizes(root),
    ...checkLinks(root),
    ...checkRefRules(root),
    ...checkProjectsIndex(root),
    ...checkCheckpointBullets(root),
    ...checkContractSync(root),
  ];
  const counts = {
    fail: flags.filter(f => f.severity === 'fail').length,
    warn: flags.filter(f => f.severity === 'warn').length,
  };
  return { generatedAt: new Date().toISOString(), root: root.replace(/\\/g, '/'), counts, flags };
}
