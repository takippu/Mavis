// Repairer core. Single writer for brain structure changes. Zero deps.
// Personal brain data is GITIGNORED, so there is no `git checkout` to undo a bad
// repair: applyPlan always copies originals to _backup/repair-<timestamp>/ before
// writing, and that backup is the ONLY recovery path.
//
// Every function below is pure except applyPlan (the only thing that writes) and
// the planners (which read). Plans are data: {command, project, summary, writes}.
//
// Two rules keep that backup promise real, because _backup is the ONLY net here:
//   1. applyPlan decides what to back up by stat-ing each target, never by
//      trusting a plan's `before`. A planner cannot cause an unbacked write.
//   2. A write's `before` is the exact pre-image read from disk, so it doubles as
//      an apply-time precondition and as an honest diff for the approval modal.
//      A planner that reports `before: null` for a file that exists both skips the
//      backup and renders a clobber as a green new-file add — never do that.
import fs from 'node:fs';
import path from 'node:path';

// A relative link target that points at a markdown file, i.e. one that has to be
// re-based when the content holding it moves into a deeper directory.
const isRebasable = (target) =>
  !/^(https?:|mailto:|#|\/|[A-Za-z]:)/.test(target) && /\.md(#|$)/.test(target);

// Mirrors brain-lint-core's fence scan. Content inside a fence is literal — a
// pasted format skeleton, not live markdown. CLAUDE.md ships the paired-write
// template as a fenced '## YYYY-MM-DD -> [daily memory](...)', so a fence-blind
// scan would read that line as a real heading and a real link.
const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})/;

/**
 * Walk `src` line by line, tagging which lines sit inside a fenced code block.
 * `offset` is the byte index of the line in `src`; split('\n') drops exactly one
 * byte per line, so the running offset stays exact (a \r stays in `line`).
 * Fence markers themselves are tagged fenced: they are never headings or links.
 */
function scanLines(src) {
  const out = [];
  let fence = null; // the marker run that opened the current fence, or null
  let offset = 0;
  for (const line of src.split('\n')) {
    const hit = line.match(FENCE_RE);
    let fenced = true;
    if (fence) {
      if (hit && hit[1][0] === fence[0] && hit[1].length >= fence.length) fence = null;
    } else if (hit) {
      fence = hit[1];
    } else {
      fenced = false;
    }
    out.push({ line, offset, fenced });
    offset += line.length + 1;
  }
  return out;
}

/** Byte offsets of every `## ` line that is a real heading (i.e. outside a fence). */
export function headingIndices(src) {
  return scanLines(src).filter((l) => !l.fenced && /^## /.test(l.line)).map((l) => l.offset);
}

/**
 * Prepend `levels` x '../' to every relative .md link in `content`.
 * http(s)/mailto/absolute/drive-letter/anchor-only targets and [[wikilinks]] are
 * left alone, as is anything inside a code fence (an illustrative template must
 * stay byte-identical when its file moves). `levels` is how many directories
 * deeper the content is moving: rotation -> progress-archive/ is 1; shard ->
 * notes/_details/ is 2.
 */
export function rewriteRelativeLinks(content, levels = 1) {
  if (levels <= 0) return content;
  const up = '../'.repeat(levels);
  return scanLines(content)
    .map(({ line, fenced }) => (fenced ? line : line.replace(/\]\(([^)\s]+)\)/g,
      (whole, target) => (isRebasable(target) ? `](${up}${target})` : whole))))
    .join('\n');
}

/**
 * Split a progress.md into its header and its `## ` checkpoint blocks.
 * Lossless: header + blocks.map(raw).join('') === src.
 * CRLF-safe: `.` never matches \r in JS, so the date regex stops before it, and
 * boundaries come from headingIndices (which ignores fenced `## ` lines).
 */
export function splitCheckpoints(src) {
  const idx = headingIndices(src);
  if (idx.length === 0) return { header: src, blocks: [] };
  const header = src.slice(0, idx[0]);
  const blocks = idx.map((start, i) => {
    const raw = src.slice(start, idx[i + 1] ?? src.length);
    const dm = raw.match(/^## (\d{4})-(\d{2})-(\d{2})/);
    return { raw, date: dm ? `${dm[1]}-${dm[2]}-${dm[3]}` : null, year: dm ? dm[1] : null };
  });
  return { header, blocks };
}

const FOOTER = '\n---\n\n*Older checkpoints: [progress-archive/](progress-archive/)*\n';
// The footer is script-owned and regenerated below on every rotation, so strip
// EVERY occurrence anywhere rather than one byte-exact copy at EOF. Anchoring to
// $ meant a single trailing blank line (an editor with "insert final newline")
// defeated the strip: the stale footer was absorbed into the last block, a second
// was appended, and once that block aged out the stale one was archived — where
// its progress-archive/ pointer resolves nowhere. Unanchored + /g also heals a
// file that already carries duplicates. Global, but only ever used with .replace,
// which resets lastIndex.
const FOOTER_RE = /\r?\n---\r?\n\s*\*Older checkpoints:[^\n]*/g;

/**
 * Plan a rotation of projects/<project>/progress.md.
 * Checkpoints are newest-first by contract, so the newest `keepMin` always stay
 * hot; past that, blocks move to progress-archive/<year>.md until the hot file
 * fits `targetKB`. Once one dated block moves, every older dated block moves too
 * — keeping the hot file a contiguous newest-N run rather than one with holes.
 * Undated `## ` blocks (e.g. "## Backlog") have no year to file under, so they
 * always stay hot — and, being checkpoint-less, they never count against keepMin.
 */
export function planRotation(root, project, { targetKB = 32, keepMin = 5 } = {}) {
  const relHot = `projects/${project}/progress.md`;
  const abs = path.join(root, relHot);
  const original = fs.readFileSync(abs, 'utf8');
  const src = original.replace(FOOTER_RE, ''); // strip the footer; it is re-added below
  const { header, blocks } = splitCheckpoints(src);

  const kept = [];
  const moved = [];
  let bytes = Buffer.byteLength(header);
  let rotating = false; // set once a dated block has been pushed out
  let datedKept = 0; // keepMin is a floor on CHECKPOINTS; undated blocks must not consume its slots
  for (const b of blocks) {
    const size = Buffer.byteLength(b.raw);
    if (!b.year) { kept.push(b); bytes += size; continue; }
    if (!rotating && (datedKept < keepMin || bytes + size <= targetKB * 1024)) {
      kept.push(b);
      bytes += size;
      datedKept++;
    } else {
      rotating = true;
      moved.push(b);
    }
  }

  const byYear = new Map();
  for (const b of moved) {
    if (!byYear.has(b.year)) byYear.set(b.year, []);
    byYear.get(b.year).push(b);
  }

  // Keep the footer if we are archiving now, or if this project already has an archive.
  const hasArchive = moved.length > 0 || fs.existsSync(path.join(root, 'projects', project, 'progress-archive'));
  const body = header + kept.map((b) => b.raw).join('');
  const hotAfter = hasArchive ? body.replace(/\s*$/, '\n') + FOOTER : body;

  const writes = [{ path: relHot, before: original, after: hotAfter }];
  for (const [year, ys] of byYear) {
    const relArch = `projects/${project}/progress-archive/${year}.md`;
    const absArch = path.join(root, relArch);
    const existing = fs.existsSync(absArch) ? fs.readFileSync(absArch, 'utf8') : null;
    const head = `# ${project} — Progress Archive ${year}\n\n*Rotated out of [progress.md](../progress.md) — newest first.*\n\n`;
    const prev = existing ? splitCheckpoints(existing) : null;
    // The generated head is regenerated, but anything a human put above the first
    // checkpoint is theirs and must survive. Carrying only header-minus-head also
    // rescues the degenerate case of a hand-written archive with no `## ` blocks
    // at all, where header IS the whole file.
    const prevHeader = prev ? prev.header : '';
    const handWritten = prevHeader.startsWith(head) ? prevHeader.slice(head.length) : prevHeader;
    const carried = handWritten.trim() ? `${handWritten.trim()}\n\n` : '';
    const existingBody = prev ? prev.blocks.map((b) => b.raw).join('') : '';
    // moved blocks are newer than anything previously archived -> they go on top
    const after = head + carried + ys.map((b) => rewriteRelativeLinks(b.raw, 1)).join('') + existingBody;
    writes.push({ path: relArch, before: existing, after });
  }

  return {
    command: 'rotate',
    project,
    summary: {
      kept: datedKept, // checkpoints held hot; undated blocks are counted separately
      keptUndated: kept.length - datedKept,
      moved: moved.length,
      hotBytesBefore: Buffer.byteLength(original),
      hotBytesAfter: Buffer.byteLength(hotAfter),
      archives: [...byYear.keys()].map((y) => `progress-archive/${y}.md`),
    },
    writes,
  };
}

/**
 * Check that disk still looks exactly as the plan expects. A plan is previewed
 * (--dry-run --json), rendered in a diff modal, approved, and only then applied,
 * so the bytes that were approved must be the bytes that get overwritten. Any
 * drift — another session's paired write, a hand edit — means the human approved
 * a diff that no longer describes what would happen, so refuse the whole plan.
 */
function verifyPreconditions(root, plan) {
  const drifted = [];
  for (const w of plan.writes) {
    const abs = path.join(root, w.path);
    const exists = fs.existsSync(abs);
    if (w.before === null || w.before === undefined) {
      if (exists) drifted.push(`${w.path}: plan expected to create it, but it exists on disk`);
    } else if (!exists) {
      drifted.push(`${w.path}: plan expected to modify it, but it is gone from disk`);
    } else if (fs.readFileSync(abs, 'utf8') !== w.before) {
      drifted.push(`${w.path}: changed on disk since the plan was previewed`);
    }
  }
  if (drifted.length) {
    throw new Error(
      `disk has drifted from the approved plan — refusing to apply:\n  ${drifted.join('\n  ')}\n` +
      're-preview the change and approve the new diff');
  }
}

/**
 * Execute a plan. Verifies every precondition first, then copies every file that
 * already exists to _backup/repair-<timestamp>/<path> BEFORE the first write, then
 * writes each target atomically (tmp + rename). The backup loop is deliberately
 * separate from and prior to the write loop: if a later write throws, the originals
 * are already safe on disk.
 *
 * What gets backed up is decided by stat-ing each target, NOT by trusting the
 * plan's `before`: brain data is gitignored and _backup is the only safety net, so
 * a planner that mislabels an overwrite as a creation must not be able to produce
 * an unbacked destructive write. `verify` is an internal escape hatch for tests.
 */
export function applyPlan(root, plan, { verify = true } = {}) {
  if (verify) verifyPreconditions(root, plan);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(root, '_backup', `repair-${stamp}`);
  for (const w of plan.writes) {
    const abs = path.join(root, w.path);
    if (!fs.existsSync(abs)) continue;
    const bak = path.join(backupDir, w.path);
    fs.mkdirSync(path.dirname(bak), { recursive: true });
    fs.copyFileSync(abs, bak);
  }
  for (const w of plan.writes) {
    const abs = path.join(root, w.path);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const tmp = `${abs}.tmp`;
    try {
      fs.writeFileSync(tmp, w.after);
      fs.renameSync(tmp, abs);
    } catch (e) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* nothing to clean */ }
      throw e;
    }
  }
  return { backupDir };
}

/**
 * Max slug length. notes.md headings are full sentences, so an uncapped slug
 * produced a 247-char absolute path on a real brain file — against Windows'
 * 260-char MAX_PATH, with applyPlan writing `<path>.tmp` (+4) first. 60 keeps
 * the deepest real path near 160 and the filenames legible. The FULL title is
 * preserved as the `## ` heading in the index, so nothing is lost by truncating.
 */
export const MAX_SLUG = 60;

/**
 * kebab-case a notes.md section title into a slug. Strips markdown link syntax
 * and `code`/*emphasis* markers, then collapses every other run of non-alphanumerics
 * to a single dash — so API_KEY becomes api-key rather than apikey.
 * Truncated at a dash boundary to MAX_SLUG; callers must still dedupe, since
 * truncation can make two distinct titles collide.
 */
export function slugifyTitle(title) {
  const full = title
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*]/g, '')
    .trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (full.length <= MAX_SLUG) return full;
  const cut = full.slice(0, MAX_SLUG);
  const lastDash = cut.lastIndexOf('-');
  // prefer a whole-word cut, but never throw away more than the last word
  return (lastDash > MAX_SLUG * 0.6 ? cut.slice(0, lastDash) : cut).replace(/-+$/, '');
}

/**
 * Split a notes.md into its header and `## ` sections. Lossless in the same sense
 * as splitCheckpoints: header + sections.map(s => s.heading + s.body).join('') === src.
 * CRLF-safe.
 */
export function splitSections(src) {
  const idx = headingIndices(src);
  if (idx.length === 0) return { header: src, sections: [] };
  const header = src.slice(0, idx[0]);
  const sections = idx.map((start, i) => {
    const raw = src.slice(start, idx[i + 1] ?? src.length);
    const title = raw.match(/^## (.*)$/m)[1].trim();
    const heading = raw.match(/^## .*(\r?\n)?/)[0]; // \r?\n so CRLF headings are stripped too
    return { title, heading, body: raw.slice(heading.length), raw };
  });
  return { header, sections };
}

// `**Discovered:** [...]` / `**Resolved:** [...]` are pointer metadata, not prose:
// they are never a useful Summary.
const POINTER_LINE = /^\*\*(Discovered|Resolved):\*\*/;
const STOPWORDS = new Set(['the', 'and', 'for', 'with', 'from', 'into', 'that', 'this', 'was', 'are', 'but', 'not']);

/**
 * Plan the two-tier split of projects/<project>/notes.md: notes.md itself becomes
 * the index (so all inbound refs keep resolving) and each `## ` section's body
 * moves to notes/_details/<slug>.md.
 *
 * Detail files sit TWO directories below notes.md (projects/p/notes/_details/),
 * so their links are rebased by 2 levels, not 1.
 *
 * Triggers/Summary here are scaffolds; Mavis enriches them in the same approved
 * write (trigger-writing is judgment, not mechanics).
 */
export function planShard(root, project) {
  const relIdx = `projects/${project}/notes.md`;
  const src = fs.readFileSync(path.join(root, relIdx), 'utf8');
  if (/^\*\*Detail:\*\*\s*\[notes\/_details\//m.test(src)) {
    throw new Error(`${relIdx} is already sharded (it has **Detail:** entries) — refusing to re-shard`);
  }
  const { header, sections } = splitSections(src);
  const writes = [];
  const used = new Set();
  const entries = [];
  const collisions = [];

  for (const s of sections) {
    const base = slugifyTitle(s.title) || 'untitled';
    let slug = base;
    let n = 2;
    while (used.has(slug)) slug = `${base}-${n++}`;
    used.add(slug);

    const relDetail = `projects/${project}/notes/_details/${slug}.md`;
    const absDetail = path.join(root, relDetail);
    // Read the real pre-image instead of assuming a creation: `before` drives both
    // the backup and the approval diff, so claiming null for a file that exists
    // both skips the backup and renders a clobber as a green new-file add.
    const before = fs.existsSync(absDetail) ? fs.readFileSync(absDetail, 'utf8') : null;
    if (before !== null) collisions.push(relDetail);
    // The title becomes this file's H1 and it moves with the body, so a link in it
    // needs the same rebase the body gets; the index entry below keeps the title
    // raw, since notes.md itself does not move.
    writes.push({
      path: relDetail,
      before,
      after: `# ${rewriteRelativeLinks(s.title, 2)}\n\n${rewriteRelativeLinks(s.body, 2)}`,
    });

    const firstProse = s.body.split('\n')
      .map((l) => l.trim())
      .find((l) => l && !POINTER_LINE.test(l)) || '';
    const summary = (firstProse || s.title).slice(0, 200);
    const triggers = base.split('-').filter((w) => w.length > 2 && !STOPWORDS.has(w)).join(', ');
    entries.push(
      `## ${s.title}\n\n**Triggers:** ${triggers}\n\n**Summary:** ${summary}\n\n` +
      `**Detail:** [notes/_details/${slug}.md](notes/_details/${slug}.md)\n\n`
    );
  }

  // A detail file that already exists means the two-tier state is inconsistent
  // (a hand-started migration, or a restored-flat notes.md over a live _details/).
  // Sharding anyway would replace hand-written analysis with a scaffold. The data
  // is gitignored and irreplaceable, so make it a human's explicit decision — the
  // same stance as the already-sharded guard above.
  if (collisions.length) {
    throw new Error(
      `refusing to shard ${relIdx}: these detail files already exist and would be overwritten:\n  ` +
      `${collisions.join('\n  ')}\nmerge or move them by hand first`);
  }

  const after = header + entries.join('');
  writes.unshift({ path: relIdx, before: src, after });
  return {
    command: 'shard-notes',
    project,
    summary: {
      entries: entries.length,
      indexBytesBefore: Buffer.byteLength(src),
      indexBytesAfter: Buffer.byteLength(after),
    },
    writes,
  };
}
