'use strict';

// Surgical, contract-safe writer for the Mavis identity files + two-tier category entries. Every edit
// replaces ONE `##` section body (or one profile frontmatter key, or appends one
// preference bullet) and re-emits all other content verbatim — so the file Mavis reads at
// auto-load stays byte-structurally the same. A pre-write GUARD aborts any change that
// would drop/duplicate a `##` heading or lose frontmatter, so a form save can NEVER ship a
// file that breaks the session-start read. Pure parse/transform fns operate on strings (no
// I/O) so they're unit-tested; preview()/save() add the file read/guard/atomic write.

const fs = require('fs');
const path = require('path');
const { mavisFilePath } = require('./brain-stats');

// the form may only write these (rules/CLAUDE.md stays external-edit, read-only in-app)
const WRITABLE = { profile: 1, personality: 1, communication: 1 };

function writeFileAtomic(file, text) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

// md → { frontmatter:[lines]|null, preBody:[lines], sections:[{headingText, headingLine, bodyLines}] }
// Sections split on level-2 `## ` only; `###+` and everything else stay in a section body.
function parseSections(md) {
  const lines = String(md == null ? '' : md).split(/\r?\n/);
  let i = 0, frontmatter = null;
  if (lines[0] === '---') {
    const fm = []; let j = 1;
    while (j < lines.length && lines[j] !== '---') { fm.push(lines[j]); j++; }
    if (j < lines.length) { frontmatter = fm; i = j + 1; }
  }
  const preBody = [], sections = [];
  let cur = null;
  for (; i < lines.length; i++) {
    const h = lines[i].match(/^##\s+(.+?)\s*$/);
    if (h) { if (cur) sections.push(cur); cur = { headingText: h[1].trim(), headingLine: lines[i], bodyLines: [] }; }
    else if (cur) cur.bodyLines.push(lines[i]);
    else preBody.push(lines[i]);
  }
  if (cur) sections.push(cur);
  return { frontmatter, preBody, sections };
}

function emit(parsed) {
  const out = [];
  if (parsed.frontmatter) { out.push('---'); parsed.frontmatter.forEach((l) => out.push(l)); out.push('---'); }
  parsed.preBody.forEach((l) => out.push(l));
  parsed.sections.forEach((s) => { out.push(s.headingLine); s.bodyLines.forEach((l) => out.push(l)); });
  return out.join('\n');
}

// split the EXACT leading/trailing blank runs off a section body so a replace keeps the
// surrounding spacing verbatim (a same-content replace must round-trip byte-identical).
function blanks(body) {
  let first = 0; while (first < body.length && body[first].trim() === '') first++;
  let last = body.length - 1; while (last >= 0 && body[last].trim() === '') last--;
  if (last < first) return { lead: body.slice(), trail: [] }; // all-blank section
  return { lead: body.slice(0, first), trail: body.slice(last + 1) };
}

function replaceSectionBody(md, headingText, newBody) {
  const parsed = parseSections(md);
  const sec = parsed.sections.find((s) => s.headingText === String(headingText).trim());
  if (!sec) return { ok: false, error: 'section "' + headingText + '" not found' };
  // No-op guard: when the trimmed body is unchanged, return the file VERBATIM so a re-save
  // round-trips byte-identical. Without this, re-emitting an empty section grows a blank
  // line per save, and a de-indented (but content-equal) re-save would strip the first
  // line's indentation. Leaving the bytes untouched restores the unchanged:true guarantee.
  if (sec.bodyLines.join('\n').trim() === String(newBody == null ? '' : newBody).trim()) {
    return { ok: true, md };
  }
  const { lead, trail } = blanks(sec.bodyLines);
  const content = String(newBody == null ? '' : newBody).replace(/\s+$/, '').split('\n');
  sec.bodyLines = lead.concat(content, trail);
  return { ok: true, md: emit(parsed) };
}

// Replace a section body if the heading exists; otherwise APPEND a new `## <heading>` section at
// the end — so an edit can fill an absent optional section (e.g. add a Pre-empt to a topic that
// lacks one). Returns { ok, md, added? } where `added` is the heading name when it was appended.
function upsertSectionBody(md, headingText, newBody) {
  const h = String(headingText).trim();
  const parsed = parseSections(md);
  if (parsed.sections.find((s) => s.headingText === h)) return replaceSectionBody(md, h, newBody);
  if (parsed.sections.length) {
    const last = parsed.sections[parsed.sections.length - 1];
    last.bodyLines = oneTrailingBlank(last.bodyLines);
  } else {
    parsed.preBody = oneTrailingBlank(parsed.preBody);
  }
  const content = String(newBody == null ? '' : newBody).replace(/\s+$/, '').split('\n');
  parsed.sections.push({ headingText: h, headingLine: '## ' + h, bodyLines: content });
  return { ok: true, md: emit(parsed), added: h };
}

function setFrontmatterKey(md, key, value) {
  const parsed = parseSections(md);
  if (!parsed.frontmatter) return { ok: false, error: 'no frontmatter' };
  if (!/^[A-Za-z0-9_]+$/.test(String(key))) return { ok: false, error: 'bad key' };
  const v = String(value == null ? '' : value).replace(/[\r\n]/g, ' ');
  let found = false;
  parsed.frontmatter = parsed.frontmatter.map((l) => {
    const m = l.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (m && m[1] === key) { found = true; return key + ': ' + v; }
    return l;
  });
  if (!found) parsed.frontmatter.push(key + ': ' + v);
  return { ok: true, md: emit(parsed) };
}

// Like setFrontmatterKey, but when the key is NEW it is inserted immediately AFTER
// `afterKey` (instead of appended at the end). Keeps the canonical key order intact —
// e.g. `superseded_by` belongs right after `links`, not after whatever is currently last.
// If the key already exists it is replaced in place (its position is preserved); if
// `afterKey` is missing, the new key is appended at the end as a fallback.
function setFrontmatterKeyAfter(md, afterKey, key, value) {
  const parsed = parseSections(md);
  if (!parsed.frontmatter) return { ok: false, error: 'no frontmatter' };
  if (!/^[A-Za-z0-9_]+$/.test(String(key))) return { ok: false, error: 'bad key' };
  const v = String(value == null ? '' : value).replace(/[\r\n]/g, ' ');
  const fm = parsed.frontmatter;
  for (let i = 0; i < fm.length; i++) {
    const m = fm[i].match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (m && m[1] === key) { fm[i] = key + ': ' + v; parsed.frontmatter = fm; return { ok: true, md: emit(parsed) }; }
  }
  let idx = -1;
  for (let i = 0; i < fm.length; i++) {
    const m = fm[i].match(/^([A-Za-z0-9_]+):/);
    if (m && m[1] === afterKey) { idx = i; break; }
  }
  if (idx === -1) fm.push(key + ': ' + v);
  else fm.splice(idx + 1, 0, key + ': ' + v);
  parsed.frontmatter = fm;
  return { ok: true, md: emit(parsed) };
}

function appendPreferenceEntry(md, bucket, dateISO, line, why) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateISO))) return { ok: false, error: 'bad date' };
  if (!String(line || '').trim()) return { ok: false, error: 'empty entry' };
  const parsed = parseSections(md);
  const sec = parsed.sections.find((s) => s.headingText === String(bucket).trim());
  if (!sec) return { ok: false, error: 'bucket "' + bucket + '" not found' };
  const entry = ['- **' + dateISO + '** — ' + String(line).trim().replace(/[\r\n]+/g, ' ')];
  if (why && String(why).trim()) entry.push('  **Why:** ' + String(why).trim().replace(/[\r\n]+/g, ' '));
  const body = sec.bodyLines;
  let last = body.length - 1; while (last >= 0 && body[last].trim() === '') last--;
  const head = body.slice(0, last + 1);
  const trail = body.slice(last + 1);
  sec.bodyLines = head.concat([''], entry, trail.length ? trail : ['']);
  return { ok: true, md: emit(parsed) };
}

function removeFrontmatterKey(md, key) {
  const parsed = parseSections(md);
  if (!parsed.frontmatter) return { ok: true, md };
  parsed.frontmatter = parsed.frontmatter.filter((l) => {
    const m = l.match(/^([A-Za-z0-9_]+):/);
    return !(m && m[1] === key);
  });
  return { ok: true, md: emit(parsed) };
}

// GUARD: after must keep frontmatter (if before had it) and every `##` heading 1:1.
function guard(before, after) {
  const b = parseSections(before), a = parseSections(after);
  if (b.frontmatter && !a.frontmatter) return { ok: false, error: 'frontmatter would be lost' };
  const bh = b.sections.map((s) => s.headingText);
  const ah = a.sections.map((s) => s.headingText);
  if (ah.length !== bh.length) return { ok: false, error: 'the set of ## sections changed' };
  for (const h of bh) { if (ah.filter((x) => x === h).length !== 1) return { ok: false, error: 'heading "' + h + '" is no longer present exactly once' }; }
  return { ok: true };
}

// op: {type:'section', heading, body} | {type:'frontmatter', key, value} |
//     {type:'appendPref', bucket, date, line, why}
function applyOp(before, op) {
  if (!op || typeof op !== 'object') return { ok: false, error: 'bad op' };
  if (op.type === 'section') return replaceSectionBody(before, op.heading, op.body);
  if (op.type === 'frontmatter') return setFrontmatterKey(before, op.key, op.value);
  if (op.type === 'appendPref') return appendPreferenceEntry(before, op.bucket, op.date, op.line, op.why);
  return { ok: false, error: 'unknown op type' };
}

// compose-only (no write): returns { ok, before, after } or { ok:false, error }
function preview(brainRoot, key, op) {
  if (!WRITABLE[key]) return { ok: false, error: 'not a writable file' };
  const p = mavisFilePath(brainRoot, key);
  if (!p) return { ok: false, error: 'unknown key' };
  let before; try { before = fs.readFileSync(p, 'utf8'); } catch { return { ok: false, error: 'cannot read file' }; }
  const r = applyOp(before, op);
  if (!r.ok) return r;
  const g = guard(before, r.md);
  if (!g.ok) return g;
  return { ok: true, before, after: r.md, changed: before !== r.md };
}

// apply + guard + atomic write. Never writes a file that fails the guard.
function save(brainRoot, key, op) {
  const pv = preview(brainRoot, key, op);
  if (!pv.ok) return pv;
  if (!pv.changed) return { ok: true, unchanged: true };
  const p = mavisFilePath(brainRoot, key);
  try { writeFileAtomic(p, pv.after.endsWith('\n') ? pv.after : pv.after + '\n'); } catch (e) { return { ok: false, error: e.message }; }
  return { ok: true };
}

// Set (or clear) a project's `color:` frontmatter key in projects/<slug>/index.md.
// Guarded + atomic like the identity writes. A hex value is quoted so it stays valid
// YAML (a bare `#…` would read as a comment); an empty value removes the key entirely.
function saveProjectColor(brainRoot, slug, color) {
  if (typeof slug !== 'string' || !/^[A-Za-z0-9._-]+$/.test(slug) || slug === '.' || slug === '..') return { ok: false, error: 'bad slug' };
  const c = String(color == null ? '' : color).trim();
  if (c && !/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(c)) return { ok: false, error: 'bad color' };
  const p = path.join(brainRoot, 'projects', slug, 'index.md');
  let before;
  try { before = fs.readFileSync(p, 'utf8'); } catch { return { ok: false, error: 'cannot read project index' }; }
  const r = c ? setFrontmatterKey(before, 'color', '"' + c + '"') : removeFrontmatterKey(before, 'color');
  if (!r.ok) return r;
  const g = guard(before, r.md);
  if (!g.ok) return g;
  if (before === r.md) return { ok: true, unchanged: true };
  try { writeFileAtomic(p, r.md.endsWith('\n') ? r.md : r.md + '\n'); } catch (e) { return { ok: false, error: e.message }; }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Unified two-tier entries: <category>/_index.md + <category>/_details/<slug>.md.
// Produced ALONGSIDE the legacy brain (never touches identity/, projects/, dailies).
// Same parse -> guard -> atomic-write discipline; the _index gets a controlled
// heading-set delta (one add / one remove) via guardHeadingDelta, the _details
// file is governed by the existing strict `guard` (its heading set never changes).
// ---------------------------------------------------------------------------

// shared slug/category rule (mirrors brain-stats.safeSlug + saveProjectColor's idiom)
function validSlug(s) {
  return typeof s === 'string' && /^[A-Za-z0-9._-]+$/.test(s) && s !== '.' && s !== '..';
}

function isDate(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s)); }

// triggers → single comma-joined line; array members rstrip+flatten, drop empties.
function normTriggers(t) {
  if (Array.isArray(t)) {
    return t.map((x) => String(x == null ? '' : x).replace(/[\r\n]+/g, ' ').trim()).filter(Boolean).join(', ');
  }
  return String(t == null ? '' : t).replace(/[\r\n]+/g, ' ').trim();
}

// scope / links → string[]: array members flatten + trim, dropping empties; a comma string
// splits on commas. Used to thread the `scope: [..]` / `links: [..]` front-matter arrays.
function normList(v) {
  if (Array.isArray(v)) return v.map((x) => String(x == null ? '' : x).replace(/[\r\n]+/g, ' ').trim()).filter(Boolean);
  const s = String(v == null ? '' : v).replace(/[\r\n]+/g, ' ').trim();
  if (!s) return [];
  return s.split(',').map((x) => x.trim()).filter(Boolean);
}

// category DIR (plural) → the SINGULAR enum the detail front-matter `category:` carries.
const CATEGORY_SINGULAR = { preferences: 'preference', rules: 'rule', topics: 'topic', notes: 'note' };
function singularCategory(dir) { return CATEGORY_SINGULAR[dir] || dir; }

// strip trailing blank lines off a lines[] and re-add exactly one — the inter-section
// blank that emit() relies on (it inserts no separators of its own).
function oneTrailingBlank(lines) {
  let last = lines.length - 1;
  while (last >= 0 && lines[last].trim() === '') last--;
  return lines.slice(0, last + 1).concat(['']);
}

// Generalized guard: permit a declared heading-set delta on _index. guard(b,a) is the
// added=[],removed=[] case (kept separately). added/removed are bare slugs.
function guardHeadingDelta(before, after, opts) {
  const added = (opts && opts.added) || [];
  const removed = (opts && opts.removed) || [];
  const b = parseSections(before), a = parseSections(after);
  if (b.frontmatter && !a.frontmatter) return { ok: false, error: 'frontmatter would be lost' };
  const bh = b.sections.map((s) => s.headingText);
  const ah = a.sections.map((s) => s.headingText);
  const count = (arr, h) => arr.filter((x) => x === h).length;
  const removedSet = new Set(removed);
  const addedSet = new Set(added);
  for (const h of removed) {
    if (count(bh, h) !== 1) return { ok: false, error: 'heading "' + h + '" is not present exactly once' };
    if (count(ah, h) !== 0) return { ok: false, error: 'heading "' + h + '" was not removed' };
  }
  for (const h of added) {
    const ca = count(ah, h);
    if (ca > 1) return { ok: false, error: 'heading "' + h + '" present more than once' };
    if (ca < 1) return { ok: false, error: 'heading "' + h + '" was not added' };
    if (count(bh, h) !== 0) return { ok: false, error: 'heading "' + h + '" already present' };
  }
  for (const h of bh) {
    if (removedSet.has(h)) continue;
    if (count(ah, h) !== 1) return { ok: false, error: 'heading "' + h + '" is no longer present exactly once' };
  }
  for (const h of ah) {
    if (addedSet.has(h)) continue;
    if (bh.includes(h) && !removedSet.has(h)) continue;
    return { ok: false, error: 'unexpected heading "' + h + '" in result' };
  }
  return { ok: true };
}

// _details/<slug>.md body — the CANONICAL contract (byte-for-byte with the migration's
// emitDetail so every producer agrees). Front-matter key order is fixed:
//   id, title, category (SINGULAR), scope, status, since, updated, links,
//   + superseded_by ONLY when status != active.
// The body starts DIRECTLY at `## Rule` (no `# <slug>` H1, no `**Index:**` preamble);
// `## Why` and `## How to apply` are OMITTED when empty. Rule/Why/How bodies are rstrip-only
// so multi-paragraph rules (blank lines between paragraphs) and indentation are preserved.
function buildDetailMd(category, slug, fields) {
  const flat = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const body = (s) => String(s == null ? '' : s).replace(/\s+$/, '');
  const status = fields.status || 'active';
  const out = ['---'];
  out.push('id: ' + slug);
  out.push('title: ' + flat(fields.title));
  out.push('category: ' + category);
  out.push('scope: [' + (fields.scope || []).join(', ') + ']');
  out.push('status: ' + status);
  out.push('since: ' + fields.since);
  out.push('updated: ' + fields.updated);
  out.push('links: [' + (fields.links || []).join(', ') + ']');
  if (status !== 'active') out.push('superseded_by: ' + (fields.superseded_by || ''));
  out.push('---');
  if (category === 'topic') {
    out.push('## Did');
    out.push(body(fields.did));
    if (flat(fields.refs)) { out.push('## Refs'); out.push(body(fields.refs)); }
    if (flat(fields.preempt)) { out.push('## Pre-empt'); out.push(body(fields.preempt)); }
  } else {
    out.push('## Rule');
    out.push(body(fields.rule));
    if (flat(fields.why)) { out.push('## Why'); out.push(body(fields.why)); }
    if (flat(fields.how)) { out.push('## How to apply'); out.push(body(fields.how)); }
  }
  return out.join('\n') + '\n';
}

// _index.md skeleton, created only when the file is absent (no trailing newline — the
// first appended entry normalizes the preBody trailing blank).
function buildIndexSkeleton(category) {
  return [
    '---',
    'category: ' + category,
    '---',
    '',
    '# ' + category + ' — index',
    '',
    '**Purpose:** retrieval router for the "' + category + '" category. Each `## <slug>` entry carries Triggers + a one-line Summary + a Detail pointer to `_details/<slug>.md` (Rule / Why / How to apply).',
  ].join('\n');
}

// append a `## <slug>` entry to _index. Each entry body ENDS with a `---` rule, so
// consecutive `## <slug>` sections are separated by `---` (matching the migration's
// emitIndex + the topic_index convention). oneTrailingBlank on the prior section keeps
// that separator intact and preserves the one-trailing-blank invariant emit() relies on.
function appendIndexEntry(indexMd, slug, triggers, summary) {
  const parsed = parseSections(indexMd);
  if (parsed.sections.length) {
    const lastSec = parsed.sections[parsed.sections.length - 1];
    lastSec.bodyLines = oneTrailingBlank(lastSec.bodyLines);
  } else {
    parsed.preBody = oneTrailingBlank(parsed.preBody);
  }
  parsed.sections.push({
    headingText: slug,
    headingLine: '## ' + slug,
    bodyLines: ['', '**Triggers:** ' + triggers, '', '**Summary:** ' + summary, '',
      '**Detail:** [_details/' + slug + '.md](_details/' + slug + '.md)', '', '---', ''],
  });
  return emit(parsed);
}

function termNL(s) { return s.endsWith('\n') ? s : s + '\n'; }

// --- addEntry ---------------------------------------------------------------

function previewAddEntry(brainRoot, category, entry) {
  if (!validSlug(category)) return { ok: false, error: 'bad category' };
  entry = entry || {};
  if (!validSlug(entry.slug)) return { ok: false, error: 'bad slug' };
  if (!isDate(entry.date)) return { ok: false, error: 'bad date' };
  const slug = entry.slug, date = entry.date;
  const catSingular = singularCategory(category);
  const isTopic = catSingular === 'topic';
  const primaryBody = isTopic ? entry.did : entry.rule;
  if (!String(primaryBody == null ? '' : primaryBody).trim()) return { ok: false, error: isTopic ? 'empty did' : 'empty rule' };
  const summary = String(entry.summary == null ? '' : entry.summary).replace(/[\r\n]+/g, ' ').trim();
  if (!summary) return { ok: false, error: 'empty summary' };
  const triggers = normTriggers(entry.triggers);
  if (!triggers) return { ok: false, error: 'empty triggers' };
  let since = date;
  if (entry.since != null) { if (!isDate(entry.since)) return { ok: false, error: 'bad since' }; since = entry.since; }
  const title = String(entry.title == null ? '' : entry.title).replace(/\s+/g, ' ').trim() || summary;
  const scope = normList(entry.scope);
  const links = normList(entry.links);

  const dir = path.join(brainRoot, category);
  const indexPath = path.join(dir, '_index.md');
  const detailPath = path.join(dir, '_details', slug + '.md');

  // additive law: never overwrite an existing brain file
  if (fs.existsSync(detailPath)) return { ok: false, error: 'entry already exists' };

  const detailsAfter = buildDetailMd(catSingular, slug, {
    title, scope, status: 'active', since, updated: date, links,
    rule: entry.rule, why: entry.why, how: entry.how,
    did: entry.did, refs: entry.refs, preempt: entry.preempt,
  });
  // creation-time stand-in for guard (no `before` to diff): shape must be exactly right.
  // Optional sections are omitted when empty, so the expected heading set is derived from
  // which of those fields the entry carries (Rule/Why/How for prefs+rules, Did/Refs/Pre-empt for topics).
  const has = (v) => !!String(v == null ? '' : v).trim();
  const expectHeads = isTopic ? ['Did'] : ['Rule'];
  if (isTopic) {
    if (has(entry.refs)) expectHeads.push('Refs');
    if (has(entry.preempt)) expectHeads.push('Pre-empt');
  } else {
    if (has(entry.why)) expectHeads.push('Why');
    if (has(entry.how)) expectHeads.push('How to apply');
  }
  const ds = parseSections(detailsAfter);
  if (!ds.frontmatter || ds.sections.map((s) => s.headingText).join('|') !== expectHeads.join('|')) {
    return { ok: false, error: 'detail shape check failed' };
  }

  let indexBefore;
  try { indexBefore = fs.readFileSync(indexPath, 'utf8'); } catch { indexBefore = buildIndexSkeleton(catSingular); }
  const indexAfter = appendIndexEntry(indexBefore, slug, triggers, summary);
  const g = guardHeadingDelta(indexBefore, indexAfter, { added: [slug] });
  if (!g.ok) return g;

  return {
    ok: true,
    files: [
      { key: 'details', path: detailPath, before: '', after: detailsAfter, changed: true },
      { key: 'index', path: indexPath, before: indexBefore, after: indexAfter, changed: indexBefore !== indexAfter },
    ],
  };
}

function addEntry(brainRoot, category, entry) {
  const pv = previewAddEntry(brainRoot, category, entry);
  if (!pv.ok) return pv;
  const detail = pv.files.find((f) => f.key === 'details');
  const index = pv.files.find((f) => f.key === 'index');
  try {
    // leaf before pointer: a crash after the detail write leaves an orphan detail with
    // no index pointer (no broken nav); re-running then trips 'entry already exists'.
    fs.mkdirSync(path.join(brainRoot, category, '_details'), { recursive: true });
    writeFileAtomic(detail.path, termNL(detail.after));
    writeFileAtomic(index.path, termNL(index.after));
  } catch (e) { return { ok: false, error: e.message }; }
  return { ok: true };
}

// --- editEntry (details file ONLY) ------------------------------------------

function previewEditEntry(brainRoot, category, slug, patch) {
  if (!validSlug(category)) return { ok: false, error: 'bad category' };
  if (!validSlug(slug)) return { ok: false, error: 'bad slug' };
  patch = patch || {};
  if (patch.date != null && !isDate(patch.date)) return { ok: false, error: 'bad date' };
  const detailPath = path.join(brainRoot, category, '_details', slug + '.md');
  let before;
  try { before = fs.readFileSync(detailPath, 'utf8'); } catch { return { ok: false, error: 'detail file not found' }; }
  let md = before, r;
  const added = [];
  const apply = (heading, val) => {
    if (val == null) return { ok: true };
    const res = upsertSectionBody(md, heading, val);
    if (!res.ok) return res;
    if (res.added) added.push(res.added);
    md = res.md;
    return { ok: true };
  };
  const heads = singularCategory(category) === 'topic'
    ? [['Did', patch.did], ['Refs', patch.refs], ['Pre-empt', patch.preempt]]
    : [['Rule', patch.rule], ['Why', patch.why], ['How to apply', patch.how]];
  for (const [h, v] of heads) { r = apply(h, v); if (!r.ok) return r; }
  if (patch.date != null) { r = setFrontmatterKey(md, 'updated', patch.date); if (!r.ok) return r; md = r.md; }
  const g = added.length ? guardHeadingDelta(before, md, { added }) : guard(before, md);
  if (!g.ok) return g;
  return { ok: true, before, after: md, changed: before !== md };
}

function editEntry(brainRoot, category, slug, patch) {
  const pv = previewEditEntry(brainRoot, category, slug, patch);
  if (!pv.ok) return pv;
  if (!pv.changed) return { ok: true, unchanged: true };
  const detailPath = path.join(brainRoot, category, '_details', slug + '.md');
  try { writeFileAtomic(detailPath, termNL(pv.after)); } catch (e) { return { ok: false, error: e.message }; }
  return { ok: true };
}

// --- supersedeEntry (flip details status + drop the index line) -------------

function previewSupersedeEntry(brainRoot, category, slug, opts) {
  if (!validSlug(category)) return { ok: false, error: 'bad category' };
  if (!validSlug(slug)) return { ok: false, error: 'bad slug' };
  opts = opts || {};
  if (!validSlug(opts.superseded_by)) return { ok: false, error: 'bad superseded_by' };
  if (opts.date != null && !isDate(opts.date)) return { ok: false, error: 'bad date' };

  const dir = path.join(brainRoot, category);
  const detailPath = path.join(dir, '_details', slug + '.md');
  const indexPath = path.join(dir, '_index.md');

  // details: status -> superseded, insert superseded_by AFTER `links` (canonical order),
  // optional updated bump.
  let detailsBefore;
  try { detailsBefore = fs.readFileSync(detailPath, 'utf8'); } catch { return { ok: false, error: 'detail file not found' }; }
  let dmd = detailsBefore, r;
  r = setFrontmatterKey(dmd, 'status', 'superseded'); if (!r.ok) return r; dmd = r.md;
  r = setFrontmatterKeyAfter(dmd, 'links', 'superseded_by', opts.superseded_by); if (!r.ok) return r; dmd = r.md;
  if (opts.date != null) { r = setFrontmatterKey(dmd, 'updated', opts.date); if (!r.ok) return r; dmd = r.md; }
  const dg = guard(detailsBefore, dmd);
  if (!dg.ok) return dg;

  // index: drop the `## <slug>` section; siblings + spacing survive verbatim.
  let indexBefore;
  try { indexBefore = fs.readFileSync(indexPath, 'utf8'); } catch { return { ok: false, error: 'index not found' }; }
  const parsed = parseSections(indexBefore);
  parsed.sections = parsed.sections.filter((s) => s.headingText !== slug);
  const indexAfter = emit(parsed);
  const ig = guardHeadingDelta(indexBefore, indexAfter, { removed: [slug] });
  if (!ig.ok) return ig;

  return {
    ok: true,
    files: [
      { key: 'details', path: detailPath, before: detailsBefore, after: dmd, changed: detailsBefore !== dmd },
      { key: 'index', path: indexPath, before: indexBefore, after: indexAfter, changed: indexBefore !== indexAfter },
    ],
  };
}

function supersedeEntry(brainRoot, category, slug, opts) {
  const pv = previewSupersedeEntry(brainRoot, category, slug, opts);
  if (!pv.ok) return pv;
  const detail = pv.files.find((f) => f.key === 'details');
  const index = pv.files.find((f) => f.key === 'index');
  try {
    // mark before unlist: a crash after the details write leaves a superseded detail
    // still listed in _index; re-running is idempotent (details unchanged, index trimmed).
    if (detail.changed) writeFileAtomic(detail.path, termNL(detail.after));
    writeFileAtomic(index.path, termNL(index.after));
  } catch (e) { return { ok: false, error: e.message }; }
  return { ok: true };
}

module.exports = {
  WRITABLE, parseSections, emit, replaceSectionBody, setFrontmatterKey, setFrontmatterKeyAfter,
  removeFrontmatterKey, appendPreferenceEntry, guard, applyOp, preview, save, saveProjectColor,
  normList, singularCategory, buildDetailMd,
  guardHeadingDelta, addEntry, editEntry, supersedeEntry,
  previewAddEntry, previewEditEntry, previewSupersedeEntry,
};
